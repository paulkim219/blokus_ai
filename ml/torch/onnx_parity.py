"""Hybrid H0 gate G1: ONNX exports against PyTorch on the test games' records.

    ml/.venv-hybrid/bin/python ml/torch/onnx_parity.py --checkpoint ml/torch/results/resnet2-b8w96-g36k-s0.pt \
        --onnx ml/data/onnx/resnet2-b8w96-g36k-s0 --out tmp/h0/onnx-parity.json

Reference: the checkpoint in PyTorch, fp32 on the CPU (no TF32 anywhere), through `serve.py`'s own
`Batcher.infer` (protocol 2). Compared against it, on every record of games 19,000–19,999:

- PyTorch on CUDA as `serve.py` runs it (default backend flags);
- the fp32 and fp16 ONNX files under ONNX Runtime's CPU provider and CUDA provider (TF32 off and on).

For each: max and 99.9th-percentile |difference| on the 64 logits (padding slots included) and the 12
utilities, and top-1 agreement over each record's candidates (records with ≥ 2 candidates).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from features import Encoder, Placements  # noqa: E402
from onnx_export import INPUTS, load_model  # noqa: E402
from records import load_run  # noqa: E402
from serve import Batcher  # noqa: E402


def torch_reference(model, encoder: Encoder, records: np.ndarray, batch: int) -> np.ndarray:
    batcher = Batcher(model, encoder, batch, 0.0, protocol=2)
    return np.concatenate([batcher.infer(records[i : i + batch]) for i in range(0, len(records), batch)])


def numpy_inputs(encoder: Encoder, records: np.ndarray) -> dict[str, np.ndarray]:
    planes, hands = encoder.board(records)
    footprint, pieces, mask, _ = encoder.candidates(records)
    values = {"planes": planes, "hands": hands, "footprint": footprint, "pieces": pieces, "mask": mask,
              "seat": encoder.seat(records)}
    return {k: v.cpu().numpy() for k, v in values.items()}


def ort_outputs(session, encoder: Encoder, records: np.ndarray, batch: int) -> np.ndarray:
    out = []
    for i in range(0, len(records), batch):
        feeds = numpy_inputs(encoder, records[i : i + batch])
        logits, utilities = session.run(["logits", "utilities"], {k: feeds[k] for k in INPUTS})
        out.append(np.concatenate([logits, utilities], axis=1))
    return np.concatenate(out).astype("<f4")


def compare(got: np.ndarray, ref: np.ndarray, records: np.ndarray) -> dict:
    count = records["candidates"].astype(int)
    multi = count >= 2
    valid = np.arange(64)[None, :] < count[:, None]
    ref_top = np.where(valid, ref[:, :64], -np.inf).argmax(1)
    got_top = np.where(valid, got[:, :64], -np.inf).argmax(1)
    dl = np.abs(got[:, :64] - ref[:, :64])
    du = np.abs(got[:, 64:] - ref[:, 64:])
    return {
        "logitsMaxAbs": float(dl.max()),
        "logitsP999Abs": float(np.quantile(dl[valid], 0.999)) if valid.any() else 0.0,
        "utilitiesMaxAbs": float(du.max()),
        "utilitiesP999Abs": float(np.quantile(du, 0.999)),
        "paddingNonZero": int(np.count_nonzero(got[:, :64][~valid])),
        "top1Agreement": float((ref_top[multi] == got_top[multi]).mean()),
        "top1Records": int(multi.sum()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--onnx", required=True, help="prefix given to onnx_export.py --out")
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--run", default="ml/data/selfplay-v41u-300")
    parser.add_argument("--first-game", type=int, default=19000)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import onnxruntime as ort

    ort.preload_dlls()
    records, _ = load_run(args.run)
    records = records[records["game"] >= args.first_game]
    print(f"{len(records)} records from games {args.first_game}+ "
          f"({int((records['candidates'] >= 2).sum())} with ≥ 2 candidates)", flush=True)
    cpu = torch.device("cpu")
    encoder = Encoder(Placements(args.placements), cpu)
    model, arm = load_model(args.checkpoint)
    started = time.time()
    reference = torch_reference(model, encoder, records, args.batch)
    print(f"reference (torch fp32 cpu) in {time.time() - started:.0f} s", flush=True)
    result = {"checkpoint": args.checkpoint, "arm": arm, "records": len(records), "firstGame": args.first_game,
              "reference": "torch fp32 cpu, serve.Batcher.infer protocol 2", "torch": torch.__version__,
              "onnxruntime": ort.__version__, "comparisons": {}}

    def record(label: str, got: np.ndarray) -> None:
        result["comparisons"][label] = compare(got, reference, records)
        print(label, json.dumps(result["comparisons"][label]), flush=True)

    if torch.cuda.is_available():
        gpu = torch.device("cuda")
        cuda_model, _ = load_model(args.checkpoint)
        record("torch fp32 cuda (serve.py defaults: cudnn.allow_tf32="
               f"{torch.backends.cudnn.allow_tf32}, matmul.allow_tf32={torch.backends.cuda.matmul.allow_tf32})",
               torch_reference(cuda_model.to(gpu), Encoder(Placements(args.placements), gpu), records, args.batch))

    for precision in ("fp32", "fp16"):
        path = f"{args.onnx}.{precision}.onnx"
        providers = [("cpu", ["CPUExecutionProvider"])]
        if "CUDAExecutionProvider" in ort.get_available_providers():
            providers += [(f"cuda tf32={t}", [("CUDAExecutionProvider", {"use_tf32": t}), "CPUExecutionProvider"])
                          for t in (0, 1)]
        for name, provider in providers:
            options = ort.SessionOptions()
            session = ort.InferenceSession(path, options, providers=provider)
            if name.startswith("cuda") and session.get_providers()[0] != "CUDAExecutionProvider":
                raise SystemExit(f"CUDA provider did not load for {path}: {session.get_providers()}")
            started = time.time()
            got = ort_outputs(session, encoder, records, args.batch)
            record(f"onnx {precision} ort {name}", got)
            print(f"  ({time.time() - started:.0f} s)", flush=True)

    gate = [c for label, c in result["comparisons"].items() if label.startswith("onnx fp32") and "tf32=1" not in label]
    result["G1"] = "PASS" if all(c["logitsMaxAbs"] <= 1e-3 and c["utilitiesMaxAbs"] <= 1e-3 for c in gate) else "FAIL"
    print("G1 (onnx fp32, ort cpu and cuda tf32=0, within 1e-3 of torch fp32 cpu, logits and utilities):", result["G1"])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(result, handle, indent=1)


if __name__ == "__main__":
    main()
