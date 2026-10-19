"""Per-seat report for a seat-rotated match log: the challenger's advantage and win share in each seat.

    python seat_report.py match.jsonl [baseline.jsonl]

Advantage = challenger score − mean of the other three seats (as aggregateMatches.ts).
Win share = 1/k if the challenger is among k tied winners, else 0.
With a baseline (a mirror on the same seeds), also prints challenger − baseline per seat; the CI is
a paired bootstrap over seeds when the seeds overlap.
"""
import json
import sys

import numpy as np

TURN_ORDER = ["blue", "green", "purple", "yellow"]
rng = np.random.default_rng(0)


def load(path):
    by_seed = {}
    for line in open(path):
        g = json.loads(line)
        s = g["scores"]
        seat = g["seat"]
        adv = s[seat] - np.mean([v for c, v in s.items() if c != seat])
        win = 1 / len(g["winner"]) if seat in g["winner"] else 0.0
        by_seed.setdefault(g["seed"], {})[seat] = (adv, win)
    return {k: v for k, v in by_seed.items() if len(v) == 4}


def ci(x):
    idx = rng.integers(0, len(x), (4000, len(x)))
    m = x[idx].mean(axis=1)
    return x.mean(), *np.percentile(m, [2.5, 97.5])


def table(by_seed, seeds):
    out = {}
    for seat in TURN_ORDER:
        out[seat] = np.array([[by_seed[k][seat][0], by_seed[k][seat][1]] for k in seeds])
    return out


def main():
    a = load(sys.argv[1])
    b = load(sys.argv[2]) if len(sys.argv) > 2 else None
    seeds = sorted(a if b is None else set(a) & set(b))
    ta = table(a, seeds)
    tb = table(b, seeds) if b else None
    print(f"{sys.argv[1]}: {len(seeds)} seeds" + (f", paired with {sys.argv[2]}" if b else ""))
    print(f"{'seat':<7}{'order':>6}  {'advantage':>24}  {'win share':>24}" + ("  {:>24}  {:>24}".format("Δ adv vs base", "Δ win vs base") if b else ""))
    for i, seat in enumerate(TURN_ORDER):
        row = f"{seat:<7}{i + 1:>6}"
        for col in (0, 1):
            m, lo, hi = ci(ta[seat][:, col])
            f = 100 if col else 1
            row += f"  {m * f:+7.2f} [{lo * f:+6.2f}, {hi * f:+6.2f}]"
        if b:
            for col in (0, 1):
                m, lo, hi = ci(ta[seat][:, col] - tb[seat][:, col])
                f = 100 if col else 1
                row += f"  {m * f:+7.2f} [{lo * f:+6.2f}, {hi * f:+6.2f}]"
        print(row)
    allw = np.concatenate([ta[s][:, 1] for s in TURN_ORDER])
    print(f"overall win share {allw.mean() * 100:.1f}% (par 25%)")


main()
