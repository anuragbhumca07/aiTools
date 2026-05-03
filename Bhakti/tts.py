#!/usr/bin/env python3
"""
tts.py <voice> <text_file> <output_mp3>

Reads story text from a UTF-8 file, sanitises it, splits into ≤400-char
sentence-boundary chunks, synthesises each with edge_tts.Communicate
(with retry/back-off), then concatenates into one MP3 via ffmpeg.
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import unicodedata

import edge_tts

CHUNK_MAX = 400   # conservative — well within edge-tts server limit
MAX_RETRIES = 3   # per-chunk retry attempts


# ── Text sanitisation ──────────────────────────────────────────────
_REPLACEMENTS = {
    # Smart / curly quotes → straight
    '\u2018': "'", '\u2019': "'",
    '\u201c': '"', '\u201d': '"',
    # Dashes
    '\u2013': '-', '\u2014': ',',
    # Ellipsis
    '\u2026': '...',
    # Non-breaking space / zero-width chars
    '\u00a0': ' ', '\u200b': '', '\u200c': '', '\u200d': '',
    # Bullet / middot
    '\u2022': '.', '\u00b7': '.',
}

def sanitize(text: str) -> str:
    """Normalise unicode and replace chars that confuse edge-tts."""
    text = unicodedata.normalize('NFC', text)
    for old, new in _REPLACEMENTS.items():
        text = text.replace(old, new)
    # Drop characters outside the Basic Latin + Latin-1 Supplement blocks
    # (e.g. Devanagari, emoji) that an English neural voice cannot pronounce.
    text = ''.join(
        c if ord(c) < 256 else (' ' if unicodedata.category(c)[0] == 'Z' else '')
        for c in text
    )
    # Collapse multiple spaces
    return ' '.join(text.split())


# ── Chunking ───────────────────────────────────────────────────────
def split_chunks(text: str) -> list:
    if len(text) <= CHUNK_MAX:
        return [text]
    chunks, remaining = [], text.strip()
    while len(remaining) > CHUNK_MAX:
        window = remaining[:CHUNK_MAX]
        best = max(
            window.rfind('. '),
            window.rfind('! '),
            window.rfind('? '),
            window.rfind('\n'),
        )
        cut = (best + 1) if best > int(CHUNK_MAX * 0.3) else CHUNK_MAX
        chunks.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


# ── Synthesis with retry ───────────────────────────────────────────
async def synthesize(voice: str, text: str, out_path: str) -> None:
    last_err = RuntimeError('no attempts made')
    for attempt in range(MAX_RETRIES):
        try:
            communicate = edge_tts.Communicate(text, voice)
            await communicate.save(out_path)
            return
        except Exception as exc:
            last_err = exc
            if attempt < MAX_RETRIES - 1:
                wait = 2 ** attempt   # 1 s, 2 s back-off
                print(f'[tts] attempt {attempt+1} failed ({exc}), retrying in {wait}s…',
                      file=sys.stderr)
                await asyncio.sleep(wait)
    raise last_err


# ── Main ───────────────────────────────────────────────────────────
async def main() -> None:
    voice     = sys.argv[1]
    text_file = sys.argv[2]
    output    = sys.argv[3]

    with open(text_file, 'r', encoding='utf-8') as fh:
        raw = fh.read()

    text = sanitize(raw)
    if not text:
        raise ValueError(f'Text is empty after sanitisation (original length {len(raw)})')

    chunks = split_chunks(text)

    if len(chunks) == 1:
        await synthesize(voice, chunks[0], output)
        return

    tmp = tempfile.mkdtemp()
    try:
        chunk_files = []
        for i, chunk in enumerate(chunks):
            p = os.path.join(tmp, f'c{i}.mp3')
            await synthesize(voice, chunk, p)
            chunk_files.append(p)

        list_path = os.path.join(tmp, 'list.txt')
        with open(list_path, 'w') as fh:
            for p in chunk_files:
                fh.write(f"file '{p}'\n")

        subprocess.run(
            ['ffmpeg', '-f', 'concat', '-safe', '0', '-i', list_path,
             '-c', 'copy', '-y', output],
            check=True,
            capture_output=True,
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


asyncio.run(main())
