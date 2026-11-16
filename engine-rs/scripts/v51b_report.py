"""Read-outs and preregistered rules for the second v5.1 round (2026-11-14 13:30, "v5.1 round 2" entry in
research_paper/v6_native_and_learning_preregistered.md).

    python3 engine-rs/scripts/v51b_report.py --rep ROOT        # Stage 1: 800 pooled seeds + per block; NEW BASE line
    python3 engine-rs/scripts/v51b_report.py --parity FILE     # Stage 2: two Blokee vs two Pentobi seats
    python3 engine-rs/scripts/v51b_report.py --roll-screen ROOT
    python3 engine-rs/scripts/v51b_report.py --roll-select ROOT   # stdout: the best clearing arm (or nothing)
    python3 engine-rs/scripts/v51b_report.py --roll-confirm ROOT  # NEW BASE line
    python3 engine-rs/scripts/v51b_report.py --extra ROOT         # level-7 and head-to-head blocks of v5.1-ultra

Stage 1 (ROOT/b1|b2/rep-<arm>.jsonl, blocks 89,500,000 and 89,600,000): an arm is accepted if its paired
advantage difference vs base over the 800 seeds (two blocks pooled; 95% percentile bootstrap by seed) has a
lower bound above 0 and its paired first-place interval is not entirely below 0. The accepted arm with the
largest pooled point estimate becomes v5.1-ultra.
Stage 3 (ROOT/screen/rol-<arm>.jsonl, ROOT/confirm/rolc-<arm>.jsonl): an arm clears if its paired lower
bound is above 0; the clearing arm with the largest point estimate is confirmed on fresh seeds, accepted by
the same rule.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from p910_report import fmt_ci, paired_lines  # noqa: E402
from paired_report import bootstrap, load  # noqa: E402
from p4_report import first_place  # noqa: E402
from s4_report import arm_rows  # noqa: E402
from v51_report import jload, table, words  # noqa: E402


def verdict(r):
    (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
    ok = dlo > 0 and not (fhi < 0)
    return ok, f"paired {dm:+.2f} [{dlo:+.2f}, {dhi:+.2f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}]"


def rep(root):
    arms = ["base"] + words(root, "PLAYED")
    pooled = os.path.join(root, "pooled")
    os.makedirs(pooled, exist_ok=True)
    for arm in arms:
        for ext in ["jsonl", "moves.jsonl", "timing.jsonl"]:
            with open(os.path.join(pooled, f"rep-{arm}.{ext}"), "w") as out:
                for blk in ["b1", "b2"]:
                    p = os.path.join(root, blk, f"rep-{arm}.{ext}")
                    if os.path.exists(p):
                        out.write(open(p).read())
    costs = jload(root, "COSTS", {})
    man = jload(root, "manifest.json", {})
    for blk, title in [("b1", "Block 89,500,000 (400 seeds)"), ("b2", "Block 89,600,000 (400 seeds)"), ("pooled", "Pooled, 800 seeds")]:
        stem = lambda a, b=blk: os.path.join(root, b, f"rep-{a}")
        rs = list(arm_rows(stem, arms, changes=man))
        print(f"### {title}\n")
        print(table(rs, stem, costs))
        print()
    stem = lambda a: os.path.join(pooled, f"rep-{a}")
    rs = {r["arm"]: r for r in arm_rows(stem, arms, changes=man)}
    accepted = []
    for arm in arms[1:]:
        r = rs.get(arm)
        if not r or not r["paired"] or r["paired_n"] < 800:
            print(f"- {arm}: incomplete ({r['paired_n'] if r and r['paired'] else 0} paired seeds) -> NOT ACCEPTED")
            continue
        ok, text = verdict(r)
        print(f"- {arm} (pooled): {text} -> {'ACCEPTED' if ok else 'NOT ACCEPTED'}")
        if ok:
            accepted.append((r["paired"][0], arm))
    if accepted:
        best = max(accepted)[1]
        print(f"VERDICT: ACCEPTED {', '.join(a for _, a in accepted)}; v5.1 = {best}")
        print(f"NEW BASE: {best}")
    else:
        print("VERDICT: nothing accepted")
        print("NEW BASE: (none)")


def parity(path):
    games = [json.loads(l) for l in open(path) if l.strip()]
    timing_path = path[: -len(".jsonl")] + ".timing.jsonl"
    timing = [json.loads(l) for l in open(timing_path) if l.strip()] if os.path.exists(timing_path) else []

    def share(g):
        ours = set(g["seats"])
        return sum(1 for w in g["winner"] if w in ours) / len(g["winner"])

    print("| Arrangements | Seeds | Games | Our mean − Pentobi mean [95% CI by seed] | First-place share of our seats (par 50%) [95% CI by seed] | Our seats among the winners (any share) |")
    print("|---|---:|---:|---:|---:|---:|")
    for name, keep in [("all six", lambda g: True), ("alternating (2)", lambda g: g["arrangement"] == "alternating"),
                       ("adjacent (4)", lambda g: g["arrangement"] == "adjacent")]:
        gs = [g for g in games if keep(g)]
        need = 6 if name == "all six" else (2 if "alternating" in name else 4)
        by = {}
        for g in gs:
            by.setdefault(g["seed"], []).append(g)
        by = {s: v for s, v in by.items() if len(v) == need}
        if not by:
            continue
        adv = bootstrap([sum(g["blokeeAdvantage"] for g in v) / len(v) for v in by.values()])
        fp = bootstrap([100 * sum(share(g) for g in v) / len(v) for v in by.values()])
        anyw = sum(any(w in g["seats"] for w in g["winner"]) for v in by.values() for g in v) / sum(len(v) for v in by.values())
        print(f"| {name} | {len(by)} | {sum(len(v) for v in by.values())} | {fmt_ci(adv)} | {fmt_ci(fp, '%')} | {anyw * 100:.1f}% |")
    print()
    for kind in ["adjacent", "alternating"]:
        for pair in sorted({g["seat"] for g in games if g["arrangement"] == kind}):
            gs = [g for g in games if g["seat"] == pair]
            m = sum(g["blokeeAdvantage"] for g in gs) / len(gs)
            print(f"- {kind} {pair}: {len(gs)} games, our mean − Pentobi mean {m:+.2f}, first-place share {100 * sum(share(g) for g in gs) / len(gs):.1f}%")
    if timing:
        bms = [x for t in timing for x in t["blokeeMs"]]
        pms = [x for t in timing for x in t["pentobiMs"]]
        bl = [x for t in timing for x in t["blokeeMs"][6:]]
        print(f"\nms/move (wall, under match load): Blokee {sum(bms) / len(bms):.1f} over {len(bms)} moves; "
              f"Pentobi {sum(pms) / len(pms):.1f} over {len(pms)} moves")


def roll_rows(root, sub, prefix, arms):
    stem = lambda a: os.path.join(root, sub, f"{prefix}-{a}")
    return stem, list(arm_rows(stem, arms, changes=jload(root, "manifest.json", {})))


def roll_screen(root):
    arms = words(root, "PLAYED")
    stem, rs = roll_rows(root, "screen", "rol", arms)
    print(table(rs, stem, jload(root, "COSTS", {})))
    sc = {a: json.load(open(os.path.join(root, "configs", f"{a}.json")))["search"]["iterationScale"] for a in ["base"] + arms}
    print("\niterationScale played: " + ", ".join(f"{a} {v}" for a, v in sc.items()))


def roll_select(root):
    arms = words(root, "PLAYED")
    _, rs = roll_rows(root, "screen", "rol", arms)
    cleared = []
    for r in rs:
        if r["arm"] == "base":
            continue
        (dm, dlo, dhi), (fm, flo, fhi) = r["paired"], r["paired_fp"]
        c = dlo > 0
        print(f"{r['arm']}: paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r['paired_n']} seeds; first place {fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}] -> "
              f"{'clears' if c else 'does not clear'}", file=sys.stderr)
        if c:
            cleared.append((dm, r["arm"]))
    best = max(cleared)[1] if cleared else ""
    print(f"selected: {best or '(none)'}", file=sys.stderr)
    print(best)


def roll_confirm(root, expected=400):
    arm = open(os.path.join(root, "selected.txt")).read().strip()
    stem, rs = roll_rows(root, "confirm", "rolc", [arm])
    print(table(rs, stem, jload(root, "COSTS", {})))
    print()
    r = {x["arm"]: x for x in rs}.get(arm)
    if not r or not r["paired"] or r["paired_n"] < expected:
        print(f"- {arm}: incomplete -> NOT ACCEPTED")
        print("NEW BASE: (none)")
        return
    ok, text = verdict(r)
    print(f"- {arm}: {text} -> {'ACCEPTED' if ok else 'NOT ACCEPTED'}")
    print(f"NEW BASE: {arm if ok else '(none)'}")


def extra(root):
    for name, path in (("v5.1-ultra vs 3 x level 7 (89,300,000)", os.path.join(root, "v51-l7.jsonl")),
                       ("v5.1-ultra vs 3 x v5.0-ultra (89,400,000)", os.path.join(root, "v51-h2h.jsonl"))):
        if not os.path.exists(path):
            print(f"- {name}: not played")
            continue
        adv = load(path)
        m, lo, hi = bootstrap(list(adv.values()))
        print(f"- {name}: {len(adv)} complete seeds, advantage {m:+.2f} [{lo:+.2f}, {hi:+.2f}], first place {first_place(path) * 100:.1f}%")


def main():
    a = sys.argv
    if len(a) < 3:
        print(__doc__)
        return
    if a[1] == "--roll-confirm" and len(a) > 3:
        roll_confirm(a[2], int(a[3]))  # optional expected seed count (default 400)
        return
    {"--rep": rep, "--parity": parity, "--roll-screen": roll_screen, "--roll-select": roll_select,
     "--roll-confirm": roll_confirm, "--extra": extra}[a[1]](a[2])


if __name__ == "__main__":
    main()
