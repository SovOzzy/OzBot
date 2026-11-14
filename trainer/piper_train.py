#!/usr/bin/env python3
"""Run Piper training (same as `python -m piper.train ...`) with one fix.

Piper always adds a checkpoint saver that keeps the best epochs by `val_mos` (a quality score that needs
torchaudio + a downloaded predictor). When that score is unavailable (torchaudio has no build for newer PyTorch,
or the download fails), current Lightning versions raise MisconfigurationException at the first save instead of
skipping. Here that saver skips quietly when the score is missing; the val_mel and last.ckpt savers are unchanged.
"""
import sys

from lightning.pytorch.callbacks import ModelCheckpoint

import piper.train.__main__ as piper_main


class OptionalMetricCheckpoint(ModelCheckpoint):
    """ModelCheckpoint that does nothing when its metric was not logged this epoch."""

    def _save_topk_checkpoint(self, trainer, monitor_candidates):
        if self.monitor and self.monitor not in monitor_candidates:
            return
        super()._save_topk_checkpoint(trainer, monitor_candidates)


_original = piper_main._default_callbacks


def _callbacks():
    out = []
    for cb in _original():
        if isinstance(cb, ModelCheckpoint) and cb.monitor == "val_mos":
            kept = OptionalMetricCheckpoint(monitor="val_mos", mode="max", save_top_k=cb.save_top_k,
                                            save_last=False, filename=cb.filename, auto_insert_metric_name=False)
            out.append(kept)
        else:
            out.append(cb)
    return out


piper_main._default_callbacks = _callbacks

if __name__ == "__main__":
    sys.argv[0] = "piper.train"
    piper_main.main()
