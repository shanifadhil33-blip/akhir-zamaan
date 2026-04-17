// setup-youtube.js
// One-time OAuth helper. Run: node setup-youtube.js
// 1. Reads YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET from .env
// 2. Opens browser to Google consent page (youtube.upload + youtube.force-ssl scopes)
// 3. Listens on localhost:8765 for the OAuth callback
// 4. Exchanges code for a refresh token
// 5. Prints the refresh token for you to paste into .env + GitHub Secrets

require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
const REDIRECT_URI = 'http://localhost:8765/oauth2callback';
const PORT = 8765;

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.warn('[setup] could not auto-open browser. Paste the URL yourself:\n', url); });
}

async function main() {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    console.error('ERROR: YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set in .env first.');
    console.error('See SETUP.md for how to create them in Google Cloud Console.');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n=== AKHIR ZAMAAN — YouTube OAuth Setup ===\n');
  console.log('Opening your browser to the Google consent page...');
  console.log('If it does not open automatically, paste this URL into your browser:\n');
  console.log(authUrl);
  console.log('');

  const server = http.createServer(async (req, res) => {
    try {
      const full = new URL(req.url, `http://localhost:${PORT}`);
      if (full.pathname !== '/oauth2callback') {
        res.writeHead(404); res.end('Not found'); return;
      }
      const code = full.searchParams.get('code');
      const error = full.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(`<h1>Error</h1><pre>${error}</pre><p>Close this tab and try again.</p>`);
        server.close();
        console.error('[setup] OAuth error:', error);
        process.exit(1);
      }
      if (!code) {
        res.writeHead(400); res.end('Missing code'); return;
      }
      const { tokens } = await oauth2.getToken(code);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<h1>Success</h1><p>You can close this tab. Check your terminal for the refresh token.</p>`);
      server.close();

      if (!tokens.refresh_token) {
        console.error('\n[setup] No refresh token returned. Try revoking access at https://myaccount.google.com/permissions and rerun.\n');
        process.exit(1);
      }

      console.log('\n=== YOUR REFRESH TOKEN ===\n');
      console.log(tokens.refresh_token);
      console.log('\n=== PASTE THIS INTO .env ===\n');
      console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\nAlso add it as a GitHub Secret named YOUTUBE_REFRESH_TOKEN.\n');
      process.exit(0);
    } catch (err) {
      console.error('[setup] exchange failed:', err.message);
      res.writeHead(500); res.end('Token exchange failed');
      server.close();
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`[setup] listening on http://localhost:${PORT} for OAuth callback...\n`);
    openBrowser(authUrl);
  });
}

main();
