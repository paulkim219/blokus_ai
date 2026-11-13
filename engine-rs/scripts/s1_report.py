"""S1 read-out: per arm, advantage vs the three Pentobi level-6 seats, first place, the seed-paired
difference against `base`, Blokee ms/move, and how many games differ from base move for move.

    python3 engine-rs/scripts/s1_report.py tmp/s1            # main block (s1-<ARM>.jsonl)
    python3 engine-rs/scripts/s1_report.py tmp/s1 --live     # liveness block (live/s1-live-<ARM>)

Advantage and the paired Δ use ml/seat/paired_report.py (per seed: mean over the four seat
rotations of challenger score − mean of the other three; percentile bootstrap over seeds with the
same generator, seed and resamples as scripts/lib/stats.ts `bootstrapCI`). Each arm's own line is
also printed by `npx tsx scripts/aggregateMatches.ts` in <dir>/summary.txt, which stays the
reference read-out. ms/move comes from <label>.timing.jsonl (`blokeeMs`, one entry per Blokee
decision that had a legal move): "all" over every decision, "3+" over a seat's own moves 3 and
later (the moves `v4.2-ultra` searches; moves 0–2 use the opening heuristic and take ~0 ms).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from paired_report import bootstrap, load  # noqa: E402

ARMS = ["base", "W96", "W400", "W400open", "N96", "O0", "C0", "R0", "R100", "MAXN", "B4", "E30", "A140"]


def lines(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def first_place(path):
    games = lines(path)
    return sum(g["seat"] in g["winner"] for g in games) / len(games) if games else float("nan")


def timing(path):
    all_ms, late_ms = [], []
    for t in lines(path):
        ms = t["blokeeMs"]
        all_ms += ms
        late_ms += ms[3:]
    mean = lambda v: sum(v) / len(v) if v else float("nan")
    return mean(all_ms), mean(late_ms), len(all_ms)


def moves_by_game(path):
    return {(m["seed"], m["seat"]): m["moves"] for m in lines(path)}


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "tmp/s1"
    live = "--live" in sys.argv
    stem = (lambda a: os.path.join(root, "live", f"s1-live-{a}")) if live else (lambda a: os.path.join(root, f"s1-{a}"))
    manifest = {m["arm"]: m["change"] for m in json.load(open(os.path.join(root, "configs", "manifest.json")))}
    base_adv = load(stem("base") + ".jsonl") if os.path.exists(stem("base") + ".jsonl") else {}
    base_moves = moves_by_game(stem("base") + ".moves.jsonl")
    _, base_late, _ = timing(stem("base") + ".timing.jsonl")

    header = "| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) | Games ≠ base |"
    print(header)
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for arm in ARMS:
        path = stem(arm) + ".jsonl"
        if not os.path.exists(path):
            continue
        adv = load(path)
        if not adv:
            continue
        m, lo, hi = bootstrap(list(adv.values()))
        fp = first_place(path)
        seeds = [s for s in adv if s in base_adv]
        if arm != "base" and seeds:
            dm, dlo, dhi = bootstrap([adv[s] - base_adv[s] for s in seeds])
            paired = f"{dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}]" + (" *" if dlo > 1e-6 or dhi < -1e-6 else "")
        else:
            paired = "—"
        t_all, t_late, n_moves = timing(stem(arm) + ".timing.jsonl")
        ratio = t_late / base_late if base_late == base_late and base_late > 0 else float("nan")
        mv = moves_by_game(stem(arm) + ".moves.jsonl")
        common = [k for k in mv if k in base_moves]
        differ = sum(mv[k] != base_moves[k] for k in common)
        print(f"| {arm} | {manifest.get(arm, '')} | {len(adv)} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {fp * 100:.1f}% | {paired} "
              f"| {t_all:.1f} | {t_late:.1f} | {ratio:.2f} | {differ}/{len(common)} |")


if __name__ == "__main__":
    main()
