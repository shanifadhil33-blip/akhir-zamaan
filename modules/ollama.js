// modules/ollama.js
// Local Ollama HTTP client for all LLM tasks (script, visual plan, metadata,
// topics, modern context). Uses gpt-oss:120b-cloud by default — OpenAI's
// open-weight 120B model hosted by Ollama Cloud, unlimited and free for the user.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const deepseek = require('./deepseek');
const scriptTemplates = require('./script-templates');

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
// Routes to DeepSeek V3 when DEEPSEEK_API_KEY is set — it follows the dense
// script-engine prompt (5 movements, 5 templates, topic-fidelity ratios,
// framing rules) noticeably better than gpt-oss:120b-cloud and the per-script
// cost stays around $0.012 at V3 pricing. Falls back to Ollama silently when
// the key is missing, so the workflow works either way.
async function generateAndParseJSONForScript(args) {
  if (deepseek.deepseekConfigured()) {
    try {
      return await deepseek.generateAndParseJSON({
        systemInstruction: args.systemInstruction,
        userPrompt: args.userPrompt,
        temperature: args.temperature ?? 0.85,
        jsonMode: args.jsonMode !== false,
        maxTokens: args.numPredict || 8192,
      });
    } catch (err) {
      // If DeepSeek fails (auth, quota exhausted, network), drop down to
      // Ollama so the daily run still produces a video. Logged loudly so the
      // operator sees credit-exhaustion in workflow output.
      console.warn(`[script-tier] DeepSeek call failed (${(err.message || '').slice(0, 200)}) — falling back to Ollama`);
    }
  }
  return generateAndParseJSON(args);
}

// Hard floor: 10-minute videos require ≥ 1,500 words at the
// 150-wpm narration rate (×0.95 Kokoro speed buys a small margin too).
// 10-min was the operator's revised target after seeing that 22-min runs
// were overshooting the 150-beat image cap (free tier).
const MIN_SCRIPT_WORDS = 1500;
const MAX_MOVEMENT_ATTEMPTS = 3;

// Per-movement word targets. Sum minimums = ~1,460, sum targets = ~1,780.
// That delivers 10-13 minute videos that match the 150-beat cap at ~5 sec
// average per beat — cinematic without being slideshow.
const MOVEMENT_SPECS = [
  { key: 'cold_open', minWords: 100, targetWords: 130, description: 'Movement 1 — THE COLD OPEN. MANDATORY OPENING STRUCTURE — exactly in this order: (1) GREETING: start with the exact line "Assalamu alaikum, brothers and sisters." Nothing before it, no variation. (2) TOPIC INTRO (1-2 sentences): state what today\'s reflection is about using the <topic>.title and a sentence-long preview of what the video will cover. Example: "Today\'s reflection is on the Dajjal — the great deceiver the Prophet (PBUH) warned us about fourteen hundred years ago. We will look at exactly how he is described in the hadith, and at how those descriptions are unfolding in our world right now." (3) TEMPLATE-SPECIFIC OPENER: then continue with the opening style from the ACTIVE TEMPLATE block — civilizational observation for ca_*/et_*/lst_*/hi_*, wonder/datum-vs-verse for sc_*/dr_*, varied personal scene for ml_*/tc_*. FORBIDDEN in the opener after the greeting: phone/screen/thumb/scroll/notification (except when topic itself is about smartphone addiction); no "It\'s 2 AM, your thumb scrolls" template. (4) PROMISE + DIAGNOSIS: a narrative promise of what\'s coming, then begin framing the topic. End with one line that hints scripture already named what was just described, without revealing what.' },
  { key: 'naming', minWords: 220, targetWords: 270, description: 'Movement 2 — THE NAMING. Name the topic. Reveal the Quranic verse from <sources> that DIRECTLY ADDRESSES THE TOPIC — not a generic "earth is a test" verse pulled from the same surah. For Dajjal topics, pick the verse from <sources> that names Dajjal-related content (Surah Al-Kahf, Ya juj/Ma juj 18:94-99). For end-times sign topics, pick the verse that names that specific sign. Refuse to substitute a tangentially-related verse just because it sits in the same chapter. MANDATORY framing before every quoted verse: `In the Quran, in Surah <surah_name> Ayah <verse_number>, God says: "<verse text>"`. Use the surah_name field from <sources> verbatim (e.g. "Ar-Ra\'d", "Al-Kahf"). The framing is non-negotiable — without it the verse blurs into your prose when the narrator reads it aloud. After the verse, insert [PAUSE], then unpack what the verse ACTUALLY says — do not pivot immediately to a modern symptom. End with: "But this is not the warning. The warning is what comes next."' },
  { key: 'excavation', minWords: 450, targetWords: 540, description: 'Movement 3 — THE EXCAVATION. APPLY THE TOPIC-FIDELITY RATIO from the prompt. For et_* and ca_* Dajjal/Mahdi/end-times topics: ~70% scripture (the actual hadith descriptions of the prophesied event/figure + Quranic context) and ~30% modern parallel. For hi_* historical topics: ~70% Quranic narrative. For sc_*/lst_*/dr_*: ~60% scripture. ONLY for ml_*/tc_* does modern parallel dominate. **DEDUPLICATION RULE (ABSOLUTE):** every Quranic verse you quote may appear in the script ONCE, with ONE analysis. Every hadith may appear ONCE. If you find yourself re-quoting the same hadith with minor rewording two paragraphs later — DELETE that repetition and replace with forward movement. The previous failure case quoted Sahih Muslim 7235 / 7237 / 7239 (all the same Gog/Magog narration with minor textual variants) three times back-to-back. Pick ONE narration and move on. **MODERN-GROUNDING POLICY:** modern parallels MUST be at the SYSTEMIC level — biometric surveillance rollouts, algorithmic echo chambers, cognitive-decline studies. ABSOLUTELY NO individual celebrities (no Kanye, no Megan Thee Stallion, no Tory Lanez, no Weinstein, no Trump, no Musk-as-person, no Kardashian, no Taylor Swift, no royalty, no athletes, no streamers). If a previous draft mentioned them, rewrite at the systemic level. FORBIDDEN: reducing the Dajjal to a metaphor for AI/the algorithm; reducing Babel to a metaphor for skyscrapers. **ESCHATOLOGICAL SEQUENCE:** if you discuss Major Signs (Dajjal, Mahdi, Isa AS, Gog/Magog, Beast/Dabbat al-Ard, sun from west, Dukhan), keep them in their distinct prophetic order; do not collapse them. The Beast is not Gog and Magog; the Mahdi is not the Dajjal. MANDATORY framings: new verse → `In the Quran, in Surah <surah_name> Ayah <verse_number>, God says: "..."`. New hadith → `In a hadith narrated in <collection> (Book X, Hadith Y), the Prophet ﷺ said: "..."`. Pattern interrupt every 45 seconds.' },
  { key: 'mirror', minWords: 370, targetWords: 440, description: 'Movement 4 — THE MIRROR. [STRUCTURE_PLACEHOLDER] Modern parallels woven in MUST be at the SYSTEMIC level (algorithms, biometrics, surveillance infrastructure, attention economy, cognitive impacts) — never named celebrities, athletes, politicians, royalty, streamers. If your draft mentions a specific person by name (Kanye, Trump, Musk-as-person, etc.) rewrite at the systemic level.' },
  { key: 'haunting', minWords: 320, targetWords: 400, description: 'Movement 5 — THE HAUNTING. Close with a reflection that does not resolve. A question he carries for 24 hours. A specific image of the man he becomes if he chooses correctly — and the man he becomes if he doesn\'t. In the final 30-45 seconds: a quiet tease for the next video by name, plus subscribe CTA woven in as part of the haunting (never marketing).' },
];

// Build the system instruction by appending the topic's active script template
// to the base script-engine prompt. Each topic in topics-queue.json declares a
// `script_template` field (or falls back to category default). The template
// block carries voice/structure/ratio guidance specific to the topic type —
// without it, every script collapses to the same modern-life voice regardless
// of category.
function buildSystemInstructionForTopic(topic) {
  const base = loadPrompt('script-engine');
  const tpl = scriptTemplates.resolveTemplate(topic);
  return `${base}\n\n---\n\n# ACTIVE SCRIPT TEMPLATE FOR THIS RUN\n\nThe topic declares \`script_template: "${tpl.name}"\`. The template block below OVERRIDES any conflicting guidance earlier in this prompt. Follow it precisely.\n${tpl.block}`;
}

// Five Movement 4 (THE MIRROR) structures. Operator caught the "Version A vs.
// Version B of the man you could become" framing being used in EVERY video.
// The deterministic hash below rotates per topic ID so consecutive videos
// land on different structures. The "two-versions" option is still in the
// rotation but is now 1-in-5 instead of 5-in-5.
const MIRROR_STRUCTURES = {
  'two-versions': 'Pivot to the listener\'s life right now. Make him face what he has been avoiding. Build to ONE existential decision he must make. Frame the choice as the contrast between two specific versions of the man he could become — one who chooses one path, one who chooses the other. Make each version concrete: what does each man\'s next week, his next Fajr, his next conversation actually look like? ONE choice, not a checklist of habits.',
  'haunting-question': 'Pivot to the listener\'s life right now. Do NOT frame the movement as a choice between two versions of himself — instead, build to ONE rhetorical question the listener cannot dodge, and leave it unanswered. The question must be specific to this script\'s topic (not generic). Surround the question with the modern context that makes it inescapable, then leave it sitting in silence. End the movement WITHOUT resolving it. The unresolved question IS the mirror.',
  'historical-mirror': 'Pivot to the listener\'s life — but the structure of this movement is a STRICT PARALLEL between a specific moment in a Prophet\'s life from the Quranic narrative and the listener\'s exact 2026 situation. Walk the listener through what that Prophet (named in the Quran — Yusuf, Musa, Ibrahim, Maryam, etc.) faced at that moment: the temptation, the doubt, the test. Then show the listener that he is standing in the same kind of moment right now, with different tools but the same test. The Prophet\'s response IS the mirror. End with the listener understanding which side of that exact moment he is standing on right now.',
  'direct-command': 'Pivot to the listener\'s life — and unlike the other Movement 4 structures, this one does not offer a choice. It issues ONE clear command for the listener to act on TONIGHT, before he sleeps. Not three habits. Not a 7-day plan. ONE specific action that is doable in the next four hours: pray two rakats of tahajjud, open Surah Al-Kahf, sit in silence for ten minutes without a screen. Tie the command to the topic\'s verse — explain why scripture demands exactly this action in response to what was just diagnosed. The command is the mirror — the listener\'s response to it (do or refuse) reveals where he stands.',
  'time-pivot': 'Pivot to the listener\'s life — but stage the movement in the FUTURE, not the present. Walk him through the next 72 hours of his life as they will unfold IF he changes nothing after watching this video. Specific scenes: Friday night, the next time he picks up his phone, the next Jumu\'ah he attends without intention, the next missed Fajr. Then, in the final third of the movement, pivot to the future as it COULD unfold if a single thing about him changes tonight. No "Version A / Version B" labels — just the temporal contrast. The future IS the mirror.',
};

function pickMirrorStructure(topic) {
  // Deterministic rotation: hash the topic ID into one of the 5 structures.
  // Same topic always gets the same structure (reproducible). Consecutive
  // queue picks land on different structures because the prefixes and
  // numbers differ. The "two-versions" structure is in the rotation but no
  // longer the default for every script.
  const id = (topic && topic.id) || '';
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  const keys = Object.keys(MIRROR_STRUCTURES);
  const chosen = keys[Math.abs(hash) % keys.length];
  return { name: chosen, instruction: MIRROR_STRUCTURES[chosen] };
}

function injectMirrorStructure(spec, topic) {
  if (spec.key !== 'mirror') return spec;
  const m = pickMirrorStructure(topic);
  return {
    ...spec,
    description: spec.description.replace('[STRUCTURE_PLACEHOLDER]', `STRUCTURE FOR THIS SCRIPT: ${m.name}. ${m.instruction}`),
  };
}

async function generateMovement({ spec, skeleton, previousMovements, topic, sources, modernContext, nextTopic }) {
  // For Movement 4 (mirror), swap the [STRUCTURE_PLACEHOLDER] with one of
  // five rotating Movement 4 structures, chosen deterministically per topic
  // ID. This breaks the "Version A vs. Version B" template the previous
  // Movement 4 spec hardcoded.
  spec = injectMirrorStructure(spec, topic);
  const systemInstruction = buildSystemInstructionForTopic(topic);
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
  const systemInstruction = buildSystemInstructionForTopic(topic);
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
  // Beat count: one beat per ~12 words ≈ 4-5 seconds per image on a 10-13 min
  // video. Min 80, max 150 (the free-tier image-provider sustainable ceiling).
  // For 1,500-2,000 word scripts that's 125-150 beats — fits the cap with room
  // for the LLM to overshoot slightly without truncation. Each beat's actual
  // duration varies (visual-architect prompt asks for meaning-aligned beats),
  // so individual beats can be 2-3 sec or 7-8 sec — only the AVERAGE matches.
  const beatsPerWord = parseFloat(process.env.BEAT_DENSITY) || (1 / 12);
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
  const contentPolicy = require('./content-policy');
  const systemInstruction = `You are a research assistant for a documentary channel that diagnoses modern life through the lens of Islamic end-times prophecy.

Your job is to surface the SYSTEMIC psychological, behavioral, and cultural patterns in modern life that the given Islamic topic illuminates. You may reference real-world technologies, cultural shifts, or macro-events from your training knowledge — but ONLY ones you are confident actually exist (TikTok as a platform, deepfake technology, the smartphone economy, ChatGPT, biometric ID systems, central bank digital currencies, the Gaza war, the Ukraine war, the COVID lockdowns, etc.). Never fabricate dates or events. If unsure of a date, omit the year field.

The OUTPUT must be a single JSON object — no prose around it.

${contentPolicy.POLICY_PROMPT_BLOCK}`;
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
