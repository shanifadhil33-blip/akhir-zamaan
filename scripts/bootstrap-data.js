// scripts/bootstrap-data.js
// Downloads Quran + hadith data files if missing. Called by GitHub Actions workflow
// before pipeline runs, and available locally via `npm run bootstrap-data`.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QURAN_EN = path.join(DATA_DIR, 'quran-en-sahih.txt');
const QURAN_AR = path.join(DATA_DIR, 'quran-uthmani.txt');
const HADITH_DIR = path.join(DATA_DIR, 'hadith');

// Quran sources, tried in order. Each entry is { url, parser }.
// Primary: api.alquran.cloud — rock-solid public API, JSON shape: data.surahs[].ayahs[].text
// Fallbacks: fawazahmed0 mirrors and raw GitHub.
const QURAN_EN_SOURCES = [
  { url: 'https://api.alquran.cloud/v1/quran/en.sahih', parser: 'alquran_cloud' },
  { url: 'https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/eng-sahihinternational.json', parser: 'fawazahmed0_v1' },
  { url: 'https://cdn.jsdelivr.net/gh/fawazahmed0/quran_api@1/editions/eng-sahihinternational.json', parser: 'fawazahmed0_v1' },
  { url: 'https://raw.githubusercontent.com/fawazahmed0/quran-api/1/editions/eng-sahihinternational.json', parser: 'fawazahmed0_v1' },
];
const QURAN_AR_SOURCES = [
  { url: 'https://api.alquran.cloud/v1/quran/quran-uthmani', parser: 'alquran_cloud' },
  { url: 'https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/ara-quranuthmanihaf.json', parser: 'fawazahmed0_v1' },
  { url: 'https://raw.githubusercontent.com/fawazahmed0/quran-api/1/editions/ara-quranuthmanihaf.json', parser: 'fawazahmed0_v1' },
];

function downloadToBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AkhirZamaan-Bootstrap/1.0)',
        'Accept': 'application/json,text/plain,*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(downloadToBuffer(next, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Timeout')));
  });
}

function parseAlquranCloud(rawJson) {
  // Shape: { code: 200, data: { surahs: [{ number, ayahs: [{ numberInSurah, text }, ...] }, ...] } }
  const obj = JSON.parse(rawJson);
  const surahs = obj && obj.data && obj.data.surahs;
  if (!Array.isArray(surahs)) throw new Error('alquran.cloud: missing data.surahs');
  const lines = [];
  for (const s of surahs) {
    const c = s.number;
    if (!Array.isArray(s.ayahs)) continue;
    for (let i = 0; i < s.ayahs.length; i++) {
      const a = s.ayahs[i];
      const n = a.numberInSurah || (i + 1);
      const t = String(a.text || '').replace(/\s+/g, ' ').trim();
      if (!c || !n || !t) continue;
      lines.push(`${c}|${n}|${t}`);
    }
  }
  return lines;
}

function parseFawazahmed0V1(rawJson) {
  // Shape: { quran: [{ chapter, verse, text }, ...] }
  const obj = JSON.parse(rawJson);
  const list = obj.quran || obj.data || obj;
  if (!Array.isArray(list)) throw new Error('fawazahmed0: unexpected shape');
  const lines = [];
  for (const v of list) {
    const c = v.chapter || v.surah;
    const n = v.verse || v.ayah;
    const t = String(v.text || '').replace(/\s+/g, ' ').trim();
    if (!c || !n || !t) continue;
    lines.push(`${c}|${n}|${t}`);
  }
  return lines;
}

const PARSERS = {
  alquran_cloud: parseAlquranCloud,
  fawazahmed0_v1: parseFawazahmed0V1,
};

function linesToPipe(lines) {
  if (lines.length < 6000) throw new Error(`only ${lines.length} verses parsed (expected ~6236)`);
  return lines.join('\n') + '\n';
}

function validatePipeFormat(text) {
  const lines = text.split(/\r?\n/);
  let valid = 0;
  for (const line of lines) {
    if (/^\d+\|\d+\|\S/.test(line.trim())) valid++;
  }
  if (valid < 6000) throw new Error(`Pipe-format validation failed: only ${valid} valid lines`);
  return true;
}

async function fetchQuran(sources, outPath, label) {
  const errors = [];
  for (const src of sources) {
    try {
      console.log(`[bootstrap] ${label}: trying ${src.parser} @ ${src.url.slice(0, 80)}...`);
      const buf = await downloadToBuffer(src.url);
      const parser = PARSERS[src.parser];
      if (!parser) throw new Error(`unknown parser ${src.parser}`);
      const lines = parser(buf.toString('utf8'));
      const pipe = linesToPipe(lines);
      fs.writeFileSync(outPath, pipe, 'utf8');
      console.log(`[bootstrap] ${label}: saved ${fs.statSync(outPath).size} bytes via ${src.parser}`);
      return;
    } catch (e) {
      console.warn(`[bootstrap] ${label}: ${src.parser} failed:`, e.message);
      errors.push(`${src.parser}: ${e.message}`);
    }
  }
  throw new Error(`All sources failed for ${label}:\n  - ${errors.join('\n  - ')}`);
}

function isValidQuranFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  if (fs.statSync(filePath).size < 100000) return false;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    validatePipeFormat(text);
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureQuran() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (isValidQuranFile(QURAN_EN)) {
    console.log('[bootstrap] Quran EN already present and valid');
  } else {
    if (fs.existsSync(QURAN_EN)) fs.unlinkSync(QURAN_EN);
    await fetchQuran(QURAN_EN_SOURCES, QURAN_EN, 'Quran EN (Sahih International)');
  }

  if (isValidQuranFile(QURAN_AR)) {
    console.log('[bootstrap] Quran AR already present and valid');
  } else {
    if (fs.existsSync(QURAN_AR)) fs.unlinkSync(QURAN_AR);
    try {
      await fetchQuran(QURAN_AR_SOURCES, QURAN_AR, 'Quran AR (Uthmani)');
    } catch (e) {
      console.warn('[bootstrap] Arabic Quran download failed (non-fatal):', e.message);
    }
  }
}

function ensureHadith() {
  const collectionsDir = path.join(HADITH_DIR, 'editions');
  if (fs.existsSync(collectionsDir)) {
    const existing = fs.readdirSync(collectionsDir).filter((d) => d.startsWith('eng-'));
    if (existing.length >= 6) {
      console.log(`[bootstrap] hadith already present (${existing.length} collections)`);
      return;
    }
  }
  console.log('[bootstrap] cloning fawazahmed0/hadith-api...');
  if (fs.existsSync(HADITH_DIR)) fs.rmSync(HADITH_DIR, { recursive: true, force: true });
  const r = spawnSync('git', ['clone', '--depth', '1', 'https://github.com/fawazahmed0/hadith-api.git', HADITH_DIR], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('git clone of hadith-api failed');
  // Prune non-English editions to save space
  const editionsDir = path.join(HADITH_DIR, 'editions');
  if (fs.existsSync(editionsDir)) {
    for (const d of fs.readdirSync(editionsDir)) {
      if (!d.startsWith('eng-')) {
        fs.rmSync(path.join(editionsDir, d), { recursive: true, force: true });
      }
    }
  }
  console.log('[bootstrap] hadith ready');
}

(async () => {
  try {
    await ensureQuran();
    ensureHadith();
    console.log('[bootstrap] ALL DATA READY');
  } catch (err) {
    console.error('[bootstrap] FAILED:', err.message);
    process.exit(1);
  }
})();
