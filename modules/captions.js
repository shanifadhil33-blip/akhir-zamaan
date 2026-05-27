// modules/captions.js
// Builds .srt (YouTube upload) and .ass (FFmpeg burn-in) from Edge TTS word timings.

const fs = require('fs');
const path = require('path');

// Whisper's word_timestamps come from DTW over cross-attention weights; the
// detected onset is biased ~200-300ms LATER than the actual phoneme. Result:
// captions appear visibly behind the voiceover. Shift every chunk earlier by
// CAPTION_LEAD_MS to compensate. Both start and end are shifted by the same
// amount — the chunk's on-screen duration stays the same, it just lands at
// the right moment. Override via env if your TTS has a different bias.
const CAPTION_LEAD_MS = parseInt(process.env.CAPTION_LEAD_MS, 10) || 280;

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
    const rawStart = slice[0].offset_ms;
    const last = slice[slice.length - 1];
    const rawEnd = last.offset_ms + last.duration_ms;
    // Shift earlier to undo Whisper's onset-detection lag (see CAPTION_LEAD_MS).
    // clamp start at 0; keep at least a 200ms visible duration so a chunk
    // that started near t=0 doesn't collapse.
    const start = Math.max(0, rawStart - CAPTION_LEAD_MS);
    const end = Math.max(start + 200, rawEnd - CAPTION_LEAD_MS);
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
  // Styling philosophy: clean documentary look, NOT YouTube-meme look.
  //  - Font: Roboto Condensed Bold (sharp, modern, slightly compressed)
  //          installed via fonts-roboto in the workflow
  //  - Size: 52pt at 1080p — readable on phones without dominating the frame
  //          (started at 44pt which felt small on small screens; 68pt was the
  //          opposite extreme. 52pt is the comfortable middle.)
  //  - Color: pure white #FFFFFF
  //  - Outline: 2px black for legibility against any background at the new size
  //  - Shadow: subtle 1px drop for depth
  //  - Spacing: +1 px between letters (looks tighter, more editorial)
  //  - 5 words per chunk — at 52pt this still fits on one line within the
  //    1680px text area (1920 − 2×120 margin), no wrapping
  //  - Sentence case (not ALL CAPS) — looks calmer, more cinematic
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
Style: Default,Roboto Condensed,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,1,0,1,2,1,2,120,120,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // 5 words per chunk feels natural and readable at the new size
  const chunks = chunkWords(words, 5);
  const lines = chunks.map((c) => {
    // Keep original case — sentence case reads as cinematic, not shouty
    return `Dialogue: 0,${msToAssTimestamp(c.start)},${msToAssTimestamp(c.end)},Default,,0,0,0,,${escapeAss(c.text)}`;
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
