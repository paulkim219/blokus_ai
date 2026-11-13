"""Write an E6 arm config: a base config plus a `native.net` (or `native.prior`) block.

    python ml/torch/e6_config.py <base.json> <out.json> <socket> net  [rootBlend=0.5 temperature=1 depth1Blend=0 depth1Temperature=1 valueVisits=0]
    python ml/torch/e6_config.py <base.json> <out.json> <socket> prior [blend=0.5 temperature=1 phase=all pseudoVisits=0]
"""
import json
import sys

base, out, socket, kind = sys.argv[1:5]
overrides = dict(a.split("=", 1) for a in sys.argv[5:])
params = json.load(open(base))
if kind == "net":
    block = {"socket": socket, "rootBlend": 0.5, "temperature": 1.0, "depth1Blend": 0.0, "depth1Temperature": 1.0, "valueVisits": 0.0}
elif kind == "prior":
    block = {"socket": socket, "blend": 0.5, "temperature": 1.0, "phase": "all", "pseudoVisits": 0}
else:
    sys.exit(f"unknown kind {kind}")
for key, value in overrides.items():
    if key not in block:
        sys.exit(f"unknown {kind} option {key}")
    block[key] = value if key == "phase" else float(value)
params["native"] = {kind: block}
json.dump(params, open(out, "w"), indent=1)
