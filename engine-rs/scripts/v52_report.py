"""Round 5 read-outs (preregistered 2026-11-15, "round 5" entries in
research_paper/v6_native_and_learning_preregistered.md).

    python3 engine-rs/scripts/v52_report.py --time FILE.timing.jsonl [...]   # clean ms/move, all moves
    python3 engine-rs/scripts/v52_report.py --tm-scale BASE_SCALE FILE.timing.jsonl [...]   # time-matched scale
    python3 engine-rs/scripts/v52_report.py --stage1 tmp/v52/S1
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from v51c_report import arm_line, merged, paired, roles, role_times, fmt_ci, per_seed, bootstrap  # noqa: E402


def timing(paths):
    b, p, early = [], [], []
    for path in paths:
        for l in open(path):
            t = json.loads(l)
            b += t["blokeeMs"]
            early += t["blokeeMs"][:3]
            p += t["pentobiMs"]
    return b, p, early


def time_report(paths):
    b, p, _ = timing(paths)
    print(f"Blokee mean {sum(b) / len(b):.2f} ms/move over {len(b)} moves; Pentobi mean {sum(p) / len(p):.2f} ms/move over {len(p)} moves; ratio {sum(b) / len(b) / (sum(p) / len(p)):.4f}")


def tm_scale(base_scale, paths):
    """Scale searched moves (own moves 3+) so that Blokee's mean over all its moves equals Pentobi's."""
    b, p, early = timing(paths)
    target = sum(p) / len(p) * len(b)
    searched = sum(b) - sum(early)
    f = (target - sum(early)) / searched
    print(f"{base_scale * f:.3f}")
    print(f"f = {f:.4f} (searched {searched:.0f} ms, early {sum(early):.0f} ms, target {target:.0f} ms)", file=sys.stderr)


def stage1(root):
    print("### Lone seat vs three level-6 seats, per-seat processes (93,000,000 + 93,100,000)\n")
    print("| Arm / block | Seeds | Advantage [95% CI] | First place (any) | First place (split) |")
    print("|---|---:|---:|---:|---:|")
    os.makedirs(os.path.join(root, "pooled"), exist_ok=True)
    sets = {}
    for c in ["base", "TM"]:
        parts = [os.path.join(root, b, f"lone-{c}.jsonl") for b in ("e1", "e2")]
        parts = [x for x in parts if os.path.exists(x)]
        if not parts:
            continue
        sets[c] = merged(parts, os.path.join(root, "pooled", f"lone-{c}.jsonl"))
        for x in parts + [sets[c]]:
            print(arm_line(f"{c} `{x}`", x))
    if len(sets) == 2:
        n, d, f1, f2 = paired(sets["TM"], sets["base"])
        print(f"\nPaired TM − base on {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp")
        print("\nRole tables:\n")
        roles(list(sets.values()))
        for c, x in sets.items():
            tp = x[: -len(".jsonl")] + ".timing.jsonl"
            parts = [os.path.join(root, b, f"lone-{c}.timing.jsonl") for b in ("e1", "e2")]
            bm, pm = [], []
            for q in parts:
                if os.path.exists(q):
                    for l in open(q):
                        t = json.loads(l)
                        bm += t["blokeeMs"]
                        pm += t["pentobiMs"]
            print(f"- {c}: in-match ms/move Blokee {sum(bm) / len(bm):.1f}, Pentobi {sum(pm) / len(pm):.1f}")
    print("\n### Compute curve (200 seeds 93,200,000)\n")
    print("| Multiple | Seeds | Advantage [95% CI] | First place (split) | Paired vs ×1 |")
    print("|---|---:|---:|---:|---:|")
    pts = []
    base = os.path.join(root, "curve", "x1.jsonl")
    for m in ("x1", "x2", "x4"):
        x = os.path.join(root, "curve", f"{m}.jsonl")
        if not os.path.exists(x):
            continue
        d = per_seed(x)
        mean = bootstrap([v[0] for v in d.values()])
        fp = 100 * sum(v[2] for v in d.values()) / len(d)
        pv = "—" if m == "x1" else fmt_ci(paired(x, base)[1])
        print(f"| {m} | {len(d)} | {fmt_ci(mean)} | {fp:.1f}% | {pv} |")
        pts.append((math.log2({"x1": 1, "x2": 2, "x4": 4}[m]), mean[0]))
    extra = os.path.join(root, "curve", "round4-x2.txt")
    if len(pts) >= 2:
        n = len(pts)
        mx, my = sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n
        b = sum((p[0] - mx) * (p[1] - my) for p in pts) / sum((p[0] - mx) ** 2 for p in pts)
        a = my - b * mx
        print(f"\nLeast-squares line over the multiples played: advantage = {a:+.2f} + {b:+.2f}·log2(multiple); "
              f"parity (advantage 0) at multiple {2 ** (-a / b):.2f}" if b > 0 else f"\nslope {b:+.2f} (not positive)")
    print("\n### One level-6 seat vs three time-matched seats (200 seeds 93,250,000)\n")
    x = os.path.join(root, "rev-TM.jsonl")
    if os.path.exists(x):
        print("| Match | Seeds | Pentobi's advantage | First place (any) | First place (split) |\n|---|---:|---:|---:|---:|")
        print(arm_line("one L6 vs three TM", x))
        roles([x])


if __name__ == "__main__":
    a = sys.argv
    if a[1] == "--time":
        time_report(a[2:])
    elif a[1] == "--tm-scale":
        tm_scale(float(a[2]), a[3:])
    elif a[1] == "--stage1":
        stage1(a[2])
