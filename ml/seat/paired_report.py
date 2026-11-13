"""Seed-paired difference in advantage between two seat-rotated match logs on the same seeds (E6).

    python ml/seat/paired_report.py <arm.jsonl> <control.jsonl> [--label NAME]

Per seed, advantage = mean over the four seat rotations of (challenger score − mean of the other
three seats), exactly as scripts/aggregateMatches.ts and ml/seat/seat_report.py define it. Only
seeds with all four rotations in BOTH logs are used. The statistic is the mean over seeds of
(arm advantage − control advantage), with a 95% percentile bootstrap over seeds that uses the same
generator, seed (12345), 4,000 resamples and percentile indices as `bootstrapCI` in
scripts/lib/stats.ts. Each log's own advantage is printed with the same interval, so a single log's
line matches aggregateMatches when the seed sets agree.

E6 reads an arm as advancing when the paired difference against P0 has a CI lower bound above 0.
"""
import argparse
import json

SEATS = ("blue", "yellow", "purple", "green")
MASK = 0xFFFFFFFF


def load(path):
    """seed → {seat: advantage}, in order of first appearance; complete rotations only."""
    by_seed = {}
    for line in open(path):
        if not line.strip():
            continue
        g = json.loads(line)
        s, seat = g["scores"], g["seat"]
        others = [s[c] for c in SEATS if c != seat]
        by_seed.setdefault(g["seed"], {})[seat] = s[seat] - sum(others) / len(others)
    return {seed: sum(v.values()) / 4 for seed, v in by_seed.items() if len(v) == 4}


def bootstrap(samples, iterations=4000, seed=12345):
    """Port of bootstrapCI (scripts/lib/stats.ts): mean, low, high."""
    n = len(samples)
    point = sum(samples) / n if n else 0.0
    if n < 2:
        return point, point, point
    state = seed & MASK

    def imul(a, b):
        return (a * b) & MASK

    def rand():
        nonlocal state
        state = (state + 0x6D2B79F5) & MASK
        t = imul(state ^ (state >> 15), 1 | state)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & MASK) ^ t
        return ((t ^ (t >> 14)) & MASK) / 4294967296

    means = []
    for _ in range(iterations):
        total = 0.0
        for _ in range(n):
            total += samples[int(rand() * n)]
        means.append(total / n)
    means.sort()
    return point, means[int(iterations * 0.025)], means[int(iterations * 0.975)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("arm")
    parser.add_argument("control")
    parser.add_argument("--label", default=None)
    args = parser.parse_args()
    arm, control = load(args.arm), load(args.control)
    seeds = [s for s in arm if s in control]
    label = args.label or args.arm
    print(f"{label}: {len(seeds)} paired seeds ({len(arm)} complete in arm, {len(control)} in control)")
    if not seeds:
        return
    a = [arm[s] for s in seeds]
    c = [control[s] for s in seeds]
    d = [x - y for x, y in zip(a, c)]
    for name, xs in (("arm advantage", a), ("control advantage", c)):
        m, lo, hi = bootstrap(xs)
        print(f"  {name:<22} {m:+.2f} [95% CI {lo:+.2f}, {hi:+.2f}]")
    m, lo, hi = bootstrap(d)
    verdict = "ADVANCES (CI lower bound > 0)" if lo > 1e-6 else "does not advance"
    print(f"  paired Δ (arm − control) {m:+.2f} [95% CI {lo:+.2f}, {hi:+.2f}] → {verdict}")


if __name__ == "__main__":
    main()
