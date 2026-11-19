"""Export a network-v3 checkpoint (`model.ResNet3`, hybrid H1) to ONNX.

    ml/.venv-hybrid/bin/python ml/torch/onnx_export_v3.py --checkpoint tmp/h1/train/<name>.pt --out ml/data/onnx/<name>

writes `<out>.fp32.onnx` and `<out>.fp16.onnx` (TorchScript exporter, opset 17, dynamic batch, as H0).

| input | shape | dtype | from |
|---|---|---|---|
| `planes` | (B, 13, 20, 20) | float32 | `features.Encoder.board` (`net_features.rs` `push_board`) |
| `hands` | (B, 4, 21) | float32 | the same |
| `seat` | (B,) | int64 | the mover's absolute seat |

| output | shape | dtype | meaning |
|---|---|---|---|
| `policy` | (B, 36400) | float32 | policy head 0 (trained on the search's root visits), unmasked logits by policy index (`policy_index.py`) |
| `teacher` | (B, 36400) | float32 | policy head 1 (trained on Pentobi's moves), the same layout |
| `utilities` | (B, 12) | float32 | relative seat r × [margin, rank, first], probabilities (index 3·r + k), as protocol 2 |
| `margins` | (B, 4) | float32 | `score − mean(others)` per relative seat, in squares |
| `search` | (B,) | float32 | the mover's root value in the search's reward units |

The logits are not masked: a caller reads the entries of the legal moves (the engine maps placement
ids to policy indices with `net_v3.rs`) and normalises over them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(__file__))
from model import ARMS, utility_probabilities  # noqa: E402

INPUTS = ["planes", "hands", "seat"]
OUTPUTS = ["policy", "teacher", "utilities", "margins", "search"]


class Export3(nn.Module):
    def __init__(self, model: nn.Module, half: bool = False) -> None:
        super().__init__()
        self.model = model.half() if half else model
        self.half = half

    def forward(self, planes, hands, seat):
        if self.half:
            planes, hands = planes.half(), hands.half()
        out = self.model(planes, hands, seat)
        policy = out["policy"].float()
        utilities = utility_probabilities(out["utility"].float()).reshape(-1, 12)
        return policy[:, 0], policy[:, 1], utilities, out["margins"].float() * 20.0, out["search"].float()


def load_model(path: str) -> tuple[nn.Module, str]:
    ck = torch.load(path, map_location="cpu")
    model = ARMS[ck["arm"]]()
    model.load_state_dict(ck["state"])
    model.eval()
    if getattr(model, "version", 1) != 3:
        raise SystemExit(f"{path} is {ck['arm']}, not a network-v3 arm")
    return model, ck["arm"]


def sha256(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    manifest = {"checkpoint": args.checkpoint, "checkpointSha256": sha256(args.checkpoint), "inputs": INPUTS, "outputs": OUTPUTS,
                "opset": 17, "exporter": "torch.onnx.export(dynamo=False)", "torch": torch.__version__, "files": {}}
    for half in (False, True):
        model, arm = load_model(args.checkpoint)
        wrapper = Export3(model, half).eval()
        b = 2
        example = (torch.zeros(b, 13, 20, 20), torch.zeros(b, 4, 21), torch.zeros(b, dtype=torch.int64))
        path = f"{args.out}.{'fp16' if half else 'fp32'}.onnx"
        torch.onnx.export(wrapper, example, path, input_names=INPUTS, output_names=OUTPUTS, opset_version=17, dynamo=False,
                          dynamic_axes={k: {0: "batch"} for k in INPUTS + OUTPUTS})
        manifest["files"][os.path.basename(path)] = {"bytes": os.path.getsize(path), "sha256": sha256(path)}
        manifest["arm"] = arm
        print(f"wrote {path}", flush=True)
    json.dump(manifest, open(f"{args.out}.manifest.json", "w"), indent=1)


if __name__ == "__main__":
    main()
