// modules/deepseek.js
// DeepSeek V3 client for script-tier generation. OpenAI-compatible chat API.
// Used by modules/ollama.js generateAndParseJSONForScript() when DEEPSEEK_API_KEY
// is set. Other LLM calls (visual plan, metadata, topic refill, modern context)
// stay on Ollama — DeepSeek is reserved for the script-engine where instruction-
// following quality matters most and the per-script cost is bounded.

const axios = require('axios');

const DEEPSEEK_API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'; // V3
const DEEPSEEK_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_TIMEOUT_MS, 10) || 300000;

function deepseekKey() {
  return (process.env.DEEPSEEK_API_KEY || '').trim();
}

function deepseekConfigured() {
  return !!deepseekKey();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isTransientError(err) {
  if (!err) return false;
  const code = err.code;
  const status = err.response && err.response.status;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED') return true;
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  return false;
}

async function callDeepseekOnce({ systemInstruction, userPrompt, temperature = 0.85, jsonMode = true, maxTokens = 8192 }) {
  const key = deepseekKey();
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');

  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const resp = await axios.post(`${DEEPSEEK_API_BASE}/chat/completions`, body, {
    timeout: DEEPSEEK_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    validateStatus: (s) => s === 200,
  });

  const content = resp.data
    && resp.data.choices
    && resp.data.choices[0]
    && resp.data.choices[0].message
    && resp.data.choices[0].message.content;
  if (!content || !String(content).trim()) {
    const err = new Error(`DeepSeek returned no content (finish_reason=${resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].finish_reason || 'unknown'})`);
    err.code = 'DEEPSEEK_EMPTY_RESPONSE';
    throw err;
  }
  return content;
}

async function callDeepseek(args, { maxAttempts = 3, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callDeepseekOnce(args);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxAttempts) throw err;
      const wait = Math.min(20000, baseDelayMs * Math.pow(2, attempt - 1));
      const status = err.response && err.response.status;
      console.warn(`[deepseek] transient error (${err.code || status || '?'}: ${(err.message || '').slice(0, 120)}) — retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function extractJSON(text) {
  if (!text) throw new Error('Empty DeepSeek response');
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object in DeepSeek response');
  const slice = s.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`Failed to parse DeepSeek JSON: ${e.message}\nRaw: ${slice.slice(0, 500)}...`);
  }
}

async function generateAndParseJSON(args) {
  const maxJsonAttempts = args.maxJsonAttempts || 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxJsonAttempts; attempt++) {
    const promptForAttempt = attempt === 1
      ? args.userPrompt
      : `${args.userPrompt}\n\nIMPORTANT: Your previous response failed or returned empty content. Return STRICT, COMPLETE JSON. No trailing commas. No markdown fences. Every opening bracket/brace matched. Just JSON.`;
    try {
      const text = await callDeepseek({ ...args, userPrompt: promptForAttempt });
      return extractJSON(text);
    } catch (err) {
      lastErr = err;
      if (attempt === maxJsonAttempts || !/JSON|parse|Unexpected|Empty|no content/i.test(err.message || '')) throw err;
      console.warn(`[deepseek] JSON response failed (${err.message.slice(0, 120)}) - retry ${attempt}/${maxJsonAttempts} with strict reminder`);
    }
  }
  throw lastErr;
}

module.exports = {
  deepseekConfigured,
  generateAndParseJSON,
  DEEPSEEK_MODEL,
};
