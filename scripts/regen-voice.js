// scripts/regen-voice.js
// Regenerates the voiceover + captions for an existing pipeline output folder,
// reusing script.json. Use after changing voiceover settings (provider, voice,
// sanitization rules).
//
// Usage:
//   node scripts/regen-voice.js "output/<folder>"

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const voiceover = require('../modules/voiceover');
const captions = require('../modules/captions');

async function main() {
  const rawDir = process.argv[2];
  if (!rawDir || !fs.existsSync(rawDir)) {
    console.error('Usage: node scripts/regen-voice.js <output-folder>');
    process.exit(2);
  }
  const outputDir = path.resolve(rawDir);
  const script = JSON.parse(fs.readFileSync(path.join(outputDir, 'script.json'), 'utf8'));

  // Back up existing voiceover so we can A/B
  for (const name of ['voiceover.mp3', 'voice-metadata.json']) {
    const src = path.join(outputDir, name);
    const bak = path.join(outputDir, name.replace(/(\.[^.]+)$/, '.bak$1'));
    if (fs.existsSync(src) && !fs.existsSync(bak)) {
      fs.renameSync(src, bak);
      console.log(`[regen-voice] backed up ${name} → ${path.basename(bak)}`);
    } else if (fs.existsSync(src)) {
      fs.unlinkSync(src);
    }
  }

  console.log('[regen-voice] rendering...');
  const voiceRes = await voiceover.generateVoiceover(script, outputDir);
  console.log(`[regen-voice] done: provider=${voiceRes.provider} voice=${voiceRes.voice} duration=${voiceRes.durationSec.toFixed(1)}s`);

  console.log('[regen-voice] rewriting captions from new word timings...');
  const capPaths = captions.writeCaptions(voiceRes.wordTimings, outputDir);
  console.log(`[regen-voice] captions: ${capPaths.srtPath}, ${capPaths.assPath}`);
}

main().catch((err) => {
  console.error('[regen-voice] FAILED:', err);
  process.exit(1);
});
