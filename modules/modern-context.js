// modules/modern-context.js
// Asks the LLM for 4–6 real 2023–2026 events + behavioral patterns that mirror the topic theme.
// Same content-policy filter as research.js applies here — even when Tavily
// isn't configured and we fall back to the LLM's training memory, the
// celebrity / pop-culture banlist still scrubs the output.

const { findModernContext } = require('./llm');
const policy = require('./content-policy');

async function getModernContext(topic) {
  const theme = topic.theme || topic.title || '';
  const angle = topic.modern_angle || topic.context || '';
  if (!theme) return { events: [], patterns: [] };
  try {
    const result = await findModernContext({ topicTheme: theme, modernAngle: angle });
    const rawEvents = (result.events || []).slice(0, 10);
    const rawPatterns = (result.patterns || []).slice(0, 7);
    const events = policy.filterSynthesizedEvents(rawEvents);
    const patterns = policy.filterSynthesizedPatterns(rawPatterns);
    const dropped = (rawEvents.length - events.length) + (rawPatterns.length - patterns.length);
    if (dropped) {
      console.warn(`[modern-context] post-filter dropped ${dropped} entries that leaked banned names`);
    }
    return { events, patterns };
  } catch (err) {
    console.warn('[modern-context] failed:', err.message);
    return { events: [], patterns: [] };
  }
}

module.exports = { getModernContext };
