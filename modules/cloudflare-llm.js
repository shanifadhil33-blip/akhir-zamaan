// modules/cloudflare-llm.js
// Cloudflare Workers AI client for the script-generation tier. Llama 3.3 70B
// produces stronger long-form narrative prose than Ollama gpt-oss:120b, and
// Cloudflare's free tier (10,000 neurons/day) easily covers our ~70-700
// neurons/week. Uses the same CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
// secrets that already power the image-generation stage.
//
// We don't use this for visual plan / topic generation — those produce JSON
// outputs >4K tokens which can hit Cloudflare's per-call cap. Ollama handles
// those, where the output bandwidth matters more than narrative quality.

const axios = require('axios');

const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const MODEL_DEFAULT = (process.env.CLOUDFLARE_LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast').trim();
const MAX_TOKENS_DEFAULT = 4096;

function cfAccountId() { return (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim(); }
function cfApiToken() { return (process.env.CLOUDFLARE_API_TOKEN || '').trim(); }

function configured() {
  return !!(cfAccountId() && cfApiToken());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isTransientError(err) {
  if (!err) return false;
  const code = err.code;
  const status = err.response && err.response.status;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED') return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  if (status === 429) return true;
  return false;
}

async function callOnce({
  systemInstruction,
  userPrompt,
  temperature = 0.85,
  jsonMode = true,
  model = MODEL_DEFAULT,
  maxTokens = MAX_TOKENS_DEFAULT,
  timeoutMs = 240000,
}) {
  const accountId = cfAccountId();
  const apiToken = cfApiToken();
  if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');

  const url = `${CF_API_BASE}/${accountId}/ai/run/${model}`;
  const body = {
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
    validateStatus: (s) => s === 200,
  });

  if (!resp.data || resp.data.success === false) {
    const errs = resp.data && resp.data.errors;
    throw new Error(`Cloudflare LLM returned !success: ${errs ? JSON.stringify(errs) : 'unknown'}`);
  }
  // Workers AI puts text under .result.response; some models also use .result.text
  const content = (resp.data.result && (resp.data.result.response || resp.data.result.text)) || '';
  if (!content) {
    throw new Error(`Cloudflare LLM response missing result.response. Body keys: ${Object.keys(resp.data || {}).join(',')}`);
  }
  return content;
}

async function call(args, { maxAttempts = 3, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callOnce(args);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxAttempts) throw err;
      const wait = Math.min(20000, baseDelayMs * Math.pow(2, attempt - 1));
      console.warn(`[cloudflare-llm] transient error (${err.code || (err.response && err.response.status) || '?'}: ${(err.message || '').slice(0, 120)}) — retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = { call, configured, MODEL_DEFAULT };
