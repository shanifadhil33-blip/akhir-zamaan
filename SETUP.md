# SETUP — Akhir Zamaan

Follow these steps **in order**. Each section has checkboxes — tick them as you go. The whole thing takes ~45 minutes.

---

## Part 1 — GitHub account + repo (10 min)

Why: GitHub Actions runs the daily cron for free. The repo is where your code + state (published.json) lives.

- [ ] Go to https://github.com/signup and create an account (use the email `shanifadhil33@gmail.com`)
- [ ] Verify your email
- [ ] Click the **+** button top-right → **New repository**
- [ ] Name: `akhir-zamaan` (or anything you like)
- [ ] Visibility: **Private** (recommended — keeps your prompts/topics private)
- [ ] Do NOT check "Add a README" — we already have files
- [ ] Click **Create repository**

Now push this project folder to GitHub:

```bash
cd "c:/Users/SMART ZONE/Akhir zamaan youtube engine"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/akhir-zamaan.git
git push -u origin main
```

If asked for a password, GitHub will want a **personal access token**, not your password:
1. github.com → top-right avatar → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)
2. Give it `repo` scope + expiration of 1 year
3. Copy it, paste it as the "password" when prompted

- [ ] Repo pushed successfully

---

## Part 2 — Google Cloud project + YouTube Data API (15 min)

Why: We need OAuth credentials so the pipeline can upload videos to your channel.

### 2A. Create Google Cloud project
- [ ] Go to https://console.cloud.google.com (sign in with the same Google account that owns your YouTube channel)
- [ ] Accept terms if prompted
- [ ] Top bar → click the project dropdown → **New Project**
- [ ] Name: `akhir-zamaan`
- [ ] Click **Create**, wait ~30s, make sure it's selected in the dropdown

### 2B. Enable YouTube Data API v3
- [ ] In the left sidebar: **APIs & Services** → **Library**
- [ ] Search "YouTube Data API v3"
- [ ] Click it → click **Enable**

### 2C. Configure OAuth consent screen
- [ ] Left sidebar: **APIs & Services** → **OAuth consent screen**
- [ ] User type: **External** → Create
- [ ] App name: `Akhir Zamaan`
- [ ] User support email: your Gmail
- [ ] Developer contact email: your Gmail
- [ ] Save and continue (leave scopes empty for now)
- [ ] Test users: add your own Gmail (`shanifadhil33@gmail.com`) so YOU can authorize in test mode
- [ ] Save and continue → Back to Dashboard

Your app will stay in "Testing" mode — that's fine. Refresh tokens from test-mode apps expire after 7 days for Google apps, but for YouTube Data API they generally persist. If a token ever stops working, rerun `node setup-youtube.js` to get a new one.

### 2D. Create OAuth client credentials
- [ ] Left sidebar: **APIs & Services** → **Credentials**
- [ ] **+ Create Credentials** → **OAuth client ID**
- [ ] Application type: **Web application**
- [ ] Name: `akhir-zamaan-pipeline`
- [ ] Authorized redirect URIs → **+ Add URI**: `http://localhost:8765/oauth2callback`
- [ ] Click **Create**
- [ ] A modal pops up with **Client ID** and **Client Secret** — copy both

### 2E. Paste into .env
Open `.env` in this folder and fill:
```
YOUTUBE_CLIENT_ID=<paste the client ID>
YOUTUBE_CLIENT_SECRET=<paste the client secret>
```

Save. Do NOT commit `.env` — it is already gitignored.

### 2F. Get the refresh token (one-time)
```bash
npm install
node setup-youtube.js
```

- [ ] Browser opens a Google consent screen
- [ ] Choose your Akhir Zamaan Google account
- [ ] You may see "This app isn't verified" — click **Advanced** → **Go to Akhir Zamaan (unsafe)**. This is your own app, it's fine.
- [ ] Approve the youtube.upload and youtube.force-ssl permissions
- [ ] The terminal prints `YOUTUBE_REFRESH_TOKEN=1//...`
- [ ] Copy it, paste into `.env` on the `YOUTUBE_REFRESH_TOKEN=` line

---

## Part 3 — Add music tracks (5 min)

See [assets/music/README.md](assets/music/README.md). Drop 5–10 halal ambient `.mp3` files into `assets/music/`.

If you skip this, videos still publish — just with voice only, no ambient music bed.

- [ ] At least 5 tracks in `assets/music/`, OR you've accepted voice-only

---

## Part 4 — GitHub Secrets (10 min)

Why: The GitHub Actions cron needs your API keys too. It cannot read your local `.env`.

- [ ] On github.com, open your repo → **Settings** → **Secrets and variables** → **Actions**
- [ ] Click **New repository secret** and add each of these (one at a time):

| Secret name | Value |
|---|---|
| `GOOGLE_AI_API_KEY` | Your Gemini key |
| `YOUTUBE_CLIENT_ID` | From step 2D |
| `YOUTUBE_CLIENT_SECRET` | From step 2D |
| `YOUTUBE_REFRESH_TOKEN` | From step 2F |
| `TELEGRAM_BOT_TOKEN` | (optional — see Part 5) |
| `TELEGRAM_CHAT_ID` | (optional — see Part 5) |

- [ ] All secrets added

---

## Part 5 — Telegram error alerts (optional, 5 min)

Skip this if you don't want error pings.

- [ ] Open Telegram, search `@BotFather`, start chat, type `/newbot`
- [ ] Pick a name like `Akhir Zamaan Alerts Bot`
- [ ] Pick a username ending in `bot`, e.g. `akhir_zamaan_alerts_bot`
- [ ] BotFather gives you a token like `123456:ABC-xyz...` — this is `TELEGRAM_BOT_TOKEN`
- [ ] Open a chat with your new bot and send any message (required to "activate")
- [ ] In a browser: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` — find `"chat":{"id":...}` — that's `TELEGRAM_CHAT_ID`
- [ ] Add both to `.env` and to GitHub Secrets

---

## Part 6 — Test run (5 min)

Before unleashing the daily cron, do one dry run:

```bash
npm run bootstrap-data   # downloads Quran + hadith (one-time, ~50MB)
npm run test-script      # runs pipeline in dry-run mode — stops after script generation
```

This will:
1. Pick the first topic from `topics-queue.json`
2. Load Quran/hadith sources
3. Call Gemini for modern context
4. Call Gemini 2.5 Pro to generate the script
5. Save everything to `output/<timestamp>_<slug>/` and stop there

- [ ] `output/` folder now has a subfolder with `topic.json`, `sources.json`, `modern-context.json`, `script.json`
- [ ] Open `script.json` — read the `cold_open` field. Does it sound like the diagnostic-cinematic voice? Does it feel like Allah speaking directly to the viewer?

If the voice is off, paste the script back to Claude and we tune `prompts/script-engine.md`.

---

## Part 7 — Full end-to-end test (one real video, ~15 min)

Only after the dry run reads well:

```bash
npm start
```

This will run all 10 stages and upload a real video + Short to your YouTube channel. Watch the terminal for progress. If any stage fails, you'll see a Telegram alert (if configured) and the stage name in the error.

- [ ] Video published to @akhirzamaan
- [ ] Short published as well
- [ ] Thumbnail looks clickable

---

## Part 8 — Enable the daily cron

The `.github/workflows/daily.yml` file is already configured to run at **06:00 UTC daily**. Once your code is pushed to GitHub with all secrets in place, it will run automatically every day.

- [ ] Go to your repo → **Actions** tab
- [ ] You should see "Daily Video Pipeline" listed
- [ ] Click it → **Run workflow** button (top right) → Run workflow to trigger a manual test
- [ ] Watch the logs. Full run should take ~20-30 min.
- [ ] If it succeeds, you're fully autonomous.

Tomorrow at 06:00 UTC and every day after, a new video will publish without you touching anything.

---

## Quick reference — what runs where

| Service | What it does | Cost |
|---|---|---|
| Google AI Studio (Gemini) | script, visual, metadata, topic generation | $0 (free tier, Pro ~50 req/day) |
| Pollinations.ai | all 60+ images + thumbnail background | $0 (no key) |
| Edge TTS | British narrator voiceover | $0 (no key) |
| EveryAyah | Mishary Arabic Quran recitation | $0 (no key) |
| FFmpeg | video assembly, Ken Burns, captions burn-in | $0 (free software) |
| YouTube Data API | upload video + thumbnail + captions | $0 (10k units/day, we use ~1600) |
| GitHub Actions | daily cron runner | $0 (2000 free min/month, we use ~30/day) |

Total monthly cost: **$0.00**

---

## If something breaks

1. Check the Actions tab on GitHub → latest run → expand the failed step
2. If stage `4_script` fails with a 429: Gemini rate-limited. `GEMINI_AUTO_DEGRADE=true` should handle this, but if Flash is also capped, the run retries tomorrow with the same topic.
3. If stage `8_assemble_video` fails: usually a beat image is corrupted. Re-running will regenerate.
4. If upload fails with 401: refresh token expired. Rerun `node setup-youtube.js` locally, update `YOUTUBE_REFRESH_TOKEN` in `.env` AND GitHub Secrets.
5. Otherwise: paste the error + stage into Claude and we'll fix.

---

You're done. The channel runs itself.
