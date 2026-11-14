#!/usr/bin/env python3
"""Import zip(s) recorded on the OzBot dashboard (Voice profiles -> Record a voice) as a training dataset.

  ./import.sh <voice> ozbot-voice-oz.zip [more.zip ...]        new dataset
  ./import.sh <voice> another-session.zip --append              add to an existing dataset

Clips are loudness-normalised (same as prepare.py) into work/<voice>/dataset/wavs and the transcripts go to
work/<voice>/dataset/metadata.csv. No Whisper needed: the text is what was on screen.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("voice")
    ap.add_argument("zips", nargs="+", type=Path)
    ap.add_argument("--append", action="store_true", help="add to an existing dataset instead of refusing")
    args = ap.parse_args()

    out = Path("work") / args.voice / "dataset"
    wavs, meta = out / "wavs", out / "metadata.csv"
    rows: list[str] = []
    if meta.exists():
        if not args.append:
            sys.exit(f"{out} already exists. Use --append to add to it, or delete the folder to start over.")
        rows = [r for r in meta.read_text(encoding="utf-8").splitlines() if r.strip()]
    wavs.mkdir(parents=True, exist_ok=True)
    n = len(rows)

    for z in args.zips:
        if not z.is_file():
            sys.exit(f"Not found: {z}")
        with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(z) as zf:
            for name in zf.namelist():  # refuse odd paths before extracting
                if name.startswith("/") or ".." in Path(name).parts:
                    sys.exit(f"Unsafe path in zip: {name}")
            zf.extractall(tmp)
            src_meta = Path(tmp) / "dataset" / "metadata.csv"
            if not src_meta.exists():
                sys.exit(f"{z.name} is not an OzBot recording zip (no dataset/metadata.csv)")
            added = 0
            for line in src_meta.read_text(encoding="utf-8").splitlines():
                if "|" not in line:
                    continue
                fname, text = line.split("|", 1)
                src = Path(tmp) / "dataset" / "wavs" / fname
                if not src.exists():
                    continue
                n += 1
                dst = f"utt{n:05d}.wav"
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "22050",
                                "-sample_fmt", "s16", "-af", "highpass=f=60,loudnorm=I=-20:TP=-2:LRA=11", str(wavs / dst)], check=True)
                rows.append(f"{dst}|{text.strip()}")
                added += 1
            print(f"{z.name}: {added} clips")

    meta.write_text("\n".join(rows) + "\n", encoding="utf-8")
    seconds = sum((p.stat().st_size - 44) / 44100 for p in wavs.glob("*.wav"))
    print(f"\nDataset: {len(rows)} clips, {seconds / 60:.1f} minutes in {out}")
    print(f"Next: ./train.sh {args.voice} --fresh" if args.append else f"Next: ./train.sh {args.voice}")
    if seconds < 300:
        print("Tip: under 5 minutes works, but recording another prompt set (--append) will sound better.")


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg missing - run ./setup.sh first")
    main()
