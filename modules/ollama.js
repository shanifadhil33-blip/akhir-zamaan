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
  if (code === 'OLLAMA_EMPTY_RESPONSE') return true;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED') return true;
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  return false;
}

function makeOllamaEmptyResponseError(data) {
  const keys = Object.keys(data || {}).join(',');
  const doneReason = data && data.done_reason;
  const evalCount = data && data.eval_count;
  const err = new Error(`Ollama returned no content (done_reason=${doneReason || 'unknown'}, eval_count=${evalCount ?? 'unknown'}). Body keys: ${keys}`);
  err.code = 'OLLAMA_EMPTY_RESPONSE';
  err.doneReason = doneReason;
  return err;
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
  if (!content || !String(content).trim()) throw makeOllamaEmptyResponseError(resp.data);
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
  const maxJsonAttempts = args.maxJsonAttempts || 3;
  for (let attempt = 1; attempt <= maxJsonAttempts; attempt++) {
    const promptForAttempt = attempt === 1
      ? args.userPrompt
      : `${args.userPrompt}\n\nIMPORTANT: Your previous response failed or returned empty content. Return STRICT, COMPLETE JSON. No trailing commas. No markdown fences. Every opening bracket/brace matched. Just JSON.`;
    try {
      const text = await callOllama({ ...args, userPrompt: promptForAttempt });
      return extractJSON(text);
    } catch (err) {
      if (attempt === maxJsonAttempts || !/JSON|parse|Unexpected|Empty|no content/i.test(err.message || '')) throw err;
      console.warn(`[ollama] JSON response failed (${err.message.slice(0, 120)}) - retry ${attempt}/${maxJsonAttempts} with strict reminder`);
    }
  }
}

// Script-tier JSON wrapper. Used by the chunked script generator
// (skeleton + 5 movements + metadata-extract) for narrative-heavy calls.
// Identical to generateAndParseJSON today — kept as a separate function
// so future provider swaps for the script tier (e.g. streaming Cloudflare,
// Claude/OpenAI API, etc.) only need to touch this one function instead of
// rewriting every call site.
async function generateAndParseJSONForScript(args) {
  return generateAndParseJSON(args);
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
      console.warn(`[script] ${spec.key} attempt ${attempt}: response missing the "${spec.key}" key`);
      continue;
    }
    const words = text.replace(/\[PAUSE\]/gi, ' ').trim().split(/\s+/).filter(Boolean).length;
    console.log(`[script] ${spec.key} attempt ${attempt}: ${words} words (need ≥ ${spec.minWords})`);
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
  console.log(`[script-gen] chunked mode, provider: ollama (${MODEL_PRIMARY})`);

  // Step 1 — skeleton (titles, mood, planned arc)
  const skeleton = await generateScriptSkeleton({ topic, sources, modernContext, nextTopic });
  console.log(`[script] skeleton: mood=${skeleton.mood}, title="${(skeleton.title_options || [])[0] || ''}"`);

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
  console.log(`[script] chunked script complete: ${totalWords} words across 5 movements`);

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

function countWords(text) {
  return String(text || '').replace(/\[PAUSE\]/gi, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function compactWords(text, maxWords) {
  return String(text || '')
    .replace(/\[PAUSE\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ');
}

function fallbackPromptForMovement(movementKey, segment) {
  const theme = compactWords(segment, 16);
  const base = {
    cold_open: 'A solitary modern man awake in phone light, apartment shadows, anxious reflection in dark glass',
    naming: 'Ancient manuscript pages reflected over a modern city, a man recognizing a spiritual warning',
    excavation: 'Cinematic desert ruins and present-day streets merging, hidden patterns revealed through light and shadow',
    mirror: 'A lone man facing his reflection in a city window, split between comfort and repentance',
    haunting: 'Quiet dawn over an empty prayer space, one figure carrying an unresolved question',
  }[movementKey] || 'Cinematic Islamic documentary scene, modern life and ancient warning intertwined';

  return `${base}, visual metaphor for "${theme}"`.slice(0, 240);
}

function buildFallbackVisualMeta(script) {
  const title = (script.title_options && script.title_options[0]) || 'Akhir Zamaan';
  return {
    aesthetic_style_string: script.mood === 'painterly_islamic'
      ? 'painterly Islamic realism, warm light, detailed texture'
      : 'cinematic realism, high contrast, deep shadows, subtle gold light',
    thumbnail: {
      background_prompt: `Dramatic cinematic Islamic scene inspired by "${title}", single human silhouette, high contrast, no text`,
      title_overlay: compactWords(title, 5).toUpperCase() || 'AKHIR ZAMAAN',
      accent_color: '#D6B25E',
    },
    shorts_segment: { start_beat: 1, end_beat: 12, reason: 'Opening section has the clearest hook.' },
  };
}

function buildFallbackBeatsForMovement({ movementKey, movementText, beatTarget, beatNumberStart }) {
  const cleanText = String(movementText || '')
    .replace(/\[PAUSE\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleanText.split(/\s+/).filter(Boolean);
  const target = Math.max(1, beatTarget || Math.ceil(words.length / 9) || 1);
  const beats = [];

  for (let i = 0; i < target; i++) {
    const start = Math.floor((i * words.length) / target);
    const end = Math.max(start + 1, Math.floor(((i + 1) * words.length) / target));
    const segment = words.slice(start, end).join(' ') || compactWords(cleanText, 12);
    beats.push({
      beat_number: beatNumberStart + i,
      script_segment: segment,
      duration_estimate_seconds: 3.8,
      image_prompt: fallbackPromptForMovement(movementKey, segment),
      caption_emphasis: compactWords(segment, 4),
      verse_overlay: false,
      fallback_visual_plan: true,
    });
  }

  return beats;
}

function normalizeBeatsForMovement({ beats, movementKey, movementText, beatTarget, beatNumberStart }) {
  const source = Array.isArray(beats) ? beats : [];
  const normalized = [];
  for (let i = 0; i < source.length; i++) {
    const beat = source[i];
    if (!beat || typeof beat !== 'object') continue;
    const segment = compactWords(beat.script_segment || movementText, 24);
    normalized.push({
      beat_number: beatNumberStart + normalized.length,
      script_segment: segment,
      duration_estimate_seconds: clampNumber(beat.duration_estimate_seconds, 3, 5, 3.8),
      image_prompt: compactWords(beat.image_prompt, 35) || fallbackPromptForMovement(movementKey, segment),
      caption_emphasis: compactWords(beat.caption_emphasis || segment, 4),
      verse_overlay: !!beat.verse_overlay,
      fallback_visual_plan: !!beat.fallback_visual_plan,
    });
  }

  const minimumUsable = Math.max(1, Math.floor((beatTarget || 1) * 0.7));
  if (normalized.length < minimumUsable) {
    console.warn(`[visual-plan] ${movementKey}: only ${normalized.length} usable beats; using deterministic fallback`);
    return buildFallbackBeatsForMovement({ movementKey, movementText, beatTarget, beatNumberStart });
  }

  return normalized;
}

function trimTitle(text, maxLen = 68) {
  const title = String(text || 'Akhir Zamaan').replace(/\s+/g, ' ').trim();
  if (title.length <= maxLen) return title;
  return `${title.slice(0, maxLen - 1).replace(/\s+\S*$/, '')}...`;
}

function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildFallbackChapters(script) {
  const movements = [
    { key: 'cold_open', label: 'The Question You Avoided' },
    { key: 'naming', label: 'What He Called It' },
    { key: 'excavation', label: 'The Pattern Beneath It' },
    { key: 'mirror', label: 'Where It Finds You' },
    { key: 'haunting', label: 'The Choice Tonight' },
  ];
  let elapsed = 0;
  return movements.map((m, index) => {
    const time = index === 0 ? '0:00' : formatTimestamp(elapsed);
    elapsed += (countWords(script[m.key]) / 150) * 60;
    return { time, label: m.label };
  });
}

function sourceLabel(source) {
  if (!source || typeof source !== 'object') return '';
  return source.reference || source.ref || source.id || source.title || '';
}

function buildFallbackMetadata({ script, sources, topic }) {
  const title = trimTitle((script.title_options && script.title_options[0]) || (topic && topic.title) || 'Akhir Zamaan');
  const chapters = buildFallbackChapters(script);
  const sourceRefs = [
    ...((sources && sources.verses) || []),
    ...((sources && sources.hadith) || []),
  ].map(sourceLabel).filter(Boolean);
  const sourceLines = sourceRefs.length
    ? sourceRefs.map((s) => `- ${s}`).join('\n')
    : '- Quran and hadith sources retrieved for this topic';
  const chapterLines = chapters.map((c) => `${c.time} ${c.label}`).join('\n');
  const question = script.pinned_comment_question || 'What part of this warning feels closest to your life right now?';
  const description = [
    compactWords(script.cold_open, 24) || 'A quiet warning can sit inside ordinary modern life.',
    'This reflection connects authenticated Islamic sources to the patterns we are living through now.',
    '',
    'SOURCES REFERENCED IN THIS VIDEO:',
    sourceLines,
    '',
    'CHAPTERS:',
    chapterLines,
    '',
    'ABOUT THIS CHANNEL:',
    'Akhir Zamaan presents authenticated verses and hadith from primary Islamic sources, woven into cinematic reflections on the modern condition. We do not issue fatwa. We invite reflection.',
    '',
    `COMMENT below: ${question}`,
    '',
    'DISCLAIMER:',
    'This channel presents authenticated verses and hadith from primary sources. All interpretations are general reflections, not formal fatwa. For specific religious guidance, consult a qualified scholar.',
    '',
    '#islam #endtimes #qiyamah #akhirzamaan #quran #hadith #signsofqiyamah #islamicreminder',
  ].join('\n');

  return {
    title,
    description,
    tags: [
      'islam',
      'end times islam',
      'qiyamah signs',
      'signs of the hour',
      'akhir zamaan',
      'quran',
      'hadith',
      'islamic reminder',
      'prophetic warnings',
      'islamic eschatology',
      'last days islam',
      'deen',
      'faith',
    ],
    chapters,
    category_id: 27,
    default_language: 'en',
    default_audio_language: 'en',
    fallback_metadata: true,
  };
}

async function generateVisualPlanMeta({ script, words, approxMinutes }) {
  const systemInstruction = loadPrompt('visual-architect');
  const userPrompt = [
    `<script>\n${JSON.stringify(script, null, 2)}\n</script>`,
    `<target>\n  word_count: ${words}\n  approx_minutes: ${approxMinutes}\n</target>`,
    '',
    'PLANNING PHASE ONLY. Do not generate any beats yet. Return JSON with these top-level keys only:',
    '{',
    '  "aesthetic_style_string": "5-10 word suffix to append to every beat\'s image prompt — sets the consistent visual language",',
    '  "thumbnail": { "background_prompt": "dramatic image prompt", "title_overlay": "3-6 words ALL CAPS, most clickable phrase", "accent_color": "#hex" },',
    '  "shorts_segment": { "start_beat": int, "end_beat": int, "reason": "why these beats make a strong vertical short" }',
    '}',
    '',
    'No beats array. Pure JSON. No markdown.',
  ].join('\n');
  return generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.7 });
}

async function generateBeatsForMovement({ movementKey, movementText, aesthetic, beatTarget, beatNumberStart }) {
  const systemInstruction = loadPrompt('visual-architect');
  const userPrompt = [
    `<aesthetic_style>\n${aesthetic}\n</aesthetic_style>`,
    `<movement_key>${movementKey}</movement_key>`,
    `<movement_text>\n${movementText}\n</movement_text>`,
    `<target_beat_count>${beatTarget}</target_beat_count>`,
    `<beat_number_start>${beatNumberStart}</beat_number_start>`,
    '',
    `Generate EXACTLY ${beatTarget} beats covering only the <movement_text> above (±2 acceptable). Each beat covers ~8-10 words ≈ 3-4 seconds. beat_number starts at ${beatNumberStart} and increments by 1 for each subsequent beat. Append <aesthetic_style> as a suffix to every image_prompt for visual consistency.`,
    '',
    'Schema:',
    '{',
    '  "beats": [',
    '    {',
    '      "beat_number": int,',
    '      "script_segment": "exact words from this movement covered by this beat",',
    '      "duration_estimate_seconds": float (3.0-5.0),',
    '      "image_prompt": "15-35 words, ending with the aesthetic style suffix",',
    '      "caption_emphasis": "1-4 words pulled from the script_segment",',
    '      "verse_overlay": false',
    '    }',
    '  ]',
    '}',
    '',
    'Set verse_overlay to true ONLY for beats where a Quranic verse from the script is being recited (max 3 across the whole video). Pure JSON. No markdown.',
  ].join('\n');
  // Per-movement output is at most ~90 beats × 60 tokens = 5400 tokens. Generous cap to be safe.
  return generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.7, numPredict: 16384 });
}

async function generateVisualPlan({ script }) {
  const words = countScriptWords(script);
  // Beat count: one beat per ~18 words ≈ 7-8 seconds per image. Min 80, max 150.
  // Original spec was 3-4 sec/beat (one per 9 words), but that produced 350-400
  // beats for a 22-min video, and free-tier image providers (Cloudflare Workers
  // AI + Pollinations fallback) cannot sustain that volume — sustained 429s
  // with shared cooldowns cause the image stage to take 5+ hours. 7-8 sec per
  // beat is the realistic ceiling that ships videos. Override via env if you
  // upgrade to a paid image tier.
  const beatsPerWord = parseFloat(process.env.BEAT_DENSITY) || (1 / 18);
  const minBeats = parseInt(process.env.MIN_BEATS, 10) || 80;
  const maxBeats = parseInt(process.env.MAX_BEATS, 10) || 150;
  const targetBeats = Math.max(minBeats, Math.min(maxBeats, Math.round(words * beatsPerWord)));
  const approxMinutes = (words / 150).toFixed(1);

  console.log(`[visual-plan] chunked mode, target ${targetBeats} beats across 5 movements`);

  // Step 1 — meta (aesthetic, thumbnail, shorts_segment). Small JSON, single call.
  let meta;
  try {
    meta = await generateVisualPlanMeta({ script, words, approxMinutes });
  } catch (err) {
    console.warn(`[visual-plan] meta generation failed (${err.message}) - using deterministic fallback`);
    meta = buildFallbackVisualMeta(script);
  }
  console.log(`[visual-plan] meta: aesthetic="${(meta.aesthetic_style_string || '').slice(0, 60)}..."`);

  // Step 2 — beats per movement. Distribute target proportional to movement length.
  const movements = [
    { key: 'cold_open', text: script.cold_open || '' },
    { key: 'naming', text: script.naming || '' },
    { key: 'excavation', text: script.excavation || '' },
    { key: 'mirror', text: script.mirror || '' },
    { key: 'haunting', text: script.haunting || '' },
  ];
  const wordsByMovement = movements.map((m) => countWords(m.text));
  const totalMovementWords = wordsByMovement.reduce((a, b) => a + b, 0) || 1;

  const allBeats = [];
  for (let i = 0; i < movements.length; i++) {
    const m = movements[i];
    const w = wordsByMovement[i];
    const beatTarget = Math.max(10, Math.round((w / totalMovementWords) * targetBeats));
    const beatNumberStart = allBeats.length + 1;
    let result;
    try {
      result = await generateBeatsForMovement({
        movementKey: m.key,
        movementText: m.text,
        aesthetic: meta.aesthetic_style_string || '',
        beatTarget,
        beatNumberStart,
      });
    } catch (err) {
      console.warn(`[visual-plan] ${m.key} generation failed (${err.message}) - using deterministic fallback`);
      result = { beats: buildFallbackBeatsForMovement({ movementKey: m.key, movementText: m.text, beatTarget, beatNumberStart }) };
    }
    const movementBeats = normalizeBeatsForMovement({
      beats: result.beats,
      movementKey: m.key,
      movementText: m.text,
      beatTarget,
      beatNumberStart,
    });
    console.log(`[visual-plan] ${m.key}: ${movementBeats.length} beats (target ${beatTarget}, ${w} words)`);
    allBeats.push(...movementBeats);
  }

  console.log(`[visual-plan] complete: ${allBeats.length} beats total (target ${targetBeats})`);
  return {
    aesthetic_style_string: meta.aesthetic_style_string || '',
    thumbnail: meta.thumbnail || {},
    shorts_segment: meta.shorts_segment || {},
    beats: allBeats,
  };
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
  try {
    return await generateAndParseJSON({ model: MODEL_PRIMARY, systemInstruction, userPrompt, temperature: 0.7 });
  } catch (err) {
    console.warn(`[metadata] generation failed (${err.message}) - using deterministic fallback`);
    return buildFallbackMetadata({ script, visualPlan, sources, topic });
  }
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
