# OzBot voice trainer (runs on your PC, not the VPS)

Turns a few minutes of someone's voice into a Piper voice (`.onnx` + `.onnx.json`) that OzBot can speak with.
Training needs a GPU; the VPS only *uses* the finished voice (about 60 MB, ~250 MB RAM while talking).

**You need:** Windows with an NVIDIA GPU (8 GB+ VRAM), WSL2 with Ubuntu, the NVIDIA driver installed on Windows
(WSL uses it automatically), ~15 GB free disk.

## 1. Set up (once)

Copy this `trainer/` folder into your WSL home (e.g. `~/OzBot/trainer`), **not** onto `/mnt/c/...`: the Windows drive
is very slow from WSL. **The path must not contain spaces** (`~/OzBot-Training` is fine, `~/OzBot - Training` is not):
Piper's build breaks on them. Then:

```bash
cd ~/OzBot/trainer
./setup.sh
```

It checks the GPU, installs build tools + ffmpeg, the Piper training code, PyTorch, Whisper, and downloads the
Lessac base checkpoint (~850 MB) that every voice is fine-tuned from. It takes about 10-20 minutes.

## 2a. Record in the dashboard (easiest)

On the OzBot dashboard, open **Voice profiles** and use **Record a voice for training**. Read the sentences it shows
(Space starts and stops each one), then press **Finish & make zip** and download it. You don't need Whisper or
transcript fixing for this, because the zip already contains the exact text of every clip:

```bash
./import.sh <voice> ~/Downloads/ozbot-voice-<voice>.zip            # or /mnt/c/Users/<you>/Downloads/...
./import.sh <voice> second-session.zip --append                     # add another session later
```

Then skip to step 4. The server deletes its copy once you leave the page (it warns you first).

## 2b. …or collect clips you already have

```
work/<voice>/clips/      <- put audio here (wav, mp3, m4a, ogg, flac, even mp4)
```

`<voice>` is a short name you choose, like `oz` or `dave`, using letters, numbers and underscores only.

- **How much:** 5 minutes works, 15-30 minutes sounds clearly better, and more is better still. Long files are fine
  because they get cut up automatically.
- **What:** one speaker only, talking normally. The cleaner the better: no music, no game sounds, no other people,
  little echo. A Discord recording of just that person is OK if it's clean.
- Varied sentences beat the same phrases over and over.

## 3. Prepare the dataset

```bash
./prepare.sh <voice>
```

Whisper writes transcripts and the audio is cut into 1.5-12 s pieces at 22,050 Hz. The result is
`work/<voice>/dataset/` (`wavs/` + `metadata.csv`).

**Then open `work/<voice>/dataset/metadata.csv` and fix any wrong words.** Each line is `utt00001.wav|What was said.`
Delete lines that are mumbles, laughs or another person. This is the biggest quality win.

Options: `./prepare.sh <voice> --model medium` (faster Whisper, slightly worse), `--language en`.

## 4. Train

```bash
./train.sh <voice>              # 2000 epochs (the recommended fine-tune length)
./train.sh <voice> 1000         # shorter test run
ESPEAK=en-gb-x-rp ./train.sh <voice> # accent for pronunciation: en (British, default), en-gb-x-rp (southern/RP),
                                     # en-gb-scotland, en-us ...
BATCH=8 ./train.sh <voice>      # if you get "CUDA out of memory"
```

- Rough time for 15 minutes of audio on an RTX 3060-4090: **2-5 hours** for 2000 epochs. You can leave it overnight.
- **Ctrl+C stops it.** Running `./train.sh <voice>` again resumes from the last checkpoint.
- Optional, to watch progress and listen to samples while it trains: in a second terminal,
  `. .venv/bin/activate && tensorboard --logdir work/<voice>/train`, then open http://localhost:6006
  (Audio and Scalars tabs; `val_mel` going down is good).

## 5. Export

```bash
./export.sh <voice>                  # -> output/en_GB-<voice>-medium.onnx (+ .onnx.json, + -test.wav)
./export.sh <voice> en_GB-dave-medium
```

Listen to `output/<name>-test.wav`. Not happy? Train longer (`./train.sh <voice> 3000` continues), or improve the
clips and transcripts and start again (delete `work/<voice>/train` and `work/<voice>/cache` first).

You can export at any point, even halfway through training, to hear how it's going.

## 6. Upload to OzBot

1. Open the OzBot dashboard and go to **Voice profiles**, then **Add a voice**.
2. Drop in **both** files: `<name>.onnx` and `<name>.onnx.json`. From Windows Explorer they're at
   `\\wsl.localhost\Ubuntu\home\<you>\OzBot\trainer\output`.
3. Give it a name, adjust speed and expression, and press **Preview**.
4. Pick it as the default voice, or choose it per command: `/say text:hello voice:<name>`.

## Files

| File | What it does |
|---|---|
| `setup.sh` | One-time install: venv, piper1-gpl `[train]`, faster-whisper, base checkpoint |
| `import.py` / `import.sh` | Dashboard recording zip(s) become `work/<voice>/dataset` (no Whisper) |
| `prepare.py` / `prepare.sh` | clips, then Whisper transcripts, then the cut 22,050 Hz dataset and `metadata.csv` |
| `train.sh` | Fine-tune (warm start from Lessac medium; resumes automatically) |
| `export.sh` | Newest checkpoint to `.onnx` + `.onnx.json`, plus a test sentence |
| `work/`, `output/`, `checkpoints/`, `.venv/`, `piper1-gpl/` | Created locally and not committed (big) |

## Notes

- **Only train on voices you have permission to use**, such as your own or a friend's who said yes. Don't use public
  figures. Tell the server it's a synthetic voice.
- Training code: [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0). It's cloned at setup and
  not bundled here. Its `docs/TRAINING.md` explains every option.
- Fine-tuning from an en_US checkpoint with a British `ESPEAK` accent is normal: the checkpoint gives the model a head start,
  and your clips and the espeak accent decide how it ends up sounding.
