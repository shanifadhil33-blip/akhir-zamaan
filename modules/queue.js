// modules/queue.js
// Topic queue management + dedup via published.json.

const fs = require('fs');
const path = require('path');

const QUEUE_PATH = path.join(__dirname, '..', 'topics-queue.json');
const PUBLISHED_PATH = path.join(__dirname, '..', 'published.json');

function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) {
    throw new Error('topics-queue.json missing');
  }
  const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : (data.topics || []);
}

function saveQueue(topics) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(topics, null, 2), 'utf8');
}

function loadPublished() {
  if (!fs.existsSync(PUBLISHED_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(PUBLISHED_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function savePublished(list) {
  fs.writeFileSync(PUBLISHED_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function getNextTopic() {
  const queue = loadQueue();
  const published = loadPublished();
  const publishedIds = new Set(published.map((p) => p.id));
  const unpublished = queue.filter((t) => !publishedIds.has(t.id));
  if (unpublished.length === 0) return { topic: null, next: null, remaining: 0 };
  const topic = unpublished[0];
  const next = unpublished[1] || null;
  return { topic, next, remaining: unpublished.length };
}

function markPublished(topic, videoId, url) {
  const published = loadPublished();
  published.push({
    id: topic.id,
    title: topic.title,
    videoId,
    url,
    publishedAt: new Date().toISOString(),
  });
  savePublished(published);
}

function getPublishedCount() {
  return loadPublished().length;
}

function getHighestIds() {
  const queue = loadQueue();
  const highest = { et: 0, pr: 0, s: 0, th: 0 };
  for (const t of queue) {
    const m = /^([a-z]+)_(\d+)$/.exec(t.id || '');
    if (!m) continue;
    const prefix = m[1];
    const num = parseInt(m[2], 10);
    if (highest[prefix] !== undefined && num > highest[prefix]) highest[prefix] = num;
  }
  return {
    et: `et_${highest.et}`,
    pr: `pr_${highest.pr}`,
    s: `s_${highest.s}`,
    th: `th_${highest.th}`,
  };
}

function getExistingCount() {
  const queue = loadQueue();
  const count = { et: 0, pr: 0, s: 0, th: 0, total: queue.length };
  for (const t of queue) {
    const m = /^([a-z]+)_\d+$/.exec(t.id || '');
    if (m && count[m[1]] !== undefined) count[m[1]]++;
  }
  return count;
}

function getRecentTopics(n = 30) {
  const queue = loadQueue();
  return queue.slice(-n);
}

function appendTopics(newTopics) {
  const queue = loadQueue();
  const existingIds = new Set(queue.map((t) => t.id));
  const filtered = newTopics.filter((t) => t.id && !existingIds.has(t.id));
  const merged = [...queue, ...filtered];
  saveQueue(merged);
  return filtered.length;
}

function getRemainingCount() {
  const queue = loadQueue();
  const published = loadPublished();
  const publishedIds = new Set(published.map((p) => p.id));
  return queue.filter((t) => !publishedIds.has(t.id)).length;
}

module.exports = {
  getNextTopic,
  markPublished,
  getPublishedCount,
  getRemainingCount,
  getHighestIds,
  getExistingCount,
  getRecentTopics,
  appendTopics,
  loadQueue,
  loadPublished,
};
