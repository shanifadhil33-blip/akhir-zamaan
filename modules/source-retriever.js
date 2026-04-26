// modules/source-retriever.js
// Reads Quran + hadith from local files. No network. No API keys.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QURAN_EN_PATH = path.join(DATA_DIR, 'quran-en-sahih.txt');
const QURAN_AR_PATH = path.join(DATA_DIR, 'quran-uthmani.txt');
const HADITH_DIR = path.join(DATA_DIR, 'hadith', 'editions');

// 114 surahs metadata (name in Arabic transliteration, English meaning, verse count, place)
const SURAH_INFO = [
  { num: 1, name: 'Al-Fatiha', english: 'The Opening', verses: 7, place: 'Meccan' },
  { num: 2, name: 'Al-Baqarah', english: 'The Cow', verses: 286, place: 'Medinan' },
  { num: 3, name: 'Aal-Imran', english: 'Family of Imran', verses: 200, place: 'Medinan' },
  { num: 4, name: 'An-Nisa', english: 'The Women', verses: 176, place: 'Medinan' },
  { num: 5, name: 'Al-Maidah', english: 'The Table Spread', verses: 120, place: 'Medinan' },
  { num: 6, name: 'Al-Anam', english: 'The Cattle', verses: 165, place: 'Meccan' },
  { num: 7, name: 'Al-Araf', english: 'The Heights', verses: 206, place: 'Meccan' },
  { num: 8, name: 'Al-Anfal', english: 'The Spoils of War', verses: 75, place: 'Medinan' },
  { num: 9, name: 'At-Tawbah', english: 'The Repentance', verses: 129, place: 'Medinan' },
  { num: 10, name: 'Yunus', english: 'Jonah', verses: 109, place: 'Meccan' },
  { num: 11, name: 'Hud', english: 'Hud', verses: 123, place: 'Meccan' },
  { num: 12, name: 'Yusuf', english: 'Joseph', verses: 111, place: 'Meccan' },
  { num: 13, name: 'Ar-Rad', english: 'The Thunder', verses: 43, place: 'Medinan' },
  { num: 14, name: 'Ibrahim', english: 'Abraham', verses: 52, place: 'Meccan' },
  { num: 15, name: 'Al-Hijr', english: 'The Rocky Tract', verses: 99, place: 'Meccan' },
  { num: 16, name: 'An-Nahl', english: 'The Bee', verses: 128, place: 'Meccan' },
  { num: 17, name: 'Al-Isra', english: 'The Night Journey', verses: 111, place: 'Meccan' },
  { num: 18, name: 'Al-Kahf', english: 'The Cave', verses: 110, place: 'Meccan' },
  { num: 19, name: 'Maryam', english: 'Mary', verses: 98, place: 'Meccan' },
  { num: 20, name: 'Ta-Ha', english: 'Ta-Ha', verses: 135, place: 'Meccan' },
  { num: 21, name: 'Al-Anbiya', english: 'The Prophets', verses: 112, place: 'Meccan' },
  { num: 22, name: 'Al-Hajj', english: 'The Pilgrimage', verses: 78, place: 'Medinan' },
  { num: 23, name: 'Al-Muminun', english: 'The Believers', verses: 118, place: 'Meccan' },
  { num: 24, name: 'An-Nur', english: 'The Light', verses: 64, place: 'Medinan' },
  { num: 25, name: 'Al-Furqan', english: 'The Criterion', verses: 77, place: 'Meccan' },
  { num: 26, name: 'Ash-Shuara', english: 'The Poets', verses: 227, place: 'Meccan' },
  { num: 27, name: 'An-Naml', english: 'The Ant', verses: 93, place: 'Meccan' },
  { num: 28, name: 'Al-Qasas', english: 'The Stories', verses: 88, place: 'Meccan' },
  { num: 29, name: 'Al-Ankabut', english: 'The Spider', verses: 69, place: 'Meccan' },
  { num: 30, name: 'Ar-Rum', english: 'The Romans', verses: 60, place: 'Meccan' },
  { num: 31, name: 'Luqman', english: 'Luqman', verses: 34, place: 'Meccan' },
  { num: 32, name: 'As-Sajdah', english: 'The Prostration', verses: 30, place: 'Meccan' },
  { num: 33, name: 'Al-Ahzab', english: 'The Confederates', verses: 73, place: 'Medinan' },
  { num: 34, name: 'Saba', english: 'Sheba', verses: 54, place: 'Meccan' },
  { num: 35, name: 'Fatir', english: 'The Originator', verses: 45, place: 'Meccan' },
  { num: 36, name: 'Ya-Sin', english: 'Ya-Sin', verses: 83, place: 'Meccan' },
  { num: 37, name: 'As-Saffat', english: 'Those Who Set The Ranks', verses: 182, place: 'Meccan' },
  { num: 38, name: 'Sad', english: 'Sad', verses: 88, place: 'Meccan' },
  { num: 39, name: 'Az-Zumar', english: 'The Troops', verses: 75, place: 'Meccan' },
  { num: 40, name: 'Ghafir', english: 'The Forgiver', verses: 85, place: 'Meccan' },
  { num: 41, name: 'Fussilat', english: 'Explained In Detail', verses: 54, place: 'Meccan' },
  { num: 42, name: 'Ash-Shura', english: 'The Consultation', verses: 53, place: 'Meccan' },
  { num: 43, name: 'Az-Zukhruf', english: 'The Gold Adornments', verses: 89, place: 'Meccan' },
  { num: 44, name: 'Ad-Dukhan', english: 'The Smoke', verses: 59, place: 'Meccan' },
  { num: 45, name: 'Al-Jathiya', english: 'The Crouching', verses: 37, place: 'Meccan' },
  { num: 46, name: 'Al-Ahqaf', english: 'The Wind-Curved Sandhills', verses: 35, place: 'Meccan' },
  { num: 47, name: 'Muhammad', english: 'Muhammad', verses: 38, place: 'Medinan' },
  { num: 48, name: 'Al-Fath', english: 'The Victory', verses: 29, place: 'Medinan' },
  { num: 49, name: 'Al-Hujurat', english: 'The Rooms', verses: 18, place: 'Medinan' },
  { num: 50, name: 'Qaf', english: 'Qaf', verses: 45, place: 'Meccan' },
  { num: 51, name: 'Adh-Dhariyat', english: 'The Winnowing Winds', verses: 60, place: 'Meccan' },
  { num: 52, name: 'At-Tur', english: 'The Mount', verses: 49, place: 'Meccan' },
  { num: 53, name: 'An-Najm', english: 'The Star', verses: 62, place: 'Meccan' },
  { num: 54, name: 'Al-Qamar', english: 'The Moon', verses: 55, place: 'Meccan' },
  { num: 55, name: 'Ar-Rahman', english: 'The Most Merciful', verses: 78, place: 'Medinan' },
  { num: 56, name: 'Al-Waqiah', english: 'The Inevitable', verses: 96, place: 'Meccan' },
  { num: 57, name: 'Al-Hadid', english: 'The Iron', verses: 29, place: 'Medinan' },
  { num: 58, name: 'Al-Mujadila', english: 'The Pleading Woman', verses: 22, place: 'Medinan' },
  { num: 59, name: 'Al-Hashr', english: 'The Exile', verses: 24, place: 'Medinan' },
  { num: 60, name: 'Al-Mumtahanah', english: 'She That Is To Be Examined', verses: 13, place: 'Medinan' },
  { num: 61, name: 'As-Saff', english: 'The Ranks', verses: 14, place: 'Medinan' },
  { num: 62, name: 'Al-Jumuah', english: 'The Congregation', verses: 11, place: 'Medinan' },
  { num: 63, name: 'Al-Munafiqun', english: 'The Hypocrites', verses: 11, place: 'Medinan' },
  { num: 64, name: 'At-Taghabun', english: 'The Mutual Disillusion', verses: 18, place: 'Medinan' },
  { num: 65, name: 'At-Talaq', english: 'The Divorce', verses: 12, place: 'Medinan' },
  { num: 66, name: 'At-Tahrim', english: 'The Prohibition', verses: 12, place: 'Medinan' },
  { num: 67, name: 'Al-Mulk', english: 'The Sovereignty', verses: 30, place: 'Meccan' },
  { num: 68, name: 'Al-Qalam', english: 'The Pen', verses: 52, place: 'Meccan' },
  { num: 69, name: 'Al-Haqqah', english: 'The Reality', verses: 52, place: 'Meccan' },
  { num: 70, name: 'Al-Maarij', english: 'The Ascending Stairways', verses: 44, place: 'Meccan' },
  { num: 71, name: 'Nuh', english: 'Noah', verses: 28, place: 'Meccan' },
  { num: 72, name: 'Al-Jinn', english: 'The Jinn', verses: 28, place: 'Meccan' },
  { num: 73, name: 'Al-Muzzammil', english: 'The Enshrouded One', verses: 20, place: 'Meccan' },
  { num: 74, name: 'Al-Muddaththir', english: 'The Cloaked One', verses: 56, place: 'Meccan' },
  { num: 75, name: 'Al-Qiyamah', english: 'The Resurrection', verses: 40, place: 'Meccan' },
  { num: 76, name: 'Al-Insan', english: 'Man', verses: 31, place: 'Medinan' },
  { num: 77, name: 'Al-Mursalat', english: 'The Emissaries', verses: 50, place: 'Meccan' },
  { num: 78, name: 'An-Naba', english: 'The Tidings', verses: 40, place: 'Meccan' },
  { num: 79, name: 'An-Naziat', english: 'Those Who Drag Forth', verses: 46, place: 'Meccan' },
  { num: 80, name: 'Abasa', english: 'He Frowned', verses: 42, place: 'Meccan' },
  { num: 81, name: 'At-Takwir', english: 'The Overthrowing', verses: 29, place: 'Meccan' },
  { num: 82, name: 'Al-Infitar', english: 'The Cleaving', verses: 19, place: 'Meccan' },
  { num: 83, name: 'Al-Mutaffifin', english: 'The Defrauding', verses: 36, place: 'Meccan' },
  { num: 84, name: 'Al-Inshiqaq', english: 'The Splitting Open', verses: 25, place: 'Meccan' },
  { num: 85, name: 'Al-Buruj', english: 'The Mansions of the Stars', verses: 22, place: 'Meccan' },
  { num: 86, name: 'At-Tariq', english: 'The Morning Star', verses: 17, place: 'Meccan' },
  { num: 87, name: 'Al-Ala', english: 'The Most High', verses: 19, place: 'Meccan' },
  { num: 88, name: 'Al-Ghashiyah', english: 'The Overwhelming', verses: 26, place: 'Meccan' },
  { num: 89, name: 'Al-Fajr', english: 'The Dawn', verses: 30, place: 'Meccan' },
  { num: 90, name: 'Al-Balad', english: 'The City', verses: 20, place: 'Meccan' },
  { num: 91, name: 'Ash-Shams', english: 'The Sun', verses: 15, place: 'Meccan' },
  { num: 92, name: 'Al-Layl', english: 'The Night', verses: 21, place: 'Meccan' },
  { num: 93, name: 'Ad-Duha', english: 'The Morning Hours', verses: 11, place: 'Meccan' },
  { num: 94, name: 'Ash-Sharh', english: 'The Relief', verses: 8, place: 'Meccan' },
  { num: 95, name: 'At-Tin', english: 'The Fig', verses: 8, place: 'Meccan' },
  { num: 96, name: 'Al-Alaq', english: 'The Clot', verses: 19, place: 'Meccan' },
  { num: 97, name: 'Al-Qadr', english: 'The Power', verses: 5, place: 'Meccan' },
  { num: 98, name: 'Al-Bayyinah', english: 'The Clear Proof', verses: 8, place: 'Medinan' },
  { num: 99, name: 'Az-Zalzalah', english: 'The Earthquake', verses: 8, place: 'Medinan' },
  { num: 100, name: 'Al-Adiyat', english: 'The Courser', verses: 11, place: 'Meccan' },
  { num: 101, name: 'Al-Qariah', english: 'The Calamity', verses: 11, place: 'Meccan' },
  { num: 102, name: 'At-Takathur', english: 'The Rivalry in Worldly Increase', verses: 8, place: 'Meccan' },
  { num: 103, name: 'Al-Asr', english: 'The Declining Day', verses: 3, place: 'Meccan' },
  { num: 104, name: 'Al-Humazah', english: 'The Slanderer', verses: 9, place: 'Meccan' },
  { num: 105, name: 'Al-Fil', english: 'The Elephant', verses: 5, place: 'Meccan' },
  { num: 106, name: 'Quraysh', english: 'Quraysh', verses: 4, place: 'Meccan' },
  { num: 107, name: 'Al-Maun', english: 'The Small Kindnesses', verses: 7, place: 'Meccan' },
  { num: 108, name: 'Al-Kawthar', english: 'The Abundance', verses: 3, place: 'Meccan' },
  { num: 109, name: 'Al-Kafirun', english: 'The Disbelievers', verses: 6, place: 'Meccan' },
  { num: 110, name: 'An-Nasr', english: 'The Divine Support', verses: 3, place: 'Medinan' },
  { num: 111, name: 'Al-Masad', english: 'The Palm Fiber', verses: 5, place: 'Meccan' },
  { num: 112, name: 'Al-Ikhlas', english: 'The Sincerity', verses: 4, place: 'Meccan' },
  { num: 113, name: 'Al-Falaq', english: 'The Daybreak', verses: 5, place: 'Meccan' },
  { num: 114, name: 'An-Nas', english: 'The Mankind', verses: 6, place: 'Meccan' },
];

let _quranEn = null;
let _quranAr = null;

function loadQuranEn() {
  if (_quranEn) return _quranEn;
  if (!fs.existsSync(QURAN_EN_PATH)) {
    throw new Error(`Missing ${QURAN_EN_PATH}. Run npm run bootstrap-data.`);
  }
  const raw = fs.readFileSync(QURAN_EN_PATH, 'utf8');
  const map = {}; // map[chapter] = { verseNum: text }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|');
    if (parts.length < 3) continue;
    const c = parseInt(parts[0], 10);
    const v = parseInt(parts[1], 10);
    const t = parts.slice(2).join('|').trim();
    if (!c || !v) continue;
    if (!map[c]) map[c] = {};
    map[c][v] = t;
  }
  _quranEn = map;
  return map;
}

function loadQuranAr() {
  if (_quranAr) return _quranAr;
  if (!fs.existsSync(QURAN_AR_PATH)) return null; // optional
  const raw = fs.readFileSync(QURAN_AR_PATH, 'utf8');
  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|');
    if (parts.length < 3) continue;
    const c = parseInt(parts[0], 10);
    const v = parseInt(parts[1], 10);
    const t = parts.slice(2).join('|').trim();
    if (!c || !v) continue;
    if (!map[c]) map[c] = {};
    map[c][v] = t;
  }
  _quranAr = map;
  return map;
}

function getChapterInfo(chapterNumber) {
  return SURAH_INFO.find((s) => s.num === chapterNumber) || null;
}

function getVersesByChapter(chapterNumber, verseNumbers) {
  const en = loadQuranEn();
  const ar = loadQuranAr();
  const chap = en[chapterNumber];
  if (!chap) return [];
  const info = getChapterInfo(chapterNumber);
  const allNums = Object.keys(chap).map(Number).sort((a, b) => a - b);
  const wanted = verseNumbers && verseNumbers.length ? verseNumbers : allNums.slice(0, 15);
  const out = [];
  for (const v of wanted) {
    if (!chap[v]) continue;
    out.push({
      reference: `${chapterNumber}:${v}`,
      surah_name: info ? info.name : `Surah ${chapterNumber}`,
      surah_english: info ? info.english : '',
      arabic: ar && ar[chapterNumber] ? ar[chapterNumber][v] || null : null,
      translation: chap[v],
    });
  }
  return out;
}

const HADITH_FILE_CANDIDATES = (collection, bookNumber) => [
  path.join(HADITH_DIR, `eng-${collection}`, 'sections', `${bookNumber}.json`),
  path.join(HADITH_DIR, `eng-${collection}`, `${bookNumber}.json`),
  path.join(HADITH_DIR, `eng-${collection}`, `${collection}.json`),
  path.join(HADITH_DIR, `eng-${collection}`, 'index.json'),
];

const _hadithCache = {};

function loadHadithCollection(collection) {
  if (_hadithCache[collection]) return _hadithCache[collection];
  // fawazahmed0 layout: editions/eng-{collection}.json (consolidated, sibling to per-hadith dir)
  // and editions/eng-{collection}.min.json (minified). Try both.
  const candidates = [
    path.join(HADITH_DIR, `eng-${collection}.json`),
    path.join(HADITH_DIR, `eng-${collection}.min.json`),
    path.join(HADITH_DIR, `eng-${collection}`, `${collection}.json`),
    path.join(HADITH_DIR, `eng-${collection}`, 'index.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      _hadithCache[collection] = data;
      return data;
    } catch (e) {
      console.warn(`[source] failed to parse ${p}: ${e.message}`);
    }
  }
  console.warn(`[source] no consolidated hadith file found for ${collection} (looked in ${candidates.join(', ')})`);
  return null;
}

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeHadith(raw, collection, bookNumber, hadithNumber) {
  if (!raw) return null;
  const text = stripHtml(raw.text || raw.body || raw.hadith || raw.english || '');
  if (!text) return null;
  return {
    reference: `${collection.charAt(0).toUpperCase() + collection.slice(1)} Book ${bookNumber} Hadith ${hadithNumber}`,
    collection,
    book: bookNumber,
    number: hadithNumber,
    text,
  };
}

function hadithBookNum(h) {
  // fawazahmed0 schema puts book number under h.reference.book.
  // Older shapes use flat fields. Try in order.
  if (h && h.reference && h.reference.book !== undefined) return parseInt(h.reference.book, 10);
  return parseInt(h.bookNumber || h.book || h.book_number, 10);
}

function hadithNum(h) {
  return parseInt(h.hadithnumber || h.number || h.hadithNumber || (h.reference && h.reference.hadith), 10);
}

function getHadith(collection, bookNumber, hadithNumber) {
  const data = loadHadithCollection(collection);
  if (!data) return null;
  const list = data.hadiths || data.hadith || [];
  for (const h of list) {
    const b = hadithBookNum(h);
    const n = hadithNum(h);
    if (b === bookNumber && n === hadithNumber) {
      return normalizeHadith(h, collection, bookNumber, hadithNumber);
    }
  }
  return null;
}

function getHadithBook(collection, bookNumber, limit = 10) {
  const data = loadHadithCollection(collection);
  if (!data) return [];
  const list = data.hadiths || data.hadith || [];
  const matched = [];
  for (const h of list) {
    const b = hadithBookNum(h);
    if (b !== bookNumber) continue;
    const n = hadithNum(h);
    const norm = normalizeHadith(h, collection, bookNumber, n);
    if (norm) matched.push(norm);
    if (matched.length >= limit) break;
  }
  return matched;
}

async function retrieveForTopic(topic) {
  const verses = [];
  const hadith = [];

  if (Array.isArray(topic.quran_chapters)) {
    for (const chap of topic.quran_chapters) {
      const v = getVersesByChapter(chap, topic.specific_verses);
      verses.push(...v);
    }
  }

  if (topic.hadith_book && topic.hadith_book.collection && topic.hadith_book.book) {
    try {
      const list = getHadithBook(topic.hadith_book.collection, topic.hadith_book.book, topic.hadith_book.limit || 8);
      hadith.push(...list);
    } catch (e) {
      console.warn(`[source] hadith book load failed (${topic.hadith_book.collection} book ${topic.hadith_book.book}):`, e.message);
    }
  }

  if (Array.isArray(topic.hadith_refs)) {
    for (const ref of topic.hadith_refs) {
      try {
        const h = getHadith(ref.collection, ref.book, ref.number);
        if (h) hadith.push(h);
        else console.warn(`[source] hadith not found: ${ref.collection} ${ref.book}:${ref.number}`);
      } catch (e) {
        console.warn(`[source] hadith ref load failed:`, e.message);
      }
    }
  }

  return {
    verses,
    hadith,
    context: topic.context || '',
  };
}

module.exports = {
  retrieveForTopic,
  getVersesByChapter,
  getChapterInfo,
  getHadith,
  getHadithBook,
  SURAH_INFO,
};
