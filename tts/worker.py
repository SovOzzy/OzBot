#!/usr/bin/env python3
"""OzBot TTS worker: a long-lived Piper process driven by JSON lines on stdin.

Request : {"id": 1, "model": "/abs/voice.onnx", "text": "...", "out": "/abs/out.wav",
           "length_scale": 1.0, "noise_scale": 0.667, "noise_w": 0.8, "speaker": null, "volume": 1.0}
Response: {"id": 1, "ok": true, "seconds": 2.4, "ms": 640}  or  {"id": 1, "ok": false, "error": "..."}
Voices stay loaded (least recently used first out) so back-to-back sentences are fast. The Node side
kills this process after a few idle minutes, which frees all of its memory.
"""
import json
import sys
import time
import wave
from collections import OrderedDict

from piper import PiperVoice, SynthesisConfig

MAX_LOADED = int(sys.argv[1]) if len(sys.argv) > 1 else 2
voices: "OrderedDict[str, PiperVoice]" = OrderedDict()


def get_voice(path: str) -> PiperVoice:
    if path in voices:
        voices.move_to_end(path)
        return voices[path]
    voice = PiperVoice.load(path)
    voices[path] = voice
    while len(voices) > MAX_LOADED:
        voices.popitem(last=False)
    return voice


def handle(req: dict) -> dict:
    if req.get("op") == "unload":
        voices.pop(req.get("model"), None)
        return {"ok": True}
    t0 = time.time()
    voice = get_voice(req["model"])
    cfg = SynthesisConfig(
        speaker_id=req.get("speaker"),
        length_scale=float(req.get("length_scale", 1.0)),
        noise_scale=float(req.get("noise_scale", 0.667)),
        noise_w_scale=float(req.get("noise_w", 0.8)),
        volume=float(req.get("volume", 1.0)),
        normalize_audio=True,
    )
    with wave.open(req["out"], "wb") as wav:
        voice.synthesize_wav(req["text"], wav, syn_config=cfg)
    with wave.open(req["out"], "rb") as wav:
        seconds = wav.getnframes() / float(wav.getframerate())
    return {"ok": True, "seconds": round(seconds, 2), "ms": int((time.time() - t0) * 1000)}


def main() -> None:
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            res = handle(req)
        except Exception as e:  # report, keep serving
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        res["id"] = rid
        print(json.dumps(res), flush=True)


if __name__ == "__main__":
    main()
