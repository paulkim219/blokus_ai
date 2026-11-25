"""Hybrid H2 development steps (research_paper/v5_hybrid_preregistered.md, "H2"): arm configs, the choice of
`interiorVisits` T, and equal-wall-time calibration. No match game is played here; every measurement is a
search on recorded positions (`examples/h2_cost.rs`, the positions `p4_cost` uses: the lone Blokee seat's
decisions at own moves 3+ of tmp/h0/x1-l6a.moves.jsonl, 150 sampled evenly, budget 300, fixed RNG seeds).

    python3 engine-rs/scripts/h2_calibrate.py probe-t  <tier>          # writes tmp/h2/dev/probe-t-<tier>.json
    python3 engine-rs/scripts/h2_calibrate.py calibrate <tier> <arm>   # writes tmp/h2/configs/<arm>.json

Tiers: turbo (control engine-rs/configs/v5.3-turbo.json) and pro (control tmp/h1/configs/v5.3-pro.json, eager).
Arms (all: the H1 network, teacher head, CUDA, fp32, TF32 off, temperature 1):
  T-R50, T-R100 (root prior, rootBlend 0.5 / 1.0), T-RI (root 0.5 + interior prior, interiorBlend 0.5);
  P-R50 (root 0.5), P-RI (root 0.5 + interior prior).
Run from the repo root with `source engine-rs/scripts/h0-env.sh` done (ONNX Runtime and CUDA libraries).
"""

from __future__ import annotations

import copy
import csv
import json
import os
import subprocess
import sys

MODEL = "tmp/h1/onnx/h1-selected.fp32.onnx"
POSITIONS = "tmp/h0/x1-l6a.moves.jsonl"
N_POSITIONS = 150
COST = os.environ.get("H2_COST", "tmp/h2/bin/h2_cost")
CONTROL = {"turbo": "engine-rs/configs/v5.3-turbo.json", "pro": "tmp/h1/configs/v5.3-pro.json"}
# Interior calls budget per searched move (the root call comes on top): turbo 8, pro 40.
BUDGET = {"turbo": 8, "pro": 40}
T_CANDIDATES = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384]
ARMS = {
    "T-R50": ("turbo", {"rootBlend": 0.5}),
    "T-R100": ("turbo", {"rootBlend": 1.0}),
    "T-RI": ("turbo", {"rootBlend": 0.5, "interiorVisits": "T", "interiorBlend": 0.5}),
    "P-R50": ("pro", {"rootBlend": 0.5}),
    "P-RI": ("pro", {"rootBlend": 0.5, "interiorVisits": "T", "interiorBlend": 0.5}),
}
BAND = (0.97, 1.03)
MAX_ROUNDS = 6


def arm_config(tier: str, net: dict, T: int | None, scale: float | None) -> dict:
    c = json.load(open(CONTROL[tier]))
    block = {"evaluator": {"backend": "ort", "model": MODEL, "device": "cuda", "format": "v3", "head": "teacher"},
             "temperature": 1.0}
    for k, v in net.items():
        block[k] = T if v == "T" else v
    c = copy.deepcopy(c)
    c["native"]["net"] = block
    if scale is not None:
        c["search"]["iterationScale"] = scale
    return c


def run_cost(configs: list[str], threads: int, out: str) -> list[dict]:
    subprocess.run([COST, POSITIONS, str(N_POSITIONS), str(threads), out, *configs], check=True)
    rows = list(csv.DictReader(open(out)))
    per = []
    for k in range(len(configs)):
        r = [x for x in rows if int(x["config"]) == k]
        searched = [x for x in r if int(x["iterations"]) > 0]
        per.append({
            "config": configs[k], "positions": len(r), "searched": len(searched),
            "msMean": sum(float(x["ms"]) for x in r) / len(r),
            "iterationsMean": sum(int(x["iterations"]) for x in searched) / max(1, len(searched)),
            "netEvalsPerSearched": sum(int(x["net_evals"]) for x in searched) / max(1, len(searched)),
        })
    return per


def probe_t(tier: str) -> None:
    """Smallest T whose mean network evaluations per searched move is at most 1 + the tier's budget,
    at the tier's own iterationScale (8 threads: counts do not depend on timing)."""
    os.makedirs("tmp/h2/dev", exist_ok=True)
    arm = "T-RI" if tier == "turbo" else "P-RI"
    paths = []
    for T in T_CANDIDATES:
        p = f"tmp/h2/dev/probe-{tier}-T{T}.json"
        json.dump(arm_config(tier, ARMS[arm][1], T, None), open(p, "w"), indent=1)
        paths.append(p)
    per = run_cost(paths, 8, f"tmp/h2/dev/probe-t-{tier}.csv")
    chosen = next((T for T, r in zip(T_CANDIDATES, per) if r["netEvalsPerSearched"] <= 1 + BUDGET[tier]), T_CANDIDATES[-1])
    result = {"tier": tier, "budget": BUDGET[tier], "candidates": [{"T": T} | r for T, r in zip(T_CANDIDATES, per)], "T": chosen}
    json.dump(result, open(f"tmp/h2/dev/probe-t-{tier}.json", "w"), indent=1)
    print(json.dumps({"tier": tier, "T": chosen, "evals": [(T, round(r["netEvalsPerSearched"], 2)) for T, r in zip(T_CANDIDATES, per)]}))


def calibrate(tier: str, arm: str) -> None:
    """Scale the arm's iterationScale until its mean ms per position is within 0.97-1.03 of the control's,
    both measured on one thread, same positions, in the same run."""
    os.makedirs("tmp/h2/configs", exist_ok=True)
    os.makedirs("tmp/h2/dev", exist_ok=True)
    net = ARMS[arm][1]
    T = json.load(open(f"tmp/h2/dev/probe-t-{tier}.json"))["T"] if "interiorVisits" in net else None
    scale = json.load(open(CONTROL[tier]))["search"]["iterationScale"]
    rounds = []
    for k in range(MAX_ROUNDS):
        path = f"tmp/h2/dev/cal-{arm}-r{k}.json"
        json.dump(arm_config(tier, net, T, scale), open(path, "w"), indent=1)
        control, a = run_cost([CONTROL[tier], path], 1, f"tmp/h2/dev/cal-{arm}-r{k}.csv")
        ratio = a["msMean"] / control["msMean"]
        rounds.append({"round": k, "iterationScale": scale, "controlMs": control["msMean"], "armMs": a["msMean"], "ratio": ratio,
                       "armNetEvalsPerSearched": a["netEvalsPerSearched"], "controlIterations": control["iterationsMean"],
                       "armIterations": a["iterationsMean"]})
        print(json.dumps(rounds[-1]), flush=True)
        if BAND[0] <= ratio <= BAND[1]:
            json.dump(arm_config(tier, net, T, scale), open(f"tmp/h2/configs/{arm}.json", "w"), indent=1)
            json.dump({"tier": tier, "arm": arm, "T": T, "iterationScale": scale, "rounds": rounds},
                      open(f"tmp/h2/dev/calibration-{arm}.json", "w"), indent=1)
            return
        scale = scale / ratio
    json.dump({"tier": tier, "arm": arm, "T": T, "rounds": rounds, "converged": False}, open(f"tmp/h2/dev/calibration-{arm}.json", "w"), indent=1)
    sys.exit(f"{arm}: not within {BAND} after {MAX_ROUNDS} rounds; needs a person (prereg: report and stop)")


if __name__ == "__main__":
    if sys.argv[1] == "probe-t":
        probe_t(sys.argv[2])
    elif sys.argv[1] == "calibrate":
        calibrate(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
