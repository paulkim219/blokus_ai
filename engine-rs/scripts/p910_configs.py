"""P9/P10 (selection rule, P4 at interior nodes, opening rules): write one `v5.0-p4-ultra` variant per arm.

    python3 engine-rs/scripts/p910_configs.py [out_dir]                    # default tmp/p910/configs
    python3 engine-rs/scripts/p910_configs.py out_dir --grid               # the tree-shape grid instead
    python3 engine-rs/scripts/p910_configs.py out_dir --combo NAME A B ...  # also NAME = arms A, B, ... merged
    python3 engine-rs/scripts/p910_configs.py out_dir --equal-time ARM R    # also ARM-ET: iterationScale 16/R

Base is engine-rs/configs/v5.0-p4-ultra.json. Each arm adds `native.selection`, keys of
`native.candidates`, `native.opening` and/or `search.openingHeuristicMaxOwnMove`
(engine-rs/README.md, "Selection rule, interior expansion and opening rules (P9/P10)"); after
writing, every file is diffed against the base (flattened JSON paths) and the script fails unless the
changed paths are exactly the intended ones. The file stem (`p910-<ARM>`) is the name
`blokee-pentobi` logs. `--combo` and `--equal-time` are used only by the chain's confirmation step.

Values (fixed before any screen game; preregistration 2026-11-13, "P9/P10"). No number is taken
from Pentobi's source:
- P4 at interior nodes: the interior node gets what the base gives the root: all legal moves scored
  by the fitted model at temperature 1, no widening, 3 initial visits (the base's `initVisits`).
- Selection rule "priorLog": exploration constants from the tree-shape grid (`--grid`, search
  internals only, `tmp/p910/diag/`); count offset 1 at nodes that are not value-initialised (as
  PUCT's 1 + n); cut-off 1 (exact: it changes no choice, only time).
- P9A centre rule: own moves 0-2 (the 90th percentile of Pentobi level 6's own moves 0-2 in the X1
  games is at the smallest centre distance, by our measure; from own move 3 it is not), slack 0;
  the opening shortcut is switched off so that those moves are searched at all.
- P9B rollout rule: 5-square pieces only while fewer than 31 pieces are on the board (Pentobi level
  6's moves in the X1 games are at least 90% five-square pieces up to 30 pieces on the board, 88% at 31).
Run from the repository root.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from s1_configs import flatten  # noqa: E402

BASE = "engine-rs/configs/v5.0-p4-ultra.json"

# Exploration constants of the priorLog rule, chosen from the tree-shape grid (tmp/p910/diag, search
# internals only; see the prereg entry): on 47 X1 positions Pentobi level 6's top root child holds 52%
# of the root's visits; priorLog alone gives 58% at 0.1 and 46% at 0.2 (the two grid values that
# bracket it), and with P4 at interior nodes 0.2 is the grid value whose tree is closest to level 6's
# (root: top child 47% vs 52%, 1.9 children hold half the visits in both; mean depth 6.1 vs 5.6).
C_A = 0.2
C_B = 0.1

INTERIOR = {"interiorFull": True, "interiorScorer": "fitted", "interiorNoWidening": True, "interiorInitVisits": 3.0}
ID_INTERIOR = {"interiorFull": False, "interiorNoWidening": False, "interiorInitVisits": 0.0}


def sel(c):
    return {"rule": "priorLog", "exploration": c, "scope": "all", "countOffset": 1.0, "cutoff": 1.0}


ID_SEL = {"rule": "puct", "exploration": 1.0, "scope": "all", "countOffset": 1.0, "cutoff": 0.0}
CENTRE = {"centreMaxOwnMove": 3.0, "centreSlack": 0.0}
ROLLOUT_LARGE = {"rolloutMinSize": 5.0, "rolloutUntilPieces": 31.0}
ID_OPENING = {"centreMaxOwnMove": 0.0, "centreSlack": 0.0, "rolloutMinSize": 0.0, "rolloutUntilPieces": 0.0}


def change(selection=None, interior=None, opening=None, search=None):
    """{dotted path: value} for the changes an arm makes."""
    out = {}
    for k, v in (selection or {}).items():
        out[f"native.selection.{k}"] = v
    for k, v in (interior or {}).items():
        out[f"native.candidates.{k}"] = v
    for k, v in (opening or {}).items():
        out[f"native.opening.{k}"] = v
    for k, v in (search or {}).items():
        out[f"search.{k}"] = v
    return out


def arms():
    """(arm, mechanism(s), human-readable change, changes)."""
    a = [
        ("base", (), "v5.0-p4-ultra unchanged", {}),
        ("ID", (), "identity point: selection puct (cut-off 0), interior options off, opening rules 0 (gates only)",
         change(selection=ID_SEL, interior=ID_INTERIOR, opening=ID_OPENING)),
        ("P4I", ("P4I",), "P4 at interior nodes: all legal moves, fitted prior, no widening, 3 initial visits",
         change(interior=INTERIOR)),
        ("P9A", ("P9A",), "P9A: opening searched (shortcut off) with the centre rule on own moves 0-2, slack 0",
         change(opening=CENTRE, search={"openingHeuristicMaxOwnMove": 0})),
        ("P9B", ("P9B",), "P9B: rollouts play 5-square pieces only while fewer than 31 pieces are on the board",
         change(opening=ROLLOUT_LARGE)),
        ("O0", ("O0",), "control for P9A: opening searched (shortcut off), no centre rule",
         change(search={"openingHeuristicMaxOwnMove": 0})),
    ]
    if C_A is not None:
        a += [
            ("P10A", ("P10",), f"P10 selection rule priorLog, exploration {C_A}, all nodes, cut-off 1", change(selection=sel(C_A))),
            ("P4IP10A", ("P4I", "P10"), f"P4I and P10A together (exploration {C_A})", change(selection=sel(C_A), interior=INTERIOR)),
        ]
    if C_B is not None:
        a += [("P10B", ("P10",), f"P10 selection rule priorLog, exploration {C_B}, all nodes, cut-off 1", change(selection=sel(C_B)))]
    return a


SCREEN = ["P10A", "P10B", "P4I", "P4IP10A", "P9A", "P9B", "O0"]  # copied to tmp/p910/ARMS before the screen

GRID_C = [0.05, 0.1, 0.2, 0.4, 0.8, 1.6]


def grid():
    g = [("base", (), "base", {}), ("P4I", ("P4I",), "P4I", change(interior=INTERIOR))]
    for c in GRID_C:
        g.append((f"S{c}", ("P10",), f"priorLog {c}", change(selection=sel(c))))
    for c in GRID_C:
        g.append((f"IS{c}", ("P4I", "P10"), f"P4I + priorLog {c}", change(selection=sel(c), interior=INTERIOR)))
    # PUCT with an exact cut-off: the cut-off alone must not change the tree.
    g.append(("CUT", (), "PUCT with cut-off 1", change(selection=dict(ID_SEL, cutoff=1.0))))
    return g


def apply(c, changes):
    for path, v in changes.items():
        node = c
        keys = path.split(".")
        for k in keys[:-1]:
            node = node.setdefault(k, {})
        node[keys[-1]] = v


def main():
    args = list(sys.argv[1:])
    equal_time = None
    combo = None
    if "--equal-time" in args:
        i = args.index("--equal-time")
        equal_time = (args[i + 1], float(args[i + 2]))
        del args[i:i + 3]
    if "--combo" in args:
        i = args.index("--combo")
        combo = (args[i + 1], args[i + 2:])
        del args[i:]
    is_grid = "--grid" in args
    args = [a for a in args if a != "--grid"]
    out_dir = args[0] if args else "tmp/p910/configs"
    base = json.load(open(BASE))
    flat_base = flatten(base)
    os.makedirs(out_dir, exist_ok=True)
    all_arms = grid() if is_grid else arms()
    if combo:
        name, parts = combo
        merged, mech = {}, ()
        for p in parts:
            src = next(a for a in all_arms if a[0] == p)
            for k, v in src[3].items():
                assert k not in merged or merged[k] == v, f"--combo: {p} conflicts on {k}"
                merged[k] = v
            mech += src[1]
        all_arms.append((name, tuple(dict.fromkeys(mech)), " + ".join(parts) + " together", merged))
    if equal_time:
        name, ratio = equal_time
        src = next(a for a in all_arms if a[0] == name)
        scale = round(base["search"]["iterationScale"] / ratio, 3)
        all_arms.append((f"{name}-ET", src[1], f"{name} at equal time: search.iterationScale 16 -> {scale} (16 / {ratio})",
                         dict(src[3], **{"search.iterationScale": scale})))
    manifest = []
    prefix = "p910g" if is_grid else "p910"
    for arm, mech, text, changes in all_arms:
        c = copy.deepcopy(base)
        apply(c, changes)
        flat = flatten(c)
        assert set(flat_base) <= set(flat), f"{arm}: a base key was removed"
        changed = {k for k in set(flat) | set(flat_base) if flat.get(k) != flat_base.get(k)}
        expected = {k for k, v in changes.items() if flat_base.get(k) != v}
        assert changed == expected, f"{arm}: changed {sorted(changed)}, expected {sorted(expected)}"
        path = os.path.join(out_dir, f"{prefix}-{arm}.json")
        with open(path, "w") as f:
            json.dump(c, f, indent=1)
            f.write("\n")
        diff = {k: [flat_base.get(k), flat[k]] for k in sorted(flat) if flat.get(k) != flat_base.get(k)}
        manifest.append({"arm": arm, "mechanisms": list(mech), "change": text, "config": path, "diff": diff})
        print(f"{arm:<10} {path}  {text}")
    mpath = os.path.join(out_dir, "manifest.json")
    if os.path.exists(mpath):
        names = {m["arm"] for m in manifest}
        manifest += [m for m in json.load(open(mpath)) if m["arm"] not in names]
    with open(mpath, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
