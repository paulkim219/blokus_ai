"""Round 3 Stage D configs (preregistered 2026-11-14, "v5.1 round 3, Stage D" entry): one-change arms on
v5.0-ultra. python3 engine-rs/scripts/v51c_dconfigs.py tmp/v51c/D"""
import copy, json, os, sys

root = sys.argv[1]
base = json.load(open("engine-rs/configs/v5.0-ultra.json"))
arms = {
    "NP05": (["native", "candidates", "nextPressure"], 0.5),
    "NP10": (["native", "candidates", "nextPressure"], 1.0),
    "NW2": (["native", "reward", "nextWeight"], 2.0),
    "NW3": (["native", "reward", "nextWeight"], 3.0),
}
os.makedirs(os.path.join(root, "configs"), exist_ok=True)
json.dump(base, open(os.path.join(root, "configs", "base.json"), "w"), indent=1)
man = {"base": "engine-rs/configs/v5.0-ultra.json unchanged (iterationScale 13.528)"}
for name, (path, v) in arms.items():
    c = copy.deepcopy(base)
    d = c
    for k in path[:-1]:
        d = d[k]
    d[path[-1]] = v
    json.dump(c, open(os.path.join(root, "configs", f"{name}.json"), "w"), indent=1)
    man[name] = f"{'.'.join(path)} -> {v}"
json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)
open(os.path.join(root, "ARMS"), "w").write(" ".join(arms) + "\n")
