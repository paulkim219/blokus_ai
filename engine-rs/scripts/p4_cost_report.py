"""Summarise examples/p4_cost.rs output: per config, ms/move, ratio to the first config, iterations,
iterations/second, root candidates, root children visited, top child's visit share, and how often
the move equals the first config's — overall and by own-move band.

    python3 engine-rs/scripts/p4_cost_report.py tmp/p4/cost/cost.csv base ID FULLord ...
"""
import collections
import csv
import sys

BANDS = [("3-8", 3, 9), ("9-14", 9, 15), ("15+", 15, 99), ("all", 3, 99)]


def main():
    path, names = sys.argv[1], sys.argv[2:]
    rows = list(csv.DictReader(open(path)))
    print("| Config | Band | Positions | ms/move | × first | Iterations | Iterations/s | Root candidates | Children visited | Top child share | Same move as first |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for band, lo, hi in BANDS:
        by = collections.defaultdict(list)
        for r in rows:
            if lo <= int(r["own_idx"]) < hi:
                by[int(r["config"])].append(r)
        if not by:
            continue
        mean = lambda v, k: sum(float(r[k]) for r in v) / len(v)
        base_ms = mean(by[0], "ms")
        for k in sorted(by):
            v = by[k]
            ms, it = mean(v, "ms"), mean(v, "iterations")
            share = sum(float(r["top_visits"]) / max(1.0, float(r["iterations"])) for r in v) / len(v)
            name = names[k] if k < len(names) else str(k)
            print(f"| {name} | {band} | {len(v)} | {ms:.1f} | {ms / base_ms:.2f} | {it:.0f} | {it / ms * 1000:.0f} | "
                  f"{mean(v, 'candidates'):.1f} | {mean(v, 'visited'):.1f} | {share:.2f} | {mean(v, 'same_as_first'):.2f} |")


if __name__ == "__main__":
    main()
