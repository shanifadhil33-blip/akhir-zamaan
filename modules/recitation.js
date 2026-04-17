// modules/recitation.js
// Downloads Quran verse recitations from EveryAyah.com (free, no key).
// Default reciter: Mishary Rashid Alafasy 128kbps.
// URL pattern: https://everyayah.com/data/{RECITER_ID}/{NNNVVV}.mp3
//   where NNN = zero-padded chapter (3 digits), VVV = zero-padded verse (3 digits)

const fs = require('fs');
const path = require('path');
const axios = require('axios');

function pad(n, width = 3) {
  return String(n).padStart(width, '0');
}

function buildUrl(reciterId, chapter, verse) {
  return `https://everyayah.com/data/${reciterId}/${pad(chapter)}${pad(verse)}.mp3`;
}

function parseRef(ref) {
  // "18:54" -> { chapter: 18, verse: 54 }
  if (!ref || typeof ref !== 'string') return null;
  const m = ref.match(/(\d+):(\d+)/);
  if (!m) return null;
  return { chapter: parseInt(m[1], 10), verse: parseInt(m[2], 10) };
}

async function downloadVerseAudio(ref, outDir) {
  const reciter = process.env.RECITER_ID || 'Alafasy_128kbps';
  const parsed = parseRef(ref);
  if (!parsed) return null;
  const url = buildUrl(reciter, parsed.chapter, parsed.verse);
  const fileName = `recitation_${pad(parsed.chapter)}_${pad(parsed.verse)}.mp3`;
  const outPath = path.join(outDir, fileName);
  if (fs.existsSync(outPath)) return outPath;
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(outPath, Buffer.from(resp.data));
    return outPath;
  } catch (err) {
    console.warn(`[recitation] failed for ${ref} (${url}):`, err.message);
    return null;
  }
}

async function downloadAllRecitations(versesForRecitation, outDir) {
  if (!Array.isArray(versesForRecitation) || versesForRecitation.length === 0) return [];
  const recDir = path.join(outDir, 'recitations');
  if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
  const results = [];
  for (const v of versesForRecitation) {
    const ref = v.reference || v.ref;
    if (!ref) continue;
    const audioPath = await downloadVerseAudio(ref, recDir);
    if (audioPath) {
      results.push({ ...v, audioPath });
    }
  }
  return results;
}

module.exports = { downloadAllRecitations, downloadVerseAudio, buildUrl };
