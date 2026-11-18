#!/usr/bin/env python3
"""High-budget round (research_paper/v5_high_budget_results.md): probe configs into tmp/hb/configs.

Every config is a byte-level JSON transform of a recorded one, so its provenance is one line:
  pro-base         = tmp/v56/pro/configs/base.json (= engine-rs/configs/v5.2-pro.json)
  pro-W1D-ET       = tmp/v56/pro/configs/W1D-ET.json (round 9/10 candidate, iterationScale 239.172)
  pro-W1D-ET-lazy  = pro-W1D-ET + interiorCap.lazy true
  ultra-W1D        = engine-rs/configs/v5.2-ultra.json + interiorCap {16, 4, 0.5} (no re-timing; probe only)
  ultra-W1D-lazy   = ultra-W1D + interiorCap.lazy true
  <tier>-lazy      = engine-rs/configs/v5.3-<tier>.json + interiorCap.lazy true (identity only)
Run from the repo root of the worktree; ROOT defaults to /Users/paulkim/Blokee/tmp/hb.
"""
import json, os, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/Users/paulkim/Blokee/tmp/hb"
DATA = "/Users/paulkim/Blokee/tmp"
out = os.path.join(ROOT, "configs")
os.makedirs(out, exist_ok=True)


def load(p):
    with open(p) as f:
        return json.load(f)


def save(name, c):
    with open(os.path.join(out, name + ".json"), "w") as f:
        json.dump(c, f, indent=1)
        f.write("\n")


def lazy(c):
    c = json.loads(json.dumps(c))
    c["native"]["candidates"]["interiorCap"]["lazy"] = True
    return c


base = load(f"{DATA}/v56/pro/configs/base.json")
w1d = load(f"{DATA}/v56/pro/configs/W1D-ET.json")
save("pro-base", base)
save("pro-W1D-ET", w1d)
save("pro-W1D-ET-lazy", lazy(w1d))
ultra = load("engine-rs/configs/v5.2-ultra.json")
ultra["native"]["candidates"]["interiorCap"] = {"init": 16, "growth": 4, "exponent": 0.5}
save("ultra-W1D", ultra)
save("ultra-W1D-lazy", lazy(ultra))
for tier in ["v5.3-nano", "v5.3-lite", "v5.3", "v5.3-turbo"]:
    save(tier + "-lazy", lazy(load(f"engine-rs/configs/{tier}.json")))
print("wrote", sorted(os.listdir(out)))
