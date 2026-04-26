// scripts/resume-pipeline.js
// Resumes a pipeline run from stage 8 (video assembly) using existing artifacts
// in an output folder. Useful when ffmpeg fails and we don't want to regenerate
// script/voice/images (which cost API quota + 20+ min).
//
// Usage:
//   node scripts/resume-pipeline.js "output/20260419_2151_the-dajjal-..."
//
// Expected artifacts in the folder:
//   topic.json, script.json, visual-plan.json, sources.json,
//   voice-metadata.json, voiceover.mp3, recitations.json,
//   captions.srt, captions.ass, thumbnail_bg.jpg, images/beat_NNN.jpg

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const assembler = require('../modules/assembler');
const llm = require('../modules/llm');
const queue = require('../modules/queue');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeArtifact(dir, name, data) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

async function main() {
  const args = process.argv.slice(2);
  const rawDir = args.find((a) => !a.startsWith('--'));
  if (!rawDir || !fs.existsSync(rawDir)) {
    console.error('Usage: node scripts/resume-pipeline.js <output-folder>');
    process.exit(2);
  }
  const outputDir = path.resolve(rawDir);

  const topic = readJson(path.join(outputDir, 'topic.json'));
  const script = readJson(path.join(outputDir, 'script.json'));
  const visualPlan = readJson(path.join(outputDir, 'visual-plan.json'));
  const srcData = readJson(path.join(outputDir, 'sources.json'));
  const voiceMeta = readJson(path.join(outputDir, 'voice-metadata.json'));
  const recitationsRaw = readJson(path.join(outputDir, 'recitations.json'));

  // Reconstruct beats[] with imagePath pointing at the already-generated files
  const beatsRes = visualPlan.beats.map((b, i) => {
    const n = b.beat_number || i + 1;
    return { ...b, imagePath: path.join(outputDir, 'images', `beat_${String(n).padStart(3, '0')}.jpg`) };
  });

  const voiceRes = {
    audioPath: path.join(outputDir, 'voiceover.mp3'),
    wordTimings: voiceMeta.words || [],
    durationSec: voiceMeta.duration_sec,
  };

  const capPaths = {
    srtPath: path.join(outputDir, 'captions.srt'),
    assPath: path.join(outputDir, 'captions.ass'),
  };

  const thumb = visualPlan.thumbnail || {};
  const bgPath = path.join(outputDir, 'thumbnail_bg.jpg');
  const thumbRes = {
    bgPath: fs.existsSync(bgPath) ? bgPath : (beatsRes[0] && beatsRes[0].imagePath),
    overlayText: thumb.title_overlay || 'AKHIR ZAMAAN',
    accentColor: thumb.accent_color || '#FFD700',
  };

  console.log(`[resume] folder: ${outputDir}`);
  console.log(`[resume] beats: ${beatsRes.length}, voice: ${voiceRes.durationSec.toFixed(1)}s, recitations: ${recitationsRaw.length}`);

  // Stage 8
  console.log('[resume] STAGE 8: assemble video');
  const asmRes = await assembler.assembleVideo({
    beats: beatsRes,
    audioPath: voiceRes.audioPath,
    captionsAss: capPaths.assPath,
    recitations: recitationsRaw,
    outputDir,
  });
  console.log(`[resume] video: ${asmRes.videoPath} (${asmRes.durationSec.toFixed(1)}s)`);

  // Stage 9
  console.log('[resume] STAGE 9: thumbnail');
  const thumbPath = assembler.assembleThumbnail(thumbRes, outputDir);
  console.log(`[resume] thumbnail: ${thumbPath}`);

  // Stage 10
  console.log('[resume] STAGE 10: metadata');
  const metaPath = path.join(outputDir, 'metadata.json');
  const metadata = fs.existsSync(metaPath)
    ? readJson(metaPath)
    : await llm.generateMetadata({ script, visualPlan, sources: srcData, topic });
  if (!fs.existsSync(metaPath)) writeArtifact(outputDir, 'metadata.json', metadata);

  const repoRoot = path.resolve(__dirname, '..');
  const relVideoPath = path.relative(repoRoot, asmRes.videoPath).replace(/\\/g, '/');
  queue.markPublished(topic, null, relVideoPath);
  writeArtifact(outputDir, 'delivery.json', {
    videoPath: relVideoPath,
    thumbnailPath: path.relative(repoRoot, thumbPath).replace(/\\/g, '/'),
    srtPath: path.relative(repoRoot, capPaths.srtPath).replace(/\\/g, '/'),
    durationSec: asmRes.durationSec,
    title: metadata.title,
    generatedAt: new Date().toISOString(),
  });

  console.log(`[resume] DONE — video ready: ${asmRes.videoPath}`);
}

main().catch((err) => {
  console.error('[resume] FAILED:', err);
  process.exit(1);
});
