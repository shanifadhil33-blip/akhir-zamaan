# SETUP — Akhir Zamaan

Follow these steps **in order**. Each section has checkboxes — tick them as you go. The whole thing takes ~20 minutes (no Google Cloud / OAuth dance anymore).

The pipeline generates the video for you, uploads it to a temporary file host, and Telegrams you the download link. You then upload to YouTube manually.

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
2. Give it `repo` + `workflow` scope + expiration of 1 year
3. Copy it, paste it as the "password" when prompted

- [ ] Repo pushed successfully

---

## Part 2 — Telegram bot (5 min, REQUIRED for delivery)

Why: This is how you receive the daily video download link. Without it, the workflow still runs and produces a `.mp4`, but you'll have to grab it from the workflow's artifacts each day.

- [ ] Open Telegram, search `@BotFather`, start chat, type `/newbot`
- [ ] Pick a name like `Akhir Zamaan Delivery Bot`
- [ ] Pick a username ending in `bot`, e.g. `akhir_zamaan_delivery_bot`
- [ ] BotFather gives you a token like `123456:ABC-xyz...` — this is `TELEGRAM_BOT_TOKEN`
- [ ] Open a chat with your new bot and send any message (required to "activate")
- [ ] In a browser open: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` — find `"chat":{"id":...}` — that's `TELEGRAM_CHAT_ID`

---

## Part 3 — Ollama endpoint (5 min)

The pipeline uses Ollama (`gpt-oss:120b-cloud` by default) for script, visual plan, metadata, and topic-queue generation. You need an Ollama server reachable from GitHub Actions (i.e. publicly addressable, or behind a tunnel like Tailscale Funnel / Cloudflare Tunnel).

- [ ] Install Ollama: https://ollama.com/download
- [ ] Pull the model: `ollama pull gpt-oss:120b-cloud`
- [ ] Make the Ollama HTTP endpoint reachable from the public internet, OR use an Ollama-compatible cloud provider
- [ ] Note the URL — that becomes `OLLAMA_HOST` (e.g. `https://your-tunnel.example.com`)

If you're running locally and skipping autonomous cron, just leave `OLLAMA_HOST=http://localhost:11434`.

---

## Part 4 — Music tracks (5 min, optional)

See [assets/music/README.md](assets/music/README.md). Drop 5–10 halal ambient `.mp3` files into `assets/music/`.

If you skip this, videos still publish — just with voice only, no ambient music bed.

- [ ] At least 5 tracks in `assets/music/`, OR you've accepted voice-only

---

## Part 5 — GitHub Secrets (5 min)

Why: The GitHub Actions cron needs your tokens. It cannot read your local `.env`.

- [ ] On github.com, open your repo → **Settings** → **Secrets and variables** → **Actions**
- [ ] Click **New repository secret** and add each of these:

| Secret name | Value | Required? |
|---|---|---|
| `OLLAMA_HOST` | Your Ollama endpoint URL from Part 3 | ✅ |
| `TELEGRAM_BOT_TOKEN` | From Part 2 | ✅ for delivery link |
| `TELEGRAM_CHAT_ID` | From Part 2 | ✅ for delivery link |

- [ ] All secrets added

---

## Part 6 — Local `.env` (2 min)

Copy `.env.example` to `.env` and fill in the same values you just put in GitHub Secrets. Used only for local runs.

```
OLLAMA_HOST=https://your-tunnel.example.com
TELEGRAM_BOT_TOKEN=123456:ABC-...
TELEGRAM_CHAT_ID=123456789
```

`.env` is gitignored.

---

## Part 7 — Test run (5 min)

Before unleashing the daily cron, do one dry run:

```bash
npm install
npm run bootstrap-data   # downloads Quran + hadith (one-time, ~50MB)
npm run test-script      # runs pipeline in dry-run mode — stops after script generation
```

This will:
1. Pick the first topic from `topics-queue.json`
2. Load Quran/hadith sources
3. Pull modern context
4. Generate the script
5. Save everything to `output/<timestamp>_<slug>/` and stop there

- [ ] `output/` folder now has a subfolder with `topic.json`, `sources.json`, `modern-context.json`, `script.json`
- [ ] Open `script.json` — read the `cold_open` field. Does it sound like the diagnostic-cinematic voice?

---

## Part 8 — Full end-to-end test (one real video, ~15 min)

```bash
npm start
```

This runs all 10 stages and produces `output/<timestamp>_<slug>/final.mp4`. No upload happens locally — that step is GitHub-Actions-only. Open the folder and play `final.mp4` to confirm it renders correctly.

- [ ] `final.mp4` plays
- [ ] `thumbnail.jpg` looks clickable
- [ ] `metadata.json` title/description/tags look good

---

## Part 9 — Enable the daily cron

The `.github/workflows/daily.yml` file is already configured to run at **06:00 UTC daily**. Once your code is pushed to GitHub with all secrets in place, it will run automatically every day.

- [ ] Go to your repo → **Actions** tab
- [ ] You should see "Daily Video Pipeline" listed
- [ ] Click it → **Run workflow** button (top right) → Run workflow to trigger a manual test
- [ ] Watch the logs. Full run should take ~20-30 min.
- [ ] When it finishes, you'll get a Telegram message: `🎬 Akhir Zamaan Video Ready. Download here: https://bashupload.com/...`
- [ ] Click the link, download the `.mp4`, upload to YouTube manually

Tomorrow at 06:00 UTC and every day after, you'll get a new download link automatically.

> bashupload.com retains files for ~3 days. If you miss a day's link, the same `final.mp4` is also stored as a workflow artifact under the run on the **Actions** tab for 14 days.

---

## Quick reference — what runs where

| Service | What it does | Cost |
|---|---|---|
| Ollama (`gpt-oss:120b-cloud`) | script, visual, metadata, topic generation | depends on your endpoint |
| Pollinations.ai | all images + thumbnail background | $0 (no key) |
| Kokoro / Edge TTS | British narrator voiceover | $0 (no key) |
| EveryAyah | Mishary Arabic Quran recitation | $0 (no key) |
| FFmpeg | video assembly, Ken Burns, captions burn-in | $0 (free software) |
| bashupload.com | temporary file host for the daily mp4 | $0 (no key, ~3-day retention) |
| Telegram Bot API | delivery link + error alerts | $0 |
| GitHub Actions | daily cron runner + artifact storage | $0 (2000 free min/month) |

Total monthly cost: **$0.00** (Ollama endpoint cost depends on what you self-host vs. use a provider for).

---

## If something breaks

1. Check the Actions tab on GitHub → latest run → expand the failed step
2. If the **Run pipeline** step fails: read the stage name in the error. Telegram will also ping you.
3. If the **Upload final video to bashupload.com** step fails: bashupload may be down. The `.mp4` is still in the workflow artifacts — download it from there.
4. If the **Notify Telegram** step shows `Telegram HTTP 401/404`: re-check `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
5. Otherwise: paste the error + stage into Claude and we'll fix.

---

You're done. The channel runs itself — you just download and upload.
