// modules/images.js
// Pollinations.ai image generation. Free, no key, URL-based.
// Falls back to retry-with-different-seed on failure.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const POLL_BASE = 'https://image.pollinations.ai/prompt';

function buildPollinationsUrl(prompt, { width = 1920, height = 1080, seed = 42, model = 'flux' } = {}) {
  const encoded = encodeURIComponent(prompt);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    nologo: 'true',
    seed: String(seed),
    enhance: 'true',
  });
  return `${POLL_BASE}/${encoded}?${params.toString()}`;
}

async function fetchImage(url, outPath, timeoutMs = 90000) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: timeoutMs });
  if (!resp.data || resp.data.byteLength < 2000) {
    throw new Error(`Image too small (${resp.data && resp.data.byteLength} bytes), likely an error response`);
  }
  fs.writeFileSync(outPath, Buffer.from(resp.data));
  return outPath;
}

async function generateBeatImage({ prompt, outPath, beatNumber, width = 1920, height = 1080 }) {
  const seed = (beatNumber * 1009) % 100000;
  // Attempt 1: Pollinations with primary seed
  try {
    const url1 = buildPollinationsUrl(prompt, { width, height, seed });
    return await fetchImage(url1, outPath);
  } catch (e1) {
    console.warn(`[images] beat ${beatNumber} attempt 1 failed: ${e1.message}`);
  }
  // Attempt 2: Pollinations with different seed
  try {
    const url2 = buildPollinationsUrl(prompt, { width, height, seed: seed + 31337 });
    return await fetchImage(url2, outPath);
  } catch (e2) {
    console.warn(`[images] beat ${beatNumber} attempt 2 failed: ${e2.message}`);
  }
  // Attempt 3: Pollinations turbo model fallback
  try {
    const url3 = buildPollinationsUrl(prompt, { width, height, seed: seed + 99991, model: 'turbo' });
    return await fetchImage(url3, outPath);
  } catch (e3) {
    console.warn(`[images] beat ${beatNumber} attempt 3 failed: ${e3.message}`);
  }
  throw new Error(`All image generation attempts failed for beat ${beatNumber}`);
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

async function generateThumbnail(visualPlan, outputDir) {
  const thumb = visualPlan.thumbnail || {};
  const aesthetic = visualPlan.aesthetic_style_string || '';
  const prompt = `${thumb.background_prompt || 'dramatic islamic mosque at dusk, single subject, high contrast'}, ${aesthetic}`.replace(/,\s*$/, '');
  const outPath = path.join(outputDir, 'thumbnail_bg.jpg');
  await generateBeatImage({ prompt, outPath, beatNumber: 9001, width: 1280, height: 720 });
  return {
    bgPath: outPath,
    overlayText: thumb.title_overlay || 'AKHIR ZAMAAN',
    accentColor: thumb.accent_color || '#FFD700',
  };
}

module.exports = { generateAllBeats, generateThumbnail, buildPollinationsUrl };
