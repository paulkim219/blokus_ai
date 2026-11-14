"""S4 / N11 read-outs (speed work with identical output; prior re-fit matches).

    python3 engine-rs/scripts/s4_report.py --cost tmp/s4/cost             # old vs new binary, clean ms/move
    python3 engine-rs/scripts/s4_report.py --confirm tmp/s4                # re-timed base vs v5.0-p4i-ultra + verdict
    python3 engine-rs/scripts/s4_report.py --reuse tmp/s4/reuse/reuse.csv BUDGET   # Stage 2 (P8 re-measure)
    python3 engine-rs/scripts/s4_report.py --arms DIR PREFIX BASE ARM...   # any lone-seat arm table vs a base

Every arm table: advantage vs the three Pentobi seats [95% bootstrap by seed], first place (share of the
four rotations won, ties first), seed-paired advantage difference vs base and seed-paired first-place
difference (pp), both 95% percentile bootstraps over seeds (ml/seat/paired_report.bootstrap), in-match
ms/move (all, own moves 3+), games differing from base.

Confirmation rule (preregistered 2026-11-13, "S4"): the re-timed config is accepted as the new base if
its paired advantage CI lower bound vs v5.0-p4i-ultra (same seeds, same binary) is above 0 and its
paired first-place interval is not entirely below 0.
"""
import collections
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from paired_report import bootstrap, load  # noqa: E402
from p4_report import first_place, moves_by_game, timing  # noqa: E402
from p910_report import fmt_ci, paired_lines  # noqa: E402


def arm_rows(stem, arms, base="base", changes=None):
    base_path = stem(base) + ".jsonl"
    base_moves = moves_by_game(stem(base) + ".moves.jsonl")
    _, base_late = timing(stem(base) + ".timing.jsonl")
    for arm in [base] + [a for a in arms if a != base]:
        path = stem(arm) + ".jsonl"
        if not os.path.exists(path):
            continue
        adv = load(path)
        if not adv:
            continue
        r = {"arm": arm, "change": (changes or {}).get(arm, ""), "seeds": len(adv), "adv": bootstrap(list(adv.values())),
             "fp": first_place(path), "paired": None, "paired_fp": None}
        if arm != base:
            r["paired"], r["paired_fp"], r["paired_n"] = paired_lines(path, base_path)
        r["t_all"], r["t_late"] = timing(stem(arm) + ".timing.jsonl")
        r["ratio"] = r["t_late"] / base_late if base_late == base_late and base_late > 0 else float("nan")
        mv = moves_by_game(stem(arm) + ".moves.jsonl")
        common = [k for k in mv if k in base_moves]
        r["differ"] = (sum(mv[k] != base_moves[k] for k in common), len(common))
        yield r


def table(rs, opponent="L6"):
    out = [f"| Arm | Change | Seeds | Advantage vs {opponent} [95% CI] | First place | Paired Δ advantage vs base [95% CI] | "
           "Paired Δ first place, pp [95% CI] | ms/move all | ms/move 3+ | × base (3+, in-match) | Games ≠ base |",
           "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in rs:
        m, lo, hi = r["adv"]
        out.append(f"| {r['arm']} | {r['change']} | {r['seeds']} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {r['fp'] * 100:.1f}% | "
                   f"{fmt_ci(r['paired'])} | {fmt_ci(r['paired_fp'])} | {r['t_all']:.1f} | {r['t_late']:.1f} | {r['ratio']:.2f} | "
                   f"{r['differ'][0]}/{r['differ'][1]} |")
    return "\n".join(out)


def cost(d):
    """Old (bin-before) vs new binary, same positions, rounds alternating; ms/move over own moves 3+."""
    names = open(os.path.join(d, "names")).read().split()
    per = collections.defaultdict(list)  # (side, config) -> [round means]
    iters = collections.defaultdict(list)
    moves = {}
    for f in sorted(os.listdir(d)):
        if not (f.startswith("cost-before-") or f.startswith("cost-after-")) or not f.endswith(".csv"):
            continue
        side = "before" if "before" in f else "after"
        rows = list(csv.DictReader(open(os.path.join(d, f))))
        for k, name in enumerate(names):
            v = [r for r in rows if int(r["config"]) == k]
            per[(side, name)].append(sum(float(r["ms"]) for r in v) / len(v))
            iters[(side, name)].append(sum(int(r["iterations"]) for r in v) / len(v))
            moves.setdefault((side, name), []).append([(r["pos"], r["best"], r["iterations"]) for r in v])
    print("| Config | ms/move before (rounds) | ms/move after (rounds) | before mean | after mean | after / before | speed-up | iterations before / after | same moves and iterations |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|")
    for name in names:
        b, a = per[("before", name)], per[("after", name)]
        mb, ma = sum(b) / len(b), sum(a) / len(a)
        same = all(x == moves[("before", name)][0] for x in moves[("before", name)] + moves[("after", name)])
        print(f"| {name} | {' / '.join(f'{x:.1f}' for x in b)} | {' / '.join(f'{x:.1f}' for x in a)} | {mb:.1f} | {ma:.1f} | "
              f"{ma / mb:.3f} | {(mb / ma - 1) * 100:+.1f}% | {iters[('before', name)][0]:.0f} / {iters[('after', name)][0]:.0f} | {'yes' if same else 'NO'} |")


def confirm(root):
    stem = lambda a: os.path.join(root, "confirm", f"s4c-{a}")
    changes = {"base": "v5.0-p4i-ultra unchanged (new binary)", "S4T": "re-timed: iterationScale from S4 calibration"}
    rs = list(arm_rows(stem, ["S4T"], changes=changes))
    print(table(rs))
    print()
    t = [r for r in rs if r["arm"] == "S4T"]
    if not t or not t[0]["paired"]:
        print("VERDICT: incomplete")
        return
    r = t[0]
    (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
    ok_adv, ok_fp = dlo > 0, not (fhi < 0)
    print(f"- S4T: paired {dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}]")
    if ok_adv and ok_fp:
        print("VERDICT: ACCEPTED (lower bound > 0, first-place interval not entirely below 0) -> new base")
    elif ok_adv:
        print("VERDICT: NOT ACCEPTED as base: advantage clears but the first-place interval lies entirely below 0 (reported; Paul's decision)")
    else:
        print("VERDICT: NOT ACCEPTED (paired lower bound not above 0)")


def reuse(path, budget):
    """P8 re-measure: what the previous own decision's tree holds at the position actually reached."""
    rs = [r for r in csv.DictReader(open(path)) if r["source"] == "search" and r["prev_iterations"]]
    games = {(r["seed"], r["seat"]) for r in rs}
    rep = [r for r in rs if r["reproduced"] != "-1"]
    print(f"{len(games)} games, {len(rs)} searched decisions with a searched previous decision; "
          f"{sum(r['reproduced'] == '1' for r in rep)}/{len(rep)} (ply >= 8) reproduced the recorded move")
    print(f"| Own moves | Decisions | Prev. iterations | Depth 1 (own move) | Depth 2 | Depth 3 | Depth 4 = next own turn | share of the {budget:,} budget | "
          "share of prev. iterations | decisions with > 0 | max |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    f = lambda v: float(v) if v not in ("", None) else 0.0
    for band, lo, hi in [("4-8", 4, 9), ("9-14", 9, 15), ("15+", 15, 99), ("all", 4, 99)]:
        b = [r for r in rs if lo <= int(r["own_idx"]) < hi]
        if not b:
            continue
        m = lambda k: sum(f(r[k]) for r in b) / len(b)
        share = sum(f(r["reusable_visits"]) / f(r["prev_iterations"]) for r in b) / len(b)
        print(f"| {band} | {len(b)} | {m('prev_iterations'):.0f} | {m('visits_d1'):.0f} | {m('visits_d2'):.1f} | {m('visits_d3'):.2f} | "
              f"{m('reusable_visits'):.2f} | {m('reusable_visits') / budget * 100:.3f}% | {share * 100:.3f}% | "
              f"{sum(f(r['reusable_visits']) > 0 for r in b)} | {max(f(r['reusable_visits']) for r in b):.0f} |")


def main():
    a = sys.argv
    if "--cost" in a:
        cost(a[a.index("--cost") + 1])
    elif "--confirm" in a:
        confirm(a[a.index("--confirm") + 1])
    elif "--reuse" in a:
        i = a.index("--reuse")
        reuse(a[i + 1], int(a[i + 2]))
    elif "--arms" in a:
        i = a.index("--arms")
        d, prefix, base, arms = a[i + 1], a[i + 2], a[i + 3], a[i + 4:]
        opponent = "L7" if "--l7" in a else "L6"
        arms = [x for x in arms if not x.startswith("--")]
        print(table(list(arm_rows(lambda x: os.path.join(d, f"{prefix}-{x}"), arms, base=base)), opponent))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
