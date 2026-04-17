// modules/voiceover.js
// Edge TTS voiceover with word-level timings for caption sync.

const fs = require('fs');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

function combineScript(script) {
  // Combine all five movements in order. Strip excessive whitespace, normalize line breaks.
  const parts = [
    script.cold_open,
    script.naming,
    script.excavation,
    script.mirror,
    script.haunting,
  ].filter(Boolean);
  let combined = parts.join('\n\n');
  // Replace [PAUSE] markers with SSML breaks
  combined = combined.replace(/\[PAUSE\]/gi, '<break time="700ms"/>');
  // Light prosody only: no pitch/rate manipulation, just preserved pauses.
  combined = combined.replace(/\s+/g, ' ').trim();
  return combined;
}

function buildSSML({ voice, text }) {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // restore the break tags we just escaped
    .replace(/&lt;break time=&quot;700ms&quot;\/&gt;/g, '<break time="700ms"/>')
    .replace(/&lt;break time="700ms"\/&gt;/g, '<break time="700ms"/>');
  return `<speak version="1.0" xml:lang="en-US"><voice name="${voice}">${safe}</voice></speak>`;
}

async function generateVoiceover(script, outputDir) {
  const voice = process.env.VOICE_NAME || 'en-GB-RyanNeural';
  const outFile = path.join(outputDir, 'voiceover.mp3');
  const metaFile = path.join(outputDir, 'voice-metadata.json');

  const text = combineScript(script);

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  // Reset existing files
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  // toFile returns a promise that resolves with metadata including word boundaries
  const result = await tts.toFile(outFile, text);

  // Word boundaries: result.metadata is an array of WordBoundary events
  // Each: { Type: 'WordBoundary', Data: { Offset, Duration, text: { Text, Length, BoundaryType } } }
  const words = [];
  if (Array.isArray(result.metadata)) {
    for (const ev of result.metadata) {
      if (!ev || !ev.Data) continue;
      const offset = ev.Data.Offset; // in 100-nanosecond units (HNS)
      const duration = ev.Data.Duration; // HNS
      const wordText = ev.Data.text && ev.Data.text.Text;
      if (typeof offset !== 'number' || typeof duration !== 'number' || !wordText) continue;
      words.push({
        text: wordText,
        offset_ms: Math.round(offset / 10000),
        duration_ms: Math.round(duration / 10000),
      });
    }
  }

  fs.writeFileSync(metaFile, JSON.stringify({ voice, word_count: words.length, words }, null, 2));

  return {
    audioPath: outFile,
    metadataPath: metaFile,
    wordTimings: words,
    voice,
  };
}

module.exports = { generateVoiceover, combineScript };
