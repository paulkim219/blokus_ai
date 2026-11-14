"""Read-outs and the preregistered selection for the v5.1 candidate screen (2026-11-14, "v5.1 candidates"
entry in research_paper/v6_native_and_learning_preregistered.md).

    python3 engine-rs/scripts/v51_report.py --cost ROOT TAG      # clean cost table; merges ratios into ROOT/COSTS
    python3 engine-rs/scripts/v51_report.py --screen ROOT        # screen + compute-diagnostic tables
    python3 engine-rs/scripts/v51_report.py --select ROOT        # rule -> ROOT/plan.json, ET / combination configs
    python3 engine-rs/scripts/v51_report.py --finalize ROOT      # combination cost -> COMBO or COMBO-ET; CONFIRM_ARMS
    python3 engine-rs/scripts/v51_report.py --confirm ROOT       # confirmation table + verdicts + NEW BASE line
    python3 engine-rs/scripts/v51_report.py --stage3 ROOT        # level-7 benchmark and head-to-head tables

Screen logs ROOT/screen/v51s-<arm>.jsonl; diagnostics ROOT/diag/v51d-<arm>.jsonl (own base D-base);
confirmation ROOT/confirm/v51c-<arm>.jsonl. Rules (fixed in the prereg):
- An arm clears if its paired advantage difference vs base (same seeds, 95% percentile bootstrap by seed)
  has a lower bound above 0.
- Compute slope b (advantage per doubling of iterations) = (Δ(D-x2) − Δ(D-x05)) / 2, paired point
  estimates against D-base on the diagnostic block; b+ = max(b, 0).
- A clearing arm with clean cost c ≤ 1.10 competes with its screen point estimate Δ. A clearing arm with
  c > 1.10 is represented by <arm>-ET (iterationScale 13.528 / c) and competes with Δ − b+ · log2(c),
  only if that is above 0.
- The two competing arms with the largest (expected) point estimates are selected. If the clearing arms
  span two or more option groups (rave, reward, selection, other), a combination COMBO is also built from
  the best competing arm of each group (changes applied together); its clean cost is measured in the
  chain; if above 1.10 it is confirmed as COMBO-ET (iterationScale 13.528 / its cost).
- Confirmation (fresh seeds, fresh base arm): accepted if paired lower bound > 0 and the paired first-place
  interval is not entirely below 0 (every confirmed arm is at most 1.10x or an ET version). The accepted arm
  with the largest confirmation point estimate is saved as engine-rs/configs/v5.1-ultra.json.
"""
import copy
import csv
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from p910_report import fmt_ci, paired_lines  # noqa: E402
from s4_report import arm_rows  # noqa: E402

MAX_COST = 1.10
SCALE = 13.528
MISSING = object()


def jload(root, name, default=None):
    p = os.path.join(root, name)
    return json.load(open(p)) if os.path.exists(p) else default


def words(root, name):
    p = os.path.join(root, name)
    return open(p).read().split() if os.path.exists(p) else []


# ---------------------------------------------------------------- cost
def cost(root, tag):
    per = {}
    for r in (1, 2):
        names = open(os.path.join(root, "cost", f"{tag}-round{r}.names")).read().split()
        ms = {}
        for row in csv.DictReader(open(os.path.join(root, "cost", f"{tag}-round{r}.csv"))):
            if int(row["own_idx"]) >= 3:
                ms.setdefault(names[int(row["config"])], []).append(float(row["ms"]))
        mean = {n: sum(v) / len(v) for n, v in ms.items()}
        for n in names:
            per.setdefault(n, []).append((mean[n], mean[n] / mean["base"], len(ms[n])))
    costs = jload(root, "COSTS", {})
    print(f"| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for n, v in per.items():
        ratio = (v[0][1] + v[1][1]) / 2
        if n != "base":
            costs[n] = round(ratio, 4)
        print(f"| {n} | {v[0][2]} | {v[0][0]:.1f} | {v[1][0]:.1f} | {v[0][1]:.3f} | {v[1][1]:.3f} | {ratio:.3f} |")
    json.dump(costs, open(os.path.join(root, "COSTS"), "w"), indent=1)


# ---------------------------------------------------------------- tables
def table(rs, stem, costs, base="base"):
    out = ["| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | "
           "Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |",
           "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in rs:
        m, lo, hi = r["adv"]
        c = costs.get(r["arm"])
        out.append(f"| {r['arm']} | {r['change']} | {r['seeds']} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {r['fp'] * 100:.1f}% | "
                   f"{fmt_ci(r['paired'])} | {fmt_ci(r['paired_fp'])} | {'' if c is None else f'{c:.3f}'} | "
                   f"{r['t_late']:.1f} | {r['differ'][0]}/{r['differ'][1]} |")
    return "\n".join(out)


def screen_rows(root):
    stem = lambda a: os.path.join(root, "screen", f"v51s-{a}")
    return stem, list(arm_rows(stem, words(root, "ARMS"), changes=jload(root, "manifest.json", {})))


def diag_rows(root):
    stem = lambda a: os.path.join(root, "diag", f"v51d-{a}")
    darms = words(root, "DARMS")
    if not os.path.exists(stem("D-base") + ".jsonl"):
        return stem, []
    return stem, list(arm_rows(stem, darms, base="D-base", changes=jload(root, "manifest.json", {})))


def slope(root):
    _, rs = diag_rows(root)
    by = {r["arm"]: r for r in rs}
    if not (by.get("D-x2") and by.get("D-x05") and by["D-x2"]["paired"] and by["D-x05"]["paired"]):
        return None
    return (by["D-x2"]["paired"][0] - by["D-x05"]["paired"][0]) / 2


def screen(root):
    stem, rs = screen_rows(root)
    costs = jload(root, "COSTS", {})
    print("### Screen (vs `v5.0-ultra`)\n")
    print(table(rs, stem, costs))
    dstem, drs = diag_rows(root)
    print("\n### Compute diagnostics (own base D-base)\n")
    print(table(drs, dstem, {}) if drs else "(not played)")
    b = slope(root)
    print(f"\nSlope b = (Δ(D-x2) − Δ(D-x05)) / 2 = {b:+.3f} per doubling" if b is not None else "\nSlope: incomplete")


# ---------------------------------------------------------------- config diff / combination
def diff(base, arm, path=()):
    """List of (path, value) where arm differs from base; value MISSING means the key was removed."""
    out = []
    if isinstance(base, dict) and isinstance(arm, dict):
        for k in base:
            if k not in arm:
                out.append((path + (k,), MISSING))
            else:
                out += diff(base[k], arm[k], path + (k,))
        for k in arm:
            if k not in base:
                out.append((path + (k,), arm[k]))
        return out
    return [] if base == arm else [(path, arm)]


def apply(cfg, changes):
    for path, value in changes:
        d = cfg
        for k in path[:-1]:
            d = d[k]
        if value is MISSING:
            d.pop(path[-1], None)
        else:
            d[path[-1]] = copy.deepcopy(value)


def write_et(root, arm, c):
    cfg = json.load(open(os.path.join(root, "configs", f"{arm}.json")))
    assert cfg["search"]["iterationScale"] == SCALE
    cfg["search"]["iterationScale"] = round(SCALE / c, 3)
    json.dump(cfg, open(os.path.join(root, "configs", f"{arm}-ET.json"), "w"), indent=1)
    man = jload(root, "manifest.json", {})
    man[f"{arm}-ET"] = f"{arm} at equal time: search.iterationScale {SCALE} -> {round(SCALE / c, 3)} ({SCALE} / {c:.4f})"
    json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)


def select(root):
    _, rs = screen_rows(root)
    costs = jload(root, "COSTS", {})
    groups = jload(root, "GROUPS", {})
    b = slope(root)
    bplus = max(b, 0.0) if b is not None else 0.0
    log = lambda s: print(s, file=sys.stderr)
    log(f"compute slope b = {'incomplete (taken as 0)' if b is None else f'{b:+.3f}'} per doubling; b+ = {bplus:.3f}")
    competing = []
    cleared = []
    for r in rs:
        if r["arm"] == "base":
            continue
        (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
        c = costs.get(r["arm"], float("nan"))
        clears = dlo > 0
        line = f"{r['arm']} ({groups.get(r['arm'])}): paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}]; cost {c:.3f}"
        if not clears:
            log(line + " -> does not clear")
            continue
        cleared.append(r["arm"])
        if c <= MAX_COST:
            competing.append((dm, r["arm"], r["arm"], c))
            log(line + f" -> clears; competes as itself with {dm:+.3f}")
        else:
            exp = dm - bplus * math.log2(c)
            if exp > 0:
                competing.append((exp, r["arm"], f"{r['arm']}-ET", c))
                log(line + f" -> clears; above {MAX_COST}x, competes as {r['arm']}-ET with expected {dm:+.3f} − {bplus:.3f}·log2({c:.3f}) = {exp:+.3f}")
            else:
                log(line + f" -> clears; above {MAX_COST}x, expected equal-time estimate {exp:+.3f} ≤ 0, does not compete")
    competing.sort(key=lambda t: -t[0])
    chosen = competing[:2]
    for exp, arm, conf, c in chosen:
        if conf.endswith("-ET"):
            write_et(root, arm, c)
    best_by_group = {}
    for exp, arm, conf, c in competing:
        best_by_group.setdefault(groups[arm], arm)
    combo = None
    if len(best_by_group) >= 2:
        base = json.load(open(os.path.join(root, "configs", "base.json")))
        cfg = copy.deepcopy(base)
        parts = sorted(best_by_group.values())
        for arm in parts:
            apply(cfg, diff(base, json.load(open(os.path.join(root, "configs", f"{arm}.json")))))
        json.dump(cfg, open(os.path.join(root, "configs", "COMBO.json"), "w"), indent=1)
        man = jload(root, "manifest.json", {})
        man["COMBO"] = "combination: " + " + ".join(f"{a} ({man.get(a, '')})" for a in parts)
        json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)
        combo = parts
        log(f"combination COMBO of the best competing arm per group: {' + '.join(parts)} (clean cost measured next)")
    plan = {"slope": b, "slope_plus": bplus, "cleared": cleared,
            "competing": [{"arm": a, "confirm_as": cf, "estimate": e, "cost": c} for e, a, cf, c in competing],
            "selected": [cf for _, _, cf, _ in chosen], "combo": combo}
    json.dump(plan, open(os.path.join(root, "plan.json"), "w"), indent=1)
    log(f"selected for confirmation: {', '.join(plan['selected']) or '(none)'}{' + COMBO' if combo else ''}")
    print(" ".join(plan["selected"] + (["COMBO"] if combo else [])))


def finalize(root):
    plan = jload(root, "plan.json")
    arms = list(plan["selected"])
    if plan["combo"]:
        c = jload(root, "COSTS", {})["COMBO"]
        if c > MAX_COST:
            write_et(root, "COMBO", c)
            arms.append("COMBO-ET")
            print(f"COMBO clean cost {c:.3f} > {MAX_COST}: confirmed as COMBO-ET", file=sys.stderr)
        else:
            arms.append("COMBO")
            print(f"COMBO clean cost {c:.3f} <= {MAX_COST}: confirmed as itself", file=sys.stderr)
    plan["confirm"] = arms
    json.dump(plan, open(os.path.join(root, "plan.json"), "w"), indent=1)
    open(os.path.join(root, "CONFIRM_ARMS"), "w").write(" ".join(["base"] + arms) + "\n")
    print(" ".join(["base"] + arms))


def confirm(root):
    stem = lambda a: os.path.join(root, "confirm", f"v51c-{a}")
    carms = words(root, "CONFIRM_ARMS")
    costs = jload(root, "COSTS", {})
    rs = list(arm_rows(stem, carms, changes=jload(root, "manifest.json", {})))
    print(table(rs, stem, costs))
    print()
    by = {r["arm"]: r for r in rs}
    accepted = []
    for arm in carms[1:]:
        r = by.get(arm)
        if not r or not r["paired"]:
            print(f"- {arm}: incomplete -> NOT ACCEPTED")
            continue
        (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
        c = costs.get(arm[:-3] if arm.endswith("-ET") else arm, float("nan"))
        cost_ok = arm.endswith("-ET") or c <= MAX_COST
        ok = dlo > 0 and not (fhi < 0) and cost_ok
        print(f"- {arm}: paired {dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp "
              f"[{flo:+.2f}, {fhi:+.2f}]; clean cost {'equal time' if arm.endswith('-ET') else f'{c:.3f}x'} -> "
              f"{'ACCEPTED' if ok else 'NOT ACCEPTED'}")
        if ok:
            accepted.append((dm, arm))
    if not accepted:
        print("VERDICT: nothing accepted")
        print("NEW BASE: (none)")
        return
    best = max(accepted)[1]
    print(f"VERDICT: ACCEPTED {', '.join(a for _, a in accepted)}; v5.1 = {best}")
    print(f"NEW BASE: {best}")


def stage3(root):
    sys.path.insert(0, os.path.dirname(__file__))
    from paired_report import bootstrap, load  # noqa: E402
    from p4_report import first_place  # noqa: E402
    for name, path in (("v5.1-ultra vs 3 x level 7 (89,300,000)", os.path.join(root, "stage3", "v51-l7.jsonl")),
                       ("v5.1-ultra vs 3 x v5.0-ultra (89,400,000)", os.path.join(root, "stage3", "v51-h2h.jsonl"))):
        if not os.path.exists(path):
            print(f"- {name}: not played")
            continue
        adv = load(path)
        m, lo, hi = bootstrap(list(adv.values()))
        print(f"- {name}: {len(adv)} seeds, advantage {m:+.2f} [{lo:+.2f}, {hi:+.2f}], first place {first_place(path) * 100:.1f}%")


def main():
    a = sys.argv
    if len(a) < 3:
        print(__doc__)
        return
    if a[1] == "--cost":
        cost(a[2], a[3])
        return
    {"--screen": screen, "--select": select, "--finalize": finalize, "--confirm": confirm, "--stage3": stage3}[a[1]](a[2])


if __name__ == "__main__":
    main()
