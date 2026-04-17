// modules/gemini.js
// Thin wrapper around @google/generative-ai for script, visual plan, metadata, topic generation.
// Auto-degrades from Pro -> Flash on rate limit if GEMINI_AUTO_DEGRADE=true.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const MODEL_PRO = 'gemini-2.5-pro';
const MODEL_FLASH = 'gemini-2.5-flash';

function client() {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error('GOOGLE_AI_API_KEY missing in .env');
  return new GoogleGenerativeAI(key);
}

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'prompts', `${name}.md`), 'utf8');
}

function extractJSON(text) {
  if (!text) throw new Error('Empty Gemini response');
  let s = text.trim();
  // Strip markdown code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // Find first { to last }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object in Gemini response');
  const slice = s.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`Failed to parse Gemini JSON: ${e.message}\nRaw: ${slice.slice(0, 500)}...`);
  }
}

function isRateLimitError(err) {
  const msg = (err && err.message) || '';
  return /429|rate|quota|exceed/i.test(msg);
}

async function callModel({ modelName, systemInstruction, userPrompt, temperature = 0.85, useSearch = false }) {
  const ai = client();
  const config = {
    model: modelName,
    systemInstruction,
    generationConfig: {
      temperature,
      responseMimeType: useSearch ? 'text/plain' : 'application/json',
    },
  };
  if (useSearch) {
    config.tools = [{ googleSearch: {} }];
  }
  const model = ai.getGenerativeModel(config);
  const result = await model.generateContent(userPrompt);
  const text = result.response.text();
  return text;
}

async function callWithFallback({ preferredModel, ...args }) {
  const autoDegrade = String(process.env.GEMINI_AUTO_DEGRADE || 'true') === 'true';
  try {
    return await callModel({ modelName: preferredModel, ...args });
  } catch (err) {
    if (autoDegrade && preferredModel === MODEL_PRO && isRateLimitError(err)) {
      console.warn('[gemini] Pro rate-limited; degrading to Flash for this call');
      return await callModel({ modelName: MODEL_FLASH, ...args });
    }
    throw err;
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
  const text = await callWithFallback({ preferredModel: MODEL_PRO, systemInstruction, userPrompt, temperature: 0.85 });
  return extractJSON(text);
}

async function generateVisualPlan({ script }) {
  const systemInstruction = loadPrompt('visual-architect');
  const userPrompt = `<script>\n${JSON.stringify(script, null, 2)}\n</script>\n\nGenerate the storyboard JSON exactly per the schema in your instructions. No markdown wrapping. Pure JSON.`;
  const text = await callWithFallback({ preferredModel: MODEL_FLASH, systemInstruction, userPrompt, temperature: 0.7 });
  return extractJSON(text);
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
  const text = await callWithFallback({ preferredModel: MODEL_FLASH, systemInstruction, userPrompt, temperature: 0.7 });
  return extractJSON(text);
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
  const text = await callWithFallback({ preferredModel: MODEL_FLASH, systemInstruction, userPrompt, temperature: 0.9 });
  return extractJSON(text);
}

async function findModernContext({ topicTheme, modernAngle }) {
  const systemInstruction = `You are a research assistant. Find 4-6 specific, verifiable real-world events from 2023-2026 that thematically connect to the given Islamic topic. Use Google Search. Return only verifiable facts. No speculation.`;
  const userPrompt = `Topic theme: ${topicTheme}\nModern angle: ${modernAngle || '(none)'}\n\nFind 4-6 specific real events from 2023-2026 that mirror this theme. Return as JSON array (despite text/plain output): [{"year": 2024, "event": "specific event description with date if possible", "thematic_link": "one sentence on why this connects to the topic"}, ...]\n\nReturn ONLY the JSON array. No prose around it.`;
  try {
    const text = await callWithFallback({ preferredModel: MODEL_FLASH, systemInstruction, userPrompt, temperature: 0.5, useSearch: true });
    // For grounded search, response is text/plain — try to extract JSON array
    let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    const first = s.indexOf('[');
    const last = s.lastIndexOf(']');
    if (first === -1 || last === -1) return [];
    return JSON.parse(s.slice(first, last + 1));
  } catch (err) {
    console.warn('[gemini] modern context failed:', err.message);
    return [];
  }
}

module.exports = {
  generateScript,
  generateVisualPlan,
  generateMetadata,
  generateNewTopics,
  findModernContext,
  extractJSON,
  MODEL_PRO,
  MODEL_FLASH,
};
