#!/usr/bin/env bash
# Usage: ./prepare.sh <voice> [extra prepare.py options, e.g. --model medium]
set -euo pipefail
cd "$(dirname "$0")"
VOICE="${1:?Usage: ./prepare.sh <voice-name>}"; shift
. .venv/bin/activate
python prepare.py "work/$VOICE" "$@"
