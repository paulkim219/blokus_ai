"""Round 8 (prereg 2026-11-16, "round 8" entry) arm configs.

    python3 engine-rs/scripts/v55_configs.py setup ROOT TIERCONFIG ARM...   # ROOT/configs/{base,ARM}.json + manifest.json
    python3 engine-rs/scripts/v55_configs.py retime ROOT ARM RATIO          # ROOT/configs/ARM-ET.json (iterationScale / RATIO)

Arms (W1, `native.candidates.interiorCap`, exponent 0.5): W1A init 4 growth 1; W1C init 2 growth 0.5;
W1D init 16 growth 4. The base arm is the tier's v5.2 config unchanged.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from v51b_configs import retime  # noqa: E402

ARMS = {
    "W1A": {"init": 4, "growth": 1, "exponent": 0.5},
    "W1C": {"init": 2, "growth": 0.5, "exponent": 0.5},
    "W1D": {"init": 16, "growth": 4, "exponent": 0.5},
}


def setup(root, tier_config, arms):
    os.makedirs(os.path.join(root, "configs"), exist_ok=True)
    base = json.load(open(tier_config))
    json.dump(base, open(os.path.join(root, "configs", "base.json"), "w"), indent=1)
    man = {"base": f"{tier_config} unchanged (iterationScale {base['search']['iterationScale']})"}
    for a in arms:
        c = json.loads(json.dumps(base))
        c["native"]["candidates"]["interiorCap"] = ARMS[a]
        json.dump(c, open(os.path.join(root, "configs", f"{a}.json"), "w"), indent=1)
        cap = ARMS[a]
        man[a] = f"interiorCap floor({cap['init']} + {cap['growth']} * N^{cap['exponent']})"
    json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)
    open(os.path.join(root, "ARMS"), "w").write(" ".join(arms) + "\n")


if __name__ == "__main__":
    a = sys.argv
    if a[1] == "setup":
        setup(a[2], a[3], a[4:])
    elif a[1] == "retime":
        retime(a[2], a[3], float(a[4]))
