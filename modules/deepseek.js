// modules/deepseek.js
// DeepSeek API client (OpenAI-compatible). Used for script generation when
// DEEPSEEK_API_KEY is set — DeepSeek V3 has stronger narrative writing than
// gpt-oss:120b-cloud. Free tier: 5M tokens on signup.
//
// We don't use this for visual plan / metadata / topic generation; those
// calls are JSON-shape heavy where Ollama is fine and costs nothing.

const axios = require('axios');

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL_DEFAULT = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();
const MAX_TOKENS_DEFAULT = 8192;

function configured() {
  const k = process.env.DEEPSEEK_API_KEY;
  return !!(k && k.trim());
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
  const apiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const body = {
    model,
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

  const resp = await axios.post(DEEPSEEK_URL, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
    validateStatus: (s) => s === 200,
  });

  const content = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && resp.data.choices[0].message.content;
  if (!content) {
    throw new Error(`DeepSeek returned no content. Body keys: ${Object.keys(resp.data || {}).join(',')}`);
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
      console.warn(`[deepseek] transient error (${err.code || (err.response && err.response.status) || '?'}: ${(err.message || '').slice(0, 120)}) — retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = { call, configured, MODEL_DEFAULT };
