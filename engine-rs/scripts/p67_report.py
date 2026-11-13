"""P6/P7 read-out (tables built with s2_report.rows/table: advantage vs the three Pentobi level-6 seats,
first place, seed-paired difference against base with a 95% percentile bootstrap over seeds, in-match
ms/move and games differing from base).

    python3 engine-rs/scripts/p67_report.py tmp/p67              # screen (screen/p67s-<ARM>)
    python3 engine-rs/scripts/p67_report.py tmp/p67 --live       # liveness (live/p67-live-<ARM>)
    python3 engine-rs/scripts/p67_report.py tmp/p67 --select     # selection rule -> stdout, one line per arm
    python3 engine-rs/scripts/p67_report.py tmp/p67 --cost-ratio ARM   # clean-run ms/move ratio ARM / base
    python3 engine-rs/scripts/p67_report.py tmp/p67 --confirm    # confirmation (confirm/p67c-<ARM>) + verdict
    python3 engine-rs/scripts/p67_report.py tmp/p67 --cost       # clean cost table(s)

Rules (preregistered, research_paper/v6_native_and_learning_preregistered.md, 2026-11-13 "P6/P7"):
- An arm clears the screen if its paired difference against base has a 95% CI lower bound > 0.
- Confirmed set: the cleared arm with the largest point estimate. If cleared *single-mechanism* arms
  (one of RAVE, LGR, P3) cover two or more mechanisms, also (a) the combination of the best cleared
  arm of each such mechanism (an existing screen arm if one has exactly those blocks, else a new
  config `C-<A>+<B>`) and (b) the best cleared single-mechanism arm, each if not already in the set.
  `--select` prints `ARM` or `COMBO <name> <part> <part>...` lines.
- Cost: clean-run ms/move, own moves 3+, arm / base (cost/cost.csv, or cost/cost-confirm.csv for
  arms first costed at confirmation).
- Confirmation: an arm is accepted at equal iterations if its paired CI lower bound is > 0. It can
  become the new base only if its clean cost ratio is <= 1.25, or if its equal-time arm `<ARM>-ET`
  (iterationScale 16 / ratio, same seeds) also has a paired lower bound > 0 (the equal-time config is
  then the one saved). Among several eligible arms, the largest confirmation point estimate wins.
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
    return open(path).read().split() if os.path.exists(path) else []


def manifest(root):
    return {m["arm"]: m for m in json.load(open(os.path.join(root, "configs", "manifest.json")))}


def cost_ms(root):
    """{arm: [ms at own moves 3+]} over every clean cost file present."""
    ms = {}
    for stem in ("cost", "cost-confirm"):
        path = os.path.join(root, "cost", f"{stem}.csv")
        names_path = os.path.join(root, "cost", f"{stem}.names")
        if not os.path.exists(path):
            continue
        names = open(names_path).read().split()
        per = {}
        for r in csv.DictReader(open(path)):
            if int(r["own_idx"]) >= 3:
                per.setdefault(names[int(r["config"])], []).append(float(r["ms"]))
        # Ratios are taken within one run: store each arm's mean relative to that run's base.
        mean = lambda v: sum(v) / len(v)
        for arm, v in per.items():
            ms.setdefault(arm, mean(v) / mean(per["base"]))
    return ms


def clean_ratio(root, arm):
    ratios = cost_ms(root)
    if arm.endswith("-ET"):
        return float("nan")
    return ratios[arm]


def with_arms(root, arms_name, fn):
    import s2_report
    original = s2_report.arms_of
    s2_report.arms_of = lambda r: ["base"] + [a for a in arms_file(root, arms_name) if a != "base"]
    try:
        return fn()
    finally:
        s2_report.arms_of = original


def select(root):
    screen = lambda a: os.path.join(root, "screen", f"p67s-{a}")
    man = manifest(root)
    rs = [r for r in with_arms(root, "ARMS", lambda: list(rows(root, screen))) if r["arm"] != "base"]
    cleared = [r for r in rs if r["paired"] and r["paired"][1] > 0]
    for r in rs:
        dm, dlo, dhi = r["paired"] if r["paired"] else (float("nan"),) * 3
        print(f"{r['arm']}: paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r.get('paired_n', 0)} seeds -> "
              f"{'clears the screen' if r in cleared else 'does not clear'}", file=sys.stderr)
    out = []
    if not cleared:
        print("selected: (none) -- no arm's paired CI lower bound is above 0", file=sys.stderr)
        return out
    point = lambda r: r["paired"][0]
    best = max(cleared, key=point)
    out.append(best["arm"])
    print(f"selected: {best['arm']} (cleared, largest point estimate {point(best):+.3f})", file=sys.stderr)
    single = [r for r in cleared if len(man[r["arm"]]["mechanisms"]) == 1]
    by_mech = {}
    for r in sorted(single, key=point, reverse=True):
        by_mech.setdefault(man[r["arm"]]["mechanisms"][0], r)
    if len(by_mech) >= 2:
        parts = [by_mech[m]["arm"] for m in sorted(by_mech)]
        merged = {}
        for p in parts:
            merged.update(man[p]["diff"])
        same = [a for a, m in man.items() if m["diff"] == merged and not a.endswith("-ET")]
        if same:
            name = same[0]
            if name not in out:
                out.append(name)
            print(f"two or more mechanisms cleared ({', '.join(sorted(by_mech))}): combination = existing arm {name}", file=sys.stderr)
        else:
            name = "C-" + "+".join(parts)
            out.append(("COMBO", name, parts))
            print(f"two or more mechanisms cleared ({', '.join(sorted(by_mech))}): combination {name} built from {parts}", file=sys.stderr)
        best_single = max(single, key=point)
        if best_single["arm"] not in out:
            out.append(best_single["arm"])
            print(f"best cleared single-mechanism arm also confirmed: {best_single['arm']}", file=sys.stderr)
    return out


def confirm(root):
    conf = lambda a: os.path.join(root, "confirm", f"p67c-{a}")
    rs = with_arms(root, "CONFIRM_ARMS", lambda: list(rows(root, conf)))
    print(table(rs))
    print()
    by = {r["arm"]: r for r in rs}
    eligible = []
    for r in rs:
        arm = r["arm"]
        if arm == "base" or arm.endswith("-ET") or not r["paired"]:
            continue
        lo = r["paired"][1]
        ratio = clean_ratio(root, arm)
        q = "ACCEPTED at equal iterations (lower bound > 0)" if lo > 0 else "not accepted (lower bound <= 0)"
        line = f"- {arm}: paired {r['paired'][0]:+.2f} [{lo:+.2f}, {r['paired'][2]:+.2f}] -> {q}; clean cost {ratio:.2f}x base"
        if lo > 0:
            if ratio <= MAX_COST:
                eligible.append((r["paired"][0], arm))
                line += " <= 1.25: eligible as the new base"
            else:
                et = by.get(f"{arm}-ET")
                if et and et["paired"] and et["paired"][1] > 0:
                    eligible.append((r["paired"][0], f"{arm}-ET"))
                    line += f" > 1.25; equal-time arm {et['paired'][0]:+.2f} [{et['paired'][1]:+.2f}, {et['paired'][2]:+.2f}] HOLDS: {arm}-ET eligible"
                else:
                    etxt = f"{et['paired'][0]:+.2f} [{et['paired'][1]:+.2f}, {et['paired'][2]:+.2f}]" if et and et["paired"] else "missing"
                    line += f" > 1.25; equal-time arm {etxt} does not hold: not eligible"
        print(line)
    winner = max(eligible)[1] if eligible else None
    print(f"NEW BASE: {winner or '(none)'}")
    return winner


def main():
    root = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "tmp/p67"
    if "--live" in sys.argv:
        live = lambda a: os.path.join(root, "live", f"p67-live-{a}")
        print(with_arms(root, "ARMS_LIVE", lambda: table(list(rows(root, live)))))
    elif "--cost-ratio" in sys.argv:
        print(f"{clean_ratio(root, sys.argv[sys.argv.index('--cost-ratio') + 1]):.3f}")
    elif "--select" in sys.argv:
        for x in select(root):
            print(x if isinstance(x, str) else " ".join([x[0], x[1], *x[2]]))
    elif "--confirm" in sys.argv:
        confirm(root)
    elif "--cost" in sys.argv:
        for arm, ratio in sorted(cost_ms(root).items(), key=lambda kv: kv[1]):
            print(f"{arm}: {ratio:.3f}x base (ms/move, own moves 3+)")
    else:
        screen = lambda a: os.path.join(root, "screen", f"p67s-{a}")
        print(with_arms(root, "ARMS", lambda: table(list(rows(root, screen)))))


if __name__ == "__main__":
    main()
