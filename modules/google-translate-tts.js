// modules/google-translate-tts.js
// Free TTS via Google Translate's public speech endpoint. No API key.
// Per-request limit ~200 chars, so we chunk aggressively and concat MP3s
// with FFmpeg. Throttled to avoid IP rate limiting.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawnSync } = require('child_process');

const GT_URL = 'https://translate.google.com/translate_tts';
const MAX_CHARS_PER_CHUNK = 190;
const THROTTLE_MS = 250;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function escapeFFConcatPath(p) {
  return p.replace(/\\/g, '/').replace(/'/g, `'\\''`);
}

function splitForChunks(text, maxLen = MAX_CHARS_PER_CHUNK) {
  // Translate doesn't do SSML — convert breaks to long ellipses for pause cue.
  let prepared = text.replace(/<break\s+time="?\d+ms"?\s*\/>/gi, ' ... ');
  prepared = prepared.replace(/\s+/g, ' ').trim();

  const out = [];
  // Split first on sentence boundaries, then on commas/semicolons for long sentences,
  // then on word boundaries as a last resort.
  const sentences = prepared.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (s.length <= maxLen) {
      out.push(s);
      continue;
    }
    const subs = s.split(/(?<=[,;:])\s+/);
    for (const sub of subs) {
      if (sub.length <= maxLen) { out.push(sub); continue; }
      const words = sub.split(/\s+/);
      let buf = '';
      for (const w of words) {
        if ((buf + ' ' + w).length > maxLen && buf) {
          out.push(buf);
          buf = w;
        } else {
          buf = buf ? `${buf} ${w}` : w;
        }
      }
      if (buf) out.push(buf);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

async function fetchChunk(text) {
  const resp = await axios.get(GT_URL, {
    params: {
      ie: 'UTF-8',
      q: text,
      tl: 'en',
      client: 'tw-ob',
      textlen: text.length,
    },
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Referer': 'https://translate.google.com/',
      'Accept': 'audio/mpeg,*/*',
    },
    validateStatus: (s) => s === 200,
  });
  if (!resp.data || resp.data.byteLength < 200) {
    throw new Error(`tiny response (${resp.data ? resp.data.byteLength : 0} bytes)`);
  }
  return Buffer.from(resp.data);
}

async function synthesize({ text, outputFile, maxAttempts = 5 }) {
  const tempDir = path.dirname(outputFile);
  const chunks = splitForChunks(text);
  if (!chunks.length) throw new Error('Google Translate TTS: empty text');
  console.log(`[gt-tts] split into ${chunks.length} chunks (~${MAX_CHARS_PER_CHUNK} chars each)`);

  const tmpFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    let buf;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        buf = await fetchChunk(chunks[i]);
        break;
      } catch (err) {
        lastErr = err;
        const status = err && err.response && err.response.status;
        const wait = Math.min(20000, 1500 * Math.pow(2, attempt - 1));
        console.warn(`[gt-tts] chunk ${i + 1}/${chunks.length} attempt ${attempt}/${maxAttempts} failed (${status || 'no-status'}: ${err.message}) — waiting ${wait}ms`);
        if (attempt < maxAttempts) await sleep(wait);
      }
    }
    if (!buf) throw new Error(`Google Translate chunk ${i + 1} failed after ${maxAttempts} attempts: ${lastErr && lastErr.message}`);
    const chunkPath = path.join(tempDir, `gt_chunk_${String(i).padStart(3, '0')}.mp3`);
    fs.writeFileSync(chunkPath, buf);
    tmpFiles.push(chunkPath);
    if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
      console.log(`[gt-tts] ${i + 1}/${chunks.length} chunks done`);
    }
    if (i < chunks.length - 1) await sleep(THROTTLE_MS);
  }

  const concatList = path.join(tempDir, 'gt_concat.txt');
  fs.writeFileSync(concatList, tmpFiles.map((f) => `file '${escapeFFConcatPath(path.resolve(f))}'`).join('\n'));

  const r = spawnSync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-acodec', 'libmp3lame',
    '-b:a', '128k',
    outputFile,
  ], { encoding: 'utf8' });

  if (r.status !== 0) {
    throw new Error(`Google Translate TTS concat failed: ${(r.stderr || '').slice(-500)}`);
  }

  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  try { fs.unlinkSync(concatList); } catch (_) {}

  return { outputFile, chunks: chunks.length };
}

module.exports = { synthesize, splitForChunks };
