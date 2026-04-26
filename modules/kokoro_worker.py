#!/usr/bin/env python
"""Kokoro-82M TTS worker. Reads JSON config from stdin, writes WAV to outputPath.

Input JSON shape:
  {
    "text": "...with <break time=\"700ms\"/> tags...",
    "voice": "bm_george",
    "speed": 0.95,
    "lang": "en-gb",
    "modelPath": "assets/kokoro/kokoro-v1.0.onnx",
    "voicesPath": "assets/kokoro/voices-v1.0.bin",
    "outputPath": "output/.../voiceover.wav"
  }

Breaks are honored by splitting text on <break/> tags and inserting silence.
Long text segments are sub-split on sentence boundaries so a single phonemizer
failure (espeak choking on one weird char) doesn't kill the whole render.
"""
import json
import re
import sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

BREAK_RE = re.compile(r'<break\s+time="?(\d+)ms"?\s*/>', re.IGNORECASE)
SENT_END_RE = re.compile(r'(?<=[.!?])\s+(?=[A-Z])')


def split_on_breaks(text):
    """Return list of (kind, payload) where kind is 'text' or 'break'."""
    out = []
    idx = 0
    for m in BREAK_RE.finditer(text):
        before = text[idx:m.start()].strip()
        if before:
            out.append(('text', before))
        out.append(('break', int(m.group(1))))
        idx = m.end()
    tail = text[idx:].strip()
    if tail:
        out.append(('text', tail))
    return out


def split_sentences(text, max_chars=300):
    """Split a text segment into sentence-sized pieces. Keeps short segments
    whole; splits long ones on sentence boundaries so a phonemizer failure on
    one sentence doesn't discard minutes of narration."""
    if len(text) <= max_chars:
        return [text]
    sentences = SENT_END_RE.split(text)
    chunks = []
    current = ''
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        if len(current) + len(s) + 1 <= max_chars:
            current = (current + ' ' + s).strip()
        else:
            if current:
                chunks.append(current)
            if len(s) <= max_chars:
                current = s
            else:
                # Sentence itself is too long; hard-split on commas / whitespace
                for piece in re.findall(r'.{1,%d}(?:\s|$)' % max_chars, s):
                    chunks.append(piece.strip())
                current = ''
    if current:
        chunks.append(current)
    return [c for c in chunks if c]


def main():
    cfg = json.load(sys.stdin)
    text = cfg['text']
    voice = cfg.get('voice', 'bm_george')
    speed = float(cfg.get('speed', 0.95))
    lang = cfg.get('lang', 'en-gb')
    model_path = cfg['modelPath']
    voices_path = cfg['voicesPath']
    out_path = cfg['outputPath']

    print(f'[kokoro] loading model (voice={voice}, speed={speed})', file=sys.stderr)
    kokoro = Kokoro(model_path, voices_path)

    segments = split_on_breaks(text)
    if not segments:
        raise SystemExit('kokoro_worker: empty text')

    # Flatten: expand text segments into sentence-sized chunks
    flat = []
    for kind, payload in segments:
        if kind == 'break':
            flat.append(('break', payload))
        else:
            for chunk in split_sentences(payload):
                flat.append(('text', chunk))

    all_audio = []
    sample_rate = 24000
    spoken_chars = 0
    rendered = 0
    failed = 0
    for i, (kind, payload) in enumerate(flat):
        if kind == 'break':
            silence = np.zeros(int(sample_rate * payload / 1000.0), dtype=np.float32)
            all_audio.append(silence)
            continue
        try:
            samples, sr = kokoro.create(payload, voice=voice, speed=speed, lang=lang)
            sample_rate = sr
            all_audio.append(samples.astype(np.float32))
            spoken_chars += len(payload)
            rendered += 1
            if rendered % 5 == 0 or i == len(flat) - 1:
                print(f'[kokoro] {rendered}/{len(flat)} chunks done', file=sys.stderr)
        except Exception as e:
            failed += 1
            msg = str(e).splitlines()[0] if str(e) else type(e).__name__
            preview = payload[:60].replace('\n', ' ')
            print(f'[kokoro] SKIP chunk {i+1} ({len(payload)} chars, "{preview}..."): {msg}', file=sys.stderr)
            # Insert a short silence to preserve pacing roughly
            silence = np.zeros(int(sample_rate * 0.3), dtype=np.float32)
            all_audio.append(silence)

    if rendered == 0:
        raise SystemExit('kokoro_worker: every chunk failed — check text / espeak install')

    # Fail the worker if too many chunks failed (>10%) so voiceover.js can fall
    # back to another provider instead of shipping a near-silent file.
    fail_ratio = failed / max(1, (rendered + failed))
    if fail_ratio > 0.1:
        raise SystemExit(f'kokoro_worker: {failed}/{rendered + failed} chunks failed ({fail_ratio:.0%}) — falling back')

    final = np.concatenate(all_audio) if all_audio else np.zeros(0, dtype=np.float32)
    sf.write(out_path, final, sample_rate, subtype='PCM_16')
    duration_sec = len(final) / sample_rate if sample_rate else 0.0
    print(json.dumps({
        'outputPath': out_path,
        'durationSec': duration_sec,
        'sampleRate': sample_rate,
        'voice': voice,
        'spokenChars': spoken_chars,
        'chunksRendered': rendered,
        'chunksFailed': failed,
    }))


if __name__ == '__main__':
    main()
