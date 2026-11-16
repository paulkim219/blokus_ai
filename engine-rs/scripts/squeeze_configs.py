#!/usr/bin/env python3
"""Writes the squeeze-benchmark adversary configs (docs/SQUEEZE_BENCHMARK.md).

Every adversary is `v5.2-pro`'s search with the reward replaced by kind "squeeze" (each adversary
seat values a finished game at 1 - target squares / 89) and playoutCutoff raised to 100 so every
rollout reaches the end of the game. Arms differ only in the two squeeze options; budgets only in
iterationScale. Run from the repo root:  python3 engine-rs/scripts/squeeze_configs.py
"""
import copy
import json
import os

BASE = "engine-rs/configs/v5.2-pro.json"
OUT = "engine-rs/configs/squeeze"

# Adversary arms (stage S1): SQ-P adds the target-pressure term to the fitted prior of every
# non-target seat (z-score units, as nextPressure); SQ-R makes a non-target rollout move block the
# target's corner cells with this probability.
ARMS = {
    "SQ0": {},
    "SQR": {"squeezeRollout": 0.5},
    "SQP": {"squeezePrior": 1.0},
    "SQRP": {"squeezeRollout": 0.5, "squeezePrior": 1.0},
}
# Adversary budgets (stage S2), as iterationScale at budget 300: the level-6 reference, 4x that,
# and the pro tier (about 0.9 s per adversary move on the M4 Pro).
BUDGETS = {"l6": 23.222, "l6x4": 92.888, "pro": 224.487}


def make(arm: str, budget: str) -> dict:
    with open(BASE) as f:
        config = json.load(f)
    c = copy.deepcopy(config)
    c["native"]["reward"] = {"kind": "squeeze", **ARMS[arm]}
    c["search"]["playoutCutoff"] = 100
    c["search"]["iterationScale"] = BUDGETS[budget]
    return c


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for arm in ARMS:
        for budget in BUDGETS:
            path = f"{OUT}/{arm}-{budget}.json"
            with open(path, "w") as f:
                json.dump(make(arm, budget), f, indent=1)
                f.write("\n")
            print(path)


if __name__ == "__main__":
    main()
