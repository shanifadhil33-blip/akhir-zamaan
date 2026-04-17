// scripts/bootstrap-data.js
// Downloads Quran + hadith data files if missing. Called by GitHub Actions workflow
// before pipeline runs, and available locally via `npm run bootstrap-data`.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QURAN_EN = path.join(DATA_DIR, 'quran-en-sahih.txt');
const QURAN_AR = path.join(DATA_DIR, 'quran-uthmani.txt');
const HADITH_DIR = path.join(DATA_DIR, 'hadith');

// Tanzil mirrors (plaintext, pipe-separated: chapter|verse|text)
const QURAN_EN_URL = 'https://tanzil.net/pub/download/index.php?quranType=translation&translation=en.sahih&marks=false&sajdah=false&rubElhizb=false&pageMarker=false&suraHeader=false&outType=txt&lastLineInSura=false&lastLineInQuran=false';
const QURAN_AR_URL = 'https://tanzil.net/pub/download/index.php?quranType=uthmani&marks=true&sajdah=true&rubElhizb=false&pageMarker=false&suraHeader=false&outType=txt&lastLineInSura=false&lastLineInQuran=false';

// Fallback mirrors (simpler, always available)
const QURAN_EN_FALLBACK = 'https://raw.githubusercontent.com/risan/quran-json/main/data/en.sahih.txt';

function download(url, outPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'AkhirZamaan-Bootstrap/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, outPath, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout')));
  });
}

async function ensureQuran() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(QURAN_EN) || fs.statSync(QURAN_EN).size < 10000) {
    console.log('[bootstrap] downloading Sahih International English Quran...');
    try {
      await download(QURAN_EN_URL, QURAN_EN);
    } catch (e) {
      console.warn('[bootstrap] tanzil failed, trying fallback:', e.message);
      await download(QURAN_EN_FALLBACK, QURAN_EN);
    }
    console.log(`[bootstrap] saved ${QURAN_EN} (${fs.statSync(QURAN_EN).size} bytes)`);
  } else {
    console.log('[bootstrap] Quran EN already present');
  }

  if (!fs.existsSync(QURAN_AR) || fs.statSync(QURAN_AR).size < 10000) {
    console.log('[bootstrap] downloading Uthmani Arabic Quran...');
    try {
      await download(QURAN_AR_URL, QURAN_AR);
      console.log(`[bootstrap] saved ${QURAN_AR}`);
    } catch (e) {
      console.warn('[bootstrap] Arabic Quran download failed (non-fatal):', e.message);
    }
  } else {
    console.log('[bootstrap] Quran AR already present');
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
