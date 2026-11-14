#!/usr/bin/env python3
"""Turn a folder of voice clips into a Piper training set.

clips/ (any audio/video ffmpeg reads: wav, mp3, m4a, ogg, flac, mp4...)
  -> Whisper transcribes with timestamps
  -> cut into sentence-sized pieces (1.5-12 s by default), mono 22050 Hz 16-bit, loudness-normalised
  -> dataset/wavs/*.wav + dataset/metadata.csv  ("utt0001.wav|Text of the utterance.")

Check metadata.csv afterwards: fixing wrong words (or deleting bad lines) is the single best thing
you can do for quality. Lines can be removed freely; the wav files they point to are just ignored.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

AUDIO_EXT = {".wav", ".mp3", ".m4a", ".ogg", ".opus", ".flac", ".aac", ".wma", ".mp4", ".mkv", ".webm", ".mov"}


def ffmpeg_cut(src: Path, dst: Path, start: float | None = None, end: float | None = None) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}", "-to", f"{end:.3f}"]
    cmd += ["-i", str(src), "-ac", "1", "-ar", "22050", "-sample_fmt", "s16",
            "-af", "highpass=f=60,loudnorm=I=-20:TP=-2:LRA=11", str(dst)]
    subprocess.run(cmd, check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("voice_dir", type=Path, help="work/<voice> folder containing clips/")
    ap.add_argument("--language", default="en", help="Whisper language code (default en)")
    ap.add_argument("--model", default="large-v3", help="Whisper model: large-v3 (best), medium, small")
    ap.add_argument("--min-seconds", type=float, default=1.5)
    ap.add_argument("--max-seconds", type=float, default=12.0)
    args = ap.parse_args()

    clips = args.voice_dir / "clips"
    out = args.voice_dir / "dataset"
    wavs = out / "wavs"
    if not clips.is_dir():
        sys.exit(f"Put your audio files in {clips}/ first")
    files = sorted(p for p in clips.rglob("*") if p.suffix.lower() in AUDIO_EXT)
    if not files:
        sys.exit(f"No audio files found in {clips}/")
    wavs.mkdir(parents=True, exist_ok=True)
    for old in wavs.glob("*.wav"):
        old.unlink()

    from faster_whisper import WhisperModel  # imported late so --help is instant
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading Whisper {args.model} on {device}...")
    model = WhisperModel(args.model, device=device, compute_type="float16" if device == "cuda" else "int8")

    rows, total, skipped, n = [], 0.0, 0, 0
    for f in files:
        print(f"Transcribing {f.name}...")
        segments, _ = model.transcribe(str(f), language=args.language, vad_filter=True, word_timestamps=False,
                                       condition_on_previous_text=False)
        # merge short neighbouring segments up to max-seconds so pieces are sentence-sized
        pieces, cur = [], None
        for s in segments:
            text = s.text.strip()
            if not text:
                continue
            if cur and s.start - cur["end"] < 0.6 and (s.end - cur["start"]) <= args.max_seconds:
                cur["end"], cur["text"] = s.end, cur["text"] + " " + text
            else:
                if cur:
                    pieces.append(cur)
                cur = {"start": s.start, "end": s.end, "text": text}
        if cur:
            pieces.append(cur)
        for p in pieces:
            dur = p["end"] - p["start"]
            if dur < args.min_seconds or dur > args.max_seconds or len(p["text"]) < 3:
                skipped += 1
                continue
            n += 1
            name = f"utt{n:05d}.wav"
            # small padding so word edges are not clipped
            ffmpeg_cut(f, wavs / name, max(0.0, p["start"] - 0.1), p["end"] + 0.15)
            rows.append(f"{name}|{p['text'].replace('|', ' ')}")
            total += dur

    (out / "metadata.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (out / "summary.json").write_text(json.dumps({"utterances": n, "minutes": round(total / 60, 1), "skipped": skipped}, indent=2))
    print(f"\n{n} utterances, {total / 60:.1f} minutes of speech ({skipped} pieces skipped: too short/long).")
    print(f"Now check {out / 'metadata.csv'} and fix any wrong words, then run ./train.sh {args.voice_dir.name}")
    if total < 300:
        print("Warning: under 5 minutes of speech. It will work, but 15-30+ minutes sounds much better.")


if __name__ == "__main__":
    main()
