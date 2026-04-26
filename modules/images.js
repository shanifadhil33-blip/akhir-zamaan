// modules/images.js
// Pollinations.ai image generation. Free, no key, URL-based.
// Falls back to retry-with-different-seed on failure.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const POLL_BASE = 'https://image.pollinations.ai/prompt';

// Universal negative prompt. Cuts the usual AI-slop (bad anatomy, text artifacts,
// watermarks) that makes Pollinations output feel "random" even when the prompt
// is specific.
const NEGATIVE_PROMPT = 'deformed, disfigured, bad anatomy, extra fingers, extra limbs, missing fingers, mutated hands, low quality, blurry, out of focus, jpeg artifacts, watermark, text, logo, signature, caption, ugly, pixelated, distorted faces, cartoon, anime, 3d render, plastic skin, overexposed, underexposed, oversaturated';

function buildPollinationsUrl(prompt, { width = 1920, height = 1080, seed = 42, model = 'flux-realism', negative } = {}) {
  const encoded = encodeURIComponent(prompt);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    nologo: 'true',
    seed: String(seed),
    enhance: 'true',
    negative_prompt: negative || NEGATIVE_PROMPT,
  });
  return `${POLL_BASE}/${encoded}?${params.toString()}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchImage(url, outPath, timeoutMs = 90000) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    validateStatus: (s) => s === 200,
  });
  if (!resp.data || resp.data.byteLength < 2000) {
    throw new Error(`Image too small (${resp.data && resp.data.byteLength} bytes), likely an error response`);
  }
  fs.writeFileSync(outPath, Buffer.from(resp.data));
  return outPath;
}

function backoffMsForError(err, baseMs = 5000, attempt = 1) {
  // Pollinations returns 429 when it's saturated. Respect Retry-After if present;
  // otherwise back off exponentially, but cap at 60s.
  const status = err && err.response && err.response.status;
  if (status === 429) {
    const retryAfter = err.response.headers && err.response.headers['retry-after'];
    if (retryAfter) {
      const sec = parseInt(retryAfter, 10);
      if (!Number.isNaN(sec) && sec > 0) return Math.min(60000, sec * 1000);
    }
    return Math.min(60000, baseMs * Math.pow(2, attempt - 1));
  }
  return Math.min(20000, baseMs * Math.pow(2, attempt - 1));
}

async function generateBeatImage({ prompt, outPath, beatNumber, width = 1920, height = 1080 }) {
  const seed = (beatNumber * 1009) % 100000;
  const variants = [
    { seed, model: 'flux-realism' },
    { seed: seed + 31337, model: 'flux-realism' },
    { seed: seed + 77777, model: 'flux-pro' },
    { seed: seed + 99991, model: 'flux' },
  ];
  let lastErr;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    try {
      const url = buildPollinationsUrl(prompt, { width, height, seed: v.seed, model: v.model });
      return await fetchImage(url, outPath);
    } catch (err) {
      lastErr = err;
      const status = err && err.response && err.response.status;
      const wait = backoffMsForError(err, 5000, i + 1);
      console.warn(`[images] beat ${beatNumber} attempt ${i + 1}/${variants.length} failed (${status || 'no-status'}: ${err.message}) — waiting ${wait}ms`);
      if (i < variants.length - 1) await sleep(wait);
    }
  }
  throw new Error(`All image generation attempts failed for beat ${beatNumber}: ${lastErr && lastErr.message}`);
}

async function generateAllBeats(visualPlan, outputDir) {
  const imgDir = path.join(outputDir, 'images');
  if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

  const aesthetic = visualPlan.aesthetic_style_string || '';
  const results = [];
  let lastSuccessPath = null;

  for (let i = 0; i < visualPlan.beats.length; i++) {
    const beat = visualPlan.beats[i];
    const beatNum = beat.beat_number || i + 1;
    const fileName = `beat_${String(beatNum).padStart(3, '0')}.jpg`;
    const outPath = path.join(imgDir, fileName);

    const fullPrompt = `${beat.image_prompt}, ${aesthetic}`.replace(/,\s*$/, '');

    try {
      await generateBeatImage({ prompt: fullPrompt, outPath, beatNumber: beatNum });
      lastSuccessPath = outPath;
      results.push({ ...beat, imagePath: outPath });
      console.log(`[images] beat ${beatNum}/${visualPlan.beats.length} ✓`);
    } catch (err) {
      console.warn(`[images] beat ${beatNum} all attempts failed; copying previous`);
      if (lastSuccessPath && fs.existsSync(lastSuccessPath)) {
        fs.copyFileSync(lastSuccessPath, outPath);
        results.push({ ...beat, imagePath: outPath, fallback: true });
      } else {
        // No previous image to fall back to — write a black placeholder
        const placeholderPath = path.join(__dirname, '..', 'assets', 'placeholder.jpg');
        if (fs.existsSync(placeholderPath)) {
          fs.copyFileSync(placeholderPath, outPath);
        }
        results.push({ ...beat, imagePath: outPath, fallback: true, placeholder: true });
      }
    }
  }

  return results;
}

// Generates the thumbnail background. NEVER throws — if Pollinations fails
// (e.g. persistent 429), returns bgPath: null and the caller picks a fallback
// (typically the first generated beat image). One bad upstream call must never
// kill a whole 30-min video render.
async function generateThumbnail(visualPlan, outputDir) {
  const thumb = visualPlan.thumbnail || {};
  const aesthetic = visualPlan.aesthetic_style_string || '';
  const prompt = `${thumb.background_prompt || 'dramatic islamic mosque at dusk, single subject, high contrast'}, ${aesthetic}`.replace(/,\s*$/, '');
  const outPath = path.join(outputDir, 'thumbnail_bg.jpg');
  const meta = {
    bgPath: null,
    overlayText: thumb.title_overlay || 'AKHIR ZAMAAN',
    accentColor: thumb.accent_color || '#FFD700',
  };
  try {
    await generateBeatImage({ prompt, outPath, beatNumber: 9001, width: 1280, height: 720 });
    meta.bgPath = outPath;
  } catch (err) {
    console.warn(`[images] thumbnail bg generation failed (${err.message}) — caller must supply fallback`);
  }
  return meta;
}

module.exports = { generateAllBeats, generateThumbnail, buildPollinationsUrl };
