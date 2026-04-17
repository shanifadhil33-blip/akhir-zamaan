# assets/fonts/

Optional custom `.ttf` fonts for captions and thumbnail text.

If this folder is empty, the pipeline falls back to common system fonts:
- **Windows**: `C:/Windows/Fonts/ariblk.ttf` (Arial Black) or `arialbd.ttf` (Arial Bold)
- **Linux (GitHub Actions)**: `/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf` (installed via apt in the workflow)

To override, set `FONT_PATH=/absolute/path/to/font.ttf` in `.env`.

The default Arial Black gives the "documentary headline" feel in thumbnails. Change only if you want a different brand look.
