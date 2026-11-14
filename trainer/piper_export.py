#!/usr/bin/env python3
"""Export a Piper checkpoint to ONNX (same as `python -m piper.train.export_onnx ...`) on new PyTorch.

PyTorch 2.9+ made torch.onnx.export use the new torch.export/dynamo exporter by default. Piper's model has
data-dependent code (an assert in the flow's spline) that it cannot trace (GuardOnDataDependentSymNode), so we
force the classic TorchScript exporter (dynamo=False), which is what Piper's export was written for.
"""
import sys
import warnings

import torch

_onnx_export = torch.onnx.export


def _export_torchscript(*args, **kwargs):
    kwargs.setdefault("dynamo", False)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # TracerWarnings / deprecation notices for the classic exporter
        return _onnx_export(*args, **kwargs)


torch.onnx.export = _export_torchscript

if __name__ == "__main__":
    from piper.train import export_onnx

    sys.argv[0] = "piper.train.export_onnx"
    export_onnx.main()
