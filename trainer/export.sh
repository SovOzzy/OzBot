#!/usr/bin/env bash
# Export the newest checkpoint of work/<voice> to output/<file>.onnx + .onnx.json (the pair you upload to OzBot)
# and speak a test sentence into output/<file>-test.wav.
# Usage: ./export.sh <voice> [file-name]   (file-name default: en_GB-<voice>-medium)
set -euo pipefail
cd "$(dirname "$0")"
VOICE="${1:?Usage: ./export.sh <voice-name> [file-name]}"
NAME="${2:-en_GB-${VOICE}-medium}"
[[ "$NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "File name may only use letters, numbers, _ . -"; exit 1; }
W="work/$VOICE"
CKPT=$(ls -t "$W"/train/lightning_logs/version_*/checkpoints/*.ckpt 2>/dev/null | head -1 || true)
[ -n "$CKPT" ] || { echo "No checkpoint found in $W/train - train first"; exit 1; }
[ -f "$W/config.json" ] || { echo "Missing $W/config.json (written by training)"; exit 1; }
. .venv/bin/activate
mkdir -p output
echo "Exporting $CKPT"
python piper_export.py --checkpoint "$CKPT" --output-file "output/$NAME.onnx"
cp "$W/config.json" "output/$NAME.onnx.json"
python -m piper -m "output/$NAME.onnx" -f "output/$NAME-test.wav" -- "Hello! This is my new voice. If you can hear me, the training worked."
ls -lh "output/$NAME.onnx" "output/$NAME.onnx.json"
echo
echo "Done. Listen to output/$NAME-test.wav, then upload BOTH output/$NAME.onnx and output/$NAME.onnx.json"
echo "on the OzBot dashboard: Voice profiles -> Add a voice."
printf 'From Windows Explorer: \\\\wsl.localhost\\%s%s\\output\n' "${WSL_DISTRO_NAME:-Ubuntu}" "$(pwd | tr / '\\')"
