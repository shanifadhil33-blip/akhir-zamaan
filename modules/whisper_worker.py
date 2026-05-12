#!/usr/bin/env python
"""Whisper forced-alignment worker. Reads JSON config from stdin, transcribes
the rendered Kokoro/Edge/StreamElements audio with word-level timestamps,
and writes the result as a JSON line to stdout.

Input JSON shape:
  {
    "audioPath": "output/.../voiceover.mp3",
    "model": "base.en",
    "language": "en"
  }

Output JSON line:
  { "words": [
      { "text": "you", "start_ms": 1240, "end_ms": 1380 },
      { "text": "wake", "start_ms": 1380, "end_ms": 1620 },
      ...
    ],
    "duration_sec": 832.4 }

faster-whisper uses CTranslate2 under the hood and is roughly 4x faster
than openai-whisper at equivalent accuracy. The base.en model is ~75 MB
and produces word-accurate timestamps on clean TTS audio in about
1-2 minutes per 12-min file on a hosted CPU runner.
"""
import json
import sys

from faster_whisper import WhisperModel


def main():
    cfg = json.load(sys.stdin)
    audio_path = cfg["audioPath"]
    model_size = cfg.get("model", "base.en")
    language = cfg.get("language", "en")

    print(f"[whisper] loading model: {model_size}", file=sys.stderr)
    # int8 quantization keeps the model small in memory and fast on CPU
    # without measurable quality loss for word-timestamp alignment.
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    print(f"[whisper] transcribing {audio_path}...", file=sys.stderr)
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        # VAD filtering can chop quiet/dramatic pauses out of the timeline,
        # which would mis-align captions for our cinematic [PAUSE] sections.
        # Disable it so the timing reflects the actual audio.
        vad_filter=False,
        # Beam search default is 5; trade a little accuracy for speed
        beam_size=3,
    )

    words = []
    segment_count = 0
    for segment in segments_iter:
        segment_count += 1
        if not segment.words:
            continue
        for w in segment.words:
            text = (w.word or "").strip()
            if not text:
                continue
            words.append({
                "text": text,
                "start_ms": int(round(w.start * 1000)),
                "end_ms": int(round(w.end * 1000)),
            })
        if segment_count % 20 == 0:
            print(f"[whisper] {segment_count} segments processed", file=sys.stderr)

    print(
        f"[whisper] done: {len(words)} words extracted over {info.duration:.1f}s",
        file=sys.stderr,
    )

    sys.stdout.write(json.dumps({
        "words": words,
        "duration_sec": info.duration,
    }))


if __name__ == "__main__":
    main()
