# data/

Holds the Quran text and hadith JSON collections. **All files in this folder are gitignored** — they are downloaded automatically by `scripts/bootstrap-data.js` on every GitHub Actions run, and you can fetch them locally with `npm run bootstrap-data`.

## What lives here

```
data/
├── quran-en-sahih.txt          ← Sahih International English Quran (tanzil.net format: chapter|verse|text)
├── quran-uthmani.txt           ← Arabic Uthmani script (optional, same format)
└── hadith/
    └── editions/
        ├── eng-bukhari/
        ├── eng-muslim/
        ├── eng-tirmidhi/
        ├── eng-abudawud/
        ├── eng-nasai/
        └── eng-ibnmajah/
```

## Sources

- **Quran text**: [tanzil.net](https://tanzil.net/download/) — Sahih International (English) + Uthmani (Arabic)
- **Hadith**: [github.com/fawazahmed0/hadith-api](https://github.com/fawazahmed0/hadith-api) — all six major Sunni collections in JSON

## Manual download (local dev)

```bash
npm run bootstrap-data
```

This runs `scripts/bootstrap-data.js` which fetches Tanzil + clones the hadith repo, then prunes non-English editions to save space.

## Why local files?

Religious content must never be paraphrased or hallucinated by AI. The Script Engine only quotes verses and hadith that appear in these files verbatim. If a source cannot be loaded, the verse/hadith is not used in the script.
