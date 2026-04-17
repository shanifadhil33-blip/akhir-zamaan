// modules/notify.js
// Telegram error notifications. Silent no-op if env vars missing or errors-only mode suppresses success.

const axios = require('axios');

const TG_API = 'https://api.telegram.org';

function configured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function send(text) {
  if (!configured()) return false;
  const url = `${TG_API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }, { timeout: 10000 });
    return true;
  } catch (e) {
    console.warn('[notify] telegram send failed:', e.message);
    return false;
  }
}

async function notifyError({ stage, error, topic }) {
  const msg = [
    '🚨 <b>Akhir Zamaan pipeline FAILED</b>',
    '',
    `<b>Stage:</b> ${stage || 'unknown'}`,
    topic ? `<b>Topic:</b> ${topic.id || ''} — ${topic.title || ''}` : '',
    '',
    `<pre>${String(error && error.message ? error.message : error).slice(0, 2500)}</pre>`,
  ].filter(Boolean).join('\n');
  return send(msg);
}

// Errors-only mode: success notifications are no-ops by default.
async function notifyPublished() { return false; }
async function notifyReview() { return false; }

module.exports = { notifyError, notifyPublished, notifyReview, send, configured };
