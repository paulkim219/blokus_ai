#!/usr/bin/env python3
"""Round 11 (ultra) configs: v5.2-ultra plus a lazy interior cap, and the 1%-iterations noise reference.

usage: v58_configs.py <out dir>            writes U, U-1pct, U16-4, U16-8, U32-8, U64-16
       v58_configs.py <out dir> ET <arm> <cost>   writes <arm>-ET with iterationScale 3948.432 / cost
Run from the repo root. U is a byte copy of the source; the others keep its key order and change only the named fields.
"""
import json, os, shutil, sys

SRC = "engine-rs/configs/v5.2-ultra.json"
SCALE = 3948.432
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
base = json.load(open(SRC))
assert base["search"]["iterationScale"] == SCALE and "interiorCap" not in base["native"]["candidates"]


def write(name, cfg):
    with open(os.path.join(out, f"{name}.json"), "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")


def capped(init, growth):
    c = json.loads(json.dumps(base))
    c["native"]["candidates"]["interiorCap"] = {"init": init, "growth": growth, "exponent": 0.5, "lazy": True}
    return c


if len(sys.argv) > 2 and sys.argv[2] == "ET":
    arm, cost = sys.argv[3], float(sys.argv[4])
    c = json.load(open(os.path.join(out, f"{arm}.json")))
    c["search"]["iterationScale"] = round(SCALE / cost, 3)
    write(f"{arm}-ET", c)
    print(f"{arm}-ET: iterationScale {SCALE} -> {c['search']['iterationScale']} ({SCALE} / {cost})")
else:
    shutil.copyfile(SRC, os.path.join(out, "U.json"))  # the control is a byte copy
    n = json.loads(json.dumps(base))
    n["search"]["iterationScale"] = round(SCALE * 1.01, 3)
    write("U-1pct", n)
    for i, g in [(16, 4), (16, 8), (32, 8), (64, 16)]:
        write(f"U{i}-{g}", capped(i, g))
