"""Read-outs for the package experiment (Stage A) and the interiorInitVisits replication (Stage B).

    python3 engine-rs/scripts/pkg_report.py --screen ROOT       # screen table, paired vs base and vs PKG
    python3 engine-rs/scripts/pkg_report.py --select ROOT       # stdout: up to two selected arms, one per line
    python3 engine-rs/scripts/pkg_report.py --cost ROOT         # clean cost table (ROOT/cost/cost.csv)
    python3 engine-rs/scripts/pkg_report.py --confirm ROOT      # confirmation table + verdicts + NEW BASE line
    python3 engine-rs/scripts/pkg_report.py --rep ROOT          # Stage B: 800 pooled seeds + verdict

Preregistered 2026-11-14 ("Package" and "IIV1 replication" entries in
research_paper/v6_native_and_learning_preregistered.md).

Stage A rules:
- Screen (ROOT/screen/pkgs-<ARM>): an arm clears if its paired advantage difference against base (same
  seeds; 95% percentile bootstrap by seed) has a lower bound above 0. Selected: the cleared arms with the
  two largest point estimates (at most two). The paired difference from PKG is descriptive.
- Confirmation (ROOT/confirm/pkgc-<ARM>): base, each selected arm and, for a selected arm whose clean cost
  (ROOT/COSTS) is above 1.25x base, its equal-time version <ARM>-ET (PKG's is the screened PKG-ET),
  started together on fresh seeds. An arm is accepted if its paired lower bound is above 0 and its
  paired first-place interval is not entirely below 0; when its cost is above 1.25 its -ET version must
  also have a lower bound above 0 (and its first-place interval not entirely below 0), and the -ET
  config is the one saved. If two are accepted, the saved config with the larger confirmation paired
  point estimate becomes the new base.
Stage B rule: IIV1 accepted if the paired lower bound over the 800 fresh seeds (two blocks pooled) is
above 0 and the paired first-place interval is not entirely below 0.
"""
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from p910_report import fmt_ci, paired_lines  # noqa: E402
from s4_report import arm_rows  # noqa: E402

MAX_COST = 1.25


def costs(root):
    p = os.path.join(root, "COSTS")
    return json.load(open(p)) if os.path.exists(p) else {}


def changes(root):
    p = os.path.join(root, "manifest.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def arms(root):
    return open(os.path.join(root, "ARMS")).read().split()


def table(rs, stem, ref="PKG", c=None):
    c = c or {}
    out = ["| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp | "
           f"Paired Δ vs {ref} [95% CI] | Paired Δ first place vs {ref}, pp | Clean cost × base | ms/move 3+ in-match | Games ≠ base |",
           "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    ref_path = stem(ref) + ".jsonl"
    for r in rs:
        m, lo, hi = r["adv"]
        vs = (None, None)
        if r["arm"] != ref and os.path.exists(ref_path):
            a, f, _ = paired_lines(stem(r["arm"]) + ".jsonl", ref_path)
            vs = (a, f)
        cost = c.get(r["arm"])
        out.append(f"| {r['arm']} | {r['change']} | {r['seeds']} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {r['fp'] * 100:.1f}% | "
                   f"{fmt_ci(r['paired'])} | {fmt_ci(r['paired_fp'])} | {fmt_ci(vs[0])} | {fmt_ci(vs[1])} | "
                   f"{'' if cost is None else f'{cost:.2f}'} | {r['t_late']:.1f} | {r['differ'][0]}/{r['differ'][1]} |")
    return "\n".join(out)


def screen_stem(root):
    return lambda a: os.path.join(root, "screen", f"pkgs-{a}")


def screen(root):
    stem = screen_stem(root)
    rs = list(arm_rows(stem, arms(root), changes=changes(root)))
    print(table(rs, stem, c=costs(root)))


def select(root):
    stem = screen_stem(root)
    rs = [r for r in arm_rows(stem, arms(root), changes=changes(root)) if r["arm"] != "base"]
    cleared = [r for r in rs if r["paired"] and r["paired"][1] > 0]
    for r in rs:
        (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
        print(f"{r['arm']}: paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp "
              f"[{flo:+.2f}, {fhi:+.2f}] -> {'clears' if r in cleared else 'does not clear'}", file=sys.stderr)
    best = sorted(cleared, key=lambda r: -r["paired"][0])[:2]
    print(f"selected: {', '.join(r['arm'] for r in best) or '(none)'}", file=sys.stderr)
    for r in best:
        print(r["arm"])


def cost(root):
    names = open(os.path.join(root, "cost", "cost.names")).read().split()
    per, iters = {}, {}
    for r in csv.DictReader(open(os.path.join(root, "cost", "cost.csv"))):
        if int(r["own_idx"]) >= 3:
            per.setdefault(names[int(r["config"])], []).append(float(r["ms"]))
            iters.setdefault(names[int(r["config"])], []).append(int(r["iterations"]))
    mean = lambda v: sum(v) / len(v)
    print("| Config | positions | ms/move (own moves 3+) | × base | iterations/move |")
    print("|---|---:|---:|---:|---:|")
    out = {}
    for n in names:
        out[n] = mean(per[n]) / mean(per["base"])
        print(f"| {n} | {len(per[n])} | {mean(per[n]):.1f} | {out[n]:.3f} | {mean(iters[n]):.0f} |")
    return out


def verdict_line(r):
    (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
    return dlo > 0 and not (fhi < 0), f"paired {dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}]"


def confirm(root):
    stem = lambda a: os.path.join(root, "confirm", f"pkgc-{a}")
    carms = open(os.path.join(root, "CONFIRM_ARMS")).read().split()
    sel = open(os.path.join(root, "selected.txt")).read().split()
    c = costs(root)
    rs = list(arm_rows(stem, carms, changes=changes(root)))
    print(table(rs, stem, c=c))
    print()
    by = {r["arm"]: r for r in rs}
    accepted = []
    for arm in sel:
        r = by.get(arm)
        if not r or not r["paired"]:
            print(f"- {arm}: incomplete -> not accepted")
            continue
        ok, text = verdict_line(r)
        ratio = c.get(arm, float("nan"))
        print(f"- {arm}: {text}; clean cost {ratio:.2f}x base")
        if not ok:
            print(f"  {arm}: NOT ACCEPTED")
            continue
        saved = arm
        if ratio > MAX_COST and not arm.endswith("-ET"):
            et = by.get(f"{arm}-ET")
            if not et or not et["paired"]:
                print(f"  {arm}: equal-time arm missing -> NOT ACCEPTED as base")
                continue
            ok_et, text_et = verdict_line(et)
            print(f"  {arm}-ET: {text_et}")
            if not ok_et:
                print(f"  {arm}: holds at equal iterations, but the equal-time arm does not -> NOT ACCEPTED as base")
                continue
            saved = f"{arm}-ET"
        print(f"  {arm}: ACCEPTED (saved config {saved})")
        accepted.append((by[saved]["paired"][0], saved))
    if not accepted:
        print("VERDICT: nothing accepted")
        print("NEW BASE: (none)")
        return
    best = max(accepted)[1]
    print(f"VERDICT: ACCEPTED {', '.join(a for _, a in accepted)}; new base {best}")
    print(f"NEW BASE: {best}")


def confirm2(root):
    """Amendment 2026-11-14 04:10: PKG-noROLL confirmation on 88,800,000 (ROOT/confirm2/pkgr-<ARM>)."""
    stem = lambda a: os.path.join(root, "confirm2", f"pkgr-{a}")
    rs = list(arm_rows(stem, ["PKG-noROLL", "PKG-noROLL-ET"], changes=changes(root)))
    print(table(rs, stem, ref="PKG-noROLL", c=costs(root)))
    print()
    by = {r["arm"]: r for r in rs}
    held = {}
    for arm in ["PKG-noROLL", "PKG-noROLL-ET"]:
        r = by.get(arm)
        if not r or not r["paired"]:
            print(f"- {arm}: incomplete")
            held[arm] = False
            continue
        held[arm], text = verdict_line(r)
        print(f"- {arm}: {text} -> {'holds' if held[arm] else 'does not hold'}")
    if held["PKG-noROLL-ET"]:
        print("VERDICT: ACCEPTED (PKG-noROLL-ET holds; saved as v5.0-pk-ultra)")
        print("NEW BASE: PKG-noROLL-ET")
    elif held["PKG-noROLL"]:
        print("VERDICT: holds at equal iterations only; nothing saved")
        print("NEW BASE: (none)")
    else:
        print("VERDICT: NOT ACCEPTED")
        print("NEW BASE: (none)")


def rep(root):
    """Stage B: pool the two blocks (distinct seeds) per arm and read the 800-seed paired difference."""
    pooled = os.path.join(root, "pooled")
    os.makedirs(pooled, exist_ok=True)
    for arm in ["base", "IIV1"]:
        for ext in ["jsonl", "moves.jsonl", "timing.jsonl"]:
            with open(os.path.join(pooled, f"iiv-{arm}.{ext}"), "w") as out:
                for blk in ["b1", "b2"]:
                    p = os.path.join(root, blk, f"iiv{blk}-{arm}.{ext}")
                    if os.path.exists(p):
                        out.write(open(p).read())
    stem = lambda a: os.path.join(pooled, f"iiv-{a}")
    rs = list(arm_rows(stem, ["IIV1"], changes=changes(root)))
    print(table(rs, stem, ref="base"))
    r = [x for x in rs if x["arm"] == "IIV1"]
    print()
    if not r or not r[0]["paired"]:
        print("VERDICT: incomplete")
        return
    ok, text = verdict_line(r[0])
    print(f"- IIV1 (800 fresh seeds pooled): {text}")
    for blk in ["b1", "b2"]:
        a, f, n = paired_lines(os.path.join(root, blk, f"iiv{blk}-IIV1.jsonl"), os.path.join(root, blk, f"iiv{blk}-base.jsonl"))
        if a:
            print(f"  block {blk}: paired {fmt_ci(a)} on {n} seeds; first place {fmt_ci(f)} pp (descriptive)")
    print(f"VERDICT: {'ACCEPTED' if ok else 'NOT ACCEPTED'}")
    print(f"NEW BASE: {'IIV1' if ok else '(none)'}")


def main():
    a = sys.argv
    if len(a) < 3:
        print(__doc__)
        return
    root = a[2]
    {"--screen": screen, "--select": select, "--cost": cost, "--confirm": confirm, "--confirm2": confirm2, "--rep": rep}[a[1]](root)


if __name__ == "__main__":
    main()
