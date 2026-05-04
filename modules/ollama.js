// modules/ollama.js
// Local Ollama HTTP client for all LLM tasks (script, visual plan, metadata,
// topics, modern context). Uses gpt-oss:120b-cloud by default — OpenAI's
// open-weight 120B model hosted by Ollama Cloud, unlimited and free for the user.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const deepseek = require('./deepseek');

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
// num_predict: 8192 prevents premature truncation. The default of -1 should
// be unlimited but the gpt-oss:120b-cloud route appears to cap responses
// closer to ~2K tokens, which truncates long scripts.
async function callOllamaOnce({ model, systemInstruction, userPrompt, temperature = 0.85, jsonMode = true, timeoutMs = 240000, numPredict = 8192 }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    options: { temperature, num_predict: numPredict },
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

// Script-tier router. When DEEPSEEK_API_KEY is set, all script-generation
// calls (skeleton, the 5 movements, metadata extract) go to DeepSeek V3 —
// it produces dramatically better narrative prose than gpt-oss:120b-cloud.
// When DeepSeek is not configured, falls back to Ollama with the same shape
// so the rest of the pipeline doesn't care which provider answered.
async function generateAndParseJSONForScript(args) {
  const useDeepSeek = deepseek.configured();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const promptForAttempt = attempt === 1
      ? args.userPrompt
      : `${args.userPrompt}\n\nIMPORTANT: Your previous response failed JSON parsing. Return STRICT, COMPLETE JSON. No trailing commas. No markdown fences. Every opening bracket/brace matched. Just JSON.`;
    try {
      const text = useDeepSeek
        ? await deepseek.call({
            systemInstruction: args.systemInstruction,
            userPrompt: promptForAttempt,
            temperature: args.temperature,
            jsonMode: true,
          })
        : await callOllama({ ...args, userPrompt: promptForAttempt });
      return extractJSON(text);
    } catch (err) {
      if (attempt === 2 || !/JSON|parse|Unexpected/i.test(err.message || '')) throw err;
      const provider = useDeepSeek ? 'deepseek' : 'ollama';
      console.warn(`[${provider}] JSON parse failed (${err.message.slice(0, 120)}) — retrying once with strict reminder`);
    }
  }
}

// Hard floor: 15-minute videos require ≥ 2,250 words at the
// 150-wpm narration rate (×0.95 Kokoro speed buys a small margin too).
const MIN_SCRIPT_WORDS = 2250;
const MAX_MOVEMENT_ATTEMPTS = 3;

// Per-movement word targets. Sum minimums = 2,500, sum targets = 2,800.
const MOVEMENT_SPECS = [
  { key: 'cold_open', minWords: 200, targetWords: 225, description: 'Movement 1 — THE COLD OPEN. Open inside the listener\'s life: a specific modern moment (scrolling, 3 AM dread, a thing he did this week and lied to himself about). NO mention of Islam yet, NO verse yet — just diagnosis of his current behavior. End with one line that hints the Quran/Prophet ﷺ already named what he is feeling, without revealing what.' },
  { key: 'naming', minWords: 400, targetWords: 450, description: 'Movement 2 — THE NAMING. Name the disease. Reveal the verse or hadith from <sources> cinematically — as the moment of recognition the listener has been waiting for without knowing it. Quote exactly. Strip away the comfortable interpretation. Make him understand it has always been about him, not historical figures. End with: "But this is not the warning. The warning is what comes next."' },
  { key: 'excavation', minWords: 750, targetWords: 825, description: 'Movement 3 — THE EXCAVATION. Go deeper into the source. Reveal a second verse/hadith from <sources> if available. Show how the Prophets faced the same trial in their own lives — but in a way that mirrors the listener\'s exact situation. Weave 2-3 modern parallels from <modern_context> seamlessly. Pattern interrupt every 60 seconds: rhetorical question, contradiction of the listener\'s assumption, sudden pivot.' },
  { key: 'mirror', minWords: 600, targetWords: 675, description: 'Movement 4 — THE MIRROR. Pivot to the listener\'s life right now in 2026. Make him face what he\'s been avoiding. Use modern parallels from <modern_context> to show the Prophetic warning is happening to him this week. Build to ONE existential decision he must make — NOT a 5-step checklist, NOT three habits. ONE choice. Frame as the choice between two versions of the man he could become.' },
  { key: 'haunting', minWords: 550, targetWords: 625, description: 'Movement 5 — THE HAUNTING. Close with a reflection that does not resolve. A question he carries for 24 hours. A specific image of the man he becomes if he chooses correctly — and the man he becomes if he doesn\'t. In the final 60 seconds: a quiet tease for the next video by name, plus subscribe CTA woven in as part of the haunting (never marketing).' },
];

async function generateMovement({ spec, skeleton, previousMovements, topic, sources, modernContext, nextTopic }) {
  const systemInstruction = loadPrompt('script-engine');
  const previousText = Object.entries(previousMovements)
    .map(([k, v]) => `<${k}>\n${v}\n</${k}>`)
    .join('\n\n');

  const baseUserPrompt = [
    `<topic>\n${JSON.stringify(topic, null, 2)}\n</topic>`,
    `<sources>\n${JSON.stringify(sources, null, 2)}\n</sources>`,
    `<modern_context>\n${JSON.stringify(modernContext, null, 2)}\n</modern_context>`,
    `<next_topic>\n${JSON.stringify({ title: nextTopic && nextTopic.title }, null, 2)}\n</next_topic>`,
    `<chosen_mood>${skeleton.mood} — ${skeleton.mood_reason}</chosen_mood>`,
    `<chosen_title>${(skeleton.title_options || [])[0] || ''}</chosen_title>`,
    previousText ? `<previous_movements>\n${previousText}\n</previous_movements>` : '',
    '',
    `WRITE ONLY ONE MOVEMENT: ${spec.key.toUpperCase()}.`,
    spec.description,
    '',
    `LENGTH: this movement MUST be ≥ ${spec.minWords} words (target ${spec.targetWords}). Insert [PAUSE] every 2-4 sentences for cinematic pacing. Continue naturally from any <previous_movements> shown above.`,
    '',
    `Return JSON: { "${spec.key}": "...the movement text in full..." }. No other keys. No markdown wrapping. Pure JSON.`,
  ].filter(Boolean).join('\n\n');

  for (let attempt = 1; attempt <= MAX_MOVEMENT_ATTEMPTS; attempt++) {
    const userPrompt = attempt === 1
      ? baseUserPrompt
      : `${baseUserPrompt}\n\nPREVIOUS ATTEMPT WAS TOO SHORT. Do not summarize. Slow down. Add another paradox pair, another rhetorical question, another concrete modern detail. The movement MUST be at least ${spec.minWords} words.`;
    const result = await generateAndParseJSONForScript({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.85 });
    const text = result[spec.key];
    if (!text || typeof text !== 'string') {
      console.warn(`[ollama] ${spec.key} attempt ${attempt}: response missing the "${spec.key}" key`);
      continue;
    }
    const words = text.replace(/\[PAUSE\]/gi, ' ').trim().split(/\s+/).filter(Boolean).length;
    console.log(`[ollama] ${spec.key} attempt ${attempt}: ${words} words (need ≥ ${spec.minWords})`);
    if (words >= spec.minWords) return text;
    if (attempt === MAX_MOVEMENT_ATTEMPTS) {
      // Accept short on final attempt — total-script floor will catch overall shortfall
      return text;
    }
  }
}

async function generateScriptSkeleton({ topic, sources, modernContext, nextTopic }) {
  const systemInstruction = loadPrompt('script-engine');
  const userPrompt = [
    `<topic>\n${JSON.stringify(topic, null, 2)}\n</topic>`,
    `<sources>\n${JSON.stringify(sources, null, 2)}\n</sources>`,
    `<modern_context>\n${JSON.stringify(modernContext, null, 2)}\n</modern_context>`,
    `<next_topic>\n${JSON.stringify({ title: nextTopic && nextTopic.title }, null, 2)}\n</next_topic>`,
    '',
    'PLANNING PHASE ONLY. Do not write any movement text yet. Return JSON with these keys only:',
    '',
    '{',
    '  "title_options": [5 candidate titles, each <60 chars, curiosity-gap, no clickbait lies],',
    '  "mood": "cinematic_realism | painterly_islamic | dark_cinematic",',
    '  "mood_reason": "one sentence explaining why this mood fits this topic",',
    '  "planned_arc": "3-4 sentence outline of how the 5 movements connect dramatically",',
    '  "core_recognition": "the one psychological truth the viewer must walk away with"',
    '}',
    '',
    'No markdown wrapping. Pure JSON.',
  ].join('\n\n');
  return generateAndParseJSONForScript({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.7 });
}

async function extractScriptMetadata({ topic, skeleton, movements, sources, nextTopic }) {
  const systemInstruction = `You are extracting metadata from an already-written script. Read the movements carefully and return strict JSON. Do not invent or add content — only extract what the writer already wove in.`;
  const userPrompt = [
    `<topic>\n${JSON.stringify(topic, null, 2)}\n</topic>`,
    `<sources>\n${JSON.stringify(sources, null, 2)}\n</sources>`,
    `<chosen_title>${(skeleton.title_options || [])[0] || ''}</chosen_title>`,
    `<next_topic_title>${(nextTopic && nextTopic.title) || ''}</next_topic_title>`,
    `<script_movements>\n${JSON.stringify(movements, null, 2)}\n</script_movements>`,
    '',
    'Return JSON:',
    '{',
    '  "next_video_tease": "the line in haunting that teases the next topic by name",',
    '  "pinned_comment_question": "one provocative question about the script\'s themes — should make viewers argue with themselves in comments",',
    '  "modern_parallels_used": ["list every modern event/thing referenced in the movements"],',
    '  "sources_quoted": ["list every verse/hadith reference quoted exactly, e.g. \\"Quran 18:54\\", \\"Sahih Muslim 2937\\""],',
    '  "verses_for_recitation": [',
    '    {',
    '      "reference": "18:54",',
    '      "arabic": "exact Arabic text if provided in <sources>",',
    '      "translation": "exact English translation as provided in <sources>",',
    '      "movement": "naming | excavation"',
    '    }',
    '  ]',
    '}',
    '',
    'Maximum 3 entries in verses_for_recitation. Only include verses actually quoted in the movements. No markdown. Pure JSON.',
  ].join('\n\n');
  return generateAndParseJSONForScript({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.4 });
}

async function generateScript({ topic, sources, modernContext, nextTopic }) {
  const provider = deepseek.configured() ? `deepseek (${deepseek.MODEL_DEFAULT})` : `ollama (${MODEL_PRIMARY})`;
  console.log(`[script-gen] chunked mode, provider: ${provider}`);

  // Step 1 — skeleton (titles, mood, planned arc)
  const skeleton = await generateScriptSkeleton({ topic, sources, modernContext, nextTopic });
  console.log(`[ollama] skeleton: mood=${skeleton.mood}, title="${(skeleton.title_options || [])[0] || ''}"`);

  // Step 2 — each movement, sequentially, with previous movements as context
  const movements = {};
  for (const spec of MOVEMENT_SPECS) {
    movements[spec.key] = await generateMovement({
      spec,
      skeleton,
      previousMovements: movements,
      topic,
      sources,
      modernContext,
      nextTopic,
    });
  }

  // Step 3 — extract metadata from finished movements
  const meta = await extractScriptMetadata({ topic, skeleton, movements, sources, nextTopic });

  const script = {
    title_options: skeleton.title_options || [],
    mood: skeleton.mood,
    mood_reason: skeleton.mood_reason,
    cold_open: movements.cold_open,
    naming: movements.naming,
    excavation: movements.excavation,
    mirror: movements.mirror,
    haunting: movements.haunting,
    next_video_tease: meta.next_video_tease || '',
    pinned_comment_question: meta.pinned_comment_question || '',
    modern_parallels_used: meta.modern_parallels_used || [],
    sources_quoted: meta.sources_quoted || [],
    verses_for_recitation: meta.verses_for_recitation || [],
  };

  const totalWords = countScriptWords(script);
  console.log(`[ollama] chunked script complete: ${totalWords} words across 5 movements`);

  if (totalWords < MIN_SCRIPT_WORDS) {
    throw new Error(`Chunked script only produced ${totalWords} words (need ≥ ${MIN_SCRIPT_WORDS}). Topic "${topic.title}" left in queue for next run.`);
  }
  return script;
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
  // Aim for one beat per ~9 words ≈ 3.5 seconds per image. Min 100, max 400
  // so an 18-min script gets ~310 beats and a 15-min script gets ~250.
  // Operator spec: image changes every 3-4 seconds aligned to sentence meaning.
  const targetBeats = Math.max(100, Math.min(400, Math.round(words / 9)));
  const approxMinutes = (words / 150).toFixed(1);
  const baseUserPrompt = [
    `<script>\n${JSON.stringify(script, null, 2)}\n</script>`,
    `<target>`,
    `  word_count: ${words}`,
    `  approx_minutes: ${approxMinutes}`,
    `  target_beat_count: ${targetBeats}`,
    `  seconds_per_beat: 3-4`,
    `</target>`,
    '',
    `Produce EXACTLY ${targetBeats} beats (±10 is acceptable, no fewer). Each beat covers ~8-10 words ≈ 3-4 seconds — every sentence or short clause gets its own image. The image changes constantly, in sync with the meaning of each phrase. Beats MUST align with sentence/clause boundaries. NEVER compress multiple ideas into one long static beat.`,
    '',
    'Generate the storyboard JSON exactly per the schema in your instructions. No markdown wrapping. Pure JSON.',
  ].join('\n');

  // Validate count and retry once if the model under-delivered.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userPrompt = attempt === 1
      ? baseUserPrompt
      : `${baseUserPrompt}\n\nYOUR PREVIOUS RESPONSE HAD TOO FEW BEATS. The image will sit on screen for too long and feel static. Generate AT LEAST ${Math.round(targetBeats * 0.85)} beats. Break the script into smaller chunks of 12-15 words each.`;
    // num_predict 32K so the JSON for ~310 beats doesn't truncate.
    // Each beat ≈ 60 tokens; default 8K cap only fits ~133 beats.
    const plan = await generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.7, numPredict: 32768 });
    const got = (plan.beats || []).length;
    console.log(`[ollama] visual plan attempt ${attempt}: ${got} beats (target ${targetBeats})`);
    if (got >= targetBeats * 0.7 || attempt === 2) return plan;
    console.warn(`[ollama] visual plan too few beats (${got}/${targetBeats}), retrying`);
  }
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
