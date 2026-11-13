"""S1 config-only screen: write one `v4.2-ultra` variant per arm (one knob, or the stated pair).

    python3 engine-rs/scripts/s1_configs.py [out_dir]        # default tmp/s1/configs

Each arm is `engine-rs/configs/v4.2-ultra.json` with exactly the changes listed in ARMS. After
writing, every file is diffed against the base (flattened JSON paths) and the script fails unless
the changed paths are exactly the intended ones. The file stem (`s1-<ARM>`) is the challenger name
`blokee-pentobi` logs, so each arm's JSONL is self-describing. Run from the repository root.
"""
import copy
import json
import os
import sys

BASE = "engine-rs/configs/v4.2-ultra.json"
PHASES = ("opening", "midgame", "endgame")


def search(**kv):
    def apply(c):
        for k, v in kv.items():
            assert k in c["search"], k
            c["search"][k] = v
    return apply


def centre_pull_zero(c):
    for p in PHASES:
        c["ordering"][p]["centrePull"] = 0


def aggression(c):
    c["aggressionScale"] = 1.4


# (arm, human-readable change, transform). Fixed before any S1 result was seen.
ARMS = [
    ("base", "v4.2-ultra unchanged", lambda c: None),
    ("W96", "rootShortlist 40 -> 96", search(rootShortlist=96)),
    ("W400", "rootShortlist 40 -> 400", search(rootShortlist=400)),
    ("W400open", "rootShortlist 40 -> 400 and wideningInit 8 -> 400", search(rootShortlist=400, wideningInit=400)),
    ("N96", "nodeShortlist 24 -> 96", search(nodeShortlist=96)),
    ("O0", "openingHeuristicMaxOwnMove 3 -> 0", search(openingHeuristicMaxOwnMove=0)),
    ("C0", "ordering.centrePull -> 0 in all phases (opening 0.55, midgame 0.15; endgame already 0)", centre_pull_zero),
    ("R0", "rankBlend 0.35 -> 0", search(rankBlend=0.0)),
    ("R100", "rankBlend 0.35 -> 1.0", search(rankBlend=1.0)),
    ("MAXN", "opponentPolicy auto -> maxn", search(opponentPolicy="maxn")),
    ("B4", "playoutCorners 1 -> 4 and playoutMoveCap 12 -> 48", search(playoutCorners=4, playoutMoveCap=48)),
    ("E30", "playoutEps 0.6 -> 0.3", search(playoutEps=0.3)),
    ("A140", "aggressionScale 1 -> 1.4", aggression),
]

EXPECTED = {
    "base": set(),
    "W96": {"search.rootShortlist"},
    "W400": {"search.rootShortlist"},
    "W400open": {"search.rootShortlist", "search.wideningInit"},
    "N96": {"search.nodeShortlist"},
    "O0": {"search.openingHeuristicMaxOwnMove"},
    "C0": {"ordering.opening.centrePull", "ordering.midgame.centrePull"},  # endgame is already 0
    "R0": {"search.rankBlend"},
    "R100": {"search.rankBlend"},
    "MAXN": {"search.opponentPolicy"},
    "B4": {"search.playoutCorners", "search.playoutMoveCap"},
    "E30": {"search.playoutEps"},
    "A140": {"aggressionScale"},
}


def flatten(x, prefix=""):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            out.update(flatten(v, f"{prefix}{k}."))
        return out
    if isinstance(x, list):
        out = {}
        for i, v in enumerate(x):
            out.update(flatten(v, f"{prefix}{i}."))
        return out
    return {prefix[:-1]: x}


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "tmp/s1/configs"
    base = json.load(open(BASE))
    flat_base = flatten(base)
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    for arm, change, transform in ARMS:
        c = copy.deepcopy(base)
        transform(c)
        flat = flatten(c)
        assert flat.keys() == flat_base.keys(), f"{arm}: key set changed"
        changed = {k for k in flat if flat[k] != flat_base[k]}
        assert changed == EXPECTED[arm], f"{arm}: changed {sorted(changed)}, expected {sorted(EXPECTED[arm])}"
        path = os.path.join(out_dir, f"s1-{arm}.json")
        with open(path, "w") as f:
            json.dump(c, f, indent=1)
            f.write("\n")
        manifest.append({"arm": arm, "change": change, "config": path,
                         "diff": {k: [flat_base[k], flat[k]] for k in sorted(changed)}})
        print(f"{arm:<9} {path}  {', '.join(f'{k}: {flat_base[k]} -> {flat[k]}' for k in sorted(changed)) or '(identical to base)'}")
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
