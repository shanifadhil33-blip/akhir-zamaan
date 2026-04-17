// modules/shorts.js
// Generates a 50-second vertical (9:16) Short from the main video.
// Uses the shorts_segment hint from the visual plan (start_beat, end_beat).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ffprobeDuration } = require('./assembler');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}\nSTDERR: ${r.stderr ? r.stderr.slice(-2000) : ''}`);
  return r;
}

function calculateSegment(visualPlan, beats) {
  const totalBeats = beats.length;
  const seg = visualPlan.shorts_segment || {};
  const startBeat = Math.max(1, parseInt(seg.start_beat, 10) || 1);
  const endBeat = Math.min(totalBeats, parseInt(seg.end_beat, 10) || 5);
  return { startBeat, endBeat };
}

async function generateShort({ videoPath, visualPlan, beats, outputDir }) {
  if (!fs.existsSync(videoPath)) throw new Error(`Main video missing: ${videoPath}`);
  const totalSec = ffprobeDuration(videoPath);

  const { startBeat, endBeat } = calculateSegment(visualPlan, beats);
  // Compute approximate seconds from beat boundaries using equal division across beats
  const perBeat = totalSec / beats.length;
  let startSec = (startBeat - 1) * perBeat;
  let endSec = endBeat * perBeat;
  // Clamp to 50s max, 30s min
  if (endSec - startSec > 50) endSec = startSec + 50;
  if (endSec - startSec < 30) endSec = Math.min(totalSec, startSec + 30);
  const duration = endSec - startSec;

  const shortPath = path.join(outputDir, 'short.mp4');

  // Crop center to 9:16 (1080x1920), keep burned captions visible
  // Source is 1920x1080; to get 9:16 we crop horizontally to width = (9/16)*1080 = 607.5 -> 608
  // Then scale to 1080x1920
  const vf = `crop=608:1080:(iw-608)/2:0,scale=1080:1920:flags=lanczos,setsar=1:1`;

  run('ffmpeg', [
    '-y',
    '-ss', String(startSec.toFixed(3)),
    '-t', String(duration.toFixed(3)),
    '-i', videoPath,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    shortPath,
  ]);

  return {
    shortPath,
    startSec,
    endSec,
    duration,
  };
}

function buildShortMetadata({ mainTitle, mainDescription, shortsSegmentReason }) {
  // YouTube Shorts title limit 100 chars; usually best under 60
  let title = mainTitle;
  if (title && title.length > 90) title = title.slice(0, 87) + '...';
  if (!/#shorts/i.test(title)) title = `${title} #Shorts`;

  const description = [
    `Full video on the channel.`,
    '',
    shortsSegmentReason || 'A preview of the full reflection. Watch the complete documentary on our channel.',
    '',
    '🔔 Subscribe for daily end-times reflections.',
    '',
    '#Shorts #Islam #AkhirZamaan #EndTimes #Qiyamah #Muslim #Deen #PropheticWarning',
  ].join('\n');

  return { title, description, tags: ['shorts', 'islam', 'akhir zamaan', 'end times', 'muslim', 'qiyamah', 'deen'] };
}

module.exports = { generateShort, buildShortMetadata };
