// modules/voiceover.js
// Edge TTS voiceover. msedge-tts hard-disables word boundaries, so we estimate
// per-word timings from the rendered audio duration via ffprobe, distributing
// time by character length (longer words take longer to say).

const fs = require('fs');
const path = require('path');
const edgeTts = require('./edge-tts');
const seTts = require('./streamelements-tts');
const gtTts = require('./google-translate-tts');
const kokoro = require('./kokoro-tts');
const { ffprobeDuration } = require('./assembler');

// Voice mapping per provider. Kokoro-82M (local, unlimited, no API) is the
// primary — deep British male documentary voice. Every fallback MUST be male
// (channel identity depends on it). google_translate is NOT in the chain
// because it only exposes a female default-en voice.
const VOICE_BY_PROVIDER = {
  kokoro: process.env.KOKORO_VOICE || 'bm_george',
  streamelements: process.env.SE_VOICE || 'Brian',                  // male
  edge: process.env.EDGE_VOICE || 'en-GB-RyanNeural',               // male
};

// 1500ms = a ~1.5-second beat of silence. Long enough to feel cinematic
// after a punch line; short enough that a script with many [PAUSE] markers
// doesn't drag. Combined with the script-engine prompt asking for [PAUSE]
// every 2-4 sentences in dramatic moments, the voiceover gets real pacing.
const BREAK_MS = 1500;
const BREAK_TAG_RE = /<break\s+time="?\d+ms"?\s*\/>/gi;

// Islamic honorifics: most TTS engines either skip these glyphs or mispronounce
// the parenthetical short forms. Expand to romanized speech BEFORE TTS so the
// reverence is actually heard in the audio. Order matters: longer matches first.
// NOTE: operator decision May 2026 — replace "Allah" with "God" for the audio.
// Kokoro pronounces "Allah" flat as "Alah" (no guttural stop). For an English
// narration aimed at an English-speaking audience, "God" reads cleaner. The
// ﷻ honorific is dropped at the same time so we never get "God jalla jalaaluhu".
// Captions read the same processed text, so they say "God" too — voice + caps in sync.
const HONORIFIC_REPLACEMENTS = [
  // "Allah" → "God" — MUST run before the ﷻ expansion below so the Allah+ﷻ
  // pair is converted as a single token instead of expanding the honorific.
  [/Allah\s*ﷻ/g, 'God'],
  [/\bAllah\b/g, 'God'],
  // Arabic-script honorific glyphs
  [/\u0635\u0644\u0649\s?\u0627\u0644\u0644\u0647\s?\u0639\u0644\u064A\u0647\s?\u0648\u0633\u0644\u0645/g, ' sallallahu alayhi wa sallam '], // ﷺ literal expansion if pasted as text
  [/\uFDFA/g, ' sallallahu alayhi wa sallam '], // ﷺ
  [/\uFDFB/g, ''], // \uFDFB \u2014 drop standalone (Allah \uFDFB already handled by the pair regex above)             // ﷻ
  [/\uFDFD/g, ' bismillahir rahmanir raheem '], // ﷽
  // English parenthetical short forms (all case-insensitive, with optional dots)
  [/\(\s*(?:s\.?a\.?w\.?|saw|pbuh|p\.b\.u\.h\.?)\s*\)/gi, ' sallallahu alayhi wa sallam '],
  [/\(\s*(?:a\.?s\.?|as)\s*\)/gi, ' alayhis salaam '],
  [/\(\s*(?:r\.?a\.?|ra)\s*\)/gi, ' radiallahu anhu '],
  [/\(\s*(?:swt|s\.w\.t\.?)\s*\)/gi, ' subhanahu wa ta\'ala '],
];

function expandHonorifics(text) {
  let out = text;
  for (const [re, replacement] of HONORIFIC_REPLACEMENTS) {
    out = out.replace(re, replacement);
  }
  return out;
}

// Normalises characters that crash espeak-ng (Kokoro's phonemizer) or that
// TTS engines read aloud as "unicode-hex" noise. Must run AFTER honorific
// expansion but BEFORE the text is sent to TTS.
function sanitizeForTTS(text) {
  return text
    // Smart quotes → plain ASCII
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Em/en dashes, hyphen variants, minus sign → plain hyphen
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    // Ellipsis → three dots
    .replace(/\u2026/g, '...')
    // Non-breaking spaces, narrow NBSP → plain space
    .replace(/[\u00A0\u202F\u2009]/g, ' ')
    // Zero-width joiners, non-joiners, BOM, directional marks
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    // Soft hyphen
    .replace(/\u00AD/g, '')
    // Any remaining non-ASCII letter the LLM snuck in (Arabic, CJK, emoji)
    // — strip so espeak never chokes. Kept digits and common punctuation.
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function combineScript(script) {
  const parts = [
    script.cold_open,
    script.naming,
    script.excavation,
    script.mirror,
    script.haunting,
  ].filter(Boolean);
  let combined = parts.join('\n\n');
  combined = expandHonorifics(combined);
  combined = combined.replace(/\[PAUSE\]/gi, '<break time="700ms"/>');
  combined = sanitizeForTTS(combined);
  return combined;
}

function estimateWordTimings(text, audioDurationSec) {
  // Split text into tokens: words AND <break/> placeholders, preserving order.
  const tokens = [];
  let i = 0;
  const s = text;
  const breakRe = /<break\s+time="?\d+ms"?\s*\/>/i;
  while (i < s.length) {
    const rest = s.slice(i);
    const bm = rest.match(breakRe);
    if (bm && bm.index !== undefined) {
      // Add word tokens before the break
      const before = rest.slice(0, bm.index);
      for (const w of before.split(/\s+/).filter(Boolean)) tokens.push({ kind: 'word', text: w });
      tokens.push({ kind: 'break' });
      i += bm.index + bm[0].length;
    } else {
      for (const w of rest.split(/\s+/).filter(Boolean)) tokens.push({ kind: 'word', text: w });
      break;
    }
  }

  const breakCount = tokens.filter((t) => t.kind === 'break').length;
  const words = tokens.filter((t) => t.kind === 'word');
  if (!words.length) return [];

  const breakTimeSec = breakCount * (BREAK_MS / 1000);
  const speakingSec = Math.max(0.001, audioDurationSec - breakTimeSec);
  const totalChars = words.reduce((sum, w) => sum + Math.max(1, w.text.length), 0);
  const msPerChar = (speakingSec * 1000) / totalChars;

  const timings = [];
  let cursorMs = 0;
  for (const tok of tokens) {
    if (tok.kind === 'break') {
      cursorMs += BREAK_MS;
      continue;
    }
    const chars = Math.max(1, tok.text.length);
    const durMs = Math.max(60, Math.round(chars * msPerChar));
    timings.push({ text: tok.text, offset_ms: cursorMs, duration_ms: durMs });
    cursorMs += durMs;
  }
  return timings;
}

async function tryProvider(provider, text, outFile) {
  const voice = VOICE_BY_PROVIDER[provider];
  if (provider === 'kokoro') {
    await kokoro.synthesize({ voice, text, outputFile: outFile });
  } else if (provider === 'streamelements') {
    await seTts.synthesize({ voice, text, outputFile: outFile });
  } else if (provider === 'edge') {
    await edgeTts.synthesize({ voice, text, outputFile: outFile });
  } else {
    throw new Error(`Unknown TTS provider: ${provider}`);
  }
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) {
    throw new Error(`TTS produced empty/tiny file (${fs.existsSync(outFile) ? fs.statSync(outFile).size : 0} bytes)`);
  }
  return voice;
}

async function generateVoiceover(script, outputDir) {
  const outFile = path.join(outputDir, 'voiceover.mp3');
  const metaFile = path.join(outputDir, 'voice-metadata.json');

  const text = combineScript(script);

  // Provider order: TTS_PROVIDER env wins, otherwise kokoro -> streamelements -> edge.
  // Every provider in this chain MUST produce a male British/American documentary
  // voice. google_translate was removed because its only voice is female default-en.
  // google_cloud was removed when the project dropped all Google Cloud dependencies.
  const requested = (process.env.TTS_PROVIDER || '').toLowerCase().trim();
  const order = requested
    ? [requested]
    : ['kokoro', 'streamelements', 'edge'];

  let usedProvider, usedVoice;
  let lastErr;
  for (const provider of order) {
    try {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      console.log(`[voiceover] trying provider: ${provider}`);
      usedVoice = await tryProvider(provider, text, outFile);
      usedProvider = provider;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[voiceover] provider ${provider} failed: ${err.message}`);
    }
  }
  if (!usedProvider) {
    throw new Error(`All TTS providers failed. Last error: ${lastErr && lastErr.message}`);
  }
  console.log(`[voiceover] used ${usedProvider} (${usedVoice})`);

  const durationSec = ffprobeDuration(outFile);
  const wordTimings = estimateWordTimings(text, durationSec);

  fs.writeFileSync(metaFile, JSON.stringify({
    provider: usedProvider,
    voice: usedVoice,
    duration_sec: durationSec,
    word_count: wordTimings.length,
    estimated: true,
    words: wordTimings,
  }, null, 2));

  return {
    audioPath: outFile,
    metadataPath: metaFile,
    wordTimings,
    voice: usedVoice,
    provider: usedProvider,
    durationSec,
  };
}

module.exports = { generateVoiceover, combineScript, estimateWordTimings };
