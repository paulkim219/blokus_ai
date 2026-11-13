"""P4/P5 screen arms: `v4.2-ultra` plus a `native.candidates` block (engine-rs/README.md,
"Candidate generation (P4/P5)"). The fitted model is copied inline from ml/v5-prior-weights.json, so
each config file is a complete description of its arm.

    python3 engine-rs/scripts/p4_configs.py [out_dir]        # default tmp/p4/configs

Every arm is checked: the only difference from the base config is the `native` key, and its
`candidates` block holds exactly the listed switches. `ID` is the identity point (the block present,
every switch at its default) and must play exactly as `base`. The arm list was fixed before the
first screen game (2026-11-13, 00:2x CST) and is recorded in
research_paper/v5_p4_p5_candidate_generation_results.md.
"""
import copy
import json
import os
import sys

BASE = "engine-rs/configs/v4.2-ultra.json"
MODEL = "ml/v5-prior-weights.json"

FULL = {"rootFull": True, "rootNoWidening": True, "initVisits": 3}

# (arm, human-readable change, candidates block or None for base).
ARMS = [
    ("base", "v4.2-ultra unchanged", None),
    ("ID", "identity point: native.candidates present, every switch at its default", {}),
    ("FULLord", "(a) all legal root moves, today's ordering as prior (T 6), no root widening, n0 3",
     {**FULL, "rootScorer": "ordering"}),
    ("SLfit", "(b) root shortlist 40 chosen and ordered by the fitted prior (today's tree otherwise)",
     {"rootScorer": "fitted"}),
    ("FULLfit", "(c) all legal root moves, fitted prior, no root widening, n0 3",
     {**FULL, "rootScorer": "fitted"}),
    ("FULLfitI", "(c) + fitted prior chooses and orders the interior shortlist (24)",
     {**FULL, "rootScorer": "fitted", "interiorScorer": "fitted"}),
    ("SLfitI", "(b) + fitted prior chooses and orders the interior shortlist (24)",
     {"rootScorer": "fitted", "interiorScorer": "fitted"}),
    ("FULLfitN10", "(c) with n0 10 instead of 3",
     {**FULL, "rootScorer": "fitted", "initVisits": 10}),
    ("FULLfitW", "(c) with today's root widening kept (children enter in prior order, ~63 by 4,800 iterations)",
     {"rootFull": True, "initVisits": 3, "rootScorer": "fitted"}),
]
LIVE_ONLY = {"ID"}  # played in the liveness / identity check, not in the screen


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "tmp/p4/configs"
    base = json.load(open(BASE))
    model = json.load(open(MODEL))
    model_inline = {"features": model["features"], "bands": model["bands"]}
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    for arm, change, block in ARMS:
        c = copy.deepcopy(base)
        if block is not None:
            cand = dict(block)
            if "fitted" in (cand.get("rootScorer"), cand.get("interiorScorer")):
                cand["model"] = model_inline
            c["native"] = {"candidates": cand}
        changed = {k for k in set(c) | set(base) if c.get(k) != base.get(k)}
        assert changed == (set() if block is None else {"native"}), (arm, changed)
        path = os.path.join(out_dir, f"p4-{arm}.json")
        with open(path, "w") as f:
            json.dump(c, f, indent=1)
            f.write("\n")
        shown = {k: v for k, v in (block or {}).items()}
        manifest.append({"arm": arm, "change": change, "config": path, "candidates": shown, "screen": arm not in LIVE_ONLY})
        print(f"{arm:<11} {path}  {json.dumps(shown) if block is not None else '(base)'}")
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
