// scripts/check-cloudflare-token.js
// Local-only token health check. Reads CLOUDFLARE_API_TOKEN from .env and
// reports anything that would cause the runner's HTTP layer to reject it.
// The token value itself is NEVER printed in full — only diagnostic counts
// and char codes. Run with: node scripts/check-cloudflare-token.js

require('dotenv').config();

const raw = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

console.log('--- CLOUDFLARE_ACCOUNT_ID ---');
if (!accountId) {
  console.log('  NOT SET in .env');
} else {
  const trimmed = accountId.trim();
  console.log(`  length: ${accountId.length}`);
  console.log(`  trimmed length: ${trimmed.length}`);
  console.log(`  has surrounding whitespace: ${accountId.length !== trimmed.length}`);
  console.log(`  hex format (32 chars, 0-9a-f): ${/^[0-9a-f]{32}$/i.test(trimmed)}`);
  console.log(`  starts with: ${trimmed.slice(0, 4)}…`);
  console.log(`  ends with:   …${trimmed.slice(-4)}`);
}

console.log('\n--- CLOUDFLARE_API_TOKEN ---');
if (!raw) {
  console.log('  NOT SET in .env');
  process.exit(1);
}

const trimmed = raw.trim();
const issues = [];

console.log(`  length: ${raw.length}`);
console.log(`  trimmed length: ${trimmed.length}`);
console.log(`  starts with: ${trimmed.slice(0, 4)}…`);
console.log(`  ends with:   …${trimmed.slice(-4)}`);

if (raw.length !== trimmed.length) {
  issues.push(`Has surrounding whitespace (${raw.length - trimmed.length} char(s) trimmed). The .trim() in code handles this, but cleaner to fix.`);
}

if (trimmed.length < 30) {
  issues.push(`Token looks too short (${trimmed.length} chars). Cloudflare API tokens are usually ~40 chars. Did the paste get truncated?`);
}

if (trimmed.length > 80) {
  issues.push(`Token looks too long (${trimmed.length} chars). Did extra content (description text, multiple tokens) get pasted?`);
}

const allowed = /^[A-Za-z0-9_\-]+$/;
if (!allowed.test(trimmed)) {
  issues.push('Contains characters outside [A-Za-z0-9_-]. Listing offending positions/codes:');
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    const code = trimmed.charCodeAt(i);
    if (!/[A-Za-z0-9_\-]/.test(c)) {
      const display = code < 32 || code > 126 ? `(non-printable, code ${code})` : `'${c}' (code ${code})`;
      issues.push(`    pos ${i}: ${display}`);
    }
  }
}

if (issues.length === 0) {
  console.log('\n✓ Token looks clean. If Cloudflare still 401s, the token may be invalid/revoked.');
  console.log('  Verify by hitting the API directly:');
  console.log(`  curl -sS -H "Authorization: Bearer <token>" https://api.cloudflare.com/client/v4/user/tokens/verify`);
  process.exit(0);
} else {
  console.log('\n✗ Issues found:');
  for (const m of issues) console.log(`  - ${m}`);
  console.log('\nFix: re-paste the token cleanly in GitHub Secrets AND in .env.');
  process.exit(1);
}
