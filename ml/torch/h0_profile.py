"""Hybrid H0, exploratory (not a gate): where the in-process network's time goes on the GPU.

    ml/.venv-hybrid/bin/python ml/torch/h0_profile.py --onnx ml/data/onnx/resnet2-b8w96-g36k-s0 \
        --checkpoint ml/torch/results/resnet2-b8w96-g36k-s0.pt --records tmp/h0/encoding/records.bin --out tmp/h0/profile.json

1. ONNX Runtime CUDA, fp32 and fp16: which provider each node runs on, and the time ORT's profiler
   records per node by op type at batch 1 and 256. For CUDA nodes that is host-side time (the launch;
   kernels run asynchronously), so it shows launch overhead, not GPU execution.
2. The same network in PyTorch on CUDA (eval, no_grad): fp32 as `serve.py` runs it (TF32 convolutions),
   strict fp32, and fp16 — median call time with inputs already on the GPU.
3. ONNX Runtime CUDA variants on GPU-resident inputs (IoBinding): default, `prefer_nhwc`, and CUDA graphs
   (`enable_cuda_graph`, fixed shapes).
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from features import Encoder, Placements  # noqa: E402
from onnx_export import INPUTS, Protocol2, load_model  # noqa: E402
from records import RECORD  # noqa: E402


def feeds_for(encoder: Encoder, records: np.ndarray) -> dict[str, np.ndarray]:
    planes, hands = encoder.board(records)
    footprint, pieces, mask, _ = encoder.candidates(records)
    values = {"planes": planes, "hands": hands, "footprint": footprint, "pieces": pieces, "mask": mask,
              "seat": encoder.seat(records)}
    return {k: v.cpu().numpy() for k, v in values.items()}


def median_ms(fn, calls: int = 50) -> float:
    for _ in range(5):
        fn()
    times = []
    for _ in range(calls):
        t = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t)
    return float(np.median(times) * 1e3)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--onnx", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--records", required=True)
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--batches", default="1,16,64,256")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    import onnxruntime as ort

    ort.preload_dlls()
    batches = [int(b) for b in args.batches.split(",")]
    records = np.fromfile(args.records, dtype=RECORD)
    records = records[records["candidates"] >= 2][: max(batches)]
    encoder = Encoder(Placements(args.placements), torch.device("cpu"))
    feeds = {b: feeds_for(encoder, records[:b]) for b in batches}
    result: dict = {"placement": {}, "kernels": {}, "torch_ms": {}, "ort_ms": {}}

    # 1. Placement and kernel time by op type.
    for precision in ("fp32", "fp16"):
        path = f"{args.onnx}.{precision}.onnx"
        options = ort.SessionOptions()
        options.enable_profiling = True
        options.profile_file_prefix = f"/tmp/h0-profile-{precision}"
        session = ort.InferenceSession(path, options, providers=[("CUDAExecutionProvider", {"use_tf32": 0}), "CPUExecutionProvider"])
        for b in (1, 256):
            for _ in range(20):
                session.run(None, feeds[b])
        profile = session.end_profiling()
        events = json.load(open(profile))
        providers = collections.Counter()
        by_op: dict[int, collections.Counter] = {}
        runs = [e for e in events if e.get("name") == "model_run"]
        for e in events:
            if e.get("cat") != "Node" or not e["name"].endswith("_kernel_time"):
                continue
            providers[e["args"].get("provider", "?")] += 1
        result["placement"][precision] = {k: v // 40 for k, v in providers.items()}  # nodes per run
        # Per batch: kernel time by op over the last 10 runs of that batch.
        node_events = [e for e in events if e.get("cat") == "Node" and e["name"].endswith("_kernel_time")]
        per_run = len(node_events) // 40
        for k, b in enumerate((1, 256)):
            chunk = node_events[per_run * (20 * k + 10): per_run * (20 * k + 20)]
            ops = collections.Counter()
            for e in chunk:
                ops[e["args"].get("op_name", "?")] += e["dur"] / 10
            run_us = np.median([e["dur"] for e in runs[20 * k + 10: 20 * k + 20]])
            result["kernels"][f"{precision} b{b}"] = {"model_run_us": float(run_us), "node_host_us_by_op": {o: round(t, 1) for o, t in ops.most_common()},
                                                     "node_host_us_total": round(sum(ops.values()), 1)}
        os.unlink(profile)
        print(precision, json.dumps(result["placement"][precision]), flush=True)
        for key in (f"{precision} b1", f"{precision} b256"):
            r = result["kernels"][key]
            print(" ", key, f"model_run {r['model_run_us']:.0f} us, node host time {r['node_host_us_total']:.0f} us:",
                  dict(list(r["node_host_us_by_op"].items())[:8]), flush=True)

    # 2. PyTorch on CUDA, inputs on the GPU.
    gpu = torch.device("cuda")
    for label, half, tf32 in (("torch fp32 tf32-conv (serve.py)", False, True), ("torch fp32 strict", False, False), ("torch fp16", True, False)):
        torch.backends.cudnn.allow_tf32 = tf32
        model, _ = load_model(args.checkpoint)
        wrapper = Protocol2(model.to(gpu), half=half).eval()
        for b in batches:
            tensors = [torch.from_numpy(feeds[b][k]).to(gpu) for k in INPUTS]

            def call():
                with torch.no_grad():
                    out = wrapper(*tensors)
                torch.cuda.synchronize()
                return out
            result["torch_ms"][f"{label} b{b}"] = median_ms(call)
        print(label, {b: round(result["torch_ms"][f"{label} b{b}"], 3) for b in batches}, flush=True)
    torch.backends.cudnn.allow_tf32 = True

    # 3. ORT variants with IoBinding on GPU-resident inputs and outputs.
    for precision in ("fp32", "fp16"):
        path = f"{args.onnx}.{precision}.onnx"
        for label, extra in (("default", {}), ("nhwc", {"prefer_nhwc": 1}), ("cudagraph", {"enable_cuda_graph": 1})):
            for b in batches:
                try:
                    session = ort.InferenceSession(path, providers=[("CUDAExecutionProvider", {"use_tf32": 0, **extra})])
                    binding = session.io_binding()
                    keep = []
                    for k in INPUTS:
                        value = ort.OrtValue.ortvalue_from_numpy(feeds[b][k], "cuda", 0)
                        keep.append(value)
                        binding.bind_ortvalue_input(k, value)
                    for name, width in (("logits", 64), ("utilities", 12)):
                        value = ort.OrtValue.ortvalue_from_shape_and_type([b, width], np.float32, "cuda", 0)
                        keep.append(value)
                        binding.bind_ortvalue_output(name, value)

                    def call():
                        session.run_with_iobinding(binding)
                    ms = median_ms(call)
                except Exception as error:  # noqa: BLE001 - report the failure as the result
                    ms = None
                    print(f"ort {precision} {label} b{b}: {type(error).__name__}: {str(error)[:200]}", flush=True)
                result["ort_ms"][f"{precision} {label} b{b}"] = ms
            print(f"ort {precision} {label}", {b: (round(result['ort_ms'][f'{precision} {label} b{b}'], 3) if result['ort_ms'][f'{precision} {label} b{b}'] else None) for b in batches}, flush=True)
    with open(args.out, "w") as handle:
        json.dump(result, handle, indent=1)


if __name__ == "__main__":
    main()
