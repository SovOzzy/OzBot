#!/usr/bin/env bash
# Usage: ./import.sh <voice> <ozbot-voice-xxx.zip> [more.zip ...] [--append]
set -euo pipefail
[ $# -ge 2 ] || { echo "Usage: ./import.sh <voice> <zip> [more.zip ...] [--append]"; exit 1; }
VOICE="$1"; shift
ARGS=()  # make zip paths absolute before changing folder (so ~/Downloads/... and /mnt/c/... work)
for a in "$@"; do if [ -f "$a" ]; then ARGS+=("$(realpath "$a")"); else ARGS+=("$a"); fi; done
cd "$(dirname "$0")"
. .venv/bin/activate
python import.py "$VOICE" "${ARGS[@]}"
