"""P4/P5 read-out: per arm, advantage vs the three Pentobi level-6 seats, first place, the seed-paired
difference against `base`, Blokee ms/move (and its ratio to base), and how many games differ from
base move for move. Same statistic as engine-rs/scripts/s1_report.py (ml/seat/paired_report.py).

    python3 engine-rs/scripts/p4_report.py tmp/p4              # screen (screen/p4s-<ARM>.jsonl)
    python3 engine-rs/scripts/p4_report.py tmp/p4 --live       # liveness (live/p4-live-<ARM>)
    python3 engine-rs/scripts/p4_report.py tmp/p4 --confirm    # confirmation (confirm/p4c-<ARM>)

ms/move from <label>.timing.jsonl (`blokeeMs`): "all" over every Blokee decision with a legal move,
"3+" over a seat's own moves 3 and later (the searched moves; 0–2 use the opening heuristic).
`npx tsx scripts/aggregateMatches.ts` output in <dir>/summary.txt stays the reference read-out.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from paired_report import bootstrap, load  # noqa: E402


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
    return mean(all_ms), mean(late_ms)


def moves_by_game(path):
    return {(m["seed"], m["seat"]): m["moves"] for m in lines(path)}


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "tmp/p4"
    if "--live" in sys.argv:
        stem = lambda a: os.path.join(root, "live", f"p4-live-{a}")
    elif "--confirm" in sys.argv:
        stem = lambda a: os.path.join(root, "confirm", f"p4c-{a}")
    else:
        stem = lambda a: os.path.join(root, "screen", f"p4s-{a}")
    manifest = json.load(open(os.path.join(root, "configs", "manifest.json")))
    base_adv = load(stem("base") + ".jsonl") if os.path.exists(stem("base") + ".jsonl") else {}
    base_moves = moves_by_game(stem("base") + ".moves.jsonl")
    _, base_late = timing(stem("base") + ".timing.jsonl")

    print("| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) | Games ≠ base |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for m in manifest:
        arm = m["arm"]
        path = stem(arm) + ".jsonl"
        if not os.path.exists(path):
            continue
        adv = load(path)
        if not adv:
            continue
        mean, lo, hi = bootstrap(list(adv.values()))
        seeds = [s for s in adv if s in base_adv]
        if arm != "base" and seeds:
            dm, dlo, dhi = bootstrap([adv[s] - base_adv[s] for s in seeds])
            paired = f"{dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}]" + (" *" if dlo > 1e-6 or dhi < -1e-6 else "")
        else:
            paired = "—"
        t_all, t_late = timing(stem(arm) + ".timing.jsonl")
        ratio = t_late / base_late if base_late == base_late and base_late > 0 else float("nan")
        mv = moves_by_game(stem(arm) + ".moves.jsonl")
        common = [k for k in mv if k in base_moves]
        differ = sum(mv[k] != base_moves[k] for k in common)
        print(f"| {arm} | {m['change']} | {len(adv)} | {mean:+.2f} [{lo:+.2f}, {hi:+.2f}] | {first_place(path) * 100:.1f}% | {paired} "
              f"| {t_all:.1f} | {t_late:.1f} | {ratio:.2f} | {differ}/{len(common)} |")


if __name__ == "__main__":
    main()
