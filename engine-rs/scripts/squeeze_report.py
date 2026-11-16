#!/usr/bin/env python3
"""Squeeze benchmark read-outs (docs/SQUEEZE_BENCHMARK.md). Standard library only.

  squeeze_report.py --score DIR              target table for a scoring stage (S3)
  squeeze_report.py --select-arm DIR         S1: which adversary arm takes the most squares
  squeeze_report.py --select-budget DIR ARM  S2: the smallest adversary budget near the largest
  squeeze_report.py --compare REF DIR        smoke: do two machines play the same games?

Files are <adversary>__<target>.jsonl (one line per game, the target once in each of four seats).
A target's squares come from `targetSquares`, or from its score where a log has none (ordinary
games): 89 placed when the score is positive (all pieces down), else 89 + score.
Intervals are 95% percentile bootstraps over seeds (10,000 draws, fixed RNG seed); panel intervals
resample seeds within each target and weigh every target equally.
"""
import glob
import json
import os
import random
import statistics
import sys

DRAWS = 10_000
SQUARES = 89


def placed(record):
    if "targetSquares" in record:
        return record["targetSquares"]
    s = record["scores"][record["seat"]]
    return SQUARES if s > 0 else SQUARES + s


def load(path):
    """seed -> list of (seat, squares, pieces or None, record)."""
    games = {}
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            if "error" in r:
                continue
            games.setdefault(r["seed"], []).append((r["seat"], placed(r), r.get("targetPieces"), r))
    return {seed: g for seed, g in games.items() if len(g) == 4}  # complete seeds only


def cells(directory):
    out = {}
    for path in sorted(glob.glob(os.path.join(directory, "*__*.jsonl"))):
        name = os.path.basename(path)[: -len(".jsonl")]
        if name.endswith((".moves", ".timing")):
            continue
        adversary, target = name.split("__", 1)
        out[(adversary, target)] = load(path)
    return out


def seed_means(games):
    return {seed: statistics.fmean(g[1] for g in rows) for seed, rows in games.items()}


def boot(values, rng):
    values = list(values)
    n = len(values)
    draws = sorted(statistics.fmean(rng.choices(values, k=n)) for _ in range(DRAWS))
    return draws[int(0.025 * DRAWS)], draws[int(0.975 * DRAWS) - 1]


def panel_boot(per_target, rng):
    """per_target: list of {seed: value}. Mean over targets of the mean over seeds, resampled within target."""
    lists = [list(d.values()) for d in per_target]
    draws = []
    for _ in range(DRAWS):
        draws.append(statistics.fmean(statistics.fmean(rng.choices(v, k=len(v))) for v in lists))
    draws.sort()
    return draws[int(0.025 * DRAWS)], draws[int(0.975 * DRAWS) - 1]


def target_order(t):
    if t.startswith("L") and t[1:].isdigit():
        return (1, int(t[1:]), t)
    return (0, ["v5.2-nano", "v5.2-lite", "v5.2", "v5.2-l6", "v5.2-pro", "v5.2-ultra"].index(t) if t in
            ["v5.2-nano", "v5.2-lite", "v5.2", "v5.2-l6", "v5.2-pro", "v5.2-ultra"] else 99, t)


def label(t):
    return f"Pentobi level {t[1:]}" if t.startswith("L") and t[1:].isdigit() else t


def score(directory):
    rng = random.Random(1)
    data = cells(directory)
    adversaries = sorted({a for a, _ in data if a != "ordinary"})
    for adv in adversaries:
        print(f"## Squeeze scores against `{adv}` ({directory})\n")
        print("| Target | Seeds | Squares placed of 89 [95% CI] | Pieces of 21 | All 21 placed | Last placement (ply) | Squares by seat (blue / yellow / purple / green) |")
        print("|---|---:|---|---:|---:|---:|---|")
        for (a, t) in sorted((k for k in data if k[0] == adv), key=lambda k: target_order(k[1])):
            games = data[(a, t)]
            if not games:
                continue
            means = seed_means(games)
            lo, hi = boot(means.values(), rng)
            rows = [g for rs in games.values() for g in rs]
            pieces = [g[2] for g in rows if g[2] is not None]
            last = [g[3].get("targetLastPly", -1) for g in rows]
            by_seat = {c: statistics.fmean(g[1] for g in rows if g[0] == c) for c in ["blue", "yellow", "purple", "green"]}
            print(f"| {label(t)} | {len(games)} | **{statistics.fmean(means.values()):.1f}** [{lo:.1f}, {hi:.1f}] | "
                  f"{statistics.fmean(pieces):.1f} | {100 * sum(p == 21 for p in pieces) / len(pieces):.1f}% | "
                  f"{statistics.fmean(last):.0f} | " + " / ".join(f"{by_seat[c]:.1f}" for c in by_seat) + " |")
        print()
    ordinary = sorted(t for a, t in data if a == "ordinary")
    if ordinary and adversaries:
        adv = adversaries[0]
        print("## Validity check 1: the same targets against three ordinary seats (same seeds)\n")
        print("| Target | Seeds | Ordinary opponents | Squeeze adversary | Squeeze − ordinary [95% CI] |")
        print("|---|---:|---|---|---|")
        for t in ordinary:
            a = seed_means(data[("ordinary", t)])
            b = seed_means(data.get((adv, t), {}))
            common = sorted(set(a) & set(b))
            if not common:
                continue
            d = [b[s] - a[s] for s in common]
            lo, hi = boot(d, rng)
            print(f"| {label(t)} | {len(common)} | {statistics.fmean(a[s] for s in common):.1f} | "
                  f"{statistics.fmean(b[s] for s in common):.1f} | **{statistics.fmean(d):+.1f}** [{lo:+.1f}, {hi:+.1f}] |")
        print("\nThe benchmark is used only if the squeeze takes clearly more than 5 squares off `v5.2` here.")


def panel_table(data, adversaries, rng):
    targets = sorted({t for a, t in data if a in adversaries}, key=target_order)
    print("| Target | " + " | ".join(f"`{a}`" for a in adversaries) + " |")
    print("|---|" + "---:|" * len(adversaries))
    for t in targets:
        cellsrow = []
        for a in adversaries:
            g = data.get((a, t), {})
            cellsrow.append(f"{statistics.fmean(seed_means(g).values()):.1f}" if g else "—")
        print(f"| {label(t)} | " + " | ".join(cellsrow) + " |")
    means = {}
    for a in adversaries:
        per_target = [seed_means(data[(a, t)]) for t in targets if data.get((a, t))]
        if len(per_target) != len(targets):
            means[a] = None
            continue
        m = statistics.fmean(statistics.fmean(d.values()) for d in per_target)
        lo, hi = panel_boot(per_target, rng)
        means[a] = (m, lo, hi)
    print("| **Panel mean (each target weighs 1)** | " + " | ".join(
        f"**{means[a][0]:.1f}** [{means[a][1]:.1f}, {means[a][2]:.1f}]" if means[a] else "incomplete" for a in adversaries) + " |")
    return targets, means


def paired_panel(data, a, b, targets, rng):
    """Panel mean of (b − a), paired by seed within each target."""
    per_target = []
    for t in targets:
        x, y = seed_means(data[(a, t)]), seed_means(data[(b, t)])
        common = sorted(set(x) & set(y))
        per_target.append({s: y[s] - x[s] for s in common})
    m = statistics.fmean(statistics.fmean(d.values()) for d in per_target)
    lo, hi = panel_boot(per_target, rng)
    return m, lo, hi


def select_arm(directory):
    rng = random.Random(2)
    data = cells(directory)
    arms = [a for a in ["SQ0-l6", "SQR-l6", "SQP-l6", "SQRP-l6"] if any(k[0] == a for k in data)]
    print(f"## S1: adversary arms at the level-6 budget ({directory}); mean target squares placed of 89, lower is a stronger squeeze\n")
    targets, means = panel_table(data, arms, rng)
    if any(means[a] is None for a in arms):
        print("\nIncomplete: no selection.")
        return
    print("\n| Arm − SQ0 (panel, paired by seed) | Δ squares [95% CI] |\n|---|---|")
    clears = []
    for a in arms[1:]:
        m, lo, hi = paired_panel(data, "SQ0-l6", a, targets, rng)
        print(f"| {a} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] |")
        if hi < 0:
            clears.append((means[a][0], a))
    chosen = min(clears)[1] if clears else "SQ0-l6"
    print(f"\nRule (fixed in advance): the arm with the lowest panel mean among those that take significantly more squares than SQ0 "
          f"(upper bound below 0), else SQ0.\n\n**Selected arm: {chosen.split('-')[0]}**")


def select_budget(directory, arm):
    rng = random.Random(3)
    data = cells(directory)
    names = [f"{arm}-{b}" for b in ["l6", "l6x4", "pro"]]
    print(f"## S2: adversary budget for {arm} ({directory}); mean target squares placed of 89\n")
    targets, means = panel_table(data, names, rng)
    if any(means[a] is None for a in names):
        print("\nIncomplete: no selection.")
        return
    top = means[names[-1]][0]
    print("\n| Budget − pro (panel, paired by seed) | Δ squares [95% CI] |\n|---|---|")
    for a in names[:-1]:
        m, lo, hi = paired_panel(data, names[-1], a, targets, rng)
        print(f"| {a} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] |")
    chosen = next(a for a in names if means[a][0] - top <= 1.0)
    print("\nRule (fixed in advance): the smallest budget whose panel mean is within 1.0 square of pro's.")
    if means[names[1]][0] - top > 1.0:
        print("Note: pro still takes more than a square more than l6x4, so a larger adversary would probably squeeze harder still.")
    print(f"\n**Selected budget: {chosen.split('-', 1)[1]}**  (freeze with: engine-rs/scripts/squeeze-run.sh freeze {arm} {chosen.split('-', 1)[1]})")


def compare(ref, directory):
    if not glob.glob(os.path.join(ref, "*__*.jsonl")):
        print(f"no reference games in {ref}")
        return
    same = True
    for path in sorted(glob.glob(os.path.join(ref, "*__*.jsonl"))):
        if path.endswith((".moves.jsonl", ".timing.jsonl")):
            continue
        other = os.path.join(directory, os.path.basename(path))
        key = lambda r: (r["seed"], r["seat"])
        a = {key(r): (r["scores"], r.get("targetSquares")) for r in map(json.loads, open(path))}
        b = {key(r): (r["scores"], r.get("targetSquares")) for r in map(json.loads, open(other))} if os.path.exists(other) else {}
        diff = [k for k in a if a[k] != b.get(k)]
        print(f"{os.path.basename(path)}: {len(a) - len(diff)}/{len(a)} games identical to the reference")
        same &= not diff
    print("SAME GAMES AS THE REFERENCE MACHINE" if same else
          "DIFFERENT GAMES: fine for the benchmark (results are statistical), but never pair runs from different machines")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--score"]:
        score(a[1])
    elif a[:1] == ["--select-arm"]:
        select_arm(a[1])
    elif a[:1] == ["--select-budget"]:
        select_budget(a[1], a[2])
    elif a[:1] == ["--compare"]:
        compare(a[1], a[2])
    else:
        print(__doc__)
        sys.exit(2)
