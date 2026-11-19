"""Hybrid H1 engine-interface parity for network v3 (research_paper/v5_hybrid_preregistered.md, H1-E1/E2).

    ml/.venv-hybrid/bin/python ml/torch/h1_parity.py --checkpoint tmp/h1/train/<name>.pt --onnx ml/data/onnx/<name> \
        --run <v3 run dir> --limit 20000 --rust tmp/h1/parity/rust-cpu tmp/h1/parity/rust-cuda --out tmp/h1/parity/parity.json

Reference: the checkpoint in PyTorch, fp32 on the CPU (no TF32), on the first `--limit` records of the
run's v3 shards in file order. Compared against it:

- the Python board encoder used in training (`h1_data.encode_board`) against `features.Encoder.board`
  (exact equality of planes and hands);
- the ONNX files under ONNX Runtime's CPU provider and CUDA provider (TF32 off; fp16 reported): all
  36,400 logits of both policy heads and the 12 utilities;
- the engine's path (`examples/h1_v3_eval.rs`: Rust encoder, `net_v3` policy table, ONNX Runtime from
  Rust): the logits of every listed (legal) move, both heads, and the 12 utilities; and the engine's
  policy table against `policy_index.py`, element for element.

For each: max and 99.9th percentile |difference|, and top-1 agreement over the legal moves (teacher head).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from features import Encoder, Placements  # noqa: E402
from h1_data import Tables, encode_board  # noqa: E402
from model import ARMS, utility_probabilities  # noqa: E402
from policy_index import PolicyIndex  # noqa: E402
from records_v3 import read_shard  # noqa: E402


def load_records(run: str, limit: int) -> dict:
    parts = []
    for path in sorted(glob.glob(os.path.join(run, "v3-shard-*.bin"))):
        parts.append(read_shard(path))
        if sum(len(p["header"]) for p in parts) >= limit:
            break
    header = np.concatenate([p["header"] for p in parts])[:limit]
    moves = [p["moves"][p["start"][i] : p["start"][i + 1]].astype(np.int64) for p in parts for i in range(len(p["header"]))]
    return {"header": header, "moves": moves[:limit]}


def stats(diff: np.ndarray) -> dict:
    a = np.abs(diff.reshape(-1))
    return {"maxAbs": float(a.max()), "p999": float(np.percentile(a, 99.9))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--onnx", required=True, help="prefix of <prefix>.fp32.onnx / .fp16.onnx")
    ap.add_argument("--run", required=True)
    ap.add_argument("--limit", type=int, default=20000)
    ap.add_argument("--rust", nargs="*", default=[], help="prefixes written by examples/h1_v3_eval.rs")
    ap.add_argument("--placements", default="ml/data/placements.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cuda.matmul.allow_tf32 = False
    cpu = torch.device("cpu")
    pi = PolicyIndex(args.placements)
    data = load_records(args.run, args.limit)
    h = data["header"]
    n = len(h)
    result = {"records": n, "run": args.run}

    # Encoders: training-time (from tensors) against features.Encoder.board.
    tables = Tables(pi, cpu)
    own = torch.tensor(h["own"].astype(np.int64))
    hand = torch.tensor(h["hand"].astype(np.int64))
    seat = torch.tensor(h["seat"].astype(np.int64))
    planes, hands = encode_board(tables, own, hand, seat)
    legacy = np.zeros(n, dtype=[("seat", "u1"), ("own", "<u4", (4, 13)), ("hand", "<u4", (4,))])
    legacy["seat"], legacy["own"], legacy["hand"] = h["seat"], h["own"], h["hand"]
    ref_planes, ref_hands = Encoder(Placements(args.placements), cpu).board(legacy)
    result["encoderEqual"] = bool(torch.equal(planes, ref_planes) and torch.equal(hands, ref_hands))

    # PyTorch fp32 CPU reference.
    ck = torch.load(args.checkpoint, map_location=cpu)
    model = ARMS[ck["arm"]]()
    model.load_state_dict(ck["state"])
    model.eval()
    ref_policy, ref_util = [], []
    with torch.no_grad():
        for lo in range(0, n, 256):
            out = model(planes[lo : lo + 256], hands[lo : lo + 256], seat[lo : lo + 256])
            ref_policy.append(out["policy"].numpy())
            ref_util.append(utility_probabilities(out["utility"]).reshape(-1, 12).numpy())
    ref_policy = np.concatenate(ref_policy)  # (n, 2, 36400)
    ref_util = np.concatenate(ref_util)
    legal_idx = [pi.policy[int(h["seat"][i]), data["moves"][i]] for i in range(n)]

    def top1_agree(got_teacher_at_legal: list[np.ndarray]) -> float:
        agree = [np.argmax(g) == np.argmax(ref_policy[i, 1, legal_idx[i]]) for i, g in enumerate(got_teacher_at_legal) if len(g) >= 2]
        return float(np.mean(agree))

    # ONNX Runtime from Python.
    import onnxruntime as ort

    feeds_all = {"planes": planes.numpy(), "hands": hands.numpy(), "seat": seat.numpy()}
    runs = [("fp32", "CPUExecutionProvider", {}), ("fp32", "CUDAExecutionProvider", {"use_tf32": 0}),
            ("fp32", "CUDAExecutionProvider", {"use_tf32": 1}), ("fp16", "CUDAExecutionProvider", {"use_tf32": 0}),
            ("fp16", "CPUExecutionProvider", {})]
    result["onnx"] = {}
    for precision, provider, opts in runs:
        sess = ort.InferenceSession(f"{args.onnx}.{precision}.onnx", providers=[(provider, opts)] if opts else [provider])
        pol, tea, util = [], [], []
        for lo in range(0, n, 256):
            o = sess.run(["policy", "teacher", "utilities"], {k: v[lo : lo + 256] for k, v in feeds_all.items()})
            pol.append(o[0]), tea.append(o[1]), util.append(o[2])
        pol, tea, util = np.concatenate(pol), np.concatenate(tea), np.concatenate(util)
        key = f"{precision} {provider.replace('ExecutionProvider', '')}" + (f" tf32={opts['use_tf32']}" if opts else "")
        legal_diff = np.concatenate([np.stack([pol[i, legal_idx[i]] - ref_policy[i, 0, legal_idx[i]],
                                               tea[i, legal_idx[i]] - ref_policy[i, 1, legal_idx[i]]]).reshape(-1) for i in range(n)])
        result["onnx"][key] = {
            "logitsAll": stats(np.stack([pol, tea], 1) - ref_policy), "logitsLegal": stats(legal_diff),
            "utilities": stats(util - ref_util), "top1Teacher": top1_agree([tea[i, legal_idx[i]] for i in range(n)]),
        }
        print(key, json.dumps(result["onnx"][key]), flush=True)

    # The engine's path.
    result["rust"] = {}
    for prefix in args.rust:
        table = np.fromfile(prefix + ".policy_table.u16", dtype="<u2").reshape(4, -1)
        logits = np.fromfile(prefix + ".logits.f32", dtype="<f4").reshape(-1, 2)
        util = np.fromfile(prefix + ".utilities.f32", dtype="<f4").reshape(-1, 12)
        index = [json.loads(line) for line in open(prefix + ".index.jsonl")]
        m = len(index)
        assert m <= n and [(r["game"], r["ply"]) for r in index] == [(int(g), int(p)) for g, p in zip(h["game"][:m], h["ply"][:m])], "record order"
        counts = np.array([r["n"] for r in index])
        starts = np.concatenate([[0], np.cumsum(counts)])
        ref_legal = np.concatenate([ref_policy[i][:, legal_idx[i]].T for i in range(m)])  # (moves, 2)
        entry = {
            "records": m, "tableEqual": bool(np.array_equal(table, pi.policy.astype(np.uint16))),
            "logitsLegal": stats(logits - ref_legal), "utilities": stats(util - ref_util[:m]),
            "top1Teacher": top1_agree([logits[starts[i] : starts[i + 1], 1] for i in range(m)]),
        }
        result["rust"][os.path.basename(prefix)] = entry
        print(os.path.basename(prefix), json.dumps(entry), flush=True)
    json.dump(result, open(args.out, "w"), indent=1)


if __name__ == "__main__":
    main()
