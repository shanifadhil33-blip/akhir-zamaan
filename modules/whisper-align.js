// modules/whisper-align.js
// Bridges Node ↔ Python faster-whisper for word-level forced alignment.
// Used after the TTS provider renders the voiceover MP3 — Whisper reads
// the actual audio and reports the real start/end timestamps of every
// word, replacing the proportional estimation in voiceover.js.
//
// Result: captions become frame-perfect aligned with the narrator, even
// when Kokoro stresses certain words longer than others (which is what
// caused the visible drift on the first finished video).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKER_SCRIPT = path.join(__dirname, 'whisper_worker.py');

function resolvePython() {
  // Use the same Python interpreter the Kokoro worker uses — they share
  // the requirements.txt that we install on the runner.
  if (process.env.KOKORO_PYTHON && fs.existsSync(process.env.KOKORO_PYTHON)) {
    return process.env.KOKORO_PYTHON;
  }
  if (process.env.WHISPER_PYTHON && fs.existsSync(process.env.WHISPER_PYTHON)) {
    return process.env.WHISPER_PYTHON;
  }
  const winPath = 'C:\\Users\\SMART ZONE\\AppData\\Local\\Python\\bin\\python.exe';
  if (fs.existsSync(winPath)) return winPath;
  return 'python';
}

/**
 * Run faster-whisper word-level alignment on an audio file.
 * Returns { words: [...], duration_sec: number } where each word has
 * { text, start_ms, end_ms }. Throws on worker failure — the caller
 * is responsible for falling back to estimated timings if needed.
 */
function alignAudio(audioPath, { model = 'base.en', language = 'en' } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(audioPath)) {
      return reject(new Error(`Whisper alignment: audio file not found at ${audioPath}`));
    }
    const py = resolvePython();
    const child = spawn(py, [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => {
      const s = b.toString('utf8');
      stderr += s;
      // Stream worker progress live so the workflow logs show whisper status
      process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Whisper worker exited with code ${code}. Stderr tail: ${stderr.slice(-500)}`));
      }
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
        const parsed = JSON.parse(line);
        if (!parsed.words || !Array.isArray(parsed.words)) {
          return reject(new Error(`Whisper worker output missing words array. Stdout: ${stdout.slice(-300)}`));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Whisper worker returned non-JSON output. Stdout: ${stdout.slice(-300)}`));
      }
    });
    child.stdin.write(JSON.stringify({
      audioPath,
      model,
      language,
    }));
    child.stdin.end();
  });
}

/**
 * Convert Whisper's { text, start_ms, end_ms } records into the
 * { text, offset_ms, duration_ms } shape that captions.js consumes.
 */
function toCaptionTimings(whisperWords) {
  return whisperWords.map((w) => ({
    text: w.text,
    offset_ms: Math.max(0, w.start_ms),
    duration_ms: Math.max(40, w.end_ms - w.start_ms),
  }));
}

module.exports = { alignAudio, toCaptionTimings };
