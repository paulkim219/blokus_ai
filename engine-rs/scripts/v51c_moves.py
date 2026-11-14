"""Round 3, Stage C read-out of `examples/c_moves.rs` rows (move-level interaction by engine and role).

    python3 engine-rs/scripts/v51c_moves.py tmp/v51c/C/lone-v50.csv tmp/v51c/C/twotwo-v50.csv > tmp/v51c/C/stageC.md

Phases by ply: open 0-7, mid 8-27, late 28+. Means per move; ± is 1.96 x the standard error of per-seed
means (moves within a seed are correlated, so the seed is the unit).
"""
import sys

import numpy as np
import pandas as pd

PH = [("open 0-7", 0, 8), ("mid 8-27", 8, 28), ("late 28+", 28, 999), ("all", 0, 999)]


def ci(df, col):
    by = df.groupby("seed")[col].mean()
    if len(by) < 2:
        return f"{df[col].mean():+.2f}"
    return f"{df[col].mean():+.2f} ±{1.96 * by.std(ddof=1) / np.sqrt(len(by)):.2f}"


def phase(df, lo, hi):
    return df[(df.ply >= lo) & (df.ply < hi)]


def interaction(df, name):
    print(f"\n### {name}: what a placement does to another seat (target), by mover → target engine and role\n")
    print("| Role | Mover → target | Phase | Moves | Target legal before | Δ target legal | Δ target legal, % | Δ target live attach pts | covered | killed |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")
    d = df[df.role != "self"].copy()
    d["d_rel"] = 100 * d.d_legal / d.legal_before.clip(lower=1)
    for role in ["next", "opposite", "previous"]:
        for (me, te), g in d[d.role == role].groupby(["mover_engine", "target_engine"]):
            for label, lo, hi in PH:
                p = phase(g, lo, hi)
                if len(p) == 0:
                    continue
                print(f"| {role} | {me} → {te} | {label} | {len(p)} | {p.legal_before.mean():.1f} | {ci(p, 'd_legal')} | {ci(p, 'd_rel')} | "
                      f"{ci(p, 'd_live')} | {ci(p, 'covered')} | {ci(p, 'killed')} |")


def self_rows(df, name):
    print(f"\n### {name}: the mover's own gain, and what the very next placement does to its new attach points\n")
    print("| Mover | Next placement by (engine:seats after mover) | Phase | Moves | Own legal before | Δ own legal | Δ own live | new live attach pts | reply covers | reply kills | share of new lost |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    d = df[(df.role == "self") & df.replier.notna()].copy()
    d["lost"] = (d.reply_covered + d.reply_killed) / d.new_live.clip(lower=1)
    for (me, rp), g in d.groupby(["mover_engine", "replier"]):
        if not rp.endswith(":1"):
            continue
        for label, lo, hi in PH:
            p = phase(g, lo, hi)
            if len(p) == 0:
                continue
            print(f"| {me} | {rp} | {label} | {len(p)} | {p.legal_before.mean():.1f} | {ci(p, 'd_legal')} | {ci(p, 'd_live')} | {ci(p, 'new_live')} | "
                  f"{ci(p, 'reply_covered')} | {ci(p, 'reply_killed')} | {100 * p.lost.mean():.1f}% |")


def main():
    for path in sys.argv[1:]:
        df = pd.read_csv(path, dtype={"replier": "string"})
        name = path.split("/")[-1].replace(".csv", "")
        interaction(df, name)
        self_rows(df, name)


if __name__ == "__main__":
    main()
