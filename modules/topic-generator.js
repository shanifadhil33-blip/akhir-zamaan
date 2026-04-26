// modules/topic-generator.js
// Auto-refills topics-queue.json when remaining < threshold.

const { generateNewTopics } = require('./llm');
const queue = require('./queue');

async function refillIfLow() {
  const autoRefill = String(process.env.AUTO_TOPIC_REFILL || 'true') === 'true';
  if (!autoRefill) return { refilled: false, reason: 'AUTO_TOPIC_REFILL=false' };

  const threshold = parseInt(process.env.TOPIC_REFILL_THRESHOLD || '20', 10);
  const remaining = queue.getRemainingCount();
  if (remaining >= threshold) return { refilled: false, reason: `remaining=${remaining} >= threshold=${threshold}` };

  console.log(`[topic-gen] queue low (${remaining} unpublished, threshold ${threshold}); generating 30 new topics...`);

  const existingCount = queue.getExistingCount();
  const highestIds = queue.getHighestIds();
  const recentTopicsSample = queue.getRecentTopics(30);

  const result = await generateNewTopics({ existingCount, recentTopicsSample, highestIds });
  const newTopics = (result && Array.isArray(result.topics)) ? result.topics : [];
  if (!newTopics.length) return { refilled: false, reason: 'LLM returned no topics' };

  const added = queue.appendTopics(newTopics);
  console.log(`[topic-gen] added ${added} new topics (skipped ${newTopics.length - added} as duplicates)`);
  return { refilled: true, added, total_remaining: queue.getRemainingCount() };
}

module.exports = { refillIfLow };
