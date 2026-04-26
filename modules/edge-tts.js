// modules/edge-tts.js
// Direct Edge TTS WebSocket client with Sec-MS-GEC auth.
//
// The msedge-tts npm package (v1.3.4, unmaintained) doesn't send the
// Sec-MS-GEC token Microsoft now requires, so its WebSocket gets dropped
// before any audio is sent. This module implements the same protocol the
// Python `edge-tts` package uses, with proper auth.

const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-130.0.2849.68';
const WIN_EPOCH_SEC = 11644473600n;
const CHROMIUM_FULL_VERSION = '130.0.2849.68';

// Microsoft validates the Sec-MS-GEC token against THEIR clock. Windows boxes
// commonly have ±minutes of drift; a single 403 burns the request. So we track
// observed clock skew and adjust on every token regen.
let CLOCK_SKEW_SEC = 0;

function setClockSkewFromServerDate(dateHeader) {
  if (!dateHeader) return;
  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) return;
  const serverSec = Math.floor(serverMs / 1000);
  const clientSec = Math.floor(Date.now() / 1000);
  CLOCK_SKEW_SEC = serverSec - clientSec;
}

function generateSecMsGec() {
  const adjustedSec = Math.floor(Date.now() / 1000) + CLOCK_SKEW_SEC;
  const nowSec = BigInt(adjustedSec) + WIN_EPOCH_SEC;
  const rounded = nowSec - (nowSec % 300n);
  const ticks = rounded * 10000000n;
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

function buildConnectUrl() {
  const token = generateSecMsGec();
  const connectionId = crypto.randomUUID().replace(/-/g, '');
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
}

function nowIso() {
  return new Date().toISOString().replace('Z', '+00:00');
}

function escapeSSML(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildSSML(voice, text) {
  // Preserve <break .../> tags, escape everything else.
  const parts = text.split(/(<break\s+time="?\d+ms"?\s*\/>)/i);
  const body = parts.map((p, i) => i % 2 === 0 ? escapeSSML(p) : p).join('');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
    `<voice name="${voice}">` +
    `<prosody pitch="+0Hz" rate="+0%" volume="+0%">${body}</prosody>` +
    `</voice>` +
    `</speak>`;
}

function buildConfigMessage() {
  const ts = nowIso();
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: 'false',
            wordBoundaryEnabled: 'false',
          },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        },
      },
    },
  });
  return `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${body}`;
}

function buildSSMLMessage(requestId, ssml) {
  const ts = nowIso();
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`;
}

async function synthesizeChunk({ voice, text, timeoutMs = 90000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildConnectUrl(), {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
      },
    });

    const chunks = [];
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); try { ws.close(); } catch (_) {} fn(arg); } };
    const timer = setTimeout(() => finish(reject, new Error(`Edge TTS timeout after ${timeoutMs}ms`)), timeoutMs);

    ws.on('open', () => {
      try {
        ws.send(buildConfigMessage());
        const requestId = crypto.randomUUID().replace(/-/g, '');
        ws.send(buildSSMLMessage(requestId, buildSSML(voice, text)));
      } catch (err) {
        finish(reject, new Error(`Edge TTS send failed: ${err.message || err}`));
      }
    });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          // Binary frame: 2-byte BE header length, then header text, then audio bytes.
          if (data.length < 2) return;
          const headerLen = data.readUInt16BE(0);
          if (data.length < 2 + headerLen) return;
          const audio = data.slice(2 + headerLen);
          if (audio.length > 0) chunks.push(audio);
        } else {
          const text = data.toString('utf8');
          if (/Path:\s*turn\.end/i.test(text)) {
            if (chunks.length === 0) {
              return finish(reject, new Error('Edge TTS turn.end with no audio'));
            }
            finish(resolve, Buffer.concat(chunks));
          }
        }
      } catch (err) {
        finish(reject, new Error(`Edge TTS message handler: ${err.message || err}`));
      }
    });

    ws.on('unexpected-response', (req, res) => {
      const status = res.statusCode;
      const dateHeader = res.headers && res.headers.date;
      if (status === 403 && dateHeader) {
        const oldSkew = CLOCK_SKEW_SEC;
        setClockSkewFromServerDate(dateHeader);
        console.warn(`[edge-tts] HTTP 403; adjusted clock skew ${oldSkew}s -> ${CLOCK_SKEW_SEC}s (server Date: ${dateHeader})`);
      }
      // Drain to avoid socket hang; ws will not emit 'close' for upgrade rejection.
      res.resume();
      finish(reject, new Error(`Edge TTS HTTP ${status} on upgrade${dateHeader ? ` (server Date: ${dateHeader})` : ''}`));
    });

    ws.on('error', (err) => {
      finish(reject, new Error(`Edge TTS WebSocket error: ${(err && err.message) || JSON.stringify(err)}`));
    });

    ws.on('close', (code, reason) => {
      if (settled) return;
      const reasonStr = reason ? reason.toString() : '';
      finish(reject, new Error(`Edge TTS closed without audio (code=${code}${reasonStr ? `, reason="${reasonStr}"` : ''})`));
    });
  });
}

function splitTextForChunks(text, maxChars = 5000) {
  // Split on sentence boundaries to keep prosody natural; keep <break/> tags
  // attached to the sentence they follow.
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur.trim());
  return chunks;
}

async function synthesize({ voice, text, outputFile, maxAttempts = 5 }) {
  const chunkTexts = splitTextForChunks(text);
  const audioParts = [];
  for (let ci = 0; ci < chunkTexts.length; ci++) {
    const chunk = chunkTexts[ci];
    let lastErr;
    let buf;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        buf = await synthesizeChunk({ voice, text: chunk });
        break;
      } catch (err) {
        lastErr = err;
        const backoff = Math.min(30000, 1500 * Math.pow(2, attempt - 1));
        console.warn(`[edge-tts] chunk ${ci + 1}/${chunkTexts.length} attempt ${attempt}/${maxAttempts} failed: ${err.message} — retrying in ${backoff}ms`);
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoff));
      }
    }
    if (!buf) throw new Error(`Edge TTS failed after ${maxAttempts} attempts: ${lastErr && lastErr.message}`);
    audioParts.push(buf);
  }
  const final = Buffer.concat(audioParts);
  fs.writeFileSync(outputFile, final);
  return { outputFile, bytes: final.length, chunks: chunkTexts.length };
}

module.exports = { synthesize, generateSecMsGec };
