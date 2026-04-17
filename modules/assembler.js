// modules/assembler.js
// FFmpeg video + thumbnail assembly. Pure command-line FFmpeg (no fluent-ffmpeg dep).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MUSIC_DIR = path.join(__dirname, '..', 'assets', 'music');
const FONT_PATH = process.env.FONT_PATH || ''; // optional override

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
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
  const perBeatSec = totalAudioSec / beats.length;

  // 1. Build concat list with each beat's image and computed duration
  const concatListPath = path.join(outputDir, 'concat.txt');
  const lines = [];
  for (const beat of beats) {
    const dur = beat.duration_estimate_seconds && beat.duration_estimate_seconds > 0
      ? beat.duration_estimate_seconds
      : perBeatSec;
    lines.push(`file '${escapeFFConcatPath(beat.imagePath)}'`);
    lines.push(`duration ${dur.toFixed(3)}`);
  }
  // FFmpeg concat needs the last file repeated without duration
  lines.push(`file '${escapeFFConcatPath(beats[beats.length - 1].imagePath)}'`);
  fs.writeFileSync(concatListPath, lines.join('\n'));

  const baseVideoPath = path.join(outputDir, 'base_video.mp4');
  // Pass 1: images -> base video with Ken Burns zoom
  // zoompan filter: slow zoom from 1.0 -> 1.15 over each beat
  const zoomFilter = `scale=3840:2160,zoompan=z='min(zoom+0.0008,1.15)':d=125:s=1920x1080:fps=30,format=yuv420p`;

  run('ffmpeg', [
    '-y',
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

  // Pass 2: build the full audio track = voiceover + ambient music ducked
  const mixedAudioPath = path.join(outputDir, 'mixed_audio.mp3');
  const musicTrack = pickRandomMusic();

  if (musicTrack) {
    // Mix voice (full volume) + music (volume 0.12 ~ -22dB), looped to length
    run('ffmpeg', [
      '-y',
      '-i', audioPath,
      '-stream_loop', '-1', '-i', musicTrack,
      '-filter_complex',
      `[1:a]volume=0.12,aloop=loop=-1:size=2e9[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
      '-map', '[aout]',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      mixedAudioPath,
    ]);
  } else {
    console.warn('[assembler] no music track in assets/music/ — voiceover only');
    fs.copyFileSync(audioPath, mixedAudioPath);
  }

  // Pass 3: combine base video + mixed audio + burned captions
  const finalPath = path.join(outputDir, 'final.mp4');
  const subFilter = `ass='${escapeFilterPath(captionsAss)}'`;
  run('ffmpeg', [
    '-y',
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
