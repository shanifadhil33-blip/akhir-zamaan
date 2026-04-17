# assets/music/

Drop **halal ambient tracks** here as `.mp3` files. FFmpeg picks one at random per video and plays it under the voiceover at ~-22dB.

## Requirements

- Format: `.mp3`, `.m4a`, `.wav`, or `.ogg` (mp3 strongly preferred)
- Length: 3+ minutes each (will be looped if video is longer)
- Style: ambient, atmospheric, suitable for a documentary tone — **no instrumental music** if you follow the stricter interpretation
- Count: **5–10 tracks** so the channel does not sound repetitive

## Halal track sources (free, public-domain / CC0)

- **Nasheeds without instruments** — vocal-only tracks
- **Nature soundscapes** — rain, wind, ocean, cave ambience (these are universally accepted)
- **White/brown/pink noise beds** — subtle atmospheric texture under narration

Some places to find them:
- Freesound.org (filter by CC0 / Creative Commons)
- Pixabay audio (royalty-free, no attribution required)
- Zapsplat (free with account)
- YouTube Audio Library (download then re-encode to mp3)

## Commit policy

**Do NOT commit music files to the git repo.** They are gitignored. You have two options:

### Option A: Keep music in this folder locally + on the GitHub Actions runner
- Add a release with the music bundled, then fetch it in the workflow (see `bootstrap-music` step — TODO, ask Claude to add if needed)

### Option B (simplest): Use GitHub Actions secrets or artifact
- Zip your music folder, upload as a GitHub repo asset or private gist, and download it in the workflow before `npm start`

### Option C (lowest effort): Self-hosted runner
- If you run the cron on your own machine instead of GitHub Actions, the `assets/music/` folder just stays local.

## What happens with no music?

The pipeline degrades gracefully — the voiceover plays without background music. Video still publishes. You will see `[assembler] no music track in assets/music/ — voiceover only` in the logs.
