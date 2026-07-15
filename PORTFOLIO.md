# Akhir Zamaan — Autonomous Islamic Documentary Pipeline

**Status:** Frozen as a portfolio case study on 2026-07-15. GitHub Actions cron disabled; `workflow_dispatch` retained for on-demand demos. Codebase, secrets, R2 bucket, and Telegram delivery link remain intact.

**Live demo:** Repo → Actions tab → *"Akhir Zamaan Video Pipeline"* → **Run workflow**. A full run finishes in ~25 min and Telegram delivers the download link.

---

## 1. What it does

Given a topic ID from a curated queue, the pipeline autonomously produces a 12-minute Islamic documentary video and delivers a download link to the operator's Telegram — with zero human intervention between "topic picked" and "video ready to upload to YouTube."

Every video contains:

- A 1,500–2,000-word original script anchored in Quran verses (from a local tanzil.net dataset) and canonical hadith (Bukhari, Muslim, Abu Dawud, Tirmidhi, Nasai, Ibn Majah — the six Sunni collections)
- ~80–150 AI-generated beat images that visualize what the narrator is saying at that moment
- English narration via neural TTS with Islamic-honorific pre-processing
- Word-accurate burned-in captions aligned by forced Whisper transcription
- Ken Burns zoom motion + FFmpeg-mastered audio normalized to YouTube's -14 LUFS standard
- A thumbnail with topic-appropriate imagery and title overlay
- Machine-generated YouTube title, description, tags, and chapter markers

---

## 2. What actually shipped

Autonomous production between 2026-05-22 and 2026-07-04 (44 days):

| Metric | Value |
|---|---|
| Videos produced end-to-end | **17** |
| Cadence | 2–3 per week |
| Average duration | 11–13 minutes |
| Categories covered | Modern life (ml_*), current affairs (ca_*), science (sc_*), history (hi_*), eschatology (et_*), tech (tc_*), reflections (dr_*), lust series (lst_*) |
| Runtime per video (cloud) | ~25 minutes on a `ubuntu-latest` runner |
| Human touch time per video | ~2 minutes (download link, upload to YouTube) |

The full receipts are in [`published.json`](published.json) — every video's ID, title, R2 storage path, and UTC publish timestamp.

---

## 3. Architecture

A 10-stage Node.js pipeline (`pipeline.js`) orchestrated on GitHub Actions cron. Each stage produces a JSON or media artifact consumed by the next.

```
topics-queue.json
     ↓
[1] Topic picker           modules/queue.js         → picks next unpublished
[2] Source retrieval       modules/source-retriever → Quran + hadith from data/
[3] Modern context         modules/research.js      → Tavily search + LLM synthesis
[4] Script generation      modules/ollama.js        → chunked skeleton + 5 movements + critic
                           modules/deepseek.js      → DeepSeek V3 for script tier
                           modules/script-critic.js → grounding-anchored audit + retry
                           modules/script-templates → 5 voice templates by category
[5] Visual plan            modules/ollama.js        → beats + image prompts
[6] Parallel generation:
    ├─ Voice               modules/voiceover.js     → Edge TTS / Kokoro-82M ONNX
    ├─ Images              modules/images.js        → HF Flux Schnell / CF Workers AI / Pollinations
    └─ Whisper alignment   modules/whisper-align.js → faster-whisper base.en
[7] Captions               modules/captions.js      → .srt + .ass (72pt Roboto Condensed)
[8] Video assembly         modules/assembler.js     → FFmpeg Ken Burns + loudnorm
[9] Thumbnail              modules/assembler.js     → background + text overlay
[10] Metadata              modules/ollama.js        → title, desc, tags, chapters
     ↓
Cloudflare R2 upload → Telegram delivery link + captions .txt
```

### Tech stack

| Layer | Tool | Cost |
|---|---|---|
| Runtime | Node.js 20 on `ubuntu-latest` runner | $0 (public repo → unlimited GitHub Actions minutes) |
| Main LLM | Ollama Cloud (`gpt-oss:120b-cloud`) | $0 (free/unlimited on this account) |
| Script-tier LLM | DeepSeek V3 (via OpenAI-compatible API) | ~$0.036 per video |
| Web research | Tavily Search API | $0 (free tier: 1000 searches/month) |
| Image generation | HuggingFace Flux Schnell → Cloudflare Workers AI → Pollinations (3-tier fallback) | $0 (free tiers) |
| TTS | Microsoft Edge TTS (WebSocket, no key needed) with Kokoro-82M / StreamElements fallbacks | $0 |
| Forced caption alignment | faster-whisper `base.en` on the runner | $0 (open source) |
| Video assembly | FFmpeg + libx264 + libmp3lame | $0 (open source) |
| File hosting | Cloudflare R2 (S3-compatible, public dev URL, 7-day lifecycle rule) | $0 (well under 10 GB free tier) |
| Delivery | Telegram Bot API (send-only) | $0 |
| **Total per video** | | **~$0.036** |
| **Total per video without DeepSeek** | (Ollama only for script tier) | **~$0.00** |

---

## 4. Design evolution — non-obvious things learned by shipping 17 videos

The commit log is the design narrative. Every architectural inflection has a commit with the operator-feedback reason attached. Key iterations:

### 4.1 Delivery: killed the YouTube API auto-upload
Originally the pipeline uploaded directly to YouTube via the Data API v3 with OAuth. Rejected — required Google Cloud project setup, OAuth token refresh handling, quota management, and a policy risk per Google's automation rules. Replaced with **Cloudflare R2 upload + Telegram bot link** so the operator uploads manually with 2 minutes of touch time per video. Reduced attack surface, removed one entire failure mode, no more quota exhaustion.

### 4.2 File hosting: five providers before settling on R2
Iteration order: **bashupload.com** (SSL expired) → **0x0.st** (503s) → **catbox.moe** (412s) → **Pixeldrain** (401s) → **Cloudflare R2**. R2 was the only one where I controlled both the upload endpoint and the public serving URL. First R2 attempt failed with 404s because the `R2_ENDPOINT` secret was pasted with the bucket name appended as a path — causing `s3://bucket/bucket/key` to be built. Fixed with a defensive `${R2_ENDPOINT_C%/${R2_BUCKET_NAME_C}}` strip in the workflow so future paste mistakes self-correct.

### 4.3 Queue: reshuffle from category-clumped to round-robin
Original queue was 15 `ml_*` topics followed by 15 `ca_*`, etc. First 8 weeks of publishing were all modern-life-with-a-phone scripts. Rotated to `ml → ca → sc → hi → et → tc → dr → lst → ml → …` so each week's videos land in a fresh thematic neighborhood. Immediate viewer-side improvement in perceived variety.

### 4.4 Script generation: five templates instead of one voice
The original prompt had a single "diagnostic, second-person, cinematic" voice that was tuned for modern-life psychology topics. When the queue reshuffled to include Dajjal / cosmology / history / Yusuf, that same voice produced bedroom-diagnostic scripts about topics that needed sage-authority voice. Refactored into **five templates** (`civilizational_diagnosis`, `prophecy_unfolding`, `wonder_revelation`, `historical_excavation`, `modern_diagnosis`) — each topic declares which template it uses. Result: consecutive videos structurally different from each other.

### 4.5 Content policy: three layers of defense against hallucination
A YouTube comment flagged a video for having "female shadows in the background." Investigation revealed the visual-architect prompt allowed "modest hijab back-of-head" — Flux Schnell rendered these as obvious female silhouettes. Result: **zero female depiction rule** enforced at three layers — visual-architect prompt (LLM instruction), `NEGATIVE_PROMPT` (Flux rejection terms), and a regex-based prompt sanitizer (`modules/images.js` swaps "hijabi woman" → "veil suspended in light" before the prompt reaches any provider).

Same defense-in-depth pattern applied to modern-grounding celebrity leakage after a script cited Kanye West, Megan Thee Stallion, and Harvey Weinstein in a Dajjal video — completely wrong tonal register. Result: `modules/content-policy.js` with a 24-name banlist, applied at synthesis time (research module), script-writing time (script-engine prompt), and pre-submit time (LLM validation checklist).

### 4.6 The Timelessness Test
Even after banning specific names, the LLM would still produce paragraphs that read like 2026 cable news. Added a final validation gate: *"Would this exact paragraph still make perfect sense and carry the same spiritual weight 50 years from now?"* If not, rewrite as an archetypal observation. Example: `"TikTok's 2024 algorithm change did X"` fails; `"the silent code that consumes your hours"` passes.

### 4.7 Script Critic loop with grounding anchor
LLMs were fabricating specific-sounding scientific studies (invented Lancet 2024 papers) and startup names (like "SwarmX") to force modern-context connections to religious text. Added a post-generation **critic pass**: after the 5 movements are generated, a lightweight Ollama call cross-references every specific claim in the draft against the raw Tavily search snippets that fed the research stage. Claims that can't be located in the snippets → mark `pass: false`, regenerate the flagged movement with the critic's reason as a correction hint. Max 2 retries; a third failure throws a fatal error tagged with `Unresolved Hallucinations in Script Generation` that surfaces to Telegram so the operator can inspect the topic manually.

### 4.8 Audio: five iterations to land on right levels
Music volume tuned progressively: `0.20` (inaudible) → `0.32` (dominates) → `0.18` (still loud) → `0.12` (better) → **disabled entirely** after a viewer commented that the humming was un-Islamic. Now voice-only with `loudnorm=I=-14:LRA=11:TP=-1.5` mastering to YouTube standard.

### 4.9 Captions: from 44pt to 72pt over four passes
Progressive bump `44 → 52 → 60 → 72pt` driven by mobile-readability feedback. Outline grew from 1.5px to 3px to stay crisp at the larger size. 5 words per chunk retained — still fits one line at 72pt within the 1680px text area.

### 4.10 The greeting was added at video 15
Original cold opens tried to be dramatic ("Look at the men of your generation…") without ever telling the viewer what the video was about. Watch-time dropped in the first 20 seconds. Added mandatory `"Assalamu alaikum, brothers and sisters."` + 1–2 sentence topic preview as the first thing every script says. Immediate improvement.

---

## 5. Interesting technical problems solved

- **Chunked LLM generation for long-form scripts** — a monolithic "write a 1800-word script in one call" produces truncated / hallucinated output on 120B-class models. Broke the prompt into skeleton → 5 movement calls (each with the previous movements as context) → metadata extractor. Also gave the critic natural per-movement retry granularity.

- **Whisper onset-detection lag correction** — faster-whisper's `word.start` timestamps are DTW-derived from cross-attention, biased ~200–300 ms after actual phoneme onset. Applied a `CAPTION_LEAD_MS=280` shift to both chunk start and end so captions land in sync with audio without visible drift.

- **Flux Schnell text-hallucination sanitizer** — Flux fills any text-shaped surface with garbled letters. Built a regex sanitizer (`modules/images.js`) that runs before every provider call and swaps text-prone nouns: "phone screen" → "dark glowing rectangle", "speech bubble" → "empty space", "reading a book" → "holding a closed weathered tome". Kills the trigger before generation; the strengthened negative prompt handles edge cases.

- **Deterministic Movement 4 rotation** — five different "Movement 4" reflection structures (`two-versions`, `haunting-question`, `historical-mirror`, `direct-command`, `time-pivot`) rotated per topic ID via `hash(topic.id) % 5`. Distribution across the 156-topic queue landed at 28–35 per bucket — comfortably balanced.

- **Grounding-anchored critic** — the audit LLM sees not just the draft but also the raw Tavily snippets that fed the research stage. A hallucinated "Stanford 2024 attention-span study" that doesn't appear in the snippets fails the audit; the script gets regenerated with the specific reason attached.

- **Silent-fallback multi-provider chains** — every external dependency has a fallback. Images: HF → Cloudflare → Pollinations. TTS: Edge → Kokoro → StreamElements. Script LLM: DeepSeek → Ollama. Storage: R2 → catbox → 0x0.st. Any single provider failure degrades the run gracefully; only cascade failures halt the pipeline.

---

## 6. What this project demonstrates

- **End-to-end pipeline engineering** — from cron trigger through multi-modal LLM orchestration, image generation, forced audio alignment, FFmpeg mastering, cloud storage, and delivery.
- **Iterative refinement from real feedback** — every architectural decision has a commit message with the operator or viewer feedback that motivated it. The `git log` reads as a design journal.
- **Cost engineering** — near-$0 per-video cost on free tiers of five different platforms with sensible fallback chains.
- **Prompt engineering at scale** — five per-topic script templates, three-layer content policy, per-movement specs, deduplication rules, validation checklists, cross-referencing critic.
- **Handling LLM failure modes systematically** — hallucination critic, celebrity ban post-filter, prompt sanitizer for image-model text quirks, deterministic structural rotation to defeat template collapse.
- **Domain sensitivity** — a channel about sacred content demanded editorial rules (Haya mandate, Timelessness Test, theological accuracy guardrails, jurisprudential caution) that most automation projects wouldn't need. Everything is encoded declaratively so the policy is auditable.

---

## 7. Current state

The pipeline is dormant. The Tuesday + Saturday GitHub Actions cron is commented out (see [`.github/workflows/daily.yml`](.github/workflows/daily.yml)); only manual triggers via the Actions tab will start a run. Codebase, secrets, R2 bucket, and Telegram bot token are preserved so any run initiated from the Actions tab produces a fresh video within ~25 minutes.

To reactivate autonomous production: uncomment the four `schedule:` lines in `daily.yml` and push. Everything else already works.

---

## 8. Repository map

```
akhir-zamaan/
├── PORTFOLIO.md                    ← this file
├── CLAUDE.md                       ← full architecture / spec (dense)
├── README.md, SETUP.md             ← original operator docs
├── pipeline.js                     ← 10-stage orchestrator
├── topics-queue.json               ← 156 curated topics (16 published, 140 unpublished)
├── published.json                  ← receipts: what actually shipped
├── prompts/
│   ├── script-engine.md            ← main script generation prompt
│   ├── visual-architect.md         ← beat storyboard prompt
│   ├── metadata-engine.md          ← YouTube metadata prompt
│   └── topic-generator.md          ← queue auto-refill prompt
├── modules/
│   ├── content-policy.js           ← banlist + Haya mandate + Timelessness Test
│   ├── script-templates.js         ← 5 per-category script templates
│   ├── script-critic.js            ← grounding-anchored audit loop
│   ├── deepseek.js                 ← DeepSeek V3 client
│   ├── ollama.js                   ← Ollama Cloud client + script generator
│   ├── research.js                 ← Tavily search + LLM synthesis
│   ├── source-retriever.js         ← Quran + hadith loader
│   ├── voiceover.js                ← TTS provider chain
│   ├── images.js                   ← image provider chain + text/female sanitizers
│   ├── whisper-align.js            ← forced caption alignment
│   ├── captions.js                 ← SRT + ASS builders
│   ├── assembler.js                ← FFmpeg pipeline
│   └── ...
├── data/
│   ├── quran-en-sahih.txt          ← tanzil.net Sahih International
│   └── hadith/editions/            ← six canonical Sunni collections
└── .github/workflows/daily.yml     ← cron: DISABLED. workflow_dispatch: active.
```

---

*A ~$0-per-video autonomous content pipeline that produced 17 sacred-content documentaries with three layers of hallucination defense, five script voice templates, and no human writers.*
