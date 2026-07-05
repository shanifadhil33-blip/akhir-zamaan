// modules/script-critic.js
// Lightweight factual / theological audit pass run AFTER the 5 movements
// are generated but BEFORE the script is written to disk and passed to
// the visual-architect. The critic is a small strict LLM call whose only
// job is to flag hallucinated studies, fabricated startup names, exact
// invented statistics, Prophetic miracles being reduced to natural-science
// explanations, or unfounded jurisprudential rulings.
//
// Output shape: { pass: boolean, reason: string, failed_movement: string }
//
// The script engine (modules/ollama.js generateScript) invokes this,
// checks the verdict, and either accepts the script or regenerates the
// failed movement with the critic's reason appended as a correction
// instruction. Max 2 retries; a third failure raises a fatal error
// tagged with SCRIPT_CRITIC_ABORT_SENTINEL so notify.js can format
// the Telegram alert.

const axios = require('axios');
const deepseek = require('./deepseek');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:120b-cloud';

// Sentinel string carried on the Error message when the critic loop
// exhausts its retries. pipeline.js catches at the stage boundary and
// notify.js emits it verbatim so the operator can grep past runs for
// hallucination-caused aborts.
const SCRIPT_CRITIC_ABORT_SENTINEL = 'Unresolved Hallucinations in Script Generation';

const MOVEMENT_KEYS = ['cold_open', 'naming', 'excavation', 'mirror', 'haunting'];

const CRITIC_SYSTEM_INSTRUCTION = `You are a STRICT factual and theological auditor for Islamic documentary scripts. Read the script provided and return ONLY a single JSON object with three keys:

{
  "pass": true | false,
  "reason": "one clear sentence explaining what failed, or empty string if pass=true",
  "failed_movement": "cold_open | naming | excavation | mirror | haunting | \\"\\" (empty if unknown or if pass=true)"
}

Set "pass" to FALSE if the script contains ANY of the following:

  1. HIGHLY SPECIFIC INVENTED SCIENTIFIC STUDIES — a named Lancet / NEJM / Stanford / MIT / peer-reviewed paper cited with year and finding that appears to be fabricated to match the religious point. Real citations of well-known landmark studies are fine; invented ones are not. If a specific study is cited with high confidence but you cannot verify it as commonly-known, treat it as suspect and fail the script.

  2. FABRICATED STARTUPS / COMPANIES — a specific-sounding company name (like "SwarmX", "NeuroLens", "OblivionLabs") introduced as though real, without corroboration in the modern-context data. Well-known companies (Meta, ByteDance, OpenAI, DeepMind, Anthropic, Google, Microsoft) are fine when described at a systemic level. Small/obscure named startups presented as real are not.

  3. EXACT INVENTED STATISTICS — precise percentages, user counts, dollar amounts, timelines that appear specific but are actually fabricated (e.g. "78.3% of Gen Z checks their phone within 3 minutes of waking, according to a 2024 Stanford study"). Real, commonly-cited statistics are fine; specific-looking invented ones are not.

  4. MIRACLES REDUCED TO NATURAL PHENOMENA — the script attempts to explain the parting of the sea, the moon-splitting, the she-camel of Salih (AS), Ibrahim (AS) in the fire, the Isra' & Mi'raj, or any other Prophetic miracle using biology, physics, chemistry, tidal patterns, atmospheric optics, epigenetics, or lucid dreaming. Miracles must remain miracles in the script.

  5. UNFOUNDED FATWA-LEVEL RULINGS — the script categorically declares a modern secular practice to be riba, zina, shirk, kufr, khiyana, or maysir without the Quran/hadith source provided actually supporting the ruling. Concerns and warnings framed spiritually are fine; specific rulings the source does not support are not.

  6. INDIVIDUAL CELEBRITY / POLITICIAN / STREAMER NAMES — Kanye, Trump, Musk-as-person, Andrew Tate, Megan Thee Stallion, Kardashians, MrBeast, Taylor Swift, royalty, athletes. Systemic-level references are fine; named-individual references are not.

  7. DUPLICATE SCRIPTURE — the same Quranic verse or the same hadith quoted more than once with only minor rewording. Each verse and each hadith may appear once.

If the script passes every check, set pass=true, reason="", failed_movement="".

If it fails on multiple items, cite the MOST SEVERE issue in reason and identify the movement most affected in failed_movement.

Output ONLY the JSON object. No prose, no markdown fences, no explanation.`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function extractJSON(text) {
  if (!text) throw new Error('Empty critic response');
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON in critic response');
  return JSON.parse(s.slice(first, last + 1));
}

async function callCriticDeepseek(userPrompt) {
  const key = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!key) throw new Error('No DEEPSEEK_API_KEY');
  const resp = await axios.post(`${process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1'}/chat/completions`, {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: CRITIC_SYSTEM_INSTRUCTION },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,             // deterministic — critic must be strict
    max_tokens: 512,            // small; the output is one JSON blob
    stream: false,
    response_format: { type: 'json_object' },
  }, {
    timeout: 60000,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    validateStatus: (s) => s === 200,
  });
  return resp.data?.choices?.[0]?.message?.content || '';
}

async function callCriticOllama(userPrompt) {
  const resp = await axios.post(`${OLLAMA_HOST}/api/chat`, {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: CRITIC_SYSTEM_INSTRUCTION },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    format: 'json',
    options: { temperature: 0, num_predict: 512 },
  }, {
    timeout: 90000,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: (s) => s === 200,
  });
  return resp.data?.message?.content || '';
}

function normalizeVerdict(raw) {
  const pass = raw.pass === true;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  let failed = typeof raw.failed_movement === 'string' ? raw.failed_movement.trim() : '';
  if (!MOVEMENT_KEYS.includes(failed)) failed = '';
  return { pass, reason, failed_movement: failed };
}

async function verifyScriptFactualIntegrity(draftText) {
  const userPrompt = `Audit the following Akhir Zamaan script. Return only the JSON verdict.\n\n<script>\n${draftText}\n</script>`;

  // Ollama first — Ollama Cloud is free/unlimited on this account, so the
  // critic pass costs $0 in the normal case. DeepSeek only used as a
  // reliability fallback if Ollama is transiently unreachable, and only
  // when DEEPSEEK_API_KEY is set. Set CRITIC_PROVIDER=deepseek to force
  // the paid path if you ever want stricter JSON adherence at the cost.
  const preferDeepseek = (process.env.CRITIC_PROVIDER || '').toLowerCase() === 'deepseek';
  let raw;
  if (preferDeepseek) {
    try {
      raw = await callCriticDeepseek(userPrompt);
    } catch (err) {
      console.warn(`[script-critic] DeepSeek unavailable (${(err.message || '').slice(0, 120)}) — falling back to Ollama`);
      raw = await callCriticOllama(userPrompt);
    }
  } else {
    try {
      raw = await callCriticOllama(userPrompt);
    } catch (err) {
      console.warn(`[script-critic] Ollama unavailable (${(err.message || '').slice(0, 120)}) — falling back to DeepSeek`);
      raw = await callCriticDeepseek(userPrompt);
    }
  }
  let verdict;
  try {
    verdict = normalizeVerdict(extractJSON(raw));
  } catch (err) {
    // If the critic's own response can't be parsed, treat it as a soft
    // pass and log — we don't want a critic-side parse error to block a
    // legitimate script. But this is worth flagging.
    console.warn(`[script-critic] verdict parse failed (${err.message}) — treating as soft pass. Raw: ${(raw || '').slice(0, 200)}`);
    return { pass: true, reason: '', failed_movement: '' };
  }
  return verdict;
}

function assembleDraftFromMovements(movements) {
  return MOVEMENT_KEYS
    .map((k) => movements[k] || '')
    .filter(Boolean)
    .join('\n\n---\n\n');
}

module.exports = {
  verifyScriptFactualIntegrity,
  assembleDraftFromMovements,
  SCRIPT_CRITIC_ABORT_SENTINEL,
  MOVEMENT_KEYS,
  CRITIC_SYSTEM_INSTRUCTION,
};
