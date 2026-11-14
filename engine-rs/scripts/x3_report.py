"""X3 read-out (descriptive, no gate): every arm's advantage with a 95% bootstrap by seed, first-place
share, the seed-paired advantage and first-place differences where a control exists (helpers of
p910_report.py / ml/seat/paired_report.py), and ms/move for both engines from <label>.timing.jsonl.

    python3 engine-rs/scripts/x3_report.py tmp/x3

Advantage and first place are the lone seat's: Blokee's in the one-blokee arms, Pentobi's in x3-rev.
ms/move: "all" over every decision with a legal move; "3+" over a seat's own moves 3 and later (Blokee
plays 0-2 from the opening heuristic, Pentobi mostly from its book). Start/end times and load
averages per arm come from arms.tsv (written by x3-run.sh); arms run one after another.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from p910_report import bootstrap, fmt_ci, load, paired_lines  # noqa: E402
from p4_report import first_place, lines  # noqa: E402

ARMS = [  # label, block, opponent, lone engine, config
    ("x3-l5-p4i", "level 5", "3 x Pentobi L5", "blokee", "v5.0-p4i-ultra"),
    ("x3-l5-p4", "level 5", "3 x Pentobi L5", "blokee", "v5.0-p4-ultra (control)"),
    ("x3-l7-p4i", "level 7", "3 x Pentobi L7", "blokee", "v5.0-p4i-ultra"),
    ("x3-l7-p4", "level 7", "3 x Pentobi L7", "blokee", "v5.0-p4-ultra (control)"),
    ("x3-rev", "reverse", "1 x Pentobi L6 vs 3 x v5.0-p4i-ultra", "pentobi", "v5.0-p4i-ultra (field)"),
    ("x3-c-et", "compute", "3 x Pentobi L6", "blokee", "v5.0-p4i-ultra as saved (iterationScale 10.383)"),
    ("x3-c-is16", "compute", "3 x Pentobi L6", "blokee", "iterationScale 16 (equal iterations)"),
    ("x3-c-is32", "compute", "3 x Pentobi L6", "blokee", "iterationScale 32"),
]
PAIRS = [("x3-l5-p4i", "x3-l5-p4"), ("x3-l7-p4i", "x3-l7-p4"),
         ("x3-c-is16", "x3-c-et"), ("x3-c-is32", "x3-c-et"), ("x3-c-is32", "x3-c-is16")]


def ms(path, lone):
    """(blokee all, blokee 3+, pentobi all, pentobi 3+) mean ms/move."""
    acc = {k: [] for k in ("b", "b3", "p", "p3")}
    for t in lines(path):
        for color, v in t["msBySeat"].items():
            is_lone = color == t["seat"]
            eng = lone if is_lone else ("pentobi" if lone == "blokee" else "blokee")
            k = "b" if eng == "blokee" else "p"
            acc[k] += v
            acc[k + "3"] += v[3:]
    mean = lambda v: sum(v) / len(v) if v else float("nan")
    return tuple(mean(acc[k]) for k in ("b", "b3", "p", "p3"))


def windows(root):
    w = {}
    path = os.path.join(root, "arms.tsv")
    if os.path.exists(path):
        for line in open(path):
            label, what, when, ld = (line.rstrip("\n").split("\t") + [""] * 4)[:4]
            w.setdefault(label, {})[what] = (when, ld)
    return w


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "tmp/x3"
    win = windows(root)
    print("| Arm | Block | Lone seat / field | Seeds | Advantage of the lone seat [95% CI] | First place | "
          "Blokee ms/move all / 3+ | Pentobi ms/move all / 3+ | Ran | Load start → end | Failures |")
    print("|---|---|---|---:|---:|---:|---:|---:|---|---|---:|")
    for label, block, opp, lone, cfg in ARMS:
        path = os.path.join(root, f"{label}.jsonl")
        if not os.path.exists(path):
            continue
        adv = load(path)
        if not adv:
            continue
        m, lo, hi = bootstrap(list(adv.values()))
        b, b3, p, p3 = ms(os.path.join(root, f"{label}.timing.jsonl"), lone)
        fpath = os.path.join(root, f"{label}.failures.jsonl")
        fails = sum(1 for _ in open(fpath)) if os.path.exists(fpath) else 0
        w = win.get(label, {})
        ran = f"{w.get('start', ('?',))[0][11:16]}–{w.get('end', ('…',))[0][11:16]}"
        loads = f"{w.get('start', ('', '?'))[1].split(' ')[0]} → {w.get('end', ('', '…'))[1].split(' ')[0]}"
        who = ("Pentobi L6 (lone) vs " if lone == "pentobi" else "") + cfg
        print(f"| {label} | {block} | {who} | {len(adv)} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {first_place(path) * 100:.1f}% | "
              f"{b:.1f} / {b3:.1f} | {p:.1f} / {p3:.1f} | {ran} | {loads} | {fails} |")
    print()
    print("| Paired (same seeds) | Seeds | Δ advantage [95% CI] | Δ first place, pp [95% CI] |")
    print("|---|---:|---:|---:|")
    for a, c in PAIRS:
        pa, pc = (os.path.join(root, f"{x}.jsonl") for x in (a, c))
        if not (os.path.exists(pa) and os.path.exists(pc)):
            continue
        adv, fp, n = paired_lines(pa, pc)
        if n:
            print(f"| {a} − {c} | {n} | {fmt_ci(adv)} | {fmt_ci(fp)} |")


if __name__ == "__main__":
    main()
