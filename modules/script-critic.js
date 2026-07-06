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

const CRITIC_SYSTEM_INSTRUCTION_BASE = `You are a STRICT factual and theological auditor for Islamic documentary scripts. Read the script provided and return ONLY a single JSON object with three keys:

{
  "pass": true | false,
  "reason": "one clear sentence explaining what failed, or empty string if pass=true",
  "failed_movement": "cold_open | naming | excavation | mirror | haunting | \\"\\" (empty if unknown or if pass=true)"
}

Set "pass" to FALSE if the script contains ANY of the following:

  1. UNGROUNDED SPECIFIC CLAIMS — if <grounding_snippets> are provided below, cross-reference EVERY specific modern claim in the script against them: named studies (Lancet 2024, NEJM 2023, Stanford, MIT), specific dates, precise percentages, user counts, dollar amounts, startup names, product names, event descriptions. If the script names a specific study / date / metric / company / event that does NOT appear (in substance) within the grounding snippets, fail the audit — the LLM fabricated it. When grounding snippets are NOT provided (LLM-only fallback context), fall back to plausibility: a suspiciously specific citation the LLM cannot corroborate should still fail.

  2. HIGHLY SPECIFIC INVENTED SCIENTIFIC STUDIES — a named peer-reviewed paper cited with year and finding that appears fabricated to match the religious point. Real landmark studies (Milgram 1963, Zimbardo, well-known Cochrane reviews) may be referenced without grounding snippets; obscure specific studies without grounding coverage must fail.

  3. FABRICATED STARTUPS / COMPANIES — a specific-sounding company name (like "SwarmX", "NeuroLens", "OblivionLabs") introduced as though real, without appearance in the grounding snippets. Well-known companies (Meta, ByteDance, OpenAI, DeepMind, Anthropic, Google, Microsoft) at a systemic level are fine.

  4. EXACT INVENTED STATISTICS — precise percentages, user counts, dollar amounts, timelines that appear specific (e.g. "78.3% of Gen Z checks their phone within 3 minutes of waking, according to a 2024 Stanford study") but cannot be found in the grounding snippets. Conceptual ranges ("hundreds of millions", "the last decade") are fine.

  5. MIRACLES REDUCED TO NATURAL PHENOMENA — the script attempts to explain the parting of the sea, the moon-splitting, the she-camel of Salih (AS), Ibrahim (AS) in the fire, the Isra' & Mi'raj, or any other Prophetic miracle using biology, physics, chemistry, tidal patterns, atmospheric optics, epigenetics, or lucid dreaming. Miracles must remain miracles.

  6. UNFOUNDED FATWA-LEVEL RULINGS — the script categorically declares a modern secular practice to be riba, zina, shirk, kufr, khiyana, or maysir without the Quran/hadith source provided actually supporting the ruling.

  7. INDIVIDUAL CELEBRITY / POLITICIAN / STREAMER NAMES — Kanye, Trump, Musk-as-person, Andrew Tate, Megan Thee Stallion, Kardashians, MrBeast, Taylor Swift, royalty, athletes. Systemic-level references are fine.

  8. DUPLICATE SCRIPTURE — the same Quranic verse or the same hadith quoted more than once with only minor rewording.

If the script passes every check, set pass=true, reason="", failed_movement="".
If it fails on multiple items, cite the MOST SEVERE issue in reason and identify the movement most affected in failed_movement.
Output ONLY the JSON object. No prose, no markdown fences, no explanation.`;

// Kept as an export named after the old constant so any external caller
// continues to work. Now points at the base instruction; the runtime
// prompt is assembled per-call to include grounding snippets when present.
const CRITIC_SYSTEM_INSTRUCTION = CRITIC_SYSTEM_INSTRUCTION_BASE;

// Compact snippet array into a token-frugal block the critic can search
// against. Each snippet keeps just title + content (URLs are omitted
// since the critic doesn't need to fetch, only cross-reference text).
// Overall payload capped at ~2500 chars to keep the critic call well
// under the DeepSeek/Ollama input budget.
function formatGroundingSnippets(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) return '';
  const lines = [];
  let charBudget = 2500;
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i];
    const line = `[snippet ${i + 1}] ${(s.title || '').slice(0, 120)} — ${(s.content || '').slice(0, 300)}`;
    if (charBudget - line.length < 0) break;
    lines.push(line);
    charBudget -= line.length;
  }
  return lines.join('\n');
}

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

async function verifyScriptFactualIntegrity(draftText, groundingSnippets) {
  // Optional second argument — array of { title, content, url, query }
  // preserved by modules/research.js from the Tavily search results. When
  // present the critic cross-references specific claims against these
  // snippets; when absent (Tavily not configured, or LLM-only fallback),
  // the critic still runs but on plausibility judgment alone.
  const groundingBlock = formatGroundingSnippets(groundingSnippets);
  const groundingHeader = groundingBlock
    ? `\n\n<grounding_snippets>\nThe following raw excerpts were pulled from real web sources during research for this script. Cross-reference every specific modern claim (studies, dates, statistics, company names, event descriptions) in the script against them. Claims that name specifics NOT supported by these snippets are hallucinations — fail the audit.\n\n${groundingBlock}\n</grounding_snippets>`
    : `\n\n<grounding_snippets>\n(No web-search grounding available for this run — evaluate on plausibility judgment. A specific-looking citation the LLM cannot corroborate should still fail.)\n</grounding_snippets>`;

  const userPrompt = `Audit the following Akhir Zamaan script. Return only the JSON verdict.${groundingHeader}\n\n<script>\n${draftText}\n</script>`;

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
