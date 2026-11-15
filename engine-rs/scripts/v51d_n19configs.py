"""Round 4 Stage 2 (N19) arms on v5.1-ultra. python3 engine-rs/scripts/v51d_n19configs.py tmp/v51d/S2"""
import copy, json, os, sys

root = sys.argv[1]
base = json.load(open("engine-rs/configs/v5.1-ultra.json"))
load = lambda n: {k: v for k, v in json.load(open(f"tmp/v51d/n19/fit/n19-{n}.json")).items() if k in ("features", "bands", "note")}
exact, cheap = load("exact"), load("cheap")
current = base["native"]["candidates"]["model"]
arms = {
    "R-EX": ("root: N19 exact model (39 features + own gain + removed from next/opposite/previous); interior: current model", exact, current),
    "R-CH": ("root: N19 cheap model (39 + per-cell pressure on the three opponents + own corner gain); interior: current model", cheap, current),
    "A-EX": ("root and interior: N19 exact model", exact, None),
}
os.makedirs(os.path.join(root, "configs"), exist_ok=True)
json.dump(base, open(os.path.join(root, "configs", "base.json"), "w"), indent=1)
man = {"base": "engine-rs/configs/v5.1-ultra.json unchanged (iterationScale 14.224)"}
for name, (desc, root_model, interior_model) in arms.items():
    c = copy.deepcopy(base)
    c["native"]["candidates"]["model"] = root_model
    if interior_model is not None and interior_model is not root_model:
        c["native"]["candidates"]["interiorModel"] = interior_model
    json.dump(c, open(os.path.join(root, "configs", f"{name}.json"), "w"), indent=1)
    man[name] = desc
json.dump(man, open(os.path.join(root, "manifest.json"), "w"), indent=1)
open(os.path.join(root, "ARMS"), "w").write(" ".join(arms) + "\n")
