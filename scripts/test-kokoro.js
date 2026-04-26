// Renders a Lewis sample with Islamic honorifics expanded so the user can
// confirm the TTS speaks "sallallahu alayhi wa sallam" after Prophet ﷺ.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const kokoro = require('../modules/kokoro-tts');
const { combineScript } = require('../modules/voiceover');

// Mock script object — combineScript handles honorific expansion + [PAUSE] tags.
const mockScript = {
  cold_open: `They said the end of the world would look like fire. [PAUSE] But what if it already arrived, and you didn't notice?`,
  naming: `The Prophet ﷺ warned of a day when knowledge would disappear, and trials would descend like pieces of a dark night. [PAUSE] He didn't mean tomorrow. He meant now.`,
  excavation: `Ibrahim (AS) once stood alone against an empire of idols. [PAUSE] His son Ismail (AS) walked into the desert with him, trusting a command none of us could carry today.`,
  mirror: `So ask yourself one question, before you pick up your phone tomorrow: would the man you are becoming recognize the boy you used to be?`,
};

(async () => {
  const outDir = path.join(__dirname, '..', 'output', '_kokoro_samples');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'bm_lewis_with_honorifics.mp3');

  const text = combineScript(mockScript);
  console.log('--- text after honorific expansion ---');
  console.log(text);
  console.log('--------------------------------------');

  const t0 = Date.now();
  const res = await kokoro.synthesize({
    text,
    outputFile: out,
    voice: 'bm_lewis',
  });
  console.log(`\n✓ ${res.durationSec.toFixed(1)}s audio rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  file: ${out}`);
})().catch((err) => {
  console.error('\n✗ FAIL:', err.message);
  process.exit(1);
});
