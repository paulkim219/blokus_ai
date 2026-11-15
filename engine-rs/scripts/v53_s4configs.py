"""Round 6 Stage 4 arms: one change each on v5.2-<tier> (nano, lite, base).
python3 engine-rs/scripts/v53_s4configs.py tmp/v53/S4"""
import copy, json, os, sys

root = sys.argv[1]
ARMS = {
    "RW05": (["native", "rave", "weight"], 0.5, "RAVE weight 1.0 -> 0.5"),
    "IIV3": (["native", "candidates", "interiorInitVisits"], 3.0, "interiorInitVisits 1 -> 3"),
    "T07": (["native", "candidates", "temperature"], 0.7, "prior temperature 1 -> 0.7 (sharper prior, root and interior)"),
    "X02": (["native", "selection", "exploration"], 0.2, "priorLog exploration 0.4 -> 0.2"),
    "CAP6": (["search", "playoutMoveCap"], 6, "playoutMoveCap 12 -> 6 (cheaper rollout moves)"),
}
for tier in ("nano", "lite", "base"):
    d = os.path.join(root, tier)
    os.makedirs(os.path.join(d, "configs"), exist_ok=True)
    base = json.load(open(f"engine-rs/configs/v5.2-{tier}.json"))
    json.dump(base, open(os.path.join(d, "configs", "base.json"), "w"), indent=1)
    man = {"base": f"engine-rs/configs/v5.2-{tier}.json unchanged (iterationScale {base['search']['iterationScale']})"}
    for name, (path, v, desc) in ARMS.items():
        c = copy.deepcopy(base)
        x = c
        for k in path[:-1]:
            x = x[k]
        x[path[-1]] = v
        json.dump(c, open(os.path.join(d, "configs", f"{name}.json"), "w"), indent=1)
        man[name] = desc
    json.dump(man, open(os.path.join(d, "manifest.json"), "w"), indent=1)
    open(os.path.join(d, "ARMS"), "w").write(" ".join(ARMS) + "\n")
