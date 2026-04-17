// modules/captions.js
// Builds .srt (YouTube upload) and .ass (FFmpeg burn-in) from Edge TTS word timings.

const fs = require('fs');
const path = require('path');

function msToSrtTimestamp(ms) {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function msToAssTimestamp(ms) {
  // ASS uses H:MM:SS.cc (centiseconds)
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const cents = Math.floor((totalMs % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(cents).padStart(2, '0')}`;
}

function chunkWords(words, wordsPerChunk = 4) {
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const slice = words.slice(i, i + wordsPerChunk);
    if (!slice.length) continue;
    const start = slice[0].offset_ms;
    const last = slice[slice.length - 1];
    const end = last.offset_ms + last.duration_ms;
    const text = slice.map((w) => w.text).join(' ');
    chunks.push({ start, end, text });
  }
  return chunks;
}

function buildSRT(words) {
  const chunks = chunkWords(words, 6);
  let out = '';
  chunks.forEach((c, i) => {
    out += `${i + 1}\n${msToSrtTimestamp(c.start)} --> ${msToSrtTimestamp(c.end)}\n${c.text}\n\n`;
  });
  return out;
}

function escapeAss(text) {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}

function buildASS(words) {
  // ASS header: Arial Black 68pt, white with thick black outline, bottom-third placement
  const header = `[Script Info]
Title: Akhir Zamaan Captions
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,68,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,5,2,2,80,80,160,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const chunks = chunkWords(words, 4);
  const lines = chunks.map((c) => {
    const upper = c.text.toUpperCase();
    return `Dialogue: 0,${msToAssTimestamp(c.start)},${msToAssTimestamp(c.end)},Default,,0,0,0,,${escapeAss(upper)}`;
  });

  return header + lines.join('\n') + '\n';
}

function writeCaptions(words, outputDir) {
  const srt = buildSRT(words);
  const ass = buildASS(words);
  const srtPath = path.join(outputDir, 'captions.srt');
  const assPath = path.join(outputDir, 'captions.ass');
  fs.writeFileSync(srtPath, srt, 'utf8');
  fs.writeFileSync(assPath, ass, 'utf8');
  return { srtPath, assPath };
}

module.exports = { writeCaptions, buildSRT, buildASS, chunkWords };
