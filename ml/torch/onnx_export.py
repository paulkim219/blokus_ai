"""Export a model-v2 checkpoint to ONNX with exactly the outputs of `serve.py --protocol 2` (hybrid H0).

    ml/.venv-hybrid/bin/python ml/torch/onnx_export.py \
        --checkpoint ml/torch/results/resnet2-b8w96-g36k-s0.pt --out ml/onnx/resnet2-b8w96-g36k-s0

writes `<out>.fp32.onnx` and `<out>.fp16.onnx`. Both take the encoder's tensors (`features.Encoder`) and
return what protocol 2 serves:

| input | shape | dtype | from |
|---|---|---|---|
| `planes` | (B, 13, 20, 20) | float32 | `Encoder.board` |
| `hands` | (B, 4, 21) | float32 | `Encoder.board` |
| `footprint` | (B, 64, 5) | int64 | `Encoder.candidates` (canonical cells, 400 = pad) |
| `pieces` | (B, 64) | int64 | `Encoder.candidates` |
| `mask` | (B, 64) | bool | `Encoder.candidates` |
| `seat` | (B,) | int64 | `Encoder.seat` |

| output | shape | dtype | meaning |
|---|---|---|---|
| `logits` | (B, 64) | float32 | policy logits by candidate slot, 0 on padding slots |
| `utilities` | (B, 12) | float32 | relative seat r × [margin, rank, first], probabilities (index 3·r + k) |

The fp16 file runs the network in half precision; its inputs and outputs stay float32 (casts inside the
graph), so a caller does not change between the two. The batch dimension is dynamic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(__file__))
from features import Encoder, Placements  # noqa: E402
from model import ARMS, model_version, utility_probabilities  # noqa: E402

INPUTS = ["planes", "hands", "footprint", "pieces", "mask", "seat"]
OUTPUTS = ["logits", "utilities"]


class Protocol2(nn.Module):
    """The checkpoint's network with protocol 2's post-processing (`serve.py` `Batcher.infer`)."""

    def __init__(self, model: nn.Module, half: bool = False) -> None:
        super().__init__()
        self.model = model.half() if half else model
        self.half = half

    def forward(self, planes, hands, footprint, pieces, mask, seat):
        if self.half:
            planes, hands = planes.half(), hands.half()
        out = self.model(planes, hands, footprint, pieces, mask, seat)
        logits = out["policy"].masked_fill(~mask, 0).float()
        utilities = utility_probabilities(out["utility"].float()).reshape(-1, 12)
        return logits, utilities


def load_model(path: str) -> tuple[nn.Module, str]:
    checkpoint = torch.load(path, map_location="cpu")
    model = ARMS[checkpoint["arm"]]()
    model.load_state_dict(checkpoint["state"])
    model.eval()
    if model_version(model) != 2:
        raise SystemExit(f"{path} is {checkpoint['arm']}, not a model-v2 arm")
    return model, checkpoint["arm"]


def encode(encoder: Encoder, records: np.ndarray) -> dict[str, torch.Tensor]:
    """The six model inputs for `records`, on the encoder's device."""
    planes, hands = encoder.board(records)
    footprint, pieces, mask, _ = encoder.candidates(records)
    return {"planes": planes, "hands": hands, "footprint": footprint, "pieces": pieces, "mask": mask,
            "seat": encoder.seat(records)}


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def export(model: nn.Module, half: bool, sample: dict[str, torch.Tensor], path: str, opset: int) -> None:
    wrapper = Protocol2(model, half).eval()
    args = tuple(sample[name] for name in INPUTS)
    dynamic = {name: {0: "batch"} for name in INPUTS + OUTPUTS}
    with torch.no_grad():
        torch.onnx.export(wrapper, args, path, input_names=INPUTS, output_names=OUTPUTS, dynamic_axes=dynamic,
                          opset_version=opset, dynamo=False, do_constant_folding=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True, help="path prefix; writes <out>.fp32.onnx and <out>.fp16.onnx")
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--run", default="ml/data/selfplay-v41u-300", help="where the sample batch comes from")
    parser.add_argument("--opset", type=int, default=17)
    args = parser.parse_args()

    import onnx

    from records import load_run

    model, arm = load_model(args.checkpoint)
    encoder = Encoder(Placements(args.placements), torch.device("cpu"))
    records, _ = load_run(args.run)
    sample = encode(encoder, records[(records["game"] >= 19000) & (records["candidates"] >= 2)][:4])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    manifest = {"checkpoint": args.checkpoint, "checkpointSha256": sha256(args.checkpoint), "arm": arm,
                "opset": args.opset, "torch": torch.__version__, "onnx": onnx.__version__,
                "inputs": INPUTS, "outputs": OUTPUTS, "files": {}}
    for precision, half in (("fp32", False), ("fp16", True)):
        path = f"{args.out}.{precision}.onnx"
        # A fresh copy each time: `.half()` converts in place.
        fresh, _ = load_model(args.checkpoint)
        export(fresh, half, sample, path, args.opset)
        onnx.checker.check_model(onnx.load(path))
        manifest["files"][precision] = {"path": path, "sha256": sha256(path), "bytes": os.path.getsize(path)}
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")
    with open(f"{args.out}.json", "w") as handle:
        json.dump(manifest, handle, indent=1)
    print(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
