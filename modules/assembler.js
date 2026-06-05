// modules/assembler.js
// FFmpeg video + thumbnail assembly. Pure command-line FFmpeg (no fluent-ffmpeg dep).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MUSIC_DIR = path.join(__dirname, '..', 'assets', 'music');
const FONT_PATH = process.env.FONT_PATH || ''; // optional override

function run(cmd, args, opts = {}) {
  // maxBuffer: 200 MB — FFmpeg with default loglevel prints multiple lines per
  // input frame, and a 366-beat zoompan pass produces 10+ MB of stderr. Node's
  // default spawnSync maxBuffer is 1 MB, which throws ENOBUFS before FFmpeg
  // even finishes. We don't actually need the verbose output; we only read
  // the last 2000 chars on failure. Bumping the cap is the simplest fix.
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} exited ${result.status}\nSTDERR: ${result.stderr ? result.stderr.slice(-2000) : ''}`);
  }
  return result;
}

function ffprobeDuration(filePath) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed for ${filePath}: ${r.stderr}`);
  return parseFloat(String(r.stdout).trim());
}

function pickRandomMusic() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const files = fs.readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f));
  if (!files.length) return null;
  const pick = files[Math.floor(Math.random() * files.length)];
  return path.join(MUSIC_DIR, pick);
}

function escapeFFConcatPath(p) {
  // FFmpeg concat demuxer wants single-quoted, with internal single-quotes escaped.
  // On Windows we also need forward slashes for safety.
  const norm = p.replace(/\\/g, '/');
  return norm.replace(/'/g, `'\\''`);
}

function escapeFilterPath(p) {
  // For -vf subtitles=... and ass=... filter, we need to escape colons (Windows drive) and backslashes
  let s = p.replace(/\\/g, '/');
  s = s.replace(/:/g, '\\:');
  return s;
}

async function assembleVideo({ beats, audioPath, captionsAss, recitations = [], outputDir }) {
  if (!beats.length) throw new Error('No beats provided');
  if (!fs.existsSync(audioPath)) throw new Error(`Voice audio missing: ${audioPath}`);

  const totalAudioSec = ffprobeDuration(audioPath);
  // Normalize each beat's duration so images exactly cover the audio length.
  // If visual plan provides durations, scale them; otherwise equal split.
  const rawDurations = beats.map((b) => {
    const d = parseFloat(b.duration_estimate_seconds);
    return Number.isFinite(d) && d > 0 ? d : 0;
  });
  const rawTotal = rawDurations.reduce((a, b) => a + b, 0);
  const perBeatDurations = rawTotal > 0
    ? rawDurations.map((d) => (d / rawTotal) * totalAudioSec)
    : beats.map(() => totalAudioSec / beats.length);

  // Compute start timestamp for each beat (for recitation overlay timing)
  const beatStarts = [];
  let acc = 0;
  for (const d of perBeatDurations) { beatStarts.push(acc); acc += d; }

  // 1. Build concat list with each beat's image and computed duration
  const concatListPath = path.join(outputDir, 'concat.txt');
  const lines = [];
  for (let i = 0; i < beats.length; i++) {
    lines.push(`file '${escapeFFConcatPath(beats[i].imagePath)}'`);
    lines.push(`duration ${perBeatDurations[i].toFixed(3)}`);
  }
  // FFmpeg concat needs the last file repeated without duration
  lines.push(`file '${escapeFFConcatPath(beats[beats.length - 1].imagePath)}'`);
  fs.writeFileSync(concatListPath, lines.join('\n'));

  const baseVideoPath = path.join(outputDir, 'base_video.mp4');
  // Pass 1: images -> base video with Ken Burns zoom
  // Gentle, drawn-out zoom: ~1.0 -> 1.10 over ~10 seconds at 30fps. The
  // smaller increment + smaller cap reads as cinematic drift, not the snappy
  // zoom we had before that hit max in 6 seconds and then sat still.
  const zoomFilter = `scale=3840:2160,zoompan=z='min(zoom+0.00033,1.10)':d=300:s=1920x1080:fps=30,format=yuv420p`;

  run('ffmpeg', [
    '-y',
    '-loglevel', 'warning',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-vf', zoomFilter,
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    baseVideoPath,
  ]);

  // Pass 2: build the full audio track = voiceover + ambient music + recitation overlays
  const mixedAudioPath = path.join(outputDir, 'mixed_audio.mp3');
  const musicTrack = pickRandomMusic();

  // Match recitations to verse_overlay beats (in order). Each recitation plays
  // at its matched beat's start time, with the voice ducked during that window.
  const overlayBeats = beats
    .map((b, idx) => ({ b, idx }))
    .filter(({ b }) => b.verse_overlay === true);
  const recitationOverlays = [];
  for (let i = 0; i < Math.min(overlayBeats.length, recitations.length); i++) {
    const rec = recitations[i];
    const { idx } = overlayBeats[i];
    if (!rec || !rec.audioPath || !fs.existsSync(rec.audioPath)) continue;
    const recDur = (() => { try { return ffprobeDuration(rec.audioPath); } catch (_) { return 0; } })();
    if (recDur <= 0) continue;
    recitationOverlays.push({
      audioPath: rec.audioPath,
      startSec: beatStarts[idx],
      durationSec: recDur,
    });
  }

  const inputs = ['-i', audioPath];
  if (musicTrack) inputs.push('-stream_loop', '-1', '-i', musicTrack);
  const musicInputIdx = musicTrack ? 1 : -1;
  const recInputStart = musicTrack ? 2 : 1;
  for (const ro of recitationOverlays) inputs.push('-i', ro.audioPath);

  // Build filter chain.
  // Audio strategy:
  //   1. Voice (0:a): ducked at recitation windows so Arabic plays clearly.
  //   2. Music: sidechain-compressed against the raw voice — auto-ducks when
  //      voice is speaking, comes back up during pauses. Sits at ~-14dB base
  //      and drops to ~-30dB under speech. Never competes with narration.
  //   3. Recitations: delayed to land at their beat, mixed at near-full volume.
  const filters = [];

  if (musicTrack) {
    // Split the voice input: one copy gets the rec-window envelope, one is the sidechain trigger.
    filters.push(`[0:a]asplit=2[voice_a][voice_b]`);
    if (recitationOverlays.length > 0) {
      const enableExpr = recitationOverlays
        .map((ro) => `between(t,${ro.startSec.toFixed(3)},${(ro.startSec + ro.durationSec).toFixed(3)})`)
        .join('+');
      filters.push(`[voice_a]volume=enable='${enableExpr}':volume=0.25[voice]`);
    } else {
      filters.push(`[voice_a]anull[voice]`);
    }
    // Music base at ~-10dB (was -14dB — operator reported music was inaudible).
    // Looped forever so any short ambient track covers the full video.
    filters.push(`[${musicInputIdx}:a]volume=0.32,aloop=loop=-1:size=2e9[music_raw]`);
    // Sidechain compress: trigger=voice_b, target=music. Ratio relaxed from
    // 8:1 to 4:1 and threshold raised from 0.03 to 0.05 — was ducking the
    // music to inaudibility under speech. New settings let the bed stay
    // present at ~-18dB under voice instead of dropping to ~-30dB.
    filters.push(`[music_raw][voice_b]sidechaincompress=threshold=0.05:ratio=4:attack=15:release=800:makeup=1[music]`);
  } else {
    if (recitationOverlays.length > 0) {
      const enableExpr = recitationOverlays
        .map((ro) => `between(t,${ro.startSec.toFixed(3)},${(ro.startSec + ro.durationSec).toFixed(3)})`)
        .join('+');
      filters.push(`[0:a]volume=enable='${enableExpr}':volume=0.25[voice]`);
    } else {
      filters.push(`[0:a]anull[voice]`);
    }
  }

  // Delayed recitations
  const recLabels = [];
  for (let i = 0; i < recitationOverlays.length; i++) {
    const ro = recitationOverlays[i];
    const inputIdx = recInputStart + i;
    const delayMs = Math.round(ro.startSec * 1000);
    filters.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=0.9[rec${i}]`);
    recLabels.push(`[rec${i}]`);
  }

  // Final mix → loudness normalization
  const mixInputs = ['[voice]'];
  if (musicTrack) mixInputs.push('[music]');
  mixInputs.push(...recLabels);
  filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[premix]`);

  // Normalize to YouTube's loudness target (-14 LUFS integrated, -1.5 dB true
  // peak, LRA 11). Without this, raw TTS output sits around -22 LUFS, so the
  // final video plays MUCH quieter than every other YouTube video and viewers
  // have to crank their volume to hear the narrator (and even then the music
  // bed is buried). Single-pass loudnorm produces a small artifact at the
  // very start (<200ms); the two-pass version is overkill for short-form
  // narration with no dynamic mix.
  filters.push(`[premix]loudnorm=I=-14:LRA=11:TP=-1.5[aout]`);

  run('ffmpeg', [
    '-y',
    '-loglevel', 'warning',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[aout]',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    mixedAudioPath,
  ]);

  if (!musicTrack) console.warn('[assembler] no music track in assets/music/ — voiceover only');
  if (recitationOverlays.length > 0) {
    console.log(`[assembler] mixed ${recitationOverlays.length} recitation overlay(s)`);
  }

  // Pass 3: combine base video + mixed audio + burned captions
  const finalPath = path.join(outputDir, 'final.mp4');
  const subFilter = `ass='${escapeFilterPath(captionsAss)}'`;
  run('ffmpeg', [
    '-y',
    '-loglevel', 'warning',
    '-i', baseVideoPath,
    '-i', mixedAudioPath,
    '-vf', subFilter,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-pix_fmt', 'yuv420p',
    finalPath,
  ]);

  return { videoPath: finalPath, durationSec: totalAudioSec };
}

function assembleThumbnail(thumbnailData, outputDir) {
  const { bgPath, overlayText, accentColor } = thumbnailData;
  if (!fs.existsSync(bgPath)) throw new Error(`Thumbnail bg missing: ${bgPath}`);

  const finalPath = path.join(outputDir, 'thumbnail.jpg');

  // Sanitize overlay text for FFmpeg drawtext (escape colon, backslash, single-quote, percent)
  const safeText = String(overlayText).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');

  // Pick a font: prefer FONT_PATH env, fall back to common system fonts
  let fontFile = FONT_PATH;
  if (!fontFile) {
    const candidates = [
      'C:/Windows/Fonts/ariblk.ttf',
      'C:/Windows/Fonts/arialbd.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ];
    for (const c of candidates) { if (fs.existsSync(c)) { fontFile = c; break; } }
  }
  if (!fontFile) {
    console.warn('[assembler] no font found for thumbnail text — output will be background only');
    // Just resize the bg to 1280x720 as the thumbnail
    run('ffmpeg', ['-y', '-i', bgPath, '-vf', 'scale=1280:720', finalPath]);
    return finalPath;
  }

  const safeFontPath = escapeFilterPath(fontFile);
  const accent = (accentColor || '#FFD700').replace('#', '');

  // Filter: scale to 1280x720, dark overlay, text with thick border
  const vf = [
    'scale=1280:720',
    `drawbox=x=0:y=0:w=1280:h=720:color=black@0.45:t=fill`,
    `drawtext=fontfile='${safeFontPath}':text='${safeText}':fontcolor=white:fontsize=110:bordercolor=0x${accent}:borderw=6:x=(w-text_w)/2:y=(h-text_h)/2`,
  ].join(',');

  run('ffmpeg', ['-y', '-i', bgPath, '-vf', vf, '-q:v', '2', finalPath]);
  return finalPath;
}

module.exports = { assembleVideo, assembleThumbnail, pickRandomMusic, ffprobeDuration };
