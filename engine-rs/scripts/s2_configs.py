"""S2 config-only screen on the P4/P5 base: write one `v5.0-p4-ultra` variant per arm (one change).

    python3 engine-rs/scripts/s2_configs.py [out_dir]        # default tmp/s2/configs

Base is engine-rs/configs/v5.0-p4-ultra.json (`v4.2-ultra` + the accepted `FULLfit` candidates
block). Each arm is the base with exactly the change listed in ARMS. After writing, every file is
diffed against the base (flattened JSON paths; keys added by an arm count as changed) and the script
fails unless the changed paths are exactly the intended ones. The file stem (`s2-<ARM>`) is the
challenger name `blokee-pentobi` logs. Arms fixed in tmp/s2/ARMS-FIXED.md (2026-11-13) before the
first screen game; preregistration: research_paper/v6_native_and_learning_preregistered.md ("S2").
Run from the repository root.
"""
import copy
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from s1_configs import flatten  # noqa: E402

BASE = "engine-rs/configs/v5.0-p4-ultra.json"

# Pentobi-style rising budget: multiplier ∝ exp(0.1·i) for a seat's i-th own move (i = 0..20),
# normalised so the 21 multipliers sum to 21 (Engine::search scales the budget by shape[own_moves]).
_RAW = [math.exp(0.1 * i) for i in range(21)]
SHAPE = [round(21 * r / sum(_RAW), 6) for r in _RAW]


def search(**kv):
    def apply(c):
        for k, v in kv.items():
            c["search"][k] = v
    return apply


def candidates(**kv):
    def apply(c):
        for k, v in kv.items():
            assert k in c["native"]["candidates"], k
            c["native"]["candidates"][k] = v
    return apply


# (arm, human-readable change, transform, expected changed paths).
ARMS = [
    ("base", "v5.0-p4-ultra unchanged", lambda c: None, set()),
    ("C08", "search.cPuct 1.6 -> 0.8", search(cPuct=0.8), {"search.cPuct"}),
    ("C32", "search.cPuct 1.6 -> 3.2", search(cPuct=3.2), {"search.cPuct"}),
    ("O0", "search.openingHeuristicMaxOwnMove 3 -> 0 (search from the first move)",
     search(openingHeuristicMaxOwnMove=0), {"search.openingHeuristicMaxOwnMove"}),
    ("IV1", "native.candidates.initVisits 3 -> 1", candidates(initVisits=1), {"native.candidates.initVisits"}),
    ("SHAPE", "search.iterationShape (absent = 1.0) -> 21·exp(0.1·i)/Σ, i = own move 0..20 (0.308 … 2.277)",
     search(iterationShape=SHAPE), {"search.iterationShape"}),
    ("N96", "search.nodeShortlist 24 -> 96", search(nodeShortlist=96), {"search.nodeShortlist"}),
    ("E30", "search.playoutEps 0.6 -> 0.3 (not screened: replaced by N96)", search(playoutEps=0.3), {"search.playoutEps"}),
]


def collapse(path):
    return "search.iterationShape" if path.startswith("search.iterationShape.") else path


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "tmp/s2/configs"
    base = json.load(open(BASE))
    flat_base = flatten(base)
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    for arm, change, transform, expected in ARMS:
        c = copy.deepcopy(base)
        transform(c)
        flat = flatten(c)
        assert set(flat_base) <= set(flat), f"{arm}: a base key was removed"
        changed = {collapse(k) for k in set(flat) | set(flat_base) if flat.get(k) != flat_base.get(k)}
        assert changed == expected, f"{arm}: changed {sorted(changed)}, expected {sorted(expected)}"
        path = os.path.join(out_dir, f"s2-{arm}.json")
        with open(path, "w") as f:
            json.dump(c, f, indent=1)
            f.write("\n")
        diff = {k: [flat_base.get(k), flat[k]] for k in sorted(flat) if flat.get(k) != flat_base.get(k)}
        manifest.append({"arm": arm, "change": change, "config": path, "diff": diff})
        print(f"{arm:<6} {path}  {change}")
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
