"""Configs for the second v5.1 round (preregistered 2026-11-14 13:30, "v5.1 round 2" entry in
research_paper/v6_native_and_learning_preregistered.md).

    python3 engine-rs/scripts/v51b_configs.py stage1 ROOT              # replication arms on v5.0-ultra
    python3 engine-rs/scripts/v51b_configs.py stage3 ROOT BASE.json    # rollout-cost arms on BASE
    python3 engine-rs/scripts/v51b_configs.py retime ROOT ARM RATIO    # ARM-ET: iterationScale / RATIO (from ARM)
    python3 engine-rs/scripts/v51b_configs.py correct ROOT ARM CHECK   # ARM-ET: iterationScale / CHECK (in place)
"""
import copy
import json
import os
import sys


def setp(c, path, value):
    d = c
    for k in path[:-1]:
        d = d.setdefault(k, {})
    d[path[-1]] = value


STAGE1 = {
    "IIV1": [(["native", "candidates", "interiorInitVisits"], 1.0)],
    "X04": [(["native", "selection", "exploration"], 0.4)],
    "COMBO": [(["native", "candidates", "interiorInitVisits"], 1.0), (["native", "selection", "exploration"], 0.4),
              (["native", "rave", "weight"], 1.0), (["native", "reward", "qualityWeight"], 0.5)],
}
STAGE3 = {
    "CAP6": [(["search", "playoutMoveCap"], 6)],
    "CAP24": [(["search", "playoutMoveCap"], 24)],
    "CUT32": [(["search", "playoutCutoff"], 32)],
    "COR2": [(["search", "playoutCorners"], 2)],
    "EPS4": [(["native", "rollout", "epsCap"], 4.0)],
}
DESC = lambda edits: " + ".join(f"{'.'.join(p)} -> {v}" for p, v in edits)


def build(root, base_path, arms):
    os.makedirs(os.path.join(root, "configs"), exist_ok=True)
    base = json.load(open(base_path))
    json.dump(base, open(os.path.join(root, "configs", "base.json"), "w"), indent=1)
    man = {"base": f"{base_path} unchanged (iterationScale {base['search']['iterationScale']})"}
    for name, edits in arms.items():
        c = copy.deepcopy(base)
        for p, v in edits:
            setp(c, p, v)
        json.dump(c, open(os.path.join(root, "configs", f"{name}.json"), "w"), indent=1)
        man[name] = DESC(edits)
    json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)
    open(os.path.join(root, "ARMS"), "w").write(" ".join(arms) + "\n")


def retime(root, arm, ratio, src_suffix=""):
    src = os.path.join(root, "configs", f"{arm}{src_suffix}.json")
    c = json.load(open(src))
    old = c["search"]["iterationScale"]
    c["search"]["iterationScale"] = round(old / ratio, 3)
    json.dump(c, open(os.path.join(root, "configs", f"{arm}-ET.json"), "w"), indent=1)
    man = json.load(open(os.path.join(root, "manifest.json")))
    prev = man.get(f"{arm}-ET") if src_suffix else None
    man[f"{arm}-ET"] = (prev + f"; corrected {old} -> {c['search']['iterationScale']} (/ {ratio:.4f})") if prev else \
        f"{man[arm]} at equal time: search.iterationScale {old} -> {c['search']['iterationScale']} ({old} / {ratio:.4f})"
    json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)
    print(c["search"]["iterationScale"])


if __name__ == "__main__":
    cmd, root = sys.argv[1], sys.argv[2]
    if cmd == "stage1":
        build(root, "engine-rs/configs/v5.0-ultra.json", STAGE1)
    elif cmd == "stage3":
        build(root, sys.argv[3], STAGE3)
    elif cmd == "retime":
        retime(root, sys.argv[3], float(sys.argv[4]))
    elif cmd == "correct":
        retime(root, sys.argv[3], float(sys.argv[4]), src_suffix="-ET")
