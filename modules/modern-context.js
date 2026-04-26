// modules/modern-context.js
// Asks the LLM for 4–6 real 2023–2026 events + behavioral patterns that mirror the topic theme.

const { findModernContext } = require('./llm');

async function getModernContext(topic) {
  const theme = topic.theme || topic.title || '';
  const angle = topic.modern_angle || topic.context || '';
  if (!theme) return { events: [], patterns: [] };
  try {
    const result = await findModernContext({ topicTheme: theme, modernAngle: angle });
    return {
      events: (result.events || []).slice(0, 10),
      patterns: (result.patterns || []).slice(0, 7),
    };
  } catch (err) {
    console.warn('[modern-context] failed:', err.message);
    return { events: [], patterns: [] };
  }
}

module.exports = { getModernContext };
