// modules/images.js
// Image generation. Provider chain: Cloudflare Workers AI (primary, when
// CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set) → Pollinations.ai
// (fallback, free + no key but flaky). Beats are generated concurrently,
// but throttled to avoid 429 cascades across both free-tier providers.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const POLL_BASE = 'https://image.pollinations.ai/prompt';
const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const HF_API_BASE = 'https://api-inference.huggingface.co/models';
// Flux Schnell on Workers AI: fast (~4 step), high quality, multiple-of-32
// dimensions up to 2048. 1024x576 = 16:9, fits the FFmpeg Ken Burns pipeline
// which scales to 1920x1080 anyway.
const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const HF_MODEL = (process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell').trim();
const IMAGE_CONCURRENCY = parseBoundedInt(process.env.IMAGE_CONCURRENCY, 3, 1, 3);
const CF_MAX_ATTEMPTS = parseBoundedInt(process.env.CLOUDFLARE_IMAGE_ATTEMPTS, 2, 1, 5);
const HF_MAX_ATTEMPTS = parseBoundedInt(process.env.HF_IMAGE_ATTEMPTS, 3, 1, 5);

const NEGATIVE_PROMPT = 'deformed, disfigured, bad anatomy, extra fingers, extra limbs, missing fingers, mutated hands, low quality, blurry, out of focus, jpeg artifacts, watermark, text, logo, signature, caption, ugly, pixelated, distorted faces, cartoon, anime, 3d render, plastic skin, overexposed, underexposed, oversaturated, typography, lettering, writing, words, characters, alphabet, calligraphy, sign, label, subtitle, banner, billboard';

// Strong positive directive appended to every Cloudflare/Pollinations prompt.
// Flux Schnell tends to insert garbled pseudo-Arabic/English text into images
// unless you actively tell it not to. Negative prompts help, but a positive
// "no text" instruction in the prompt itself is more reliable.
const NO_TEXT_SUFFIX = '. The image must contain NO text, NO letters, NO writing, NO signs, NO calligraphy, NO subtitles, NO watermarks. Purely visual composition.';

const providerCooldownUntil = {
  huggingface: 0,
  cloudflare: 0,
  pollinations: 0,
};

function parseBoundedInt(value, fallback, min, max) {
  const n = parseInt(value || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function buildPollinationsUrl(prompt, { width = 1920, height = 1080, seed = 42, model = 'flux-realism', negative } = {}) {
  // Append the no-text suffix to the prompt body as well — Pollinations
  // sometimes ignores the negative_prompt URL param, but always respects
  // instructions in the prompt itself.
  const fullPrompt = `${prompt}${NO_TEXT_SUFFIX}`;
  const encoded = encodeURIComponent(fullPrompt);
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

function responseStatus(err) {
  return err && err.response && err.response.status;
}

function providerName(provider) {
  if (provider === 'huggingface') return 'huggingface';
  if (provider === 'cloudflare') return 'cloudflare';
  return 'pollinations';
}

function hfToken() { return (process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '').trim(); }
function huggingfaceConfigured() { return !!hfToken(); }

async function waitForProviderCooldown(provider, beatNumber) {
  const name = providerName(provider);
  const wait = Math.max(0, providerCooldownUntil[name] - Date.now());
  if (wait > 0) {
    console.warn(`[images] beat ${beatNumber} waiting ${wait}ms for ${name} cooldown`);
    await sleep(wait);
  }
}

function markProviderCooldown(provider, err, baseMs, attempt) {
  if (responseStatus(err) !== 429) return 0;
  const name = providerName(provider);
  const wait = backoffMsForError(err, baseMs, attempt);
  providerCooldownUntil[name] = Math.max(providerCooldownUntil[name], Date.now() + wait);
  console.warn(`[images] ${name} rate-limited; shared cooldown ${wait}ms`);
  return wait;
}

function cfAccountId() { return (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim(); }
function cfApiToken() { return (process.env.CLOUDFLARE_API_TOKEN || '').trim(); }

function cloudflareConfigured() {
  return !!(cfAccountId() && cfApiToken());
}

async function generateBeatImageCloudflare({ prompt, outPath, width = 1024, height = 576 }) {
  const accountId = cfAccountId();
  const apiToken = cfApiToken();
  const url = `${CF_API_BASE}/${accountId}/ai/run/${CF_MODEL}`;
  // Flux Schnell doesn't reliably parse "Negative: ..." as a directive,
  // so we use a positive "no text" instruction in the prompt body instead.
  // Negative prompt is passed in case Cloudflare exposes it on its end.
  const resp = await axios.post(url, {
    prompt: `${prompt}${NO_TEXT_SUFFIX}`,
    negative_prompt: NEGATIVE_PROMPT,
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

async function generateBeatImageCloudflareWithRetries({ prompt, outPath, beatNumber, width = 1024, height = 576 }) {
  let lastErr;
  for (let attempt = 1; attempt <= CF_MAX_ATTEMPTS; attempt++) {
    await waitForProviderCooldown('cloudflare', beatNumber);
    try {
      return await generateBeatImageCloudflare({ prompt, outPath, width, height });
    } catch (err) {
      lastErr = err;
      const status = responseStatus(err);
      if (status === 429) {
        const wait = markProviderCooldown('cloudflare', err, 20000, attempt);
        console.warn(`[images] beat ${beatNumber} cloudflare attempt ${attempt}/${CF_MAX_ATTEMPTS} rate-limited - waiting ${wait}ms`);
        if (attempt < CF_MAX_ATTEMPTS) await sleep(wait);
        continue;
      }
      if (status >= 500 && status < 600 && attempt < CF_MAX_ATTEMPTS) {
        const wait = backoffMsForError(err, 5000, attempt);
        console.warn(`[images] beat ${beatNumber} cloudflare attempt ${attempt}/${CF_MAX_ATTEMPTS} failed (${status}) - waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function generateBeatImageHuggingFace({ prompt, outPath, width = 1024, height = 576 }) {
  // HF Inference API returns binary image bytes on success and a JSON error
  // body on failure (rate limit, model loading, etc). We accept all status
  // codes via validateStatus then inspect the content-type header to branch.
  const token = hfToken();
  const url = `${HF_API_BASE}/${HF_MODEL}`;
  const resp = await axios.post(url, {
    inputs: `${prompt}${NO_TEXT_SUFFIX}`,
    parameters: {
      width,
      height,
      num_inference_steps: 4,
      guidance_scale: 0,
    },
    options: {
      // Tell HF to block-wait until the model is loaded instead of returning
      // a 503 + estimated_time. Removes a class of transient failures.
      wait_for_model: true,
      use_cache: false,
    },
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'image/png',
    },
    responseType: 'arraybuffer',
    timeout: 120000,
    validateStatus: () => true,
  });

  const contentType = String((resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type'])) || '');
  if (resp.status === 200 && contentType.startsWith('image/')) {
    const buf = Buffer.from(resp.data);
    if (buf.byteLength < 2000) throw new Error(`HuggingFace image too small (${buf.byteLength} bytes)`);
    fs.writeFileSync(outPath, buf);
    return outPath;
  }

  // Non-image response — parse the JSON error body
  const bodyText = Buffer.from(resp.data || []).toString('utf8');
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch (_) { /* ignore */ }
  const errMsg = (bodyJson && (bodyJson.error || bodyJson.message)) || bodyText.slice(0, 200) || `HTTP ${resp.status}`;
  const err = new Error(`HuggingFace error: ${errMsg}`);
  err.response = { status: resp.status, headers: resp.headers, data: bodyJson || bodyText };
  throw err;
}

async function generateBeatImageHuggingFaceWithRetries({ prompt, outPath, beatNumber, width = 1024, height = 576 }) {
  let lastErr;
  for (let attempt = 1; attempt <= HF_MAX_ATTEMPTS; attempt++) {
    await waitForProviderCooldown('huggingface', beatNumber);
    try {
      return await generateBeatImageHuggingFace({ prompt, outPath, width, height });
    } catch (err) {
      lastErr = err;
      const status = responseStatus(err);
      // 429 = rate limit, 503 = model still loading despite wait_for_model
      if (status === 429 || status === 503) {
        const wait = markProviderCooldown('huggingface', err, 15000, attempt);
        console.warn(`[images] beat ${beatNumber} huggingface attempt ${attempt}/${HF_MAX_ATTEMPTS} rate-limited (${status}) - waiting ${wait}ms`);
        if (attempt < HF_MAX_ATTEMPTS) await sleep(wait);
        continue;
      }
      if (typeof status === 'number' && status >= 500 && status < 600 && attempt < HF_MAX_ATTEMPTS) {
        const wait = backoffMsForError(err, 5000, attempt);
        console.warn(`[images] beat ${beatNumber} huggingface attempt ${attempt}/${HF_MAX_ATTEMPTS} failed (${status}) - waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
      await waitForProviderCooldown('pollinations', beatNumber);
      const url = buildPollinationsUrl(prompt, { width, height, seed: v.seed, model: v.model });
      return await fetchPollinationsImage(url, outPath);
    } catch (err) {
      lastErr = err;
      const status = responseStatus(err);
      const wait = status === 429
        ? markProviderCooldown('pollinations', err, 15000, i + 1)
        : backoffMsForError(err, 5000, i + 1);
      console.warn(`[images] beat ${beatNumber} pollinations attempt ${i + 1}/${variants.length} failed (${status || 'no-status'}: ${err.message}) — waiting ${wait}ms`);
      if (i < variants.length - 1) await sleep(wait);
    }
  }
  throw new Error(`All Pollinations attempts failed for beat ${beatNumber}: ${lastErr && lastErr.message}`);
}

async function generateBeatImage({ prompt, outPath, beatNumber, width = 1920, height = 1080 }) {
  // Primary: HuggingFace Inference API (Flux Schnell) when HF_TOKEN is set.
  // Reasonably generous free tier with HF account, and the model is the same
  // Flux Schnell that Cloudflare Workers AI exposes — just on a less-throttled
  // backend. Falls through to Cloudflare → Pollinations on any failure.
  if (huggingfaceConfigured()) {
    try {
      return await generateBeatImageHuggingFaceWithRetries({ prompt, outPath, beatNumber, width: 1024, height: 576 });
    } catch (err) {
      console.warn(`[images] beat ${beatNumber} huggingface failed (${err.message}) — falling back to cloudflare/pollinations`);
    }
  }
  // Secondary: Cloudflare Workers AI when configured.
  if (cloudflareConfigured()) {
    try {
      return await generateBeatImageCloudflareWithRetries({ prompt, outPath, beatNumber });
    } catch (err) {
      console.warn(`[images] beat ${beatNumber} cloudflare failed (${err.message}) — falling back to pollinations`);
    }
  }
  // Last-resort: Pollinations.
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

  const primaryProvider = huggingfaceConfigured()
    ? `huggingface (${HF_MODEL})`
    : (cloudflareConfigured() ? 'cloudflare' : 'pollinations');
  console.log(`[images] generating ${total} beats with concurrency=${IMAGE_CONCURRENCY} (primary: ${primaryProvider})`);

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
