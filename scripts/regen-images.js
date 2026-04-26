// scripts/regen-images.js
// Regenerates only the images/ folder for an existing pipeline output, using
// the current Pollinations settings in modules/images.js. Voice, captions,
// script stay as-is. Useful after tweaking image model or prompts.
//
// Usage:
//   node scripts/regen-images.js "output/<folder>"

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const images = require('../modules/images');

async function main() {
  const rawDir = process.argv[2];
  if (!rawDir || !fs.existsSync(rawDir)) {
    console.error('Usage: node scripts/regen-images.js <output-folder>');
    process.exit(2);
  }
  const outputDir = path.resolve(rawDir);
  const visualPlan = JSON.parse(fs.readFileSync(path.join(outputDir, 'visual-plan.json'), 'utf8'));

  const imgDir = path.join(outputDir, 'images');
  const bakDir = path.join(outputDir, 'images.bak');
  if (fs.existsSync(imgDir) && !fs.existsSync(bakDir)) {
    fs.renameSync(imgDir, bakDir);
    console.log(`[regen] backed up old images/ → images.bak/`);
  } else if (fs.existsSync(imgDir)) {
    // Remove fresh attempts so we start clean
    fs.rmSync(imgDir, { recursive: true, force: true });
    console.log('[regen] removed previous images/ (images.bak already exists)');
  }

  console.log(`[regen] generating ${visualPlan.beats.length} beats...`);
  const results = await images.generateAllBeats(visualPlan, outputDir);
  console.log(`[regen] done: ${results.length} beats rendered`);

  // Also regenerate thumbnail background
  console.log('[regen] regenerating thumbnail background...');
  const thumbBgOld = path.join(outputDir, 'thumbnail_bg.jpg');
  if (fs.existsSync(thumbBgOld)) fs.renameSync(thumbBgOld, path.join(outputDir, 'thumbnail_bg.bak.jpg'));
  const thumbRes = await images.generateThumbnail(visualPlan, outputDir);
  console.log(`[regen] thumbnail bg: ${thumbRes.bgPath || 'FAILED (use beat fallback at resume)'}`);
}

main().catch((err) => {
  console.error('[regen] FAILED:', err);
  process.exit(1);
});
