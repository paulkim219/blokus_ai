"""S2 read-out: per arm, advantage vs the three Pentobi level-6 seats, first place, the seed-paired
difference against `base` (95% percentile bootstrap over seeds, ml/seat/paired_report.py), Blokee
ms/move and its ratio to base, and how many games differ from base move for move.

    python3 engine-rs/scripts/s2_report.py tmp/s2              # screen (screen/s2s-<ARM>)
    python3 engine-rs/scripts/s2_report.py tmp/s2 --live       # liveness (live/s2-live-<ARM>)
    python3 engine-rs/scripts/s2_report.py tmp/s2 --confirm    # confirmation (confirm/s2c-<ARM>) + verdict
    python3 engine-rs/scripts/s2_report.py tmp/s2 --select     # selection rule on the screen -> stdout

Arms are those in <dir>/ARMS (fixed before the screen), base first. Selection rule (preregistered):
every arm whose screen paired Δ has a CI lower bound > 0, at most the two best by point estimate;
prints the chosen arms one per line (nothing if none) and the reasoning to stderr. Confirmation
verdict: confirmed iff the paired CI lower bound > 0 AND ms/move (own moves 3+) ≤ 1.25× base.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from paired_report import bootstrap, load  # noqa: E402
from p4_report import first_place, moves_by_game, timing  # noqa: E402

MAX_SELECTED = 2
MAX_COST = 1.25


def arms_of(root):
    path = os.path.join(root, "ARMS")
    arms = open(path).read().split() if os.path.exists(path) else []
    return ["base"] + [a for a in arms if a != "base"]


def rows(root, stem):
    manifest = {m["arm"]: m["change"] for m in json.load(open(os.path.join(root, "configs", "manifest.json")))}
    base_adv = load(stem("base") + ".jsonl") if os.path.exists(stem("base") + ".jsonl") else {}
    base_moves = moves_by_game(stem("base") + ".moves.jsonl")
    _, base_late = timing(stem("base") + ".timing.jsonl")
    for arm in arms_of(root):
        path = stem(arm) + ".jsonl"
        if not os.path.exists(path):
            continue
        adv = load(path)
        if not adv:
            continue
        r = {"arm": arm, "change": manifest.get(arm, ""), "seeds": len(adv), "adv": bootstrap(list(adv.values())),
             "fp": first_place(path), "paired": None}
        seeds = [s for s in adv if s in base_adv]
        if arm != "base" and seeds:
            r["paired"] = bootstrap([adv[s] - base_adv[s] for s in seeds])
            r["paired_n"] = len(seeds)
        r["t_all"], r["t_late"] = timing(stem(arm) + ".timing.jsonl")
        r["ratio"] = r["t_late"] / base_late if base_late == base_late and base_late > 0 else float("nan")
        mv = moves_by_game(stem(arm) + ".moves.jsonl")
        common = [k for k in mv if k in base_moves]
        r["differ"] = (sum(mv[k] != base_moves[k] for k in common), len(common))
        yield r


def table(rs, verdict=False):
    head = "| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) | Games ≠ base |"
    sep = "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"
    if verdict:
        head += " Verdict |"
        sep += "---|"
    out = [head, sep]
    for r in rs:
        m, lo, hi = r["adv"]
        if r["paired"]:
            dm, dlo, dhi = r["paired"]
            paired = f"{dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}]" + (" *" if dlo > 1e-6 or dhi < -1e-6 else "")
        else:
            paired = "—"
        line = (f"| {r['arm']} | {r['change']} | {r['seeds']} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {r['fp'] * 100:.1f}% | {paired} "
                f"| {r['t_all']:.1f} | {r['t_late']:.1f} | {r['ratio']:.2f} | {r['differ'][0]}/{r['differ'][1]} |")
        if verdict:
            if r["arm"] == "base":
                v = "—"
            elif not r["paired"]:
                v = "no data"
            else:
                ok_q, ok_t = r["paired"][1] > 0, r["ratio"] <= MAX_COST
                v = "**confirmed**" if ok_q and ok_t else "not confirmed (" + ", ".join(
                    x for x, bad in (("CI lower bound ≤ 0", not ok_q), (f"ms/move > {MAX_COST}× base", not ok_t)) if bad) + ")"
            line += f" {v} |"
        out.append(line)
    return "\n".join(out)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "tmp/s2"
    if "--live" in sys.argv:
        print(table(rows(root, lambda a: os.path.join(root, "live", f"s2-live-{a}"))))
    elif "--confirm" in sys.argv:
        print(table(rows(root, lambda a: os.path.join(root, "confirm", f"s2c-{a}")), verdict=True))
    elif "--select" in sys.argv:
        rs = [r for r in rows(root, lambda a: os.path.join(root, "screen", f"s2s-{a}")) if r["arm"] != "base"]
        passed = [r for r in rs if r["paired"] and r["paired"][1] > 0]
        for r in rs:
            dm, dlo, dhi = r["paired"] if r["paired"] else (float("nan"),) * 3
            print(f"{r['arm']}: paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r.get('paired_n', 0)} seeds -> "
                  f"{'clears the screen' if r in passed else 'does not clear'}", file=sys.stderr)
        chosen = sorted(passed, key=lambda r: -r["paired"][0])[:MAX_SELECTED]
        print(f"selected (CI lower bound > 0, at most {MAX_SELECTED} best by point estimate): "
              f"{' '.join(r['arm'] for r in chosen) or '(none)'}", file=sys.stderr)
        for r in chosen:
            print(r["arm"])
    else:
        print(table(rows(root, lambda a: os.path.join(root, "screen", f"s2s-{a}"))))


if __name__ == "__main__":
    main()
