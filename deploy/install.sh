#!/usr/bin/env bash
# Install / update OzBot on the VPS. Re-runnable.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== node packages";   npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent
echo "== python venv (Piper TTS)"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip piper-tts
echo "== stock voices"
mkdir -p data/voices
for v in en_GB-alan-medium en_US-lessac-medium; do
  [ -f "data/voices/$v.onnx" ] || .venv/bin/python -m piper.download_voices --download-dir data/voices "$v"
done
echo "== systemd"
sudo cp deploy/ozbot.service /etc/systemd/system/ozbot.service
sudo systemctl daemon-reload
sudo systemctl enable --now ozbot
sudo systemctl restart ozbot
echo "== tailscale serve (tailnet only) https:8447 -> 4400"
sudo tailscale serve --bg --https=8447 http://127.0.0.1:4400 >/dev/null
sleep 2; curl -s localhost:4400/api/health; echo
