// modules/research.js
// Real-world research via Tavily Search API. Replaces the training-knowledge-only
// modern context with current web results — recent news, real statistics,
// 2026 events that mirror the topic theme. Free tier: 1000 searches/month.
//
// Flow:
//  1. Ask the LLM to generate 5-6 specific search queries from the topic
//  2. Run those queries against Tavily in parallel
//  3. Ask the LLM to synthesize the results into the modern_context shape
//     (events + patterns) the script-engine expects
//
// If TAVILY_API_KEY isn't set, this module is a no-op and the caller falls
// back to the LLM-only modern-context module.

const axios = require('axios');
const ollama = require('./ollama');
const policy = require('./content-policy');

const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_TIMEOUT_MS = 30000;
const PARALLEL_SEARCHES = 6;

function tavilyConfigured() {
  return !!(process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY.trim());
}

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY.trim();
  const resp = await axios.post(TAVILY_URL, {
    api_key: apiKey,
    query,
    search_depth: 'advanced',
    max_results: 5,
    include_answer: true,
    include_raw_content: false,
  }, {
    timeout: TAVILY_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: (s) => s === 200,
  });
  return {
    query,
    answer: resp.data.answer || '',
    results: (resp.data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: (r.content || '').slice(0, 800), // cap each result so the synthesis prompt stays small
    })),
  };
}

async function generateSearchQueries(topic) {
  // One small LLM call to plan smart queries from the topic.
  const systemInstruction = `You generate web search queries for a documentary research pipeline. Output strict JSON only.\n\n${policy.POLICY_PROMPT_BLOCK}`;
  const userPrompt = `Topic: ${topic.title}
Theme: ${topic.theme || ''}
Modern angle: ${topic.context || ''}

Generate up to ${PARALLEL_SEARCHES} specific Google-style search queries that surface SYSTEMIC modern content related to this Islamic topic — technological shifts at scale, behavioral patterns at the platform level, cognitive findings, geopolitical macro-events, scientific discoveries. Each query targets a DIFFERENT angle.

Approved query styles (mix of these):
- Systemic tech: "biometric mass surveillance rollout 2025"
- Cognitive research: "attention span decline studies 2024 2025"
- Statistics: "global loneliness epidemic research"
- Macro events: "central bank digital currency timeline"
- Algorithmic patterns: "recommendation system echo chamber research"
- Scientific: "cosmic background radiation latest findings"

FORBIDDEN query styles (the LLM has produced these before; reject):
- Named celebrity controversies (e.g. "Kanye West antisemitism", "Megan Thee Stallion Tory Lanez")
- Hollywood / pop-culture incidents (e.g. "Will Smith Oscar slap", "Kim Kardashian divorce")
- Named political-personality scandals (e.g. "Trump trial", "Biden gaffes")
- Sports / royalty / streamer drama
If a query is about a NAMED INDIVIDUAL'S controversy, rewrite it at the SYSTEMIC level. ("Twitter mob attacks on Kanye" → "platform-scale public shaming campaigns 2024-2025".)

IF the topic is purely spiritual / historical / jurisprudential (e.g. the Quran's specific verses on Yusuf, the rulings of Surah An-Nur, the Quranic account of Pharaoh's tower) AND no modern technological / systemic angle naturally fits, return an EMPTY queries array. Forced modern parallels on sacred-text topics break the channel's gravity. The script-engine can run on scripture alone — that is the correct outcome, not a gap.

Return JSON only:
{ "queries": ["query 1", "query 2", ... ] }  // can be 0 to ${PARALLEL_SEARCHES} queries — empty is acceptable`;

  const data = await ollama.extractJSON(
    await callRaw({ systemInstruction, userPrompt, temperature: 0.6 })
  );
  const raw = Array.isArray(data.queries) ? data.queries : [];
  // Post-filter: drop any query that leaked a banned celebrity / personality name
  // despite the prompt warning.
  return raw.filter((q) => {
    if (policy.containsBannedName(q)) {
      console.warn(`[research] dropping query (banned name): ${q}`);
      return false;
    }
    return true;
  }).slice(0, PARALLEL_SEARCHES);
}

// Light wrapper because the export shape of ollama.js doesn't expose callOllama
// directly. We re-implement the minimum needed for this module.
async function callRaw({ systemInstruction, userPrompt, temperature }) {
  const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:120b-cloud';
  const resp = await axios.post(`${OLLAMA_HOST}/api/chat`, {
    model: MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    format: 'json',
    options: { temperature, num_predict: 2048 },
  }, { timeout: 120000, validateStatus: (s) => s === 200 });
  return resp.data && resp.data.message && resp.data.message.content;
}

async function synthesizeContext({ topic, searches }) {
  // Trim down the search results so the synthesis prompt isn't massive.
  // Also strip individual search-result entries that leak banned celebrity
  // names before the LLM ever sees them — defense in depth.
  const trimmedSearches = searches.map((s) => ({
    query: s.query,
    answer: (s.answer || '').slice(0, 400),
    snippets: s.results
      .filter((r) => !policy.containsBannedName(`${r.title} ${r.content}`))
      .map((r) => `${r.title}: ${r.content}`.slice(0, 400)),
  })).filter((s) => s.snippets.length > 0 || s.answer);

  const systemInstruction = `You are a research synthesizer for a documentary channel. You read raw web search results and distill them into concrete, verifiable SYSTEMIC events and behavioral patterns. NEVER invent events, dates, or statistics not in the search results. If you can't verify a claim from the snippets, omit it. Output strict JSON only.\n\n${policy.POLICY_PROMPT_BLOCK}`;

  const userPrompt = `Topic: ${topic.title}
Theme: ${topic.theme || ''}
Modern angle: ${topic.context || ''}

I ran ${searches.length} web searches. Here are the results:

${JSON.stringify(trimmedSearches, null, 2)}

Synthesize these into the documentary research format. Cite specifics — brand names, dates, numbers, places, people — only where they appear in the snippets above.

Return JSON:
{
  "events": [
    { "year": 2025, "event": "specific real event with concrete details, 1-2 sentences", "thematic_link": "one sentence on why this mirrors the Islamic topic" },
    ... 8-10 entries, diverse (tech, geopolitics, culture, economics, health, media). Omit "year" if unsure.
  ],
  "patterns": [
    { "pattern": "short name for the behavior", "manifestation": "how it shows up in 2026 with specific brands/platforms when known", "why_it_matters": "one sentence on the psychological or spiritual dimension this reveals" },
    ... 5-7 entries
  ]
}

Pure JSON. No markdown.`;

  const data = await ollama.extractJSON(
    await callRaw({ systemInstruction, userPrompt, temperature: 0.4 })
  );
  // Final guardrail: post-filter the synthesized output. If the LLM ignored
  // the policy block and still produced "Kanye West antisemitism" or similar,
  // drop that entry before it reaches the script-engine. Log loudly so we
  // know the prompt-level filter is leaking.
  const events = policy.filterSynthesizedEvents(data.events);
  const patterns = policy.filterSynthesizedPatterns(data.patterns);
  const droppedEvents = (Array.isArray(data.events) ? data.events.length : 0) - events.length;
  const droppedPatterns = (Array.isArray(data.patterns) ? data.patterns.length : 0) - patterns.length;
  if (droppedEvents || droppedPatterns) {
    console.warn(`[research] post-filter dropped ${droppedEvents} event(s) and ${droppedPatterns} pattern(s) that leaked banned names`);
  }
  return { events, patterns };
}

async function researchTopic(topic) {
  if (!tavilyConfigured()) {
    console.log('[research] TAVILY_API_KEY not set — skipping web research, caller will fall back to LLM-only modern context');
    return null;
  }
  console.log(`[research] generating search queries for: ${topic.title}`);
  let queries;
  try {
    queries = await generateSearchQueries(topic);
  } catch (err) {
    console.warn(`[research] query generation failed: ${err.message}`);
    return null;
  }
  if (!queries.length) {
    console.warn('[research] LLM returned no queries — skipping');
    return null;
  }
  console.log(`[research] running ${queries.length} parallel Tavily searches`);

  // Run all searches in parallel; tolerate individual failures.
  const settled = await Promise.allSettled(queries.map((q) => tavilySearch(q)));
  const searches = settled
    .map((r, i) => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);
  const failed = settled.length - searches.length;
  if (failed > 0) console.warn(`[research] ${failed}/${settled.length} search(es) failed`);
  if (!searches.length) {
    console.warn('[research] all searches failed — skipping');
    return null;
  }

  console.log(`[research] synthesizing context from ${searches.length} search results`);
  try {
    const context = await synthesizeContext({ topic, searches });
    console.log(`[research] synthesized: ${context.events.length} events, ${context.patterns.length} patterns`);
    return { ...context, _source: 'tavily', _queries: queries };
  } catch (err) {
    console.warn(`[research] synthesis failed: ${err.message}`);
    return null;
  }
}

module.exports = { researchTopic, tavilyConfigured };
