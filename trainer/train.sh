#!/usr/bin/env bash
# Fine-tune a Piper voice from the Lessac checkpoint on work/<voice>/dataset.
# Usage: ./train.sh <voice> [epochs]       (Ctrl+C stops; run again to resume from the last checkpoint)
# Env:   ESPEAK=en-gb (accent for pronunciation: en-gb, en-us, en-gb-scotland, en-gb-x-rp ...)
#        BATCH=16 (lower to 8 if you run out of GPU memory, raise to 32 on 24 GB cards)
set -euo pipefail
cd "$(dirname "$0")"
VOICE="${1:?Usage: ./train.sh <voice-name> [epochs]}"
EPOCHS="${2:-2000}"
ESPEAK="${ESPEAK:-en-gb}"
BATCH="${BATCH:-16}"
W="work/$VOICE"
[ -f "$W/dataset/metadata.csv" ] || { echo "Run ./prepare.sh $VOICE first"; exit 1; }
. .venv/bin/activate
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
python -m piper.train fit \
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
  "${RESUME[@]}"
echo "Training finished. Run ./export.sh $VOICE"
