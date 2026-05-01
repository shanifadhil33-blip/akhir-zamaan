# CLAUDE.md — Akhir Zamaan: Autonomous Quran-Only Video Pipeline

## PROJECT OVERVIEW

Autonomous, near-$0/video pipeline that generates one 15–20 minute documentary twice a week (Tue + Fri). The channel is **Quran-only** — it explains the direct words of Allah, NOT hadith, NOT scholarly opinions. Source retrieval reads Quranic verses from a local file (tanzil.net Sahih International). Web research via Tavily grounds the modern_context. Script generation via DeepSeek V3 (chunked: skeleton + 5 movements + metadata). Image generation via Cloudflare Workers AI (Flux Schnell, Pollinations fallback). Voiceover via local Kokoro-82M TTS on the runner. FFmpeg assembly. GitHub Actions runs it on cron, uploads the final `.mp4` to 0x0.st via curl, and delivers the link + thumbnail + captions + metadata to the operator's Telegram. The operator uploads to YouTube manually — no YouTube API, no OAuth.

Channel: **Akhir Zamaan** (`@akhirzamaan`)

## CONTENT PHILOSOPHY — QURAN ONLY

This is the most important rule of the channel. **The voice is the Quran, unfiltered**. The pipeline:
- Quotes ONLY the direct words of Allah from the Quran
- NEVER quotes hadith, even from training knowledge
- NEVER cites scholars (Ibn Kathir, Ghazali, Sufyan, contemporaries — none)
- References prophets named in the Quran (Yusuf, Musa, Maryam, etc.) as Quranic figures
- Surfaces the listener's modern condition, then names it through a verse

The script-engine prompt enforces this with explicit forbidden patterns. The topic-generator schema does not allow hadith fields. The source-retriever still has hadith functions in code (legacy) but topics never specify hadith refs, so hadith data is never loaded.

## TECH STACK

- **Runtime**: Node.js 20 (CommonJS, not ESM)
- **Script / visual plan / metadata / topic generation**: Ollama, default model `gpt-oss:120b-cloud` (override via `OLLAMA_MODEL`)
- **Modern context**: same Ollama call, no external grounding
- **Voiceover**: provider chain `kokoro → streamelements → edge` (override with `TTS_PROVIDER`). Default voice `bm_george` (Kokoro).
  - Kokoro-82M ONNX runs locally via a Python worker (`modules/kokoro_worker.py`). Model + voices live in `assets/kokoro/`.
  - Edge TTS uses a custom WebSocket client (`modules/edge-tts.js`, `ws` npm).
- **Quran recitation**: EveryAyah CDN (no key)
- **Image generation**: Pollinations.ai (free, no key, URL-based). Single retry with seed offset on failure.
- **Captions**: built from estimated word timings → `.srt` (delivered alongside video) + `.ass` (burned into video by FFmpeg)
- **Video assembly**: FFmpeg (Ken Burns zoom on stills + voiceover + ambient music ducked at -22dB + burned captions + recitation overlays on verse beats)
- **Thumbnail**: Pollinations background + FFmpeg text overlay
- **Delivery**: GitHub Actions step → `curl -T final.mp4 https://bashupload.com/` → Telegram bot message with download link. Final `.mp4` is also retained as a workflow artifact for 14 days.
- **Notifications**: Telegram bot (errors + delivery link)
- **Religious sources**: LOCAL files only, no external APIs
  - Quran: `data/quran-en-sahih.txt` from tanzil.net (format: `chapter|verse|text`)
  - Hadith: `data/hadith/editions/eng-*/` from github.com/fawazahmed0/hadith-api

## PROJECT STRUCTURE

```
akhir-zamaan/
├── CLAUDE.md                       ← this file
├── README.md
├── SETUP.md
├── package.json
├── .env                            ← secrets (gitignored)
├── .env.example
├── .gitignore
├── pipeline.js                     ← main orchestrator (10 stages)
├── topics-queue.json               ← seed topics (auto-refilled by Ollama)
├── published.json                  ← auto-managed dedup log
├── prompts/
│   ├── script-engine.md            ← diagnostic-cinematic 5-act script generator
│   ├── visual-architect.md         ← beat-by-beat storyboard + thumbnail
│   ├── metadata-engine.md          ← title + description + tags + chapters
│   └── topic-generator.md          ← auto-refill topic queue
├── modules/
│   ├── source-retriever.js         ← reads local Quran txt + hadith JSON
│   ├── modern-context.js           ← Ollama call for 2023+ event grounding
│   ├── llm.js                      ← Ollama wrapper (script/visual/metadata/topics)
│   ├── ollama.js                   ← Ollama HTTP client + JSON-mode helper
│   ├── voiceover.js                ← TTS provider chain orchestrator
│   ├── kokoro-tts.js               ← Kokoro-82M (Python worker bridge)
│   ├── kokoro_worker.py            ← long-lived Python TTS worker
│   ├── edge-tts.js                 ← Microsoft Edge TTS (WebSocket)
│   ├── streamelements-tts.js       ← StreamElements TTS fallback
│   ├── google-translate-tts.js     ← unused in default chain (female voice only)
│   ├── recitation.js               ← Arabic Quran audio from EveryAyah
│   ├── images.js                   ← Pollinations image generation
│   ├── captions.js                 ← SRT + ASS builders from word timings
│   ├── assembler.js                ← FFmpeg video + thumbnail assembly
│   ├── queue.js                    ← topic picker + dedup via published.json
│   ├── topic-generator.js          ← auto-refill when queue is low
│   └── notify.js                   ← Telegram error notifications
├── scripts/
│   ├── bootstrap-data.js           ← downloads Quran + hadith
│   ├── resume-pipeline.js          ← re-assemble from existing artifacts
│   ├── regen-images.js             ← re-render specific beat images
│   ├── regen-voice.js              ← re-render the voiceover
│   └── test-kokoro.js              ← Kokoro smoke test
├── assets/
│   ├── kokoro/                     ← kokoro-v1.0.onnx + voices-v1.0.bin
│   ├── music/                      ← halal ambient .mp3 tracks (operator adds)
│   └── fonts/                      ← optional custom fonts
├── data/                           ← gitignored, downloaded once
│   ├── README.md                   ← download instructions
│   ├── quran-en-sahih.txt
│   └── hadith/editions/eng-*/      ← bukhari, muslim, tirmidhi, abudawud, nasai, ibnmajah, ahmad
├── output/                         ← generated videos (gitignored)
└── .github/workflows/
    └── daily.yml                   ← cron at 06:00 UTC + bashupload + Telegram delivery
```

## DEPENDENCIES (package.json)

```json
{
  "name": "akhir-zamaan",
  "version": "1.0.0",
  "main": "pipeline.js",
  "type": "commonjs",
  "scripts": {
    "start": "node pipeline.js",
    "test-script": "node pipeline.js --dry-run",
    "bootstrap-data": "node scripts/bootstrap-data.js"
  },
  "dependencies": {
    "axios": "^1.7.9",
    "dotenv": "^16.4.5",
    "ws": "^8.20.0"
  }
}
```

External binaries: `ffmpeg`, `ffprobe`, `python3` (for Kokoro worker, plus `kokoro-onnx` package).

## ENV VARS (.env.example)

```
# Ollama (script/visual/metadata/topic generation)
OLLAMA_HOST=https://your-tunnel.example.com
OLLAMA_MODEL=gpt-oss:120b-cloud

# Telegram (errors + daily delivery link from GitHub Actions)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Channel
CHANNEL_NAME=Akhir Zamaan
CHANNEL_HANDLE=@akhirzamaan

# Pipeline behavior
VOICE_NAME=en-GB-RyanNeural
RECITER_ID=Alafasy_128kbps
VIDEO_DURATION_MIN=15
VIDEO_DURATION_MAX=20
AUTO_TOPIC_REFILL=true
TOPIC_REFILL_THRESHOLD=20
```

Optional overrides used inside the code: `KOKORO_VOICE`, `KOKORO_SPEED`, `KOKORO_LANG`, `KOKORO_PYTHON`, `EDGE_VOICE`, `SE_VOICE`, `TTS_PROVIDER`, `FONT_PATH`, `OLLAMA_MODEL_FALLBACK`.

## .gitignore

```
node_modules/
.env
output/
published.json
*.log
.DS_Store
data/*
!data/README.md
```

---

## PIPELINE FLOW (pipeline.js)

The main orchestrator runs 10 stages sequentially:

1. **Topic Picker** — `topic-generator.refillIfLow()` tops up the queue if remaining < `TOPIC_REFILL_THRESHOLD`. `queue.getNextTopic()` reads `topics-queue.json`, skips anything in `published.json`, picks next, and also returns the next-next topic for cliffhanger tease.
2. **Source Retriever** — reads local Quran + hadith for the topic's referenced chapters/books.
3. **Modern Context Injector** — Ollama call returns 4–6 specific real-world events (2023–2026) tied to the theme.
4. **Script Engine** — Ollama generates a long-form 5-section script (`cold_open`, `naming`, `excavation`, `mirror`, `haunting`).
5. **Visual Architect** — Ollama splits the script into ~60 visual beats + picks mood aesthetic + thumbnail spec.
6. **Parallel generation** — `Promise.all([voiceover, beat images, recitations])`.
6b. **Thumbnail bg** — runs after beats so it can fall back to a beat image if Pollinations fails.
7. **Captions** — estimated word timings → `.srt` + `.ass`.
8. **FFmpeg Assembly** — Ken Burns zoom on images + voiceover + ambient music at -22dB + burned captions + recitation overlays → `final.mp4`.
9. **Thumbnail** — burn title text over background → `thumbnail.jpg`.
10. **Metadata + mark generated** — Ollama generates title/description/tags/chapters → `metadata.json`. `queue.markPublished(topic, null, relPath)` so the queue advances. Writes `delivery.json` with paths + duration + title.

**Delivery is OUT OF BAND.** It happens in the GitHub Actions workflow (`bashupload.com` upload + Telegram message), not in `pipeline.js`. Local runs just leave the video in `output/<timestamp>_<slug>/final.mp4` for the operator to grab.

### Key pipeline.js logic:

- `slugify(title)` creates folder-safe names
- `--dry-run` flag stops after script generation (no images/voice/video)
- Creates output dir per video: `output/<timestamp>_<slug>/`
- Saves all intermediate artifacts (`topic.json`, `sources.json`, `modern-context.json`, `script.json`, `visual-plan.json`, `recitations.json`, `voice-metadata.json`, `metadata.json`, `delivery.json`)
- Failed runs do NOT mark topic as published — next run retries the same topic automatically. Topic IS marked once the `final.mp4` is on disk; manual YouTube upload can fail without resetting the queue.

---

## PROMPTS

### prompts/script-engine.md

Diagnostic-cinematic voice. 5 sections returned as JSON:

```json
{
  "title_options": ["..."],
  "mood": "cinematic_realism | painterly_islamic | dark_cinematic",
  "mood_reason": "...",
  "cold_open": "...",
  "naming": "...",
  "excavation": "...",
  "mirror": "...",
  "haunting": "...",
  "next_video_tease": "...",
  "pinned_comment_question": "...",
  "modern_parallels_used": ["..."],
  "verses_for_recitation": [{ "chapter": 18, "verse": 95, "where": "after the line ..." }]
}
```

Absolute rules: never invent verses/hadith, never name scholars not in source, no sectarianism, no depiction of prophets, ﷺ after Prophet Muhammad, (AS) after other prophets, no predictions of WHEN the Hour comes.

### prompts/visual-architect.md

Splits script into ~60 beats (one image every 8–15s).

```json
{
  "aesthetic_style_string": "...",
  "beats": [
    { "beat_number": 1, "script_segment": "...", "duration_estimate_seconds": 12, "image_prompt": "...", "caption_emphasis": "..." }
  ],
  "thumbnail": { "background_prompt": "...", "title_overlay": "ALL CAPS", "accent_color": "#hex" }
}
```

### prompts/metadata-engine.md

```json
{
  "title": "<70 chars curiosity gap",
  "description": "hook + sources + chapters + hashtags + disclaimer",
  "tags": ["~25 tags, 500 chars total"],
  "chapters": [{ "time": "0:00", "label": "..." }]
}
```

### prompts/topic-generator.md

Run by `modules/topic-generator.js` when the unpublished queue drops below `TOPIC_REFILL_THRESHOLD`. Generates 30 new topic objects matching the existing schema, avoiding recent topic IDs/titles.

---

## MODULE SPECS

### modules/source-retriever.js
Reads local files. No network. No keys.
- Quran loader: caches `data/quran-en-sahih.txt`. `getVersesByChapter(n, [verseNums?])`. Full SURAH_INFO baked in.
- Hadith loader: reads `data/hadith/editions/eng-{collection}/`. Tries multiple layouts. `getHadith(coll, book, num)`, `getHadithBook(coll, book, limit)`.
- `retrieveForTopic(topic)` → `{ verses, hadith, context }`.

### modules/modern-context.js
Single Ollama call asking for 4–6 verifiable 2023–2026 events tied to the topic theme. Returns `{ events: [], patterns: [] }`. Falls back to empty arrays on failure.

### modules/llm.js + modules/ollama.js
Thin wrappers over the Ollama HTTP API.
- `llm.generateScript({ topic, sources, modernContext, nextTopic })`
- `llm.generateVisualPlan({ script })`
- `llm.generateMetadata({ script, visualPlan, sources, topic })`
- `llm.generateTopics({ ... })` (used by topic-generator)
- `ollama.js` exports a JSON-mode helper plus model fallback (`OLLAMA_MODEL_FALLBACK`).

### modules/voiceover.js
- Provider chain: `kokoro → streamelements → edge`. Override the whole chain with `TTS_PROVIDER`.
- Pre-processing: expands Islamic honorifics (ﷺ → "sallallahu alayhi wa sallam", `(AS)` → "alayhis salaam", etc.) and strips smart quotes / non-ASCII so the phonemizer doesn't crash.
- Estimates word timings from the rendered audio's ffprobe duration (msedge-tts hard-disables word boundaries; Kokoro doesn't expose them either). Times are distributed by character length.
- Outputs `voiceover.mp3` + `voice-metadata.json`.

### modules/kokoro-tts.js (+ kokoro_worker.py)
Spawns a long-lived Python worker that loads the Kokoro-82M ONNX model once and accepts repeated synthesize requests over stdin. Default voice `bm_george`, speed 0.95, lang `en-gb`. Model files live in `assets/kokoro/`. `KOKORO_PYTHON` env var pins the Python interpreter.

### modules/edge-tts.js
Custom WebSocket client to Microsoft Edge TTS (no API key required). Direct `ws` usage because `msedge-tts` npm leaks file handles and forbids word boundaries.

### modules/streamelements-tts.js
HTTP GET to StreamElements TTS endpoint. Voice `Brian` by default.

### modules/recitation.js
Downloads Mishary Al-Afasy verse audio from EveryAyah CDN for any `verses_for_recitation` the script asked for. Returns `[{ chapter, verse, where, audioPath }]`.

### modules/images.js
Pollinations URL builder:
```
https://image.pollinations.ai/prompt/{encoded}?width=1920&height=1080&model=flux&nologo=true&seed={seed}&enhance=true
```
60s timeout. On failure, retries once with `seed + 1000`. If still failing, copies the previous successful beat's image so the video never breaks. `generateAllBeats()` writes `images/beat_NNN.jpg`. `generateThumbnail()` writes `thumbnail_bg.jpg`.

### modules/captions.js
Built from estimated word timings.
- `buildSRT(wordTimings)` — 6 words per chunk, standard SRT for delivery alongside the video.
- `buildASS(wordTimings)` — 4 words per chunk, upper-cased, bottom-third placement, Arial Black 68pt, white with black outline, for FFmpeg burn-in.
- `writeCaptions(wordTimings, outputDir)` → `{ srtPath, assPath }`.

### modules/assembler.js
Pure FFmpeg.
- `assembleVideo({ beats, audioPath, captionsAss, recitations, outputDir })`
  1. ffprobe audio duration
  2. Per-beat duration = total / beat count
  3. Pass 1: images → base video with Ken Burns (`zoompan=z='min(zoom+0.0008,1.15)'`)
  4. Pass 2: mix voiceover + ducked ambient music (volume 0.12 ≈ -22dB) + recitation overlays at the timestamps the script flagged
  5. Pass 3: combine + burn `.ass` captions → `final.mp4`
  6. Settings: libx264, CRF 22, AAC 192k, 1920x1080, 30fps
- `assembleThumbnail(thumbnailData, outputDir)` → 1280x720 `thumbnail.jpg` with bold white text + accent border on a darkened Pollinations background.
- `pickRandomMusic()` — random `.mp3` from `assets/music/`.
- `ffprobeDuration(path)` — exported for other modules.

### modules/queue.js
- `getNextTopic()` → `{ topic, next, remaining }`
- `markPublished(topic, videoIdOrNull, urlOrPath)` — appends to `published.json`. Topic is marked once the `.mp4` is generated; the YouTube upload happens manually afterwards and isn't tracked here.
- `getRemainingCount()`, `getHighestIds()`, `appendTopics()` etc. for the topic generator.

### modules/topic-generator.js
- `refillIfLow()` — if remaining unpublished topics < `TOPIC_REFILL_THRESHOLD` AND `AUTO_TOPIC_REFILL=true`, calls `llm.generateTopics()` and appends new topics via `queue.appendTopics()`.

### modules/notify.js
- `notifyError({ stage, error, topic })` — sent on any pipeline failure.
- `notifyPublished()` / `notifyReview()` — currently no-ops (errors-only mode). Daily delivery message comes from the GitHub Actions workflow itself, not from this module.

---

## TOPICS QUEUE FORMAT (topics-queue.json)

Each topic:
```json
{
  "id": "et_1",
  "title": "The Dajjal: The Greatest Trial Mankind Will Ever Face",
  "theme": "Dajjal (Antichrist) prophecy",
  "quran_chapters": [18],
  "specific_verses": [94, 95, 96],
  "hadith_book": { "collection": "muslim", "book": 54, "limit": 8 },
  "hadith_refs": [{ "collection": "bukhari", "book": 92, "number": 3 }],
  "context": "Connect to AI, deepfakes, surveillance, mass deception"
}
```

All fields except `id` and `title` are optional. Use any combination.

Topic categories:
- `et_*` — End-times deep dives
- `pr_*` — Prophet stories
- `s_*` — Surah deep dives
- `th_*` — Thematic (Jannah, Jahannam, Riba, Jinn, Sahaba, 99 Names, practical Islam)

Valid hadith collections: `bukhari`, `muslim`, `tirmidhi`, `abudawud`, `nasai`, `ibnmajah`, `ahmad`.

---

## GITHUB ACTIONS WORKFLOW (.github/workflows/daily.yml)

Cron: `0 6 * * *` (06:00 UTC = 10:00 AM Dubai). Manual trigger via `workflow_dispatch`.

Steps:
1. Checkout
2. Setup Node 20
3. Install FFmpeg + fonts-liberation + fonts-dejavu
4. `npm install`
5. `npm run bootstrap-data` (auto-downloads Quran + hadith if missing)
6. `npm start` (runs the pipeline)
7. **Locate generated video** — finds newest `output/*/final.mp4` and reads its title from `metadata.json`. Sets step outputs.
8. **Upload final video to bashupload.com** — `curl -T <path> https://bashupload.com/`, parses the returned URL.
9. **Notify Telegram with download link** — `curl POST` to the Bot API. Message: `🎬 Akhir Zamaan Video Ready. Download here: <URL>` plus title + size on follow-up lines. No-op (with a workflow warning) if `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are unset.
10. Commit `published.json` + `topics-queue.json` back to the repo.
11. Upload `final.mp4` + `thumbnail.jpg` + `captions.srt` + json artifacts (14-day retention) as a fallback.

Timeout: 90 minutes.

Secrets needed:
- `OLLAMA_HOST`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

That's it. There are NO Google Cloud / YouTube / Gemini secrets — the pipeline doesn't touch any Google API.

---

## CONTENT PHILOSOPHY

5-section diagnostic-cinematic structure:

- **COLD OPEN:** Modern observation that names a behavior the viewer is doing right now. No source named yet.
- **NAMING:** Reveal the verse / hadith (quoted exactly from `<sources>`).
- **EXCAVATION:** Historical context, classical understanding, cinematic narration. Pattern interrupts every 45 seconds.
- **MIRROR:** Pivot to 2026. Specific real events. 2–3 actionable shifts the viewer can make THIS WEEK (concrete, not vague).
- **HAUNTING:** Final reflection question + cliffhanger tease for next video + subscribe CTA.

Hook must reference something from the last 5 years. Modern parallels must cite specific events/years. Action items doable in <7 days by a working person with a phone.

---

## ETHICAL GUARDRAILS

- Verses + hadith from verified local files, never AI-generated
- Disclaimer in every description (general reflection, not fatwa)
- No depiction of prophets / sahaba in images
- No sectarian framing
- No predictions of WHEN the Hour comes — only signs
- Visual Architect enforces: no faces of religious figures; use symbols / environments / light / architecture / calligraphy instead

---

## DATA BOOTSTRAP

```bash
mkdir -p data
# Quran: download from https://tanzil.net/download/ → Sahih International → save as data/quran-en-sahih.txt
# Hadith:
cd data
git clone --depth 1 https://github.com/fawazahmed0/hadith-api.git hadith
find hadith/editions -mindepth 1 -maxdepth 1 -type d ! -name 'eng-*' -exec rm -rf {} +
cd ..
```

`npm run bootstrap-data` automates this (used by the GitHub Actions workflow).

---

## COMMANDS

- `npm install` — install deps
- `npm run bootstrap-data` — one-time, downloads Quran + hadith
- `npm run test-script` — dry run (script only, no images/voice/video)
- `npm start` — run full pipeline (one video, written to `output/<timestamp>_<slug>/final.mp4`)
- `node scripts/resume-pipeline.js output/<folder>` — re-assemble from existing artifacts after an ffmpeg failure
- `node scripts/regen-images.js output/<folder> [beatNum...]` — re-render specific beat images
- `node scripts/regen-voice.js output/<folder>` — re-render the voiceover
- `node scripts/test-kokoro.js` — Kokoro smoke test
