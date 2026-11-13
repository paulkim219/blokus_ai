"""P9/P10 read-out. Every arm table has the advantage vs the three Pentobi level-6 seats, first place,
the seed-paired advantage difference against base AND the seed-paired first-place difference (both
95% percentile bootstraps over seeds, ml/seat/paired_report.bootstrap), in-match ms/move and games
differing from base.

    python3 engine-rs/scripts/p910_report.py tmp/p910              # screen (screen/p910s-<ARM>)
    python3 engine-rs/scripts/p910_report.py tmp/p910 --live       # liveness (live/p910-live-<ARM>)
    python3 engine-rs/scripts/p910_report.py tmp/p910 --select     # selection rule -> stdout
    python3 engine-rs/scripts/p910_report.py tmp/p910 --cost-ratio ARM   # clean-run ms/move ratio ARM / base
    python3 engine-rs/scripts/p910_report.py tmp/p910 --confirm    # confirmation (confirm/p910c-<ARM>) + verdict
    python3 engine-rs/scripts/p910_report.py tmp/p910 --cost       # clean cost ratios
    python3 engine-rs/scripts/p910_report.py --shape FILE.csv [FILE.csv ...]   # tree-shape table(s)
    python3 engine-rs/scripts/p910_report.py --paired ARM.jsonl BASE.jsonl     # one paired line (any run)

Rules (preregistered, research_paper/v6_native_and_learning_preregistered.md, 2026-11-13 "P9/P10"):
- An arm clears the screen if its paired advantage difference against base has a 95% CI lower
  bound > 0. The paired first-place difference is reported for every arm and is not a gate.
- Confirmed set: the cleared arm with the largest point estimate. If cleared arms of single
  mechanisms (P10, P4I, P9A, P9B) cover two or more mechanisms, also (a) the combination of the
  best cleared single-mechanism arm of each (an existing screen arm if one has exactly those changes,
  else a new config `C-<A>+<B>`) and (b) the best cleared single-mechanism arm, each if not already
  in the set. `--select` prints `ARM` or `COMBO <name> <part> <part>...` lines.
- Cost: clean-run ms/move, own moves 3+, arm / base (cost/cost.csv; cost/cost-confirm.csv for arms
  first costed at confirmation). For an arm that searches the opening (P9A) the ratio is taken over
  own moves 0+ (cost/cost-open.csv), where base plays moves 0-2 from the heuristic.
- Confirmation: accepted if the paired advantage lower bound is > 0. It can become the new base only
  if (i) its clean cost ratio is <= 1.25, or its equal-time arm `<ARM>-ET` (same seeds) also has a
  paired lower bound > 0 (the equal-time config is then the one saved), and (ii) its paired
  first-place interval does not lie entirely below 0 (otherwise: reported, not saved, the chain stops
  before the direct match; the trade-off is the user's decision). Among several eligible arms, the
  largest confirmation point estimate.
"""
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from paired_report import bootstrap, load  # noqa: E402
from p4_report import first_place, moves_by_game, timing  # noqa: E402

MAX_COST = 1.25
PREFIX = "p910"


def arms_file(root, name):
    path = os.path.join(root, name)
    return open(path).read().split() if os.path.exists(path) else []


def manifest(root):
    return {m["arm"]: m for m in json.load(open(os.path.join(root, "configs", "manifest.json")))}


def first_by_seed(path):
    """seed -> share of the four rotations in which the seat is first (ties count as first)."""
    by = {}
    for line in open(path):
        if not line.strip():
            continue
        g = json.loads(line)
        by.setdefault(g["seed"], {})[g["seat"]] = 1.0 if g["seat"] in g["winner"] else 0.0
    return {s: sum(v.values()) / 4 for s, v in by.items() if len(v) == 4}


def paired_lines(arm_path, base_path):
    a, b = load(arm_path), load(base_path)
    seeds = [s for s in a if s in b]
    fa, fb = first_by_seed(arm_path), first_by_seed(base_path)
    fseeds = [s for s in fa if s in fb]
    adv = bootstrap([a[s] - b[s] for s in seeds]) if seeds else None
    fp = bootstrap([100 * (fa[s] - fb[s]) for s in fseeds]) if fseeds else None
    return adv, fp, len(seeds)


def rows(root, stem, arms):
    man = manifest(root)
    base_path = stem("base") + ".jsonl"
    have_base = os.path.exists(base_path)
    base_moves = moves_by_game(stem("base") + ".moves.jsonl") if have_base else {}
    _, base_late = timing(stem("base") + ".timing.jsonl") if have_base else (float("nan"), float("nan"))
    for arm in ["base"] + [a for a in arms if a != "base"]:
        path = stem(arm) + ".jsonl"
        if not os.path.exists(path):
            continue
        adv = load(path)
        if not adv:
            continue
        r = {"arm": arm, "change": man.get(arm, {}).get("change", ""), "seeds": len(adv),
             "adv": bootstrap(list(adv.values())), "fp": first_place(path), "paired": None, "paired_fp": None}
        if arm != "base" and have_base:
            r["paired"], r["paired_fp"], r["paired_n"] = paired_lines(path, base_path)
        r["t_all"], r["t_late"] = timing(stem(arm) + ".timing.jsonl")
        r["ratio"] = r["t_late"] / base_late if base_late == base_late and base_late > 0 else float("nan")
        mv = moves_by_game(stem(arm) + ".moves.jsonl")
        common = [k for k in mv if k in base_moves]
        r["differ"] = (sum(mv[k] != base_moves[k] for k in common), len(common))
        yield r


def fmt_ci(t, unit=""):
    if not t:
        return "—"
    m, lo, hi = t
    star = " *" if lo > 1e-9 or hi < -1e-9 else ""
    return f"{m:+.2f}{unit} [{lo:+.2f}, {hi:+.2f}]{star}"


def table(rs):
    out = ["| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ advantage vs base [95% CI] | "
           "Paired Δ first place, pp [95% CI] | ms/move all | ms/move 3+ | × base (3+, in-match) | Games ≠ base |",
           "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in rs:
        m, lo, hi = r["adv"]
        out.append(f"| {r['arm']} | {r['change']} | {r['seeds']} | {m:+.2f} [{lo:+.2f}, {hi:+.2f}] | {r['fp'] * 100:.1f}% | "
                   f"{fmt_ci(r['paired'])} | {fmt_ci(r['paired_fp'])} | {r['t_all']:.1f} | {r['t_late']:.1f} | {r['ratio']:.2f} | "
                   f"{r['differ'][0]}/{r['differ'][1]} |")
    return "\n".join(out)


def cost_ms(root):
    """{arm: ms ratio to base} from every clean cost file present (own moves 3+; cost-open: 0+)."""
    ratios = {}
    for stem, min_own in (("cost", 3), ("cost-confirm", 3), ("cost-open", 0), ("cost-open-confirm", 0)):
        path = os.path.join(root, "cost", f"{stem}.csv")
        names_path = os.path.join(root, "cost", f"{stem}.names")
        if not os.path.exists(path):
            continue
        names = open(names_path).read().split()
        per = {}
        for r in csv.DictReader(open(path)):
            if int(r["own_idx"]) >= min_own:
                per.setdefault(names[int(r["config"])], []).append(float(r["ms"]))
        mean = lambda v: sum(v) / len(v)
        for arm, v in per.items():
            key = arm if not stem.startswith("cost-open") else f"{arm}@open"
            ratios.setdefault(key, mean(v) / mean(per["base"]))
    return ratios


def opening_arm(root, arm):
    m = manifest(root).get(arm, {})
    return "search.openingHeuristicMaxOwnMove" in m.get("diff", {})


def clean_ratio(root, arm):
    if arm.endswith("-ET"):
        return float("nan")
    ratios = cost_ms(root)
    if opening_arm(root, arm) and f"{arm}@open" in ratios:
        return ratios[f"{arm}@open"]
    return ratios[arm]


def select(root):
    screen = lambda a: os.path.join(root, "screen", f"{PREFIX}s-{a}")
    man = manifest(root)
    rs = [r for r in rows(root, screen, arms_file(root, "ARMS")) if r["arm"] != "base"]
    cleared = [r for r in rs if r["paired"] and r["paired"][1] > 0]
    for r in rs:
        dm, dlo, dhi = r["paired"] if r["paired"] else (float("nan"),) * 3
        fm, flo, fhi = r["paired_fp"] if r["paired_fp"] else (float("nan"),) * 3
        print(f"{r['arm']}: paired {dm:+.3f} [{dlo:+.3f}, {dhi:+.3f}] on {r.get('paired_n', 0)} seeds; first place "
              f"{fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}] -> {'clears the screen' if r in cleared else 'does not clear'}", file=sys.stderr)
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
    conf = lambda a: os.path.join(root, "confirm", f"{PREFIX}c-{a}")
    rs = list(rows(root, conf, arms_file(root, "CONFIRM_ARMS")))
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
        fm, flo, fhi = r["paired_fp"]
        q = "ACCEPTED at equal iterations (lower bound > 0)" if lo > 0 else "not accepted (lower bound <= 0)"
        line = (f"- {arm}: paired {r['paired'][0]:+.2f} [{lo:+.2f}, {r['paired'][2]:+.2f}] -> {q}; first place "
                f"{fm:+.2f} pp [{flo:+.2f}, {fhi:+.2f}]; clean cost {ratio:.2f}x base")
        if lo > 0:
            candidate = None
            if ratio <= MAX_COST:
                candidate = arm
                line += " <= 1.25"
            else:
                et = by.get(f"{arm}-ET")
                if et and et["paired"] and et["paired"][1] > 0:
                    candidate = f"{arm}-ET"
                    line += f" > 1.25; equal-time arm {fmt_ci(et['paired'])} HOLDS: {arm}-ET"
                else:
                    line += f" > 1.25; equal-time arm {fmt_ci(et['paired']) if et else 'missing'} does not hold: not eligible"
            if candidate:
                fp_arm = by[candidate]["paired_fp"]
                if fp_arm[2] < 0:
                    line += (f"; first-place interval of {candidate} lies entirely below 0 "
                             f"({fmt_ci(fp_arm)}): NOT saved as the new base (user's decision)")
                else:
                    eligible.append((r["paired"][0], candidate))
                    line += f": {candidate} eligible as the new base"
        print(line)
    winner = max(eligible)[1] if eligible else None
    print(f"NEW BASE: {winner or '(none)'}")
    return winner


def shape_table(paths):
    """Mean over positions of the tree-shape columns written by examples/p910_probe.rs."""
    rows_ = []
    for p in paths:
        rows_ += list(csv.DictReader(open(p)))
    # A position some engine did not search (a single legal move) is left out for every config.
    skip = {r["pos"] for r in rows_ if float(r["iterations"]) == 0 or r["depth_mean"].lower() == "nan"}
    if skip:
        print(f"(positions left out for every config, not searched by some engine: {sorted(skip, key=int)})\n")
    rows_ = [r for r in rows_ if r["pos"] not in skip]
    order = []
    for r in rows_:
        if r["config"] not in order:
            order.append(r["config"])
    f = lambda r, k: float(r[k])
    print("| Config | Pos. | Simulations | Root visits | Tree depth mean / max | Root children with a visit | "
          "Root children for 50% / 90% | Top root child share | PV visits: d1 / d2 / d3 / d4 / d6 | "
          "Visits at depth 3 / 4 / 5 / 6 (share of root) | Interior nodes | Edges per interior node | Visited edges per interior node | "
          "Nodes ≥100 visits: count, edges, visited, top share | ms |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for cfg in order:
        rs = [r for r in rows_ if r["config"] == cfg]
        n = len(rs)
        m = lambda k: sum(f(r, k) for r in rs) / n
        share = lambda k: sum(f(r, k) / max(1.0, f(r, "root_visits")) for r in rs) / n * 100
        inodes = sum(f(r, "interior_nodes") for r in rs)
        bnodes = sum(f(r, "busy_nodes") for r in rs)
        dmax = max(f(r, "depth_max") for r in rs)
        print(f"| {cfg} | {n} | {m('iterations'):.0f} | {m('root_visits'):.0f} | {m('depth_mean'):.2f} / {dmax:.0f} | "
              f"{m('root_visited'):.0f} of {m('root_edges'):.0f} | {m('root_50'):.1f} / {m('root_90'):.1f} | {m('root_top_share'):.2f} | "
              f"{m('pv1'):.0f} / {m('pv2'):.0f} / {m('pv3'):.0f} / {m('pv4'):.0f} / {m('pv6'):.1f} | "
              f"{share('vd3'):.1f}% / {share('vd4'):.1f}% / {share('vd5'):.1f}% / {share('vd6'):.1f}% | "
              f"{m('interior_nodes'):.0f} | {sum(f(r, 'interior_edges') for r in rs) / max(1, inodes):.1f} | "
              f"{sum(f(r, 'interior_visited') for r in rs) / max(1, inodes):.1f} | "
              f"{m('busy_nodes'):.1f}, {sum(f(r, 'busy_edges') for r in rs) / max(1, bnodes):.0f}, "
              f"{sum(f(r, 'busy_visited') for r in rs) / max(1, bnodes):.1f}, {sum(f(r, 'busy_top_share_sum') for r in rs) / max(1, bnodes):.2f} | "
              f"{m('ms'):.0f} |")


def main():
    if "--shape" in sys.argv:
        shape_table(sys.argv[sys.argv.index("--shape") + 1:])
        return
    if "--paired" in sys.argv:
        i = sys.argv.index("--paired")
        adv, fp, n = paired_lines(sys.argv[i + 1], sys.argv[i + 2])
        print(f"{n} seeds: paired advantage {fmt_ci(adv)}; paired first place {fmt_ci(fp, ' pp')}")
        return
    root = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "tmp/p910"
    if "--live" in sys.argv:
        live = lambda a: os.path.join(root, "live", f"{PREFIX}-live-{a}")
        print(table(list(rows(root, live, arms_file(root, "ARMS_LIVE")))))
    elif "--cost-ratio" in sys.argv:
        print(f"{clean_ratio(root, sys.argv[sys.argv.index('--cost-ratio') + 1]):.3f}")
    elif "--select" in sys.argv:
        for x in select(root):
            print(x if isinstance(x, str) else " ".join([x[0], x[1], *x[2]]))
    elif "--confirm" in sys.argv:
        confirm(root)
    elif "--cost" in sys.argv:
        for arm, ratio in sorted(cost_ms(root).items(), key=lambda kv: kv[1]):
            print(f"{arm}: {ratio:.3f}x base (ms/move, own moves {'0+' if arm.endswith('@open') else '3+'})")
    else:
        screen = lambda a: os.path.join(root, "screen", f"{PREFIX}s-{a}")
        print(table(list(rows(root, screen, arms_file(root, "ARMS")))))


if __name__ == "__main__":
    main()
