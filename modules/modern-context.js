// modules/modern-context.js
// Wraps Gemini grounded search to find 4–6 real 2023–2026 events that mirror the topic theme.

const { findModernContext } = require('./gemini');

async function getModernContext(topic) {
  const theme = topic.theme || topic.title || '';
  const angle = topic.modern_angle || topic.context || '';
  if (!theme) return [];
  try {
    const events = await findModernContext({ topicTheme: theme, modernAngle: angle });
    return Array.isArray(events) ? events.slice(0, 6) : [];
  } catch (err) {
    console.warn('[modern-context] failed:', err.message);
    return [];
  }
}

module.exports = { getModernContext };
