"""Configs for the v5.1 candidate screen (preregistered 2026-11-14, "v5.1 candidates" entry in
research_paper/v6_native_and_learning_preregistered.md). Writes ROOT/configs/<arm>.json, ROOT/manifest.json,
ROOT/ARMS (screen arms in play order), ROOT/DARMS (compute diagnostics), ROOT/GROUPS.

    python3 engine-rs/scripts/v51_configs.py tmp/v51
"""
import copy
import json
import os
import sys

BASE = "engine-rs/configs/v5.0-ultra.json"
SCALE = 13.528

# arm: (group, description, edit(native, search))
def setp(path, value):
    def f(c):
        d = c
        for k in path[:-1]:
            d = d[k]
        d[path[-1]] = value
    return f

def drop(path):
    def f(c):
        d = c
        for k in path[:-1]:
            d = d[k]
        del d[path[-1]]
    return f

ARMS = [
    ("R-w025", "rave", "native.rave.weight 0.5 -> 0.25", setp(["native", "rave", "weight"], 0.25)),
    ("R-w1", "rave", "native.rave.weight 0.5 -> 1.0", setp(["native", "rave", "weight"], 1.0)),
    ("R-eq30", "rave", "native.rave.equivalence 100 -> 30", setp(["native", "rave", "equivalence"], 30.0)),
    ("R-eq300", "rave", "native.rave.equivalence 100 -> 300", setp(["native", "rave", "equivalence"], 300.0)),
    ("R-dd0", "rave", "native.rave.distanceDecay 0.5 -> 0 (no distance weighting)", setp(["native", "rave", "distanceDecay"], 0.0)),
    ("R-dd1", "rave", "native.rave.distanceDecay 0.5 -> 1.0 (weight falls linearly to 0 at the simulation's end)", setp(["native", "rave", "distanceDecay"], 1.0)),
    ("W-q0", "reward", "native.reward.qualityWeight 0.25 -> 0", setp(["native", "reward", "qualityWeight"], 0.0)),
    ("W-q05", "reward", "native.reward.qualityWeight 0.25 -> 0.5", setp(["native", "reward", "qualityWeight"], 0.5)),
    ("W-f25", "reward", "native.reward.firstWeight 0 -> 0.25 (new, R1)", setp(["native", "reward", "firstWeight"], 0.25)),
    ("W-f50", "reward", "native.reward.firstWeight 0 -> 0.5 (new, R1)", setp(["native", "reward", "firstWeight"], 0.5)),
    ("S-x01", "selection", "native.selection.exploration 0.2 -> 0.1", setp(["native", "selection", "exploration"], 0.1)),
    ("S-x04", "selection", "native.selection.exploration 0.2 -> 0.4", setp(["native", "selection", "exploration"], 0.4)),
    ("S-def", "selection", "native.selection removed (default PUCT rule; the package without priorLog)", drop(["native", "selection"])),
    ("O-nolgr", "other", "native.lastGoodReply removed (off)", drop(["native", "lastGoodReply"])),
    ("O-iiv1", "other", "native.candidates.interiorInitVisits 3 -> 1", setp(["native", "candidates", "interiorInitVisits"], 1.0)),
]
DARMS = [
    ("D-base", "diag", "v5.0-ultra unchanged (diagnostic block's own base)", lambda c: None),
    ("D-x2", "diag", f"search.iterationScale {SCALE} -> {SCALE * 2:.3f}", setp(["search", "iterationScale"], round(SCALE * 2, 3))),
    ("D-x05", "diag", f"search.iterationScale {SCALE} -> {SCALE / 2:.3f}", setp(["search", "iterationScale"], round(SCALE / 2, 3))),
]


def main():
    root = sys.argv[1]
    os.makedirs(os.path.join(root, "configs"), exist_ok=True)
    base = json.load(open(BASE))
    assert base["search"]["iterationScale"] == SCALE
    json.dump(base, open(os.path.join(root, "configs", "base.json"), "w"), indent=1)
    manifest = {"base": "engine-rs/configs/v5.0-ultra.json unchanged"}
    groups = {}
    for name, group, desc, edit in ARMS + DARMS:
        c = copy.deepcopy(base)
        edit(c)
        json.dump(c, open(os.path.join(root, "configs", f"{name}.json"), "w"), indent=1)
        manifest[name] = desc
        groups[name] = group
    json.dump(manifest, open(os.path.join(root, "manifest.json"), "w"), indent=1)
    json.dump(groups, open(os.path.join(root, "GROUPS"), "w"), indent=1)
    open(os.path.join(root, "ARMS"), "w").write(" ".join(a[0] for a in ARMS) + "\n")
    open(os.path.join(root, "DARMS"), "w").write(" ".join(a[0] for a in DARMS) + "\n")


if __name__ == "__main__":
    main()
