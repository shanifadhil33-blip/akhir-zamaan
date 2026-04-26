// modules/ollama.js
// Local Ollama HTTP client for all LLM tasks (script, visual plan, metadata,
// topics, modern context). Uses gpt-oss:120b-cloud by default — OpenAI's
// open-weight 120B model hosted by Ollama Cloud, unlimited and free for the user.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL_PRIMARY = process.env.OLLAMA_MODEL || 'gpt-oss:120b-cloud';
const MODEL_FALLBACK = process.env.OLLAMA_MODEL_FALLBACK || 'llama2:latest';

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'prompts', `${name}.md`), 'utf8');
}

function extractJSON(text) {
  if (!text) throw new Error('Empty Ollama response');
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object in Ollama response');
  const slice = s.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`Failed to parse Ollama JSON: ${e.message}\nRaw: ${slice.slice(0, 500)}...`);
  }
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

// Calls Ollama /api/chat with one message. Retries transient network errors.
async function callOllamaOnce({ model, systemInstruction, userPrompt, temperature = 0.85, jsonMode = true, timeoutMs = 240000 }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    options: { temperature },
  };
  if (jsonMode) body.format = 'json';

  const resp = await axios.post(`${OLLAMA_HOST}/api/chat`, body, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: (s) => s === 200,
  });
  const content = resp.data && resp.data.message && resp.data.message.content;
  if (!content) throw new Error(`Ollama returned no content. Body keys: ${Object.keys(resp.data || {}).join(',')}`);
  return content;
}

async function callOllama(args, { maxAttempts = 3, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callOllamaOnce(args);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxAttempts) throw err;
      const wait = Math.min(20000, baseDelayMs * Math.pow(2, attempt - 1));
      console.warn(`[ollama] ${args.model} transient error (${err.code || (err.response && err.response.status) || '?'}: ${(err.message || '').slice(0, 120)}) — retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function generateAndParseJSON(args) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const promptForAttempt = attempt === 1
      ? args.userPrompt
      : `${args.userPrompt}\n\nIMPORTANT: Your previous response failed JSON parsing. Return STRICT, COMPLETE JSON. No trailing commas. No markdown fences. Every opening bracket/brace matched. Just JSON.`;
    try {
      const text = await callOllama({ ...args, userPrompt: promptForAttempt });
      return extractJSON(text);
    } catch (err) {
      if (attempt === 2 || !/JSON|parse|Unexpected/i.test(err.message || '')) throw err;
      console.warn(`[ollama] JSON parse failed (${err.message.slice(0, 120)}) — retrying once with strict reminder`);
    }
  }
}

async function generateScript({ topic, sources, modernContext, nextTopic }) {
  const systemInstruction = loadPrompt('script-engine');
  const userPrompt = [
    `<topic>\n${JSON.stringify(topic, null, 2)}\n</topic>`,
    `<sources>\n${JSON.stringify(sources, null, 2)}\n</sources>`,
    `<modern_context>\n${JSON.stringify(modernContext, null, 2)}\n</modern_context>`,
    `<next_topic>\n${JSON.stringify({ title: nextTopic && nextTopic.title }, null, 2)}\n</next_topic>`,
    '',
    'Generate the full script JSON exactly per the schema in your instructions. No markdown wrapping. Pure JSON.',
  ].join('\n\n');
  return await generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.85 });
}

function countScriptWords(script) {
  const parts = [script.cold_open, script.naming, script.excavation, script.mirror, script.haunting];
  return parts
    .filter(Boolean)
    .map((s) => String(s).replace(/\[PAUSE\]/gi, ' ').trim().split(/\s+/).filter(Boolean).length)
    .reduce((a, b) => a + b, 0);
}

async function generateVisualPlan({ script }) {
  const systemInstruction = loadPrompt('visual-architect');
  const words = countScriptWords(script);
  const targetBeats = Math.max(40, Math.min(90, Math.round(words / 27)));
  const approxMinutes = (words / 150).toFixed(1);
  const userPrompt = [
    `<script>\n${JSON.stringify(script, null, 2)}\n</script>`,
    `<target>`,
    `  word_count: ${words}`,
    `  approx_minutes: ${approxMinutes}`,
    `  target_beat_count: ${targetBeats}`,
    `</target>`,
    '',
    `Produce EXACTLY ${targetBeats} beats (±3 is acceptable). Every beat covers 25-30 words of script so the total matches the narration length. Do not invent filler beats; do not over-compress either.`,
    '',
    'Generate the storyboard JSON exactly per the schema in your instructions. No markdown wrapping. Pure JSON.',
  ].join('\n');
  return await generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.7 });
}

async function generateMetadata({ script, visualPlan, sources, topic }) {
  const systemInstruction = loadPrompt('metadata-engine');
  const userPrompt = [
    `<topic>\n${JSON.stringify(topic, null, 2)}\n</topic>`,
    `<script>\n${JSON.stringify(script, null, 2)}\n</script>`,
    `<visual_plan>\n${JSON.stringify(visualPlan, null, 2)}\n</visual_plan>`,
    `<sources>\n${JSON.stringify(sources, null, 2)}\n</sources>`,
    '',
    'Generate the metadata JSON exactly per the schema in your instructions. No markdown wrapping. Pure JSON.',
  ].join('\n\n');
  return await generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.7 });
}

async function generateNewTopics({ existingCount, recentTopicsSample, highestIds }) {
  const systemInstruction = loadPrompt('topic-generator');
  const userPrompt = [
    `<existing_topic_count>\n${JSON.stringify(existingCount, null, 2)}\n</existing_topic_count>`,
    `<recent_topics_sample>\n${JSON.stringify(recentTopicsSample, null, 2)}\n</recent_topics_sample>`,
    `<highest_ids>\n${JSON.stringify(highestIds, null, 2)}\n</highest_ids>`,
    '',
    'Generate 30 new topics in the JSON format specified. No markdown wrapping. Pure JSON.',
  ].join('\n\n');
  return await generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.9 });
}

// Modern context without web search grounding. The model must produce patterns
// and tech/cultural shifts from its training knowledge plus general reasoning
// about the topic.
async function findModernContext({ topicTheme, modernAngle }) {
  const systemInstruction = `You are a research assistant for a documentary channel that diagnoses modern life through the lens of Islamic end-times prophecy.

Your job is to surface the psychological, behavioral, and cultural patterns in modern life that the given Islamic topic illuminates. You may also reference real-world technologies, cultural shifts, or events from your training knowledge — but ONLY ones you are confident actually exist (TikTok, deepfakes, OnlyFans, crypto, ChatGPT, Ozempic, Gaza war, Ukraine war, etc.). Never fabricate dates or events. If unsure of a date, omit the year field.

The OUTPUT must be a single JSON object — no prose around it.`;
  const userPrompt = `Topic theme: ${topicTheme}
Modern angle: ${modernAngle || '(none)'}

Return a JSON object with TWO keys:

{
  "events": [
    { "year": 2024, "event": "specific event with date if confident, 1-2 sentences", "thematic_link": "one sentence on why this mirrors the Islamic topic" },
    ...8-10 entries, diverse (tech, geopolitics, culture, economics, religion, health, media). Omit "year" if unsure.
  ],
  "patterns": [
    { "pattern": "short name for the behavior", "manifestation": "how it shows up in modern life with specific brands/platforms if known", "why_it_matters": "one sentence on the psychological or spiritual dimension this reveals" },
    ...5-7 entries
  ]
}

Return ONLY the JSON object. No prose around it. No markdown fences.`;
  try {
    const parsed = await generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.5 });
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
    };
  } catch (err) {
    console.warn('[ollama] modern context failed:', err.message);
    return { events: [], patterns: [] };
  }
}

module.exports = {
  generateScript,
  generateVisualPlan,
  generateMetadata,
  generateNewTopics,
  findModernContext,
  extractJSON,
  MODEL_PRIMARY,
  MODEL_FALLBACK,
};
