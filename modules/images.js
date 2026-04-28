// modules/images.js
// Image generation. Provider chain: Cloudflare Workers AI (primary, when
// CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set) → Pollinations.ai
// (fallback, free + no key but flaky). Beats are generated concurrently
// (default 6 in flight) so the image stage finishes in minutes, not hours.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const POLL_BASE = 'https://image.pollinations.ai/prompt';
const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
// Flux Schnell on Workers AI: fast (~4 step), high quality, multiple-of-32
// dimensions up to 2048. 1024x576 = 16:9, fits the FFmpeg Ken Burns pipeline
// which scales to 1920x1080 anyway.
const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const IMAGE_CONCURRENCY = parseInt(process.env.IMAGE_CONCURRENCY || '6', 10);

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

function cfAccountId() { return (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim(); }
function cfApiToken() { return (process.env.CLOUDFLARE_API_TOKEN || '').trim(); }

function cloudflareConfigured() {
  return !!(cfAccountId() && cfApiToken());
}

async function generateBeatImageCloudflare({ prompt, outPath, width = 1024, height = 576 }) {
  const accountId = cfAccountId();
  const apiToken = cfApiToken();
  const url = `${CF_API_BASE}/${accountId}/ai/run/${CF_MODEL}`;
  const resp = await axios.post(url, {
    prompt: `${prompt}. Negative: ${NEGATIVE_PROMPT}`,
    width,
    height,
    steps: 4,
  }, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
    validateStatus: (s) => s === 200,
  });
  if (!resp.data || resp.data.success === false) {
    const errs = resp.data && resp.data.errors;
    throw new Error(`Cloudflare returned !success: ${errs ? JSON.stringify(errs) : 'unknown'}`);
  }
  const b64 = resp.data.result && resp.data.result.image;
  if (!b64) throw new Error('Cloudflare response missing result.image');
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength < 2000) throw new Error(`Cloudflare image too small (${buf.byteLength} bytes)`);
  fs.writeFileSync(outPath, buf);
  return outPath;
}

async function fetchPollinationsImage(url, outPath, timeoutMs = 90000) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    validateStatus: (s) => s === 200,
  });
  if (!resp.data || resp.data.byteLength < 2000) {
    throw new Error(`Pollinations image too small (${resp.data && resp.data.byteLength} bytes)`);
  }
  fs.writeFileSync(outPath, Buffer.from(resp.data));
  return outPath;
}

function backoffMsForError(err, baseMs = 5000, attempt = 1) {
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

async function generateBeatImagePollinations({ prompt, outPath, beatNumber, width = 1920, height = 1080 }) {
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
      return await fetchPollinationsImage(url, outPath);
    } catch (err) {
      lastErr = err;
      const status = err && err.response && err.response.status;
      const wait = backoffMsForError(err, 5000, i + 1);
      console.warn(`[images] beat ${beatNumber} pollinations attempt ${i + 1}/${variants.length} failed (${status || 'no-status'}: ${err.message}) — waiting ${wait}ms`);
      if (i < variants.length - 1) await sleep(wait);
    }
  }
  throw new Error(`All Pollinations attempts failed for beat ${beatNumber}: ${lastErr && lastErr.message}`);
}

async function generateBeatImage({ prompt, outPath, beatNumber, width = 1920, height = 1080 }) {
  // Primary: Cloudflare Workers AI when configured. Fast, reliable, generous free tier.
  if (cloudflareConfigured()) {
    try {
      return await generateBeatImageCloudflare({ prompt, outPath });
    } catch (err) {
      console.warn(`[images] beat ${beatNumber} cloudflare failed (${err.message}) — falling back to pollinations`);
    }
  }
  // Fallback: Pollinations.
  return generateBeatImagePollinations({ prompt, outPath, beatNumber, width, height });
}

async function generateAllBeats(visualPlan, outputDir) {
  const imgDir = path.join(outputDir, 'images');
  if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

  const aesthetic = visualPlan.aesthetic_style_string || '';
  const beats = visualPlan.beats;
  const total = beats.length;
  const results = new Array(total);
  let lastSuccessPath = null;
  let nextIndex = 0;
  let completed = 0;

  console.log(`[images] generating ${total} beats with concurrency=${IMAGE_CONCURRENCY} (primary: ${cloudflareConfigured() ? 'cloudflare' : 'pollinations'})`);

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= total) return;
      const beat = beats[i];
      const beatNum = beat.beat_number || i + 1;
      const fileName = `beat_${String(beatNum).padStart(3, '0')}.jpg`;
      const outPath = path.join(imgDir, fileName);
      const fullPrompt = `${beat.image_prompt}, ${aesthetic}`.replace(/,\s*$/, '');

      try {
        await generateBeatImage({ prompt: fullPrompt, outPath, beatNumber: beatNum });
        lastSuccessPath = outPath;
        results[i] = { ...beat, imagePath: outPath };
      } catch (err) {
        console.warn(`[images] beat ${beatNum} all attempts failed; using fallback image`);
        if (lastSuccessPath && fs.existsSync(lastSuccessPath)) {
          fs.copyFileSync(lastSuccessPath, outPath);
          results[i] = { ...beat, imagePath: outPath, fallback: true };
        } else {
          const placeholderPath = path.join(__dirname, '..', 'assets', 'placeholder.jpg');
          if (fs.existsSync(placeholderPath)) {
            fs.copyFileSync(placeholderPath, outPath);
          }
          results[i] = { ...beat, imagePath: outPath, fallback: true, placeholder: true };
        }
      }
      completed++;
      console.log(`[images] beat ${beatNum} done (${completed}/${total})`);
    }
  }

  const workers = Array.from({ length: Math.min(IMAGE_CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Generates the thumbnail background. NEVER throws — if every provider fails,
// returns bgPath: null and the caller falls back to the first generated beat
// image. One bad upstream call must never kill a whole 30-min video render.
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
