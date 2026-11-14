"""Round 3 read-outs (preregistered 2026-11-14, "v5.1 round 3" entries in
research_paper/v6_native_and_learning_preregistered.md).

    python3 engine-rs/scripts/v51c_report.py --stageA tmp/v51c/A
    python3 engine-rs/scripts/v51c_report.py --roles LOG.jsonl [LOG.jsonl ...]     # own/next/opposite/previous
    python3 engine-rs/scripts/v51c_report.py --stageB tmp/v51c/B

First place is given two ways: "any" = the seat is among the top scorers (the convention so far), and
"split" = 1/t for each of t tied top scorers (ties shared).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "seat"))
from paired_report import bootstrap  # noqa: E402
from p910_report import fmt_ci  # noqa: E402

TURN = ["blue", "green", "purple", "yellow"]


def games(path):
    return [json.loads(l) for l in open(path) if l.strip()]


def per_seed(path):
    """seed -> (advantage, first-any, first-split), complete rotations only (4 games)."""
    by = {}
    for g in games(path):
        s, seat = g["scores"], g["seat"]
        adv = s[seat] - sum(v for c, v in s.items() if c != seat) / 3
        w = g["winner"]
        by.setdefault(g["seed"], []).append((adv, 1.0 if seat in w else 0.0, (1.0 / len(w)) if seat in w else 0.0))
    return {k: tuple(sum(x[i] for x in v) / 4 for i in range(3)) for k, v in by.items() if len(v) == 4}


def arm_line(name, path):
    d = per_seed(path)
    m = bootstrap([v[0] for v in d.values()])
    return f"| {name} | {len(d)} | {fmt_ci(m)} | {100 * sum(v[1] for v in d.values()) / len(d):.1f}% | {100 * sum(v[2] for v in d.values()) / len(d):.1f}% |"


def paired(a_path, b_path):
    a, b = per_seed(a_path), per_seed(b_path)
    seeds = [s for s in a if s in b]
    return (len(seeds), bootstrap([a[s][0] - b[s][0] for s in seeds]),
            bootstrap([100 * (a[s][1] - b[s][1]) for s in seeds]), bootstrap([100 * (a[s][2] - b[s][2]) for s in seeds]))


def merged(paths, out):
    with open(out, "w") as f:
        for p in paths:
            f.write(open(p).read())
    return out


def stageA(root):
    os.makedirs(os.path.join(root, "pooled"), exist_ok=True)
    print("### Lone seat vs three level-6 seats\n")
    print("| Arm / block | Seeds | Advantage vs L6 [95% CI] | First place (any) | First place (split) |")
    print("|---|---:|---:|---:|---:|")
    sets = {}
    for c in ["v5.0-ultra", "v5.1-ultra"]:
        r2 = {"v5.0-ultra": "rep-base", "v5.1-ultra": "rep-COMBO-ET"}[c]
        fresh = [os.path.join(root, b, f"lone-{c}.jsonl") for b in ["a1", "a2"]]
        old = [f"tmp/v51b/rep/{b}/{r2}.jsonl" for b in ["b1", "b2"]]
        sets[c] = {"a1 (90,000,000)": fresh[0], "a2 (90,100,000)": fresh[1],
                   "fresh 800": merged(fresh, os.path.join(root, "pooled", f"fresh-{c}.jsonl")),
                   "round 2 800": merged(old, os.path.join(root, "pooled", f"r2-{c}.jsonl")),
                   "all 1,600": merged(fresh + old, os.path.join(root, "pooled", f"all-{c}.jsonl"))}
        for k, p in sets[c].items():
            if os.path.exists(p) and os.path.getsize(p):
                print(arm_line(f"{c}, {k}", p))
    print("\n### Paired v5.1-ultra − v5.0-ultra (same seeds)\n")
    print("| Sample | Seeds | Paired Δ advantage [95% CI] | Paired Δ first place (any), pp | Paired Δ first place (split), pp |")
    print("|---|---:|---:|---:|---:|")
    for k in sets["v5.0-ultra"]:
        a, b = sets["v5.1-ultra"][k], sets["v5.0-ultra"][k]
        if os.path.exists(a) and os.path.exists(b) and os.path.getsize(a) and os.path.getsize(b):
            n, d, f1, f2 = paired(a, b)
            print(f"| {k} | {n} | {fmt_ci(d)} | {fmt_ci(f1)} | {fmt_ci(f2)} |")
    print("\n### Direct matches (blokee-match, 400 seeds 90,200,000; advantage = lone seat − mean of the three others)\n")
    print("| Match | Seeds | Lone seat's advantage [95% CI] | First place (any) | First place (split), par 25% |")
    print("|---|---:|---:|---:|---:|")
    fwd, rev = os.path.join(root, "h2h-fwd.jsonl"), os.path.join(root, "h2h-rev.jsonl")
    if os.path.exists(fwd):
        print(arm_line("one v5.1-ultra vs three v5.0-ultra", fwd))
    if os.path.exists(rev):
        print(arm_line("one v5.0-ultra vs three v5.1-ultra", rev))
    if os.path.exists(fwd) and os.path.exists(rev):
        a, b = per_seed(fwd), per_seed(rev)
        seeds = [s for s in a if s in b]
        print(f"\nCombined (descriptive): per seed (fwd − rev) / 2 = {fmt_ci(bootstrap([(a[s][0] - b[s][0]) / 2 for s in seeds]))} on {len(seeds)} seeds "
              "(positive = v5.1 better; the lone seat's advantage measured from both sides).")


def role_values(path):
    by = {}
    for g in games(path):
        if "+" in g["seat"]:
            continue
        i = TURN.index(g["seat"])
        mean = sum(g["scores"].values()) / 4
        by.setdefault(g["seed"], []).append([g["scores"][TURN[(i + k) % 4]] - mean for k in range(4)])
    by = {k: v for k, v in by.items() if len(v) == 4}
    return [bootstrap([sum(r[k] for r in v) / 4 for v in by.values()]) for k in range(4)]


def verdictB(root):
    """The Stage-B reading rule fixed in the prereg. Prints VERDICT (REAL / ARTEFACT / UNCLEAR) and PERSEAT."""
    shared, per = os.path.join(root, "b1-shared.jsonl"), os.path.join(root, "b1-perseat.jsonl")
    control = os.path.join(root, "b2-control.jsonl")
    if not all(os.path.exists(p) for p in (shared, per, control)):
        print("VERDICT: UNCLEAR (incomplete)")
        print("PERSEAT: no")
        return
    ns, np_, nc = role_values(shared)[1], role_values(per)[1], role_values(control)[1]
    hs, hp = (ns[2] - ns[1]) / 2, (np_[2] - np_[1]) / 2
    shrinks = ns[0] - np_[0] > (hs + hp) / 2 ** 0.5
    control_windfall = nc[1] > 0
    print(f"next seat: shared {fmt_ci(ns)}, per-seat {fmt_ci(np_)} (clearly smaller: {shrinks}); control next {fmt_ci(nc)} (above 0: {control_windfall})")
    if control_windfall or shrinks:
        v = "ARTEFACT"
    elif nc[1] <= 0 <= nc[2] and np_[1] > 0:
        v = "REAL"
    else:
        v = "UNCLEAR"
    n, d, _, _ = paired(per, shared)
    print(f"Blokee advantage per-seat - shared: {fmt_ci(d)} on {n} seeds")
    print(f"VERDICT: {v}")
    print(f"PERSEAT: {'yes' if d[1] > 0 or d[2] < 0 else 'no'}")


def roles(paths):
    """Score relative to the game mean by turn-order position relative to the reference seat (the lone
    seat, `seat`), bootstrap by seed."""
    print("| Log | Seeds | Lone seat | Next | Opposite | Previous |")
    print("|---|---:|---:|---:|---:|---:|")
    for path in paths:
        by = {}
        for g in games(path):
            if "+" in g["seat"]:
                continue
            i = TURN.index(g["seat"])
            mean = sum(g["scores"].values()) / 4
            rel = [g["scores"][TURN[(i + k) % 4]] - mean for k in range(4)]
            by.setdefault(g["seed"], []).append(rel)
        by = {k: v for k, v in by.items() if len(v) == 4}
        cols = [fmt_ci(bootstrap([sum(r[k] for r in v) / 4 for v in by.values()])) for k in range(4)]
        print(f"| `{path}` | {len(by)} | " + " | ".join(cols) + " |")


def role_times(path):
    """Mean Pentobi ms/move by role relative to the lone seat (timing log msBySeat)."""
    tp = path[: -len(".jsonl")] + ".timing.jsonl"
    if not os.path.exists(tp):
        return ""
    acc = [[] for _ in range(4)]
    for t in games(tp):
        i = TURN.index(t["seat"])
        for k in range(4):
            acc[k] += t["msBySeat"][TURN[(i + k) % 4]]
    return " / ".join(f"{sum(v) / len(v):.0f}" if v else "—" for v in acc)


def stageB(root):
    shared, per = os.path.join(root, "b1-shared.jsonl"), os.path.join(root, "b1-perseat.jsonl")
    control = os.path.join(root, "b2-control.jsonl")
    have = [p for p in (shared, per, control) if os.path.exists(p)]
    print("### Score relative to the game mean, by position relative to the lone seat (bootstrap by seed)\n")
    roles(have)
    print("\nms/move by role (lone / next / opposite / previous; wall, under match load):")
    for p in have:
        print(f"- `{p}`: {role_times(p)}")
    if os.path.exists(shared) and os.path.exists(per):
        n, d, f1, f2 = paired(per, shared)
        print(f"\nPaired, Blokee's advantage per-seat − shared processes, {n} seeds: {fmt_ci(d)}; first place (any) {fmt_ci(f1)} pp, (split) {fmt_ci(f2)} pp")
        print(arm_line("shared", shared).replace("| shared |", "- shared:"))
        print(arm_line("per-seat", per).replace("| per-seat |", "- per-seat:"))


def main():
    a = sys.argv
    if a[1] == "--verdictB":
        verdictB(a[2])
    elif a[1] == "--stageB":
        stageB(a[2])
    elif a[1] == "--stageA":
        stageA(a[2])
    elif a[1] == "--roles":
        roles(a[2:])


if __name__ == "__main__":
    main()
