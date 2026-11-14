#!/usr/bin/env bash
# One-time setup on your PC (Ubuntu on WSL2 with an NVIDIA GPU). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

case "$(pwd)" in
  *" "*)
    BAD="$(pwd)"; while [[ "$(basename "$BAD")" != *" "* ]]; do BAD="$(dirname "$BAD")"; done
    echo "This folder's path has a space in it: $(pwd)"
    echo "Piper's build (espeak-ng) breaks on spaces. Rename the folder, e.g.:"
    echo "  mv \"$BAD\" \"$(dirname "$BAD")/$(basename "$BAD" | tr -s ' ' | tr ' ' '_' | sed 's/_-_/-/g')\""
    exit 1 ;;
esac

echo "== Checking the GPU is visible inside WSL"
if ! command -v nvidia-smi >/dev/null || ! nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi does not work in WSL. Install/update the NVIDIA driver on WINDOWS (not inside WSL), then 'wsl --shutdown' and retry."
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

echo "== System packages (needs sudo)"
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential cmake ninja-build python3-venv python3-dev ffmpeg git

echo "== Piper training code (piper1-gpl)"
if [ ! -d piper1-gpl ]; then git clone --depth 1 https://github.com/OHF-Voice/piper1-gpl.git; fi

echo "== Python environment (.venv) - PyTorch with CUDA is a big download, give it a few minutes"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
python -m pip install -q --upgrade pip wheel setuptools
python -m pip install -q -e './piper1-gpl[train]'
python -m pip install -q faster-whisper
# build tools piper1-gpl needs for its in-place (dev) build; pip only had them in a temporary build env
python -m pip install -q scikit-build setuptools wheel cmake ninja cython
(cd piper1-gpl && ./build_monotonic_align.sh && python setup.py build_ext --inplace >/dev/null)

python - <<'PY'
import torch
ok = torch.cuda.is_available()
print("PyTorch", torch.__version__, "| CUDA available:", ok, "|", torch.cuda.get_device_name(0) if ok else "NO GPU - training would be extremely slow")
PY

echo "== Base checkpoint to fine-tune from (Lessac medium, ~850 MB, once)"
mkdir -p checkpoints
CKPT="checkpoints/lessac-medium.ckpt"
if [ ! -f "$CKPT" ]; then
  curl -L --fail -o "$CKPT.part" \
    "https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/en/en_US/lessac/medium/epoch%3D2164-step%3D1355540.ckpt"
  mv "$CKPT.part" "$CKPT"
fi
echo
echo "Setup done. Next: put clips in work/<voice>/clips and run ./prepare.sh <voice>"
