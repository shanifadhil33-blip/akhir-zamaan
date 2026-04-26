# Akhir Zamaan

Autonomous Islamic end-times video pipeline. One 15–20 minute documentary generated daily at 06:00 UTC. The finished `.mp4` is uploaded to a temporary file host and the download link is sent to your Telegram. You then upload to YouTube manually (no quality loss, no API).

## What it does

Every day the pipeline:
1. Picks the next topic from `topics-queue.json`
2. Loads the relevant Quran verses + hadith from local files (never AI-generated)
3. Pulls 4–6 real 2023–2026 events that mirror the topic theme
4. Generates a 2,800-word diagnostic-cinematic script (Ollama `gpt-oss:120b-cloud`)
5. Converts it to ~60 visual beats + thumbnail plan
6. In parallel: generates British-narrator voiceover (Kokoro / StreamElements / Edge TTS), all images (Pollinations), downloads Arabic recitations (EveryAyah), renders thumbnail background
7. Builds burned-in captions + standalone SRT from TTS word timings
8. Assembles the full video with FFmpeg (Ken Burns motion, ambient music ducked at -22dB, burned captions, recitation overlays on verse beats)
9. Renders the thumbnail
10. **Delivery (in GitHub Actions):** uploads the `.mp4` to `bashupload.com` via `curl` and sends the download link to your Telegram chat. The mp4 is also retained as a workflow artifact for 14 days as a fallback.

## Cost

**$0.00/month.** Ollama + Pollinations + Kokoro/Edge TTS + EveryAyah + FFmpeg + GitHub Actions free tier + bashupload.com + Telegram.

## First-time setup

See [SETUP.md](SETUP.md). The only required external accounts are GitHub, an Ollama endpoint, and a Telegram bot.

## Content vision

See [CLAUDE.md](CLAUDE.md) for the full channel spec.

## Daily commands

```bash
npm install                  # one-time
npm run bootstrap-data       # one-time, downloads Quran + hadith
npm run test-script          # dry run: generate script only, no images/voice/video
npm start                    # full pipeline: generates one video into output/<timestamp>_<slug>/
```

When you run `npm start` locally, the finished video is at `output/<latest>/final.mp4` — open the folder and grab it. The bashupload + Telegram delivery only runs in GitHub Actions.

## Autonomy

After setup, touch nothing. GitHub Actions runs `npm start` daily at 06:00 UTC and Telegrams you the download link. Download → upload to YouTube → done. If the topics queue drops below 20 unpublished entries, Ollama auto-generates 30 more. If a beat image fails, the previous beat's image is reused. If the pipeline fails, Telegram pings you and the topic stays unpublished for retry tomorrow.

## Structure

```
akhir-zamaan/
├── pipeline.js                 ← orchestrator (10 stages)
├── topics-queue.json           ← seed topics (auto-refilled by Ollama)
├── published.json              ← dedup log (committed back by workflow)
├── package.json
├── .env / .env.example         ← secrets (gitignored)
├── prompts/
│   ├── script-engine.md
│   ├── visual-architect.md
│   ├── metadata-engine.md
│   └── topic-generator.md
├── modules/
│   ├── llm.js                  ← Ollama wrapper (script + visual + metadata)
│   ├── ollama.js               ← Ollama HTTP client
│   ├── source-retriever.js     ← Quran + hadith from local files
│   ├── modern-context.js       ← real-event grounding
│   ├── voiceover.js            ← TTS provider chain (kokoro → streamelements → edge)
│   ├── kokoro-tts.js           ← local Kokoro-82M ONNX TTS
│   ├── edge-tts.js             ← Microsoft Edge TTS
│   ├── streamelements-tts.js   ← StreamElements TTS fallback
│   ├── recitation.js           ← Arabic Quran audio from EveryAyah
│   ├── images.js               ← Pollinations image generation
│   ├── captions.js             ← SRT + ASS from TTS word timings
│   ├── assembler.js            ← FFmpeg video + thumbnail
│   ├── queue.js                ← topic picker + dedup
│   ├── topic-generator.js      ← auto-refill
│   └── notify.js               ← Telegram notifications (errors + delivery)
├── scripts/
│   ├── bootstrap-data.js       ← downloads Quran + hadith
│   ├── resume-pipeline.js      ← re-assemble from existing artifacts
│   ├── regen-images.js
│   ├── regen-voice.js
│   └── test-kokoro.js
├── assets/
│   ├── kokoro/                 ← Kokoro-82M ONNX model + voices
│   ├── music/                  ← halal ambient tracks (you add these)
│   └── fonts/                  ← optional custom fonts
├── data/                       ← gitignored, downloaded on demand
└── .github/workflows/
    └── daily.yml               ← cron at 06:00 UTC + bashupload + Telegram delivery
```

## Guardrails

- Verses + hadith never AI-generated — only from local verified files
- No depiction of Prophet ﷺ, prophets (AS), sahaba (RA), Allah ﷻ, or angels with faces
- No sectarianism, no fatwa claims, no predictions of WHEN the Hour comes
- Disclaimer in every video description
- Topic stays unpublished until video assembly succeeds

## License

Personal use. No warranty. Built for @akhirzamaan.
