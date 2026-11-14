"""Arm configs for engine-rs/scripts/screen-chain.sh: each arm is the base config plus dotted-path changes.

    python3 engine-rs/scripts/chain_configs.py ROOT BASE.json ARMS.json

ARMS.json: {"arm": {"change": "text", "set": {"search.cPuct": 0.8, ...}, "model": "ml/....json"}, ...}
"model" replaces native.candidates.model with that file's "features" and "bands" (nothing else).
Writes ROOT/configs/base.json (a copy of BASE), ROOT/configs/<arm>.json, ROOT/manifest.json and
ROOT/ARMS; prints each arm's differences from base.
"""
import json
import os
import sys


def setp(d, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value


def flat(d, prefix=""):
    out = {}
    for k, v in d.items():
        p = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict) and k != "model":
            out.update(flat(v, p))
        else:
            out[p] = v
    return out


def main():
    root, base_path, arms_path = sys.argv[1:4]
    base = json.load(open(base_path))
    arms = json.load(open(arms_path))
    os.makedirs(os.path.join(root, "configs"), exist_ok=True)
    json.dump(base, open(os.path.join(root, "configs", "base.json"), "w"), indent=1)
    manifest = {"base": f"{os.path.basename(base_path)} unchanged"}
    for arm, spec in arms.items():
        c = json.loads(json.dumps(base))
        for path, value in spec.get("set", {}).items():
            setp(c, path, value)
        if "model" in spec:
            m = json.load(open(spec["model"]))
            c["native"]["candidates"]["model"] = {"features": m["features"], "bands": m["bands"]}
        json.dump(c, open(os.path.join(root, "configs", f"{arm}.json"), "w"), indent=1)
        manifest[arm] = spec["change"]
        fb, fa = flat(base), flat(c)
        diff = {k: fa.get(k) for k in set(fb) | set(fa) if fb.get(k) != fa.get(k)}
        print(f"{arm}: {', '.join(f'{k} = {json.dumps(v)[:60]}' for k, v in sorted(diff.items()))}")
    json.dump(manifest, open(os.path.join(root, "manifest.json"), "w"), indent=1)
    open(os.path.join(root, "ARMS"), "w").write(" ".join(arms) + "\n")


if __name__ == "__main__":
    main()
