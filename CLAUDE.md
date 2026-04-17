# CLAUDE.md — Akhir Zamaan: Autonomous Islamic YouTube Channel

## PROJECT OVERVIEW

Fully autonomous, $0/video YouTube pipeline. Publishes one 10–13 minute Islamic end-times documentary daily. Reads Quran + hadith from local files (no APIs), generates scripts via Gemini, creates images via Pollinations, voiceover via Edge TTS, assembles via FFmpeg, uploads via YouTube Data API. GitHub Actions cron runs it daily.

Channel: **Akhir Zamaan** (`@akhirzamaan`)

## TECH STACK

- **Runtime**: Node.js (CommonJS, not ESM)
- **Script generation**: Gemini 2.5 Pro (via `@google/generative-ai`)
- **Visual storyboard + metadata**: Gemini 2.5 Flash
- **Modern context**: Gemini Flash with Google Search grounding
- **Voiceover**: Edge TTS (`msedge-tts` npm) — voice: `en-GB-RyanNeural`
- **Image generation**: Pollinations.ai (free, no key, URL-based) — fallback: Gemini Flash Image
- **Captions**: Built from Edge TTS word timings — burned via FFmpeg (.ass) + YouTube upload (.srt)
- **Video assembly**: FFmpeg (Ken Burns zoom on stills + voiceover + ambient music + burned captions)
- **Thumbnail**: Pollinations background + FFmpeg text overlay
- **Upload**: YouTube Data API v3 (googleapis npm)
- **Scheduling**: GitHub Actions cron (06:00 UTC daily)
- **Notifications**: Telegram bot (optional, for review mode)
- **Religious sources**: LOCAL files only, no external APIs
  - Quran: `data/quran-en-sahih.txt` from tanzil.net (format: `chapter|verse|text`)
  - Hadith: `data/hadith/editions/eng-*/` from github.com/fawazahmed0/hadith-api

## PROJECT STRUCTURE

```
akhir-zamaan/
├── CLAUDE.md                  ← this file
├── package.json
├── .env                       ← secrets (gitignored)
├── .env.example
├── .gitignore
├── pipeline.js                ← main orchestrator (10 stages)
├── setup-youtube.js           ← one-time OAuth helper
├── topics-queue.json          ← 213 pre-loaded topics
├── published.json             ← auto-managed dedup log (gitignored)
├── prompts/
│   ├── script-engine.md       ← 3-act dramatic documentary script generator
│   ├── visual-architect.md    ← beat-by-beat storyboard + thumbnail planner
│   └── metadata-engine.md     ← title + description + tags + chapters
├── modules/
│   ├── source-retriever.js    ← reads local Quran txt + hadith JSON
│   ├── modern-context.js      ← Gemini grounded search for 2023+ events
│   ├── gemini.js              ← Gemini wrapper for script/visual/metadata
│   ├── voiceover.js           ← Edge TTS + word timings
│   ├── images.js              ← Pollinations + Gemini fallback
│   ├── captions.js            ← SRT + ASS builders from word timings
│   ├── assembler.js           ← FFmpeg video + thumbnail assembly
│   ├── youtube.js             ← upload + thumbnail + captions + pinned comment
│   ├── queue.js               ← topic picker + dedup via published.json
│   └── notify.js              ← Telegram alerts for review mode
├── assets/
│   ├── music/                 ← 5–10 ambient .mp3 tracks (user adds manually)
│   └── fonts/                 ← optional custom fonts
├── data/                      ← gitignored, downloaded once
│   ├── README.md              ← download instructions
│   ├── quran-en-sahih.txt     ← from tanzil.net
│   └── hadith/editions/       ← from fawazahmed0/hadith-api
│       ├── eng-bukhari/
│       ├── eng-muslim/
│       ├── eng-tirmidhi/
│       ├── eng-abudawud/
│       ├── eng-nasai/
│       └── eng-ibnmajah/
├── output/                    ← generated videos (gitignored)
└── .github/workflows/
    └── daily.yml              ← cron at 06:00 UTC
```

## DEPENDENCIES (package.json)

```json
{
  "name": "akhir-zamaan",
  "version": "1.0.0",
  "description": "Fully autonomous Islamic end-times YouTube channel pipeline",
  "main": "pipeline.js",
  "type": "commonjs",
  "scripts": {
    "start": "node pipeline.js",
    "test-script": "node pipeline.js --dry-run",
    "upload-only": "node modules/youtube.js"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "axios": "^1.7.9",
    "dotenv": "^16.4.5",
    "googleapis": "^144.0.0",
    "msedge-tts": "^1.3.4"
  }
}
```

## ENV VARS (.env.example)

```
GOOGLE_AI_API_KEY=your_gemini_key_here
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
CHANNEL_NAME=Akhir Zamaan
CHANNEL_HANDLE=@akhirzamaan
REVIEW_THRESHOLD=10
```

## .gitignore

```
node_modules/
.env
output/
published.json
token.json
*.log
.DS_Store
data/*
!data/README.md
```

---

## PIPELINE FLOW (pipeline.js)

The main orchestrator runs 10 stages sequentially:

1. **Topic Picker** — reads `topics-queue.json`, skips anything in `published.json`, picks next. Also grabs the FOLLOWING topic for cliffhanger tease.
2. **Source Retriever** — reads local Quran + hadith files for the topic's referenced chapters/books.
3. **Modern Context Injector** — Gemini Flash with Google Search grounding finds 4–6 real events from 2023–2026 that mirror the topic theme.
4. **Script Engine** — Gemini 2.5 Pro generates a 1,800-word 3-act script (Hook → Revelation → Mirror). Returns JSON with title_options, mood, hook, body, cliffhanger, pinned_comment_question.
5. **Visual Architect** — Gemini Flash splits the script into 40–60 visual beats + picks mood aesthetic + generates thumbnail spec. Returns JSON.
6. **Parallel generation** — Voice (Edge TTS), images (Pollinations), thumbnail run in parallel via Promise.all.
7. **Captions** — Word timings from Edge TTS → .srt (YouTube upload) + .ass (burned into video).
8. **FFmpeg Assembly** — Ken Burns zoom on images + voiceover + ambient music at -22dB + burned captions → final.mp4.
9. **Decision gate** — Videos 1–10 go to /review folder + Telegram notify. Videos 11+ auto-upload.
10. **Upload + publish** — YouTube Data API uploads video + thumbnail + .srt captions + posts pinned comment. Marks topic in published.json.

### Key pipeline.js logic:

- `slugify(title)` creates folder-safe names
- `--dry-run` flag stops after script generation (no images/voice/video)
- Creates output dir per video: `output/<timestamp>_<slug>/`
- Saves all intermediate artifacts (sources.json, script.json, visual-plan.json, metadata.json) for debugging
- Failed runs do NOT mark topic as published — next run retries same topic automatically

---

## PROMPTS

### prompts/script-engine.md

Role: Head writer of "Akhir Zamaan" — faceless YouTube documentary channel.

Audience: English-speaking Muslims aged 18–45, mobile viewers, watching at night.

ABSOLUTE RULES:
1. NEVER invent a verse, hadith, or scholarly quote. Only use provided `<sources>`.
2. NEVER name a specific scholar unless in source material.
3. NEVER make sectarian claims (Sunni vs Shia, madhab disputes).
4. NEVER depict physical appearance of prophets.
5. ALWAYS write ﷺ after Prophet/Muhammad, (AS) after other prophets.
6. NEVER predict WHEN the Hour comes. Frame as "signs" not "timing."
7. Use plain English. No Arabic without immediate English translation.

STRUCTURE — 3 acts:

**ACT 1 — THE HOOK (0–60s, ~150 words):** Open with a MODERN observation. Build curiosity gap. Don't name the source yet. End with tension hook.

**ACT 2 — THE REVELATION (60s – 60%, ~900 words):** Reveal the verse/hadith (quoted exactly from sources). Historical context. Classical understanding. Cinematic narration. Pattern interrupts every 45 seconds (rhetorical question, statistic, scene shift).

**ACT 3 — THE MIRROR (60% – 95%, ~600 words):** Pivot to 2026. Specific modern parallels (real events, real tech, real geopolitics from last 5 years). 2–3 ACTIONABLE shifts the viewer can make THIS WEEK (concrete, not vague). Personal challenge.

**CLIFFHANGER (final 5%, ~80 words):** Haunting reflection question. Tease next video by name. Subscribe CTA woven naturally.

TONE: British documentary narrator. Slow, deliberate, weighty. Short sentences for impact. `[PAUSE]` markers for breathing.

OUTPUT FORMAT — strict JSON:
```json
{
  "title_options": ["5 titles, <60 chars, curiosity-gap"],
  "mood": "cinematic_realism | painterly_islamic | dark_cinematic",
  "mood_reason": "one sentence why",
  "hook": "Act 1 text, ~150 words",
  "body": "Act 2 + Act 3 combined, ~1500 words, with [PAUSE] markers",
  "cliffhanger": "final ~80 words",
  "next_video_tease": "topic name from queue",
  "pinned_comment_question": "provocative question for comments",
  "modern_parallels_used": ["list of events referenced"]
}
```

INPUT at runtime: `<topic>`, `<sources>`, `<modern_context>`, `<next_topic>`.

### prompts/visual-architect.md

Takes finalized script → splits into 40–60 visual beats (one image per 8–15 seconds).

ABSOLUTE RULES:
1. NEVER depict Prophet Muhammad ﷺ, any prophet, or sahaba.
2. NEVER depict Allah, angels with faces.
3. Faces are rare — use silhouettes, hands, eyes only, back-of-head.

MOOD → AESTHETIC:
- **cinematic_realism** → photorealistic, IMAX landscapes, golden/blue hour
- **painterly_islamic** → geometric patterns, calligraphy, jewel tones, stained glass
- **dark_cinematic** → high contrast, eclipses, ruins, smoke, blood-moon palette

Beat timing: ~150 words/min → each beat ≈ 25–35 words of script.

OUTPUT — strict JSON:
```json
{
  "aesthetic_style_string": "5–10 word suffix for all prompts",
  "beats": [
    {
      "beat_number": 1,
      "script_segment": "exact words covered",
      "duration_estimate_seconds": 12,
      "image_prompt": "15–35 words, Pollinations-friendly",
      "caption_emphasis": "1–4 words to emphasize"
    }
  ],
  "thumbnail": {
    "background_prompt": "dramatic image prompt",
    "title_overlay": "3–6 words, ALL CAPS, most clickable phrase",
    "accent_color": "#hex"
  }
}
```

### prompts/metadata-engine.md

Takes script + visual plan + sources → generates YouTube metadata.

OUTPUT — strict JSON:
```json
{
  "title": "final title, <70 chars, curiosity gap",
  "description": "full description with hook, sources, chapters, hashtags, disclaimer",
  "tags": ["25 tags max, 500 chars total"],
  "chapters": [{ "time": "0:00", "label": "..." }]
}
```

Description template includes:
- 2-line hook
- "🕌 SOURCES REFERENCED:" with verse/hadith refs
- "⏱ CHAPTERS:" auto-filled
- Share CTA + subscribe CTA + 15 hashtags
- DISCLAIMER: "This channel presents authenticated verses and hadith from primary sources. All interpretations are general reflections, not formal fatwa."

Tag mix: topic-specific (5–8) + niche (8–10: islam, end times, qiyamah, etc.) + broad (5–7).

---

## MODULE SPECS

### modules/source-retriever.js

Reads local files. No network. No API keys.

**Quran loader:**
- Reads `data/quran-en-sahih.txt` (format: `chapter|verse|text` per line)
- Optionally reads `data/quran-uthmani.txt` for Arabic
- Caches in memory after first load
- `getVersesByChapter(chapterNumber, verseNumbers?)` → array of `{ reference, arabic, translation }`
- `getChapterInfo(chapterNumber)` → `{ num, name, english, verses, place }`
- Full SURAH_INFO array with all 114 surahs baked in (name, english name, verse count, Meccan/Medinan)

**Hadith loader:**
- Reads from `data/hadith/editions/eng-{collection}/` (fawazahmed0/hadith-api format)
- Collection map: bukhari, muslim, tirmidhi, abudawud, nasai, ibnmajah, ahmad
- Tries multiple file paths (sections/{book}.json, {collection}.json, index.json)
- Caches full collection in memory after first load
- `getHadith(collection, bookNumber, hadithNumber)` → single hadith
- `getHadithBook(collection, bookNumber, limit)` → array of hadith
- `normalizeHadith()` strips HTML tags, extracts reference string

**Topic dispatcher:**
- `retrieveForTopic(topic)` → `{ verses: [], hadith: [], context: '' }`
- If topic has `quran_chapters` → loads those chapters (specific_verses if provided, else first 15)
- If topic has `hadith_refs` → loads individual hadith
- If topic has `hadith_book` → loads a book section with limit
- Graceful error handling — warns on missing hadith but continues

### modules/modern-context.js

Uses Gemini 2.5 Flash with `google_search` tool for grounded results.

Prompt: "Find 4-6 specific, verifiable real-world events from 2023-2026 that connect to: [topic theme]"

Returns array of `{ year, event, thematic_link }`.

Falls back gracefully (returns empty array if fails).

### modules/gemini.js

Thin wrapper. Three functions:

- `generateScript({ topic, sources, modernContext, nextTopic })` — uses Gemini 2.5 Pro, temp 0.85
- `generateVisualPlan({ script })` — uses Gemini 2.5 Flash, temp 0.7
- `generateMetadata({ script, visualPlan, sources, topic })` — uses Gemini 2.5 Flash, temp 0.7

All use `responseMimeType: 'application/json'`. All load prompts from `prompts/*.md` via `loadPrompt()`.

`extractJSON()` helper strips markdown fences, finds first `{` to last `}`, parses.

### modules/voiceover.js

Uses `msedge-tts` npm package. Voice: `en-GB-RyanNeural`.

`generateVoiceover(script, outputDir)`:
- Combines hook + body + cliffhanger
- Replaces `[PAUSE]` with `<break time="700ms"/>`
- Outputs `voiceover.mp3` + `voice-metadata.json` (word timings)
- Word timings: `{ text, offset_ms, duration_ms }` per word

### modules/images.js

**Pollinations primary:**
```
https://image.pollinations.ai/prompt/{encoded_prompt}?width=1920&height=1080&model=flux&nologo=true&seed={seed}&enhance=true
```
60s timeout, arraybuffer response.

**Gemini Flash Image fallback** if Pollinations fails.

**Third fallback**: retry Pollinations with seed+1000.

`generateAllBeats(visualPlan, outputDir)`:
- Creates `images/` subfolder
- Loops all beats, appends `aesthetic_style_string` to each prompt
- Saves as `beat_001.jpg`, `beat_002.jpg`, etc.
- If a beat fails, copies previous successful image (video never breaks)

`generateThumbnail(visualPlan, outputDir)`:
- Generates one dramatic background image
- Returns `{ bgPath, overlayText, accentColor }`

### modules/captions.js

Builds from Edge TTS word timings (no Whisper needed).

`chunkWords(wordTimings, wordsPerChunk)` — groups into 3-4 word chunks for mobile-friendly captions.

`buildSRT(wordTimings)` — 6 words per chunk, standard SRT format for YouTube upload.

`buildASS(wordTimings)` — 4 words per chunk, upper-cased, bottom-third placement, Arial Black 68pt, white with black outline, for FFmpeg burn-in.

`writeCaptions(wordTimings, outputDir)` → `{ srtPath, assPath }`.

### modules/assembler.js

Pure FFmpeg. Two functions:

`assembleVideo({ beats, audioPath, captionsAss, outputDir })`:
1. Gets audio duration via ffprobe
2. Calculates per-beat duration (total / beat count)
3. Writes FFmpeg concat list
4. Pass 1: images → base video with Ken Burns zoom (`zoompan=z='min(zoom+0.0008,1.15)'`)
5. Pass 2: mix voiceover + random ambient track from `assets/music/` (music at volume 0.12 = ~-22dB)
6. Pass 3: combine base video + mixed audio + burn .ass captions → `final.mp4`
7. Settings: libx264, CRF 22, AAC 192k, 1920x1080, 30fps

`assembleThumbnail(thumbnailData, outputDir)`:
- Takes Pollinations background
- Burns dark overlay (black@0.45) for legibility
- Burns bold white text (110pt, with accent-colored border)
- Outputs `thumbnail.jpg` at 1280x720

`pickRandomMusic()` — picks random .mp3 from `assets/music/`.

### modules/youtube.js

`uploadVideo({ videoPath, thumbnailPath, srtPath, metadata })`:
1. OAuth2 with refresh token
2. Insert video (category 27 = Education, public, not made for kids)
3. Set custom thumbnail
4. Upload .srt as English caption track

`postPinnedComment(videoId, commentText)` — posts the script's `pinned_comment_question` as a top-level comment.

`getAuthClient()` — creates OAuth2 client from env vars.

### modules/queue.js

`getNextTopic()` — loads `topics-queue.json`, loads `published.json`, finds first topic whose `id` is NOT in published. Also returns the next-next topic for cliffhanger.

`markPublished(topic, videoId, url)` — appends to `published.json` with timestamp.

`getPublishedCount()` — returns length of published log.

Topic only marked published AFTER successful YouTube upload. Failed runs auto-retry same topic next day.

### modules/notify.js

Telegram notifications. Silently no-ops if env vars missing.

`notifyReview({ topic, videoPath, metadata })` — sends message when review-mode video is ready.
`notifyPublished({ topic, url })` — sends message when auto-uploaded.

---

## TOPICS QUEUE FORMAT (topics-queue.json)

213 topics pre-loaded. Each topic:

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
- `et_*` — End-times deep dives (25 topics): Dajjal, Mahdi, Yajuj/Majuj, signs of the Hour
- `pr_*` — Prophet stories (27 topics): Adam through Muhammad ﷺ, multi-part where rich
- `s_*` — Surah deep dives (114 topics): one per surah
- `th_*` — Thematic (47 topics): Jannah, Jahannam, Riba, Jinn, Sahaba, 99 Names, practical Islam

Valid hadith collections: bukhari, muslim, tirmidhi, abudawud, nasai, ibnmajah, ahmad.

---

## GITHUB ACTIONS WORKFLOW (.github/workflows/daily.yml)

Cron: `0 6 * * *` (06:00 UTC = 10:00 AM Dubai)
Also: manual trigger via workflow_dispatch.

Steps:
1. Checkout
2. Setup Node 20
3. Install FFmpeg + fonts-liberation
4. npm install
5. Bootstrap Quran + hadith data (auto-downloads if missing)
6. Restore published.json from artifact
7. Run pipeline with all secrets from GitHub Secrets
8. Upload published.json as artifact
9. Commit published.json back to repo

Timeout: 90 minutes.

Secrets needed:
- GOOGLE_AI_API_KEY
- YOUTUBE_CLIENT_ID
- YOUTUBE_CLIENT_SECRET
- YOUTUBE_REFRESH_TOKEN
- TELEGRAM_BOT_TOKEN (optional)
- TELEGRAM_CHAT_ID (optional)

---

## SETUP-YOUTUBE.JS

One-time OAuth helper. Run locally:
1. Creates OAuth2 client from env vars
2. Opens browser to Google auth page (scopes: youtube.upload, youtube.force-ssl)
3. Listens on localhost:8765 for callback
4. Exchanges code for tokens
5. Prints YOUTUBE_REFRESH_TOKEN to paste into .env + GitHub Secrets

---

## CONTENT PHILOSOPHY

Every video = 3-act structure built for addiction:

**ACT 1 — THE HOOK:** Cold open with modern parallel BEFORE naming the source. Curiosity gap.

**ACT 2 — THE REVELATION:** Verified verse/hadith, historical context, cinematic narration.

**ACT 3 — THE MIRROR (this is the differentiator):** Pivot to 2026. Specific modern parallels. 2–3 actionable shifts the viewer can make THIS WEEK. Not vague ("be a better Muslim") — concrete ("delete one app that steals 2 hours of your day").

**CLIFFHANGER:** Tease next video by name. Subscribe CTA woven naturally.

Pattern interrupts every 45 seconds. Hook must reference something from last 5 years. Modern parallels must cite specific events/years. Action items doable in <7 days by a working person with a phone.

---

## ETHICAL GUARDRAILS

- Verses + hadith from verified local files, never AI-generated
- Disclaimer in every description (not fatwa)
- No depiction of prophets/sahaba in images
- No sectarian framing
- No predictions of WHEN the Hour comes — only signs
- 10-video manual review before autonomous upload
- Visual Architect enforces: no faces of religious figures, use symbols/environments/light/architecture/calligraphy instead

---

## DATA BOOTSTRAP (for local dev)

```bash
mkdir -p data
# Quran: download from https://tanzil.net/download/ → Sahih International → save as data/quran-en-sahih.txt
# Hadith:
cd data
git clone --depth 1 https://github.com/fawazahmed0/hadith-api.git hadith
find hadith/editions -mindepth 1 -maxdepth 1 -type d ! -name 'eng-*' -exec rm -rf {} +
cd ..
```

---

## COMMANDS

- `npm install` — install deps
- `npm start` — run full pipeline (one video)
- `npm run test-script` — dry run (script only, no images/voice/video)
- `node setup-youtube.js` — one-time YouTube OAuth
- `PUBLISH_DIR="output/<folder>" npm run upload-only` — manually upload a review-mode video
