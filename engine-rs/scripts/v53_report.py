"""Round 6 read-outs (preregistered 2026-11-15 13:40, "round 6" entry).

    python3 engine-rs/scripts/v53_report.py --cal tmp/v53/cal            # calibration table + scales.json
    python3 engine-rs/scripts/v53_report.py --tiers tmp/v53              # Stage 2 tables
    python3 engine-rs/scripts/v53_report.py --bench tmp/v53              # Stage 3 DRAFT break-even read-out

Time per move is the mean over each seat's moves from its fifth move on (index >= 4), for both engines:
Pentobi's first searched move in a process carries a one-off memory set-up (150-700 ms), and Blokee's first
three moves are the opening heuristic; the all-moves means are reported beside it.
"""
import glob
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from v51c_report import arm_line, roles, fmt_ci, per_seed, bootstrap  # noqa: E402

TURN = ["blue", "green", "purple", "yellow"]
DISPLAY = ["blue", "yellow", "purple", "green"]
TIERS = [("nano", 1), ("lite", 3), ("base", 5), ("pro", 7), ("ultra", 9)]


def times(path, lone_blokee=True):
    """(blokee ms own>=4, blokee ms all, pentobi ms idx>=4, pentobi ms all) from a timing JSONL."""
    b4, ba, p4, pa = [], [], [], []
    for l in open(path):
        t = json.loads(l)
        lone = t["seat"]
        for c, v in t["msBySeat"].items():
            ours = bool(t["blokeeMs"]) and ((c == lone) == lone_blokee)
            if ours:
                b4 += v[4:]
                ba += v
            else:
                p4 += v[4:]
                pa += v
    m = lambda v: sum(v) / len(v) if v else float("nan")
    return m(b4), m(ba), m(p4), m(pa), len(b4), len(p4)


def sims(logdir):
    s, v = [], []
    for f in glob.glob(os.path.join(logdir, "*.log")):
        for x in open(f, errors="ignore"):
            q = re.search(r"Vst (\d+), Sim (\d+)", x)
            if q:
                v.append(int(q.group(1)))
                s.append(int(q.group(2)))
    return (sum(s) / len(s) if s else float("nan")), (sum(v) / len(v) if v else float("nan")), len(s)


def cal(root):
    rows = {}
    for k in range(1, 10):
        tp = os.path.join(root, f"L{k}.timing.jsonl")
        if not os.path.exists(tp):
            continue
        b4, ba, p4, pa, nb, np_ = times(tp)
        sm, vm, ns = sims(os.path.join(root, f"logs-L{k}"))
        rows[k] = dict(b4=b4, ba=ba, p4=p4, pa=pa, nb=nb, np=np_, sims=sm, vst=vm, nsims=ns,
                       games=sum(1 for _ in open(tp)))
    # Blokee at 14.224: pooled over the level 1-7 runs (own moves 4+)
    bs = [rows[k]["b4"] for k in rows if k <= 7]
    B = sum(bs) / len(bs)
    out = {"blokee_ms_own4_at_14.224": B, "levels": rows, "scales": {}}
    for tier, k in TIERS:
        if k in rows:
            out["scales"][tier] = round(14.224 * rows[k]["p4"] / B, 3)
    json.dump(out, open(os.path.join(root, "scales.json"), "w"), indent=1)
    print(f"Blokee `v5.1-ultra` at iterationScale 14.224: {B:.1f} ms/move (own moves 4+, pooled over the level 1-7 runs)\n")
    print("| Level | Games | Pentobi ms/move (move 5+) | Pentobi ms/move (all) | new simulations/move | root visits | Tier | iterationScale |")
    print("|---:|---:|---:|---:|---:|---:|---|---:|")
    tiermap = {k: t for t, k in TIERS}
    for k, r in sorted(rows.items()):
        t = tiermap.get(k, "")
        sc = out["scales"].get(t, "")
        print(f"| {k} | {r['games']} | {r['p4']:.1f} | {r['pa']:.1f} | {r['sims']:.0f} | {r['vst']:.0f} | {t} | {sc} |")


def checks(root):
    print("\n| Tier | Level | iterationScale (checked) | our ms/move (own 4+) | Pentobi ms/move (move 5+) | ratio | our ms (all) |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for tier, k in TIERS:
        for tag in ("check", "check2"):
            tp = os.path.join(root, f"{tag}-{tier}.timing.jsonl")
            if os.path.exists(tp):
                b4, ba, p4, pa, _, _ = times(tp)
                cfg = json.load(open(os.path.join(root, f"{tag}-{tier}.config.json")))
                print(f"| {tier} ({tag}) | {k} | {cfg['search']['iterationScale']} | {b4:.1f} | {p4:.1f} | {b4 / p4:.3f} | {ba:.1f} |")


def tiers(root):
    print("| Match | Seeds | Our advantage [95% CI] | First place (any) | First place (split) |")
    print("|---|---:|---:|---:|---:|")
    logs = []
    for tier, k in TIERS:
        for name, p in ((f"v5.2-{tier} vs 3 x L{k}", f"{root}/S2/{tier}-L{k}.jsonl"), (f"one L{k} vs 3 x v5.2-{tier} (Pentobi's advantage)", f"{root}/S2/rev-{tier}-L{k}.jsonl")):
            if os.path.exists(p) and os.path.getsize(p):
                print(arm_line(name, p))
                logs.append(p)
    print()
    roles(logs)
    print("\nIn-match ms/move (own/move 5+; all): ")
    for p in logs:
        b4, ba, p4, pa, _, _ = times(p[:-6] + ".timing.jsonl", lone_blokee="/rev-" not in p)
        print(f"- `{p}`: ours {b4:.1f} ({ba:.1f}), Pentobi {p4:.1f} ({pa:.1f})")


def seeds_adv(path):
    return {s: v[0] for s, v in per_seed(path).items()}


def bench(root):
    """DRAFT. For each engine, lone-seat advantages against three seats of each anchor level played; the
    break-even level by linear interpolation between the bracketing anchors; 95% interval by bootstrap."""
    print("**DRAFT read-out (design to be settled by the supervising session with Paul).**\n")
    engines = {}
    def add(engine, level, path):
        if os.path.exists(path) and os.path.getsize(path):
            engines.setdefault(engine, {})[level] = path
    for tier, k in TIERS:
        add(f"v5.2-{tier}", k, f"{root}/S2/{tier}-L{k}.jsonl")
        for lv in range(1, 10):
            add(f"v5.2-{tier}", lv, f"{root}/S3/{tier}-vs-L{lv}.jsonl")
    add("v5.2-l6", 6, "tmp/v52/S1/pooled/lone-TM.jsonl")
    for lv in range(1, 10):
        add("v5.2-l6", lv, f"{root}/S3/l6-vs-L{lv}.jsonl")
    for k in range(1, 9):
        add(f"Pentobi L{k + 1}", k, f"{root}/S3/ladder-L{k + 1}-vs-L{k}.jsonl")
        add(f"Pentobi L{k}", k + 1, f"{root}/S3/ladder-L{k}-vs-L{k + 1}.jsonl")
    print("| Engine | ms/move (own 4+) | Advantage vs anchors played (level: adv [95% CI]) | Break-even level [95% CI] |")
    print("|---|---:|---|---:|")
    rnd = random.Random(7)
    for e, d in engines.items():
        lv = sorted(d)
        advs = {l: seeds_adv(d[l]) for l in lv}
        advs = {l: a for l, a in advs.items() if a}
        lv = sorted(advs)
        if not lv:
            continue
        means = {l: sum(a.values()) / len(a) for l, a in advs.items()}
        cells = "; ".join(f"L{l}: {fmt_ci(bootstrap(list(advs[l].values())))}" for l in lv)
        def be(m):
            pts = sorted(m.items())
            for (l1, a1), (l2, a2) in zip(pts, pts[1:]):
                if a1 >= 0 >= a2 and a1 != a2:
                    return l1 + (l2 - l1) * a1 / (a1 - a2)
            return None
        point = be(means)
        reps = []
        if point is not None:
            for _ in range(2000):
                m = {}
                for l, a in advs.items():
                    v = list(a.values())
                    m[l] = sum(rnd.choice(v) for _ in v) / len(v)
                x = be(m)
                if x is not None:
                    reps.append(x)
        if point is None:
            bes = "not bracketed (" + ("above all anchors" if all(v > 0 for v in means.values()) else "below all anchors" if all(v < 0 for v in means.values()) else "non-monotone") + ")"
        else:
            reps.sort()
            bes = f"{point:.2f} [{reps[int(0.025 * len(reps))]:.2f}, {reps[int(0.975 * len(reps)) - 1]:.2f}]"
        ms = ""
        try:
            b4, _, p4, _, _, _ = times(d[lv[0]][:-6] + ".timing.jsonl")
            ms = f"{b4:.1f}" if e.startswith("v5.2") else ""
        except Exception:
            pass
        print(f"| {e} | {ms} | {cells} | {bes} |")


if __name__ == "__main__":
    a = sys.argv
    if a[1] == "--cal":
        cal(a[2])
        checks(a[2])
    elif a[1] == "--tiers":
        tiers(a[2])
    elif a[1] == "--bench":
        bench(a[2])
