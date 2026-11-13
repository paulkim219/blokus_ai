"""P1–P3 read-out (tables built with s2_report.rows/table: advantage vs the three Pentobi level-6
seats, first place, seed-paired difference against base with a 95% percentile bootstrap over seeds,
in-match ms/move and games differing from base).

    python3 engine-rs/scripts/p13_report.py tmp/p13              # screen (screen/p13s-<ARM>)
    python3 engine-rs/scripts/p13_report.py tmp/p13 --live       # liveness (live/p13-live-<ARM>)
    python3 engine-rs/scripts/p13_report.py tmp/p13 --select     # selection rule -> stdout (one arm or nothing)
    python3 engine-rs/scripts/p13_report.py tmp/p13 --cost-ratio ARM   # clean-run ms/move ratio ARM / base
    python3 engine-rs/scripts/p13_report.py tmp/p13 --confirm    # confirmation (confirm/p13c-<ARM>) + verdict

Rules (preregistered, research_paper/v6_native_and_learning_preregistered.md, "P1–P3"):
- selection: among screen arms whose paired Δ vs base has a 95% CI lower bound > 0, the one with the
  largest point estimate (none if no arm clears);
- cost: ms/move from the clean cost run (`p13-run.sh cost`, all own moves 3+), arm / base;
- confirmation: the selected arm is accepted at equal iterations if its paired CI lower bound is > 0.
  If its clean cost ratio is > 1.25, the equal-time arm `<ARM>-ET` (iterationScale 16 / ratio) is also
  played on the confirmation seeds, and only if *its* paired CI lower bound is > 0 does the arm become
  the new base config (as `<ARM>-ET`).
"""
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from s2_report import rows, table  # noqa: E402

MAX_COST = 1.25


def arms_file(root, name):
    path = os.path.join(root, name)
    arms = open(path).read().split() if os.path.exists(path) else []
    return arms


def clean_ratio(root, arm):
    path = os.path.join(root, "cost", "cost.csv")
    names = ["base", "ID", "P1S", "P1L", "P1X", "P3A", "P3B", "P1LP3B"]
    ms = {}
    for r in csv.DictReader(open(path)):
        if int(r["own_idx"]) >= 3:
            ms.setdefault(names[int(r["config"])], []).append(float(r["ms"]))
    mean = lambda v: sum(v) / len(v)
    return mean(ms[arm]) / mean(ms["base"])


def with_arms(root, arms_name, fn):
    # s2_report.rows reads <root>/ARMS; point it at the right arm list for this table.
    import s2_report
    original = s2_report.arms_of
    s2_report.arms_of = lambda r: ["base"] + [a for a in arms_file(root, arms_name) if a != "base"]
    try:
        return fn()
    finally:
        s2_report.arms_of = original


def main():
    root = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "tmp/p13"
    screen = lambda a: os.path.join(root, "screen", f"p13s-{a}")
    if "--live" in sys.argv:
        live = lambda a: os.path.join(root, "live", f"p13-live-{a}")
        print(with_arms(root, "ARMS_LIVE", lambda: table(list(rows(root, live)))))
    elif "--cost-ratio" in sys.argv:
        print(f"{clean_ratio(root, sys.argv[sys.argv.index('--cost-ratio') + 1]):.3f}")
    elif "--select" in sys.argv:
        rs = [r for r in with_arms(root, "ARMS", lambda: list(rows(root, screen))) if r["arm"] != "base"]
        passed = [r for r in rs if r["paired"] and r["paired"][1] > 0]
        for r in rs:
            dm, dlo, dhi = r["paired"] if r["paired"] else (float("nan"),) * 3
            print(f"{r['arm']}: paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r.get('paired_n', 0)} seeds -> "
                  f"{'clears the screen' if r in passed else 'does not clear'}", file=sys.stderr)
        chosen = sorted(passed, key=lambda r: -r["paired"][0])[:1]
        print(f"selected (CI lower bound > 0, best point estimate): {' '.join(r['arm'] for r in chosen) or '(none)'}", file=sys.stderr)
        for r in chosen:
            print(r["arm"])
    elif "--confirm" in sys.argv:
        conf = lambda a: os.path.join(root, "confirm", f"p13c-{a}")
        rs = with_arms(root, "CONFIRM_ARMS", lambda: list(rows(root, conf)))
        print(table(rs))
        print()
        for r in rs:
            if r["arm"] == "base" or not r["paired"]:
                continue
            arm = r["arm"]
            lo = r["paired"][1]
            if arm.endswith("-ET"):
                print(f"- {arm} (equal time): paired lower bound {lo:+.2f} -> {'HOLDS at equal time' if lo > 0 else 'does not hold at equal time'}")
            else:
                ratio = clean_ratio(root, arm)
                q = "passes (lower bound > 0)" if lo > 0 else "fails (lower bound <= 0)"
                c = f"clean cost {ratio:.2f}× base" + (" > 1.25: equal-time arm decides" if ratio > MAX_COST else " <= 1.25")
                print(f"- {arm} (equal iterations): {q}; {c}")
    else:
        print(with_arms(root, "ARMS", lambda: table(list(rows(root, screen)))))


if __name__ == "__main__":
    main()
