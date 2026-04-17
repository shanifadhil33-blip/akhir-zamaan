# Akhir Zamaan

Fully autonomous Islamic end-times YouTube channel. One 15–20 minute video + a companion Short published daily at 06:00 UTC. Zero-touch, $0/video.

## What it does

Every day the pipeline:
1. Picks the next topic from `topics-queue.json`
2. Loads the relevant Quran verses + hadith from local files (never AI-generated)
3. Uses Gemini with Google Search grounding to find 4–6 real 2023–2026 events that mirror the topic
4. Generates a 2,800-word diagnostic-cinematic script (Gemini 2.5 Pro)
5. Converts it to 60 visual beats + thumbnail plan (Gemini 2.5 Flash)
6. In parallel: generates British-narrator voiceover (Edge TTS), all 60 images (Pollinations), downloads Arabic recitations (EveryAyah), renders thumbnail background
7. Builds burned-in captions + YouTube SRT from TTS word timings
8. Assembles the full video with FFmpeg (Ken Burns motion, ambient music ducked at -22dB, burned captions, recitation overlays on verse beats)
9. Generates a 50-second vertical Short from the hook sequence
10. Uploads both + thumbnail + captions + pinned comment to YouTube

## Cost

**$0.00/month.** Gemini free tier + Pollinations + Edge TTS + EveryAyah + FFmpeg + GitHub Actions free tier + YouTube API free tier.

## First-time setup

See [SETUP.md](SETUP.md). ~45 minutes, mostly OAuth. After that, the channel runs itself.

## Content vision

See [CLAUDE.md](CLAUDE.md) for the full channel spec. Short version: this is not Islamic explainer content. It is psychological excavation of the modern Muslim soul, using Quran + Sunnah as the scalpel. Every video diagnoses a 2026 behavior (scrolling, lust, riba, dunya-chasing), names it as something the Prophet ﷺ already described 1400 years ago, and leaves the viewer with ONE existential decision. Like Allah speaking directly to one person at 2 AM.

## Daily commands

```bash
npm install                  # one-time
npm run bootstrap-data       # one-time, downloads Quran + hadith
npm run setup-youtube        # one-time, OAuth flow for upload permissions
npm run test-script          # dry run: generate script only, no images/voice/video
npm start                    # full pipeline: generate + upload one video + one Short
```

## Autonomy

After setup, touch nothing. GitHub Actions runs `npm start` daily at 06:00 UTC. If the topics queue drops below 20 unpublished entries, Gemini auto-generates 30 more. If Gemini Pro is rate-limited, the pipeline degrades to Flash. If a beat image fails, the previous beat's image is reused. If the Short fails, the main video still publishes. If the main video fails, Telegram pings you and the topic stays unpublished for retry tomorrow.

## Structure

```
akhir-zamaan/
├── pipeline.js                 ← orchestrator (10 stages)
├── setup-youtube.js            ← one-time OAuth helper
├── topics-queue.json           ← seed topics (auto-refilled by Gemini)
├── published.json              ← dedup log (gitignored but committed back by workflow)
├── package.json
├── .env / .env.example         ← secrets (gitignored)
├── prompts/
│   ├── script-engine.md        ← the diagnostic-cinematic voice
│   ├── visual-architect.md     ← beat-by-beat storyboard + thumbnail
│   ├── metadata-engine.md      ← title + description + tags + chapters
│   └── topic-generator.md      ← auto-refill topic queue
├── modules/
│   ├── gemini.js               ← AI text brain (Pro + Flash + grounded search)
│   ├── source-retriever.js     ← Quran + hadith from local files
│   ├── modern-context.js       ← Gemini grounded search
│   ├── voiceover.js            ← Edge TTS
│   ├── recitation.js           ← Arabic Quran audio from EveryAyah
│   ├── images.js               ← Pollinations image generation
│   ├── captions.js             ← SRT + ASS from TTS word timings
│   ├── assembler.js            ← FFmpeg video + thumbnail
│   ├── shorts.js               ← 50s vertical clip
│   ├── youtube.js              ← Data API v3 upload
│   ├── queue.js                ← topic picker + dedup
│   ├── topic-generator.js      ← auto-refill
│   └── notify.js               ← Telegram errors-only
├── scripts/
│   └── bootstrap-data.js       ← downloads Quran + hadith
├── assets/
│   ├── music/                  ← halal ambient tracks (you add these)
│   └── fonts/                  ← optional custom fonts
├── data/                       ← gitignored, downloaded on demand
└── .github/workflows/
    └── daily.yml               ← cron at 06:00 UTC
```

## Guardrails

- Verses + hadith never AI-generated — only from local verified files
- No depiction of Prophet ﷺ, prophets (AS), sahaba (RA), Allah ﷻ, or angels with faces
- No sectarianism, no fatwa claims, no predictions of WHEN the Hour comes
- Disclaimer in every video description
- Auto-retry on rate limits; topic stays unpublished until a real upload succeeds

## License

Personal use. No warranty. Built for @akhirzamaan.
