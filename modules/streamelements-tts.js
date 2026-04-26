// modules/streamelements-tts.js
// Free TTS via StreamElements' undocumented Polly endpoint. No API key.
// Per-request char limit ~500, so we chunk at sentence boundaries and
// concat the resulting MP3 segments with FFmpeg.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawnSync } = require('child_process');

const SE_URL = 'https://api.streamelements.com/kappa/v2/speech';
const MAX_CHARS_PER_CHUNK = 480;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function escapeFFConcatPath(p) {
  const norm = p.replace(/\\/g, '/');
  return norm.replace(/'/g, `'\\''`);
}

function splitForChunks(text, maxLen = MAX_CHARS_PER_CHUNK) {
  // StreamElements doesn't do SSML — convert breaks into long ellipses so
  // the engine inserts a real pause.
  let prepared = text.replace(/<break\s+time="?(\d+)ms"?\s*\/>/gi, ' ... ');
  prepared = prepared.replace(/\s+/g, ' ').trim();

  const out = [];
  // Split on sentence terminators first; for over-long sentences, fall back to comma splits.
  const sentences = prepared.split(/(?<=[.!?])\s+/);
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxLen) {
      // Flush current
      if (cur) { out.push(cur.trim()); cur = ''; }
      // Split this monster on commas
      const sub = s.split(/(?<=,)\s+/);
      let buf = '';
      for (const piece of sub) {
        if ((buf + ' ' + piece).length > maxLen && buf) {
          out.push(buf.trim());
          buf = piece;
        } else {
          buf = buf ? `${buf} ${piece}` : piece;
        }
      }
      if (buf) out.push(buf.trim());
      continue;
    }
    if ((cur + ' ' + s).length > maxLen && cur) {
      out.push(cur.trim());
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) out.push(cur.trim());
  // Final hard cut for any chunk still too long (defensive)
  return out.flatMap((chunk) => {
    if (chunk.length <= maxLen) return [chunk];
    const pieces = [];
    for (let i = 0; i < chunk.length; i += maxLen) pieces.push(chunk.slice(i, i + maxLen));
    return pieces;
  });
}

async function fetchChunk(voice, text, attempt = 1) {
  const resp = await axios.get(SE_URL, {
    params: { voice, text },
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'audio/mpeg,*/*',
    },
    validateStatus: (s) => s === 200,
  });
  if (!resp.data || resp.data.byteLength < 500) {
    throw new Error(`StreamElements returned ${resp.data ? resp.data.byteLength : 0} bytes`);
  }
  return Buffer.from(resp.data);
}

async function synthesize({ voice = 'Brian', text, outputFile, maxAttempts = 5 }) {
  const tempDir = path.dirname(outputFile);
  const chunks = splitForChunks(text);
  if (!chunks.length) throw new Error('StreamElements TTS: empty text');

  const tmpFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    let buf;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        buf = await fetchChunk(voice, chunks[i], attempt);
        break;
      } catch (err) {
        lastErr = err;
        const status = err && err.response && err.response.status;
        const wait = Math.min(20000, 1500 * Math.pow(2, attempt - 1));
        console.warn(`[se-tts] chunk ${i + 1}/${chunks.length} attempt ${attempt}/${maxAttempts} failed (${status || 'no-status'}: ${err.message}) — waiting ${wait}ms`);
        if (attempt < maxAttempts) await sleep(wait);
      }
    }
    if (!buf) throw new Error(`StreamElements chunk ${i + 1} failed after ${maxAttempts} attempts: ${lastErr && lastErr.message}`);
    const chunkPath = path.join(tempDir, `se_chunk_${String(i).padStart(3, '0')}.mp3`);
    fs.writeFileSync(chunkPath, buf);
    tmpFiles.push(chunkPath);
    console.log(`[se-tts] chunk ${i + 1}/${chunks.length} ✓ (${buf.length} bytes)`);
  }

  const concatList = path.join(tempDir, 'se_concat.txt');
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
    throw new Error(`StreamElements TTS concat failed: ${(r.stderr || '').slice(-500)}`);
  }

  // Cleanup temp chunks
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  try { fs.unlinkSync(concatList); } catch (_) {}

  return { outputFile, chunks: chunks.length };
}

module.exports = { synthesize, splitForChunks };
