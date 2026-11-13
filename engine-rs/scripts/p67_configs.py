"""P6/P7 (RAVE, last-good-reply) and the P3B re-test: write one `v5.0-p4-ultra` variant per arm.

    python3 engine-rs/scripts/p67_configs.py [out_dir]                    # default tmp/p67/configs
    python3 engine-rs/scripts/p67_configs.py out_dir --combo NAME A B ...  # also NAME = arms A, B, ... merged
    python3 engine-rs/scripts/p67_configs.py out_dir --equal-time ARM R    # also ARM-ET: iterationScale 16/R

Base is engine-rs/configs/v5.0-p4-ultra.json. Each arm adds `native.rave`, `native.lastGoodReply`,
`native.rollout` and/or `native.reward` (engine-rs/README.md, "RAVE and last-good-reply (P6/P7)");
after writing, every file is diffed against the base (flattened JSON paths) and the script fails unless
the changed paths are exactly the intended ones. The file stem (`p67-<ARM>`) is the name
`blokee-pentobi` logs. `--combo` and `--equal-time` are used only by the chain's confirmation step
(preregistered rule); they may be given together (the equal-time arm of a combination).

Values (fixed before any screen game; preregistration 2026-11-13, "P6/P7"):
- RAVE: `equivalence` 100 and `distanceDecay` 0.5 in every arm; strength is the weight on AMAF
  samples: 0.05 (weak) or 0.5 (strong). On 60 X1 positions at own moves 3-8 (`p67_probe stats`, base
  search, weight 1) an unvisited root edge has a median AMAF weight of about 37 against 3 initial
  visits, so beta on such an edge is about 0.38 (weak) or 0.85 (strong); for an edge with 50 real
  visits and 200 AMAF samples about 0.15 / 0.49; for the top edge (about 2,000 visits) under 0.05.
  Scope "all" (interior nodes too) except `R6SR` (root only).
- last-good-reply: LGR-1 keyed on the previous placement, with forgetting.
- P3B: exactly this morning's P3B (`p13_configs.py`).
- P1L rollout weights: this morning's fit (`p13_configs.py`, `ml/v5-rollout-fit.json`).
Run from the repository root.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from s1_configs import flatten  # noqa: E402

BASE = "engine-rs/configs/v5.0-p4-ultra.json"

RAVE_WEAK = {"weight": 0.05, "equivalence": 100.0, "distanceDecay": 0.5, "scope": "all"}
RAVE_STRONG = {"weight": 0.5, "equivalence": 100.0, "distanceDecay": 0.5, "scope": "all"}
RAVE_STRONG_ROOT = dict(RAVE_STRONG, scope="root")
LGR = {"enabled": True, "forget": True}
P1L = {"policy": "all", "sizeWeight": 1.3995, "localWeight": 0.7185, "localOwnExtra": 0.6515}
P3B = {"kind": "rank", "qualityWeight": 0.25, "qualitySlope": 1.0, "lengthWeight": 0.1}
ID_RAVE = {"weight": 0.0, "equivalence": 100.0, "distanceDecay": 0.5, "scope": "all"}
ID_LGR = {"enabled": False, "forget": True}

KEYS = {"rave": "rave", "lgr": "lastGoodReply", "rollout": "rollout", "reward": "reward"}


def blocks(**kw):
    """{config key: block} for the native blocks given."""
    return {KEYS[k]: dict(v) for k, v in kw.items() if v is not None}


def native(b):
    def apply(c):
        for k, v in b.items():
            c["native"][k] = dict(v)
    return apply


def paths(b):
    return {f"native.{k}.{f}" for k, v in b.items() for f in v}


# (arm, mechanism(s), human-readable change, native blocks).
ARMS = [
    ("base", (), "v5.0-p4-ultra unchanged", {}),
    ("ID", (), "identity point: native.rave weight 0, native.lastGoodReply enabled false (gates only)",
     blocks(rave=ID_RAVE, lgr=ID_LGR)),
    ("P3B", ("P3",), "P3B re-test: rank reward + quality bonus 0.25, length 0.1 (as screened 2026-11-13 on 83,000,000)",
     blocks(reward=P3B)),
    ("R6W", ("RAVE",), "RAVE weak: AMAF weight 0.05, equivalence 100, distance decay 0.5, all nodes", blocks(rave=RAVE_WEAK)),
    ("R6S", ("RAVE",), "RAVE strong: AMAF weight 0.5, equivalence 100, distance decay 0.5, all nodes", blocks(rave=RAVE_STRONG)),
    ("R6SR", ("RAVE",), "RAVE strong at the root only (AMAF weight 0.5, equivalence 100, decay 0.5)", blocks(rave=RAVE_STRONG_ROOT)),
    ("L7", ("LGR",), "last-good-reply (LGR-1, previous placement, with forgetting)", blocks(lgr=LGR)),
    ("R6SL7", ("RAVE", "LGR"), "R6S and L7 together", blocks(rave=RAVE_STRONG, lgr=LGR)),
    ("R6SP1L", ("RAVE", "P1"), "R6S with the all-legal-moves rollout (P1L fitted weights 1.3995 / 0.7185 / 0.6515)",
     blocks(rave=RAVE_STRONG, rollout=P1L)),
]

SCREEN = ["P3B", "R6W", "R6S", "R6SR", "L7", "R6SL7", "R6SP1L"]


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
    out_dir = args[0] if args else "tmp/p67/configs"
    base = json.load(open(BASE))
    flat_base = flatten(base)
    os.makedirs(out_dir, exist_ok=True)
    arms = list(ARMS)
    if combo:
        name, parts = combo
        merged, mech = {}, ()
        for p in parts:
            src = next(a for a in ARMS if a[0] == p)
            for k, v in src[3].items():
                assert k not in merged or merged[k] == v, f"--combo: {p} conflicts on native.{k}"
                merged[k] = v
            mech += src[1]
        arms.append((name, tuple(dict.fromkeys(mech)), " + ".join(parts) + " together", merged))
    if equal_time:
        name, ratio = equal_time
        src = next(a for a in arms if a[0] == name)
        scale = round(base["search"]["iterationScale"] / ratio, 3)
        arms.append((f"{name}-ET", src[1], f"{name} at equal time: search.iterationScale 16 -> {scale} (16 / {ratio})",
                     dict(src[3], __scale=scale)))
    manifest = []
    for arm, mech, change, b in arms:
        c = copy.deepcopy(base)
        b = dict(b)
        scale = b.pop("__scale", None)
        native(b)(c)
        expected = paths(b)
        if scale is not None:
            c["search"]["iterationScale"] = scale
            expected |= {"search.iterationScale"}
        flat = flatten(c)
        assert set(flat_base) <= set(flat), f"{arm}: a base key was removed"
        changed = {k for k in set(flat) | set(flat_base) if flat.get(k) != flat_base.get(k)}
        assert changed == expected, f"{arm}: changed {sorted(changed)}, expected {sorted(expected)}"
        path = os.path.join(out_dir, f"p67-{arm}.json")
        with open(path, "w") as f:
            json.dump(c, f, indent=1)
            f.write("\n")
        diff = {k: [flat_base.get(k), flat[k]] for k in sorted(flat) if flat.get(k) != flat_base.get(k)}
        manifest.append({"arm": arm, "mechanisms": list(mech), "change": change, "config": path, "diff": diff})
        print(f"{arm:<10} {path}  {change}")
    # Keep entries written by earlier --combo/--equal-time calls.
    mpath = os.path.join(out_dir, "manifest.json")
    if os.path.exists(mpath):
        names = {m["arm"] for m in manifest}
        manifest += [m for m in json.load(open(mpath)) if m["arm"] not in names]
    with open(mpath, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
