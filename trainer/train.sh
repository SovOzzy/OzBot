#!/usr/bin/env bash
# Fine-tune a Piper voice from the Lessac checkpoint on work/<voice>/dataset.
# Usage: ./train.sh <voice> [epochs] [--fresh]
#   Ctrl+C stops; running it again resumes from the last checkpoint.
#   --fresh: start over (clears work/<voice>/train + cache). Use it after adding recordings with import.sh --append,
#            so the new clips get a full training run instead of a finished, low learning rate.
# Env:   ESPEAK=en (accent for pronunciation: en = British, en-gb-x-rp = southern/RP, en-gb-scotland, en-us ...)
#        BATCH=16 (lower to 8 if you run out of GPU memory, raise to 32 on 24 GB cards)
set -euo pipefail
cd "$(dirname "$0")"
FRESH=0; POS=()
for a in "$@"; do if [ "$a" = "--fresh" ]; then FRESH=1; else POS+=("$a"); fi; done
VOICE="${POS[0]:?Usage: ./train.sh <voice-name> [epochs] [--fresh]}"
EPOCHS="${POS[1]:-2000}"
ESPEAK="${ESPEAK:-en}"
BATCH="${BATCH:-16}"
W="work/$VOICE"
[ -f "$W/dataset/metadata.csv" ] || { echo "Run ./prepare.sh $VOICE first"; exit 1; }
if [ "$FRESH" = 1 ] && [ -d "$W/train" -o -d "$W/cache" ]; then
  echo "--fresh: removing the previous run ($W/train) and preprocessed cache ($W/cache). Exported voices in output/ are kept."
  rm -rf "$W/train" "$W/cache"
fi
echo "Dataset: $(grep -c . "$W/dataset/metadata.csv") clips"
. .venv/bin/activate
# check the accent name now, not 10 minutes into preprocessing
python - "$ESPEAK" <<'PY' || exit 1
import sys
from pathlib import Path
from piper.phonemize_espeak import EspeakPhonemizer, ESPEAK_DATA_DIR
voice = sys.argv[1]
try:
    EspeakPhonemizer().phonemize(voice, "test")
except Exception:
    names = sorted(p.name for p in (Path(ESPEAK_DATA_DIR) / "lang" / "gmw").iterdir() if p.name.lower().startswith("en"))
    sys.exit(f"Unknown accent ESPEAK={voice}. English options: {', '.join(names)} (lower-case works too)")
PY
mkdir -p "$W/train" "$W/cache"

RESUME=()
LAST=$(ls -t "$W"/train/lightning_logs/version_*/checkpoints/*.ckpt 2>/dev/null | head -1 || true)
if [ -n "$LAST" ]; then
  echo "Resuming from $LAST"
  RESUME=(--ckpt_path "$LAST")
else
  RESUME=(--model.warmstart_ckpt checkpoints/lessac-medium.ckpt)
fi

echo "Training '$VOICE': $EPOCHS epochs, accent $ESPEAK, batch $BATCH. Watch progress with:"
echo "  . .venv/bin/activate && tensorboard --logdir $W/train   (then open http://localhost:6006, Audio tab)"
# quality score (val_mos) needs torchaudio; without it, switch the score off instead of downloading for nothing
MOS=()
python -c "import torchaudio" 2>/dev/null || { echo "(torchaudio not installed: quality score val_mos off, checkpoints by val_mel + last)"; MOS=(--model.mos_metric none); }

python piper_train.py fit \
  --data.voice_name "$VOICE" \
  --data.csv_path "$W/dataset/metadata.csv" \
  --data.audio_dir "$W/dataset/wavs" \
  --model.sample_rate 22050 \
  --data.espeak_voice "$ESPEAK" \
  --data.cache_dir "$W/cache" \
  --data.config_path "$W/config.json" \
  --data.batch_size "$BATCH" \
  --trainer.max_epochs "$EPOCHS" \
  --trainer.default_root_dir "$W/train" \
  "${MOS[@]}" \
  "${RESUME[@]}"
echo "Training finished. Run ./export.sh $VOICE"
