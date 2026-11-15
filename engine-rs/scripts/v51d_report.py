"""Round 4 read-outs (preregistered 2026-11-14, "round 4" entries in
research_paper/v6_native_and_learning_preregistered.md).

    python3 engine-rs/scripts/v51d_report.py --stage1 tmp/v51d/S1
    python3 engine-rs/scripts/v51d_report.py --time tmp/v51d/time/time-v51.timing.jsonl
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from v51c_report import arm_line, merged, paired, roles, fmt_ci  # noqa: E402


def stage1(root):
    os.makedirs(os.path.join(root, "pooled"), exist_ok=True)
    print("### Lone seat vs three level-6 seats, per-seat Pentobi processes\n")
    print("| Arm / block | Seeds | Advantage [95% CI] | First place (any) | First place (split) |")
    print("|---|---:|---:|---:|---:|")
    sets = {}
    for c in ["v5.0-ultra", "v5.1-ultra"]:
        parts = [os.path.join(root, b, f"lone-{c}.jsonl") for b in ["c1", "c2"]]
        parts = [p for p in parts if os.path.exists(p)]
        sets[c] = merged(parts, os.path.join(root, "pooled", f"lone-{c}.jsonl"))
        for p in parts + [sets[c]]:
            print(arm_line(f"{c} `{p}`", p))
    if all(os.path.getsize(p) for p in sets.values()):
        n, d, f1, f2 = paired(sets["v5.1-ultra"], sets["v5.0-ultra"])
        print(f"\nPaired v5.1 − v5.0 on {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp")
        for b in ["c1", "c2"]:
            a, z = os.path.join(root, b, "lone-v5.1-ultra.jsonl"), os.path.join(root, b, "lone-v5.0-ultra.jsonl")
            if os.path.exists(a) and os.path.exists(z):
                n, d, f1, f2 = paired(a, z)
                print(f"- block {b}: {fmt_ci(d)} on {n} seeds; first place (split) {fmt_ci(f2)} pp")
    print("\n### Other blocks\n")
    print("| Match | Seeds | Lone seat's advantage [95% CI] | First place (any) | First place (split) |")
    print("|---|---:|---:|---:|---:|")
    for name, f in [("v4.2-ultra vs 3 x L6 (91,200,000)", "v42-l6.jsonl"), ("v5.1-ultra vs 3 x L7 (91,300,000)", "v51-l7.jsonl"),
                    ("one L6 vs 3 x v5.1-ultra (91,400,000; Pentobi's advantage)", "rev-l6.jsonl")]:
        p = os.path.join(root, f)
        if os.path.exists(p) and os.path.getsize(p):
            print(arm_line(name, p))
        else:
            print(f"| {name} | — | not played | | |")
    print("\n### Role tables (score − game mean by position relative to the lone seat)\n")
    logs = [sets.get("v5.0-ultra"), sets.get("v5.1-ultra")] + [os.path.join(root, f) for f in ["v42-l6.jsonl", "v51-l7.jsonl", "rev-l6.jsonl"]]
    roles([p for p in logs if p and os.path.exists(p) and os.path.getsize(p)])


def time_report(path):
    ms_b, ms_p, sims = [], [], []
    for l in open(path):
        t = json.loads(l)
        ms_b += t["blokeeMs"]
        ms_p += t["pentobiMs"]
    lat = lambda v: (sum(v) / len(v), sorted(v)[len(v) // 2]) if v else (float("nan"),) * 2
    (bm, bmed), (pm, pmed) = lat(ms_b), lat(ms_p)
    print(f"Blokee ms/move mean {bm:.1f} median {bmed:.1f} over {len(ms_b)} moves; Pentobi (per-seat process) mean {pm:.1f} median {pmed:.1f} over {len(ms_p)} moves")


if __name__ == "__main__":
    a = sys.argv
    {"--stage1": stage1, "--time": time_report}[a[1]](a[2])
