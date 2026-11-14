"""Read-out for engine-rs/scripts/screen-chain.sh (N11 prior re-fit screen; S5 config screen).

    python3 engine-rs/scripts/chain_report.py ROOT --screen     # screen table (screen/<P>s-<ARM>)
    python3 engine-rs/scripts/chain_report.py ROOT --select     # selection rule -> stdout: arm or nothing
    python3 engine-rs/scripts/chain_report.py ROOT --cost-ratio ARM   # clean ms/move ratio ARM / base (own moves 3+)
    python3 engine-rs/scripts/chain_report.py ROOT --confirm    # confirmation table + verdict
    python3 engine-rs/scripts/chain_report.py ROOT --bench      # level-7 benchmark table (bench/<P>b-<ARM>)

ROOT holds PREFIX (label prefix), ARMS (screen arms), manifest.json ({arm: change}), configs/.

Rules (preregistered; the same for N11 and S5):
- Screen: an arm clears if its paired advantage difference against base (same seeds, by seed, 95%
  percentile bootstrap) has a lower bound above 0. The paired first-place difference is reported for
  every arm, not a gate. Selected: the cleared arm with the largest point estimate; none -> no
  confirmation (a null).
- Cost: clean-run ms/move, own moves 3+, arm / base (cost/cost.csv, measured in the chain after the
  screen, nothing else of ours running). Above 1.25 an equal-time arm `<ARM>-ET`
  (search.iterationScale divided by the ratio) plays the confirmation seeds alongside.
- Confirmation: base, the selected arm (and its -ET arm) on fresh seeds, started together. Accepted if
  the paired advantage lower bound is above 0 and the paired first-place interval does not lie
  entirely below 0; with cost > 1.25 the equal-time arm must also have a lower bound above 0 and is the
  config saved. Otherwise not accepted.
"""
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from s4_report import arm_rows, table  # noqa: E402

MAX_COST = 1.25


def setting(root, name, default=""):
    p = os.path.join(root, name)
    return open(p).read().strip() if os.path.exists(p) else default


def changes(root):
    p = os.path.join(root, "manifest.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def screen_rows(root):
    prefix = setting(root, "PREFIX")
    stem = lambda a: os.path.join(root, "screen", f"{prefix}s-{a}")
    return list(arm_rows(stem, setting(root, "ARMS").split(), changes=changes(root)))


def select(root):
    rs = [r for r in screen_rows(root) if r["arm"] != "base"]
    cleared = [r for r in rs if r["paired"] and r["paired"][1] > 0]
    for r in rs:
        (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
        print(f"{r['arm']}: paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp "
              f"[{flo:+.2f}, {fhi:+.2f}] -> {'clears the screen' if r in cleared else 'does not clear'}", file=sys.stderr)
    if not cleared:
        print("selected: (none) -- no arm's paired CI lower bound is above 0", file=sys.stderr)
        return
    best = max(cleared, key=lambda r: r["paired"][0])
    print(f"selected: {best['arm']} (cleared, largest point estimate {best['paired'][0]:+.3f})", file=sys.stderr)
    print(best["arm"])


def cost_ratio(root, arm):
    names = open(os.path.join(root, "cost", "cost.names")).read().split()
    per = {}
    for r in csv.DictReader(open(os.path.join(root, "cost", "cost.csv"))):
        if int(r["own_idx"]) >= 3:
            per.setdefault(names[int(r["config"])], []).append(float(r["ms"]))
    mean = lambda v: sum(v) / len(v)
    return mean(per[arm]) / mean(per["base"])


def confirm(root):
    prefix = setting(root, "PREFIX")
    stem = lambda a: os.path.join(root, "confirm", f"{prefix}c-{a}")
    arms = setting(root, "CONFIRM_ARMS").split()
    rs = list(arm_rows(stem, arms, changes=changes(root)))
    print(table(rs))
    print()
    by = {r["arm"]: r for r in rs}
    main = [a for a in arms if a != "base" and not a.endswith("-ET")]
    if not main or main[0] not in by or not by[main[0]]["paired"]:
        print("VERDICT: incomplete")
        print("NEW BASE: (none)")
        return
    arm = main[0]
    r = by[arm]
    (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
    ratio = float(setting(root, f"COST_{arm}", "nan"))
    print(f"- {arm}: paired {dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}]; clean cost {ratio:.3f}x base")
    if dlo <= 0:
        print(f"VERDICT: NOT ACCEPTED ({arm}: paired lower bound not above 0)")
        print("NEW BASE: (none)")
        return
    saved = arm
    if ratio > MAX_COST:
        et = by.get(f"{arm}-ET")
        if not et or not et["paired"] or et["paired"][1] <= 0:
            print(f"VERDICT: accepted at equal iterations but NOT as base: cost {ratio:.2f}x > {MAX_COST} and the equal-time arm does not clear")
            print("NEW BASE: (none)")
            return
        saved = f"{arm}-ET"
        print(f"- {saved}: paired {et['paired'][0]:+.2f} [{et['paired'][1]:+.2f}, {et['paired'][2]:+.2f}]; first place "
              f"{et['paired_fp'][0]:+.2f} pp [{et['paired_fp'][1]:+.2f}, {et['paired_fp'][2]:+.2f}]")
        fhi = et["paired_fp"][2]
    if fhi < 0:
        print(f"VERDICT: advantage clears but the first-place interval lies entirely below 0: reported, not saved (Paul's decision)")
        print("NEW BASE: (none)")
        return
    print(f"VERDICT: ACCEPTED ({saved})")
    print(f"NEW BASE: {saved}")


def bench(root):
    prefix = setting(root, "PREFIX")
    stem = lambda a: os.path.join(root, "bench", f"{prefix}b-{a}")
    arms = setting(root, "BENCH_ARMS").split()
    print(table(list(arm_rows(stem, arms, changes=changes(root))), "L7"))


def main():
    root = sys.argv[1]
    a = sys.argv
    if "--screen" in a:
        print(table(screen_rows(root)))
    elif "--select" in a:
        select(root)
    elif "--cost-ratio" in a:
        print(f"{cost_ratio(root, a[a.index('--cost-ratio') + 1]):.4f}")
    elif "--confirm" in a:
        confirm(root)
    elif "--bench" in a:
        bench(root)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
