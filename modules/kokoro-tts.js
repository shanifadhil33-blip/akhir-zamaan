// modules/kokoro-tts.js
// Local Kokoro-82M TTS via a Python worker. No network, no API key, unlimited.
// Default voice: bm_george (deep British male, documentary tone).
// Renders WAV via kokoro_worker.py, then converts to MP3 with ffmpeg.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MODEL = path.join(REPO_ROOT, 'assets', 'kokoro', 'kokoro-v1.0.onnx');
const DEFAULT_VOICES = path.join(REPO_ROOT, 'assets', 'kokoro', 'voices-v1.0.bin');
const WORKER_SCRIPT = path.join(__dirname, 'kokoro_worker.py');

function resolvePython() {
  if (process.env.KOKORO_PYTHON && fs.existsSync(process.env.KOKORO_PYTHON)) {
    return process.env.KOKORO_PYTHON;
  }
  // Known Windows install path for this project
  const winPath = 'C:\\Users\\SMART ZONE\\AppData\\Local\\Python\\bin\\python.exe';
  if (fs.existsSync(winPath)) return winPath;
  // Fallback: hope 'python' is on PATH
  return 'python';
}

function runWorker(cfg) {
  return new Promise((resolve, reject) => {
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
      // Stream worker progress to our stderr so the user sees it live
      process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Kokoro worker exited with code ${code}. Stderr tail: ${stderr.slice(-500)}`));
      }
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`Kokoro worker returned non-JSON output. Stdout: ${stdout.slice(-300)}`));
      }
    });
    child.stdin.write(JSON.stringify(cfg));
    child.stdin.end();
  });
}

function wavToMp3(wavPath, mp3Path) {
  const r = spawnSync('ffmpeg', [
    '-y',
    '-i', wavPath,
    '-acodec', 'libmp3lame',
    '-b:a', '128k',
    '-ar', '24000',
    mp3Path,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg WAV→MP3 failed: ${(r.stderr || '').slice(-500)}`);
  }
}

async function synthesize({
  text,
  outputFile,
  voice = process.env.KOKORO_VOICE || 'bm_george',
  speed = parseFloat(process.env.KOKORO_SPEED || '0.82'),
  lang = process.env.KOKORO_LANG || 'en-gb',
  modelPath = DEFAULT_MODEL,
  voicesPath = DEFAULT_VOICES,
} = {}) {
  if (!text || !text.trim()) throw new Error('Kokoro TTS: empty text');
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Kokoro model missing: ${modelPath} — run the download step first`);
  }
  if (!fs.existsSync(voicesPath)) {
    throw new Error(`Kokoro voices missing: ${voicesPath}`);
  }

  const outDir = path.dirname(outputFile);
  fs.mkdirSync(outDir, { recursive: true });
  const wavOut = outputFile.replace(/\.mp3$/i, '.wav');

  const result = await runWorker({
    text,
    voice,
    speed,
    lang,
    modelPath,
    voicesPath,
    outputPath: wavOut,
  });

  if (!fs.existsSync(wavOut) || fs.statSync(wavOut).size < 1000) {
    throw new Error(`Kokoro worker wrote no/tiny WAV (${fs.existsSync(wavOut) ? fs.statSync(wavOut).size : 0} bytes)`);
  }

  // Convert WAV → MP3 for downstream pipeline (ffprobe, assembler, etc expect .mp3)
  if (outputFile.toLowerCase().endsWith('.mp3')) {
    wavToMp3(wavOut, outputFile);
    try { fs.unlinkSync(wavOut); } catch (_) {}
  }

  return {
    outputFile,
    voice: result.voice,
    durationSec: result.durationSec,
    sampleRate: result.sampleRate,
    spokenChars: result.spokenChars,
  };
}

module.exports = { synthesize };
