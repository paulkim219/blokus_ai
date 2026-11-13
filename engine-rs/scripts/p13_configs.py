"""P1–P3 (rollout policy over all legal moves, incremental move lists, rank reward): write one
`v5.0-p4-ultra` variant per arm.

    python3 engine-rs/scripts/p13_configs.py [out_dir]                 # default tmp/p13/configs
    python3 engine-rs/scripts/p13_configs.py out_dir --equal-time ARM R  # also ARM-ET: iterationScale 16/R

Base is engine-rs/configs/v5.0-p4-ultra.json. Each arm adds `native.rollout` and/or `native.reward`
(engine-rs/README.md, "Rollout policy and reward (P1–P3)"); after writing, every file is diffed
against the base (flattened JSON paths) and the script fails unless the changed paths are exactly
the intended ones. The file stem (`p13-<ARM>`) is the name `blokee-pentobi` logs.

P1 weights come from `ml/p13_fit_rollout.py` on the X1 level-6 games (Pentobi's decisions at own move
>= 3, test = seeds ending in 4 or 9), written to tmp/p13/fit/fit.json and copied here so the arms are
fixed in the repository:
  size + local + localOwn:  sizeWeight 1.3995, localWeight 0.7185, localOwnExtra 0.6515
  size only:                sizeWeight 1.4347
`P1X` keeps the fitted size and own-corner weights and makes local response dominate size: a local
square (6.0) outweighs the whole size range (4 × 1.3995 = 5.6), so a move covering more local squares
is almost always preferred whatever its size. P3 values are a two-point grid (see the preregistration).
Run from the repository root.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from s1_configs import flatten  # noqa: E402

BASE = "engine-rs/configs/v5.0-p4-ultra.json"

FIT = {"policy": "all", "sizeWeight": 1.3995, "localWeight": 0.7185, "localOwnExtra": 0.6515}
SIZE_ONLY = {"policy": "all", "sizeWeight": 1.4347, "localWeight": 0.0, "localOwnExtra": 0.0}
STEEP = {"policy": "all", "sizeWeight": 1.3995, "localWeight": 6.0, "localOwnExtra": 0.6515}
P3A = {"kind": "rank", "qualityWeight": 0.1, "qualitySlope": 1.0, "lengthWeight": 0.1}
P3B = {"kind": "rank", "qualityWeight": 0.25, "qualitySlope": 1.0, "lengthWeight": 0.1}


def native(rollout=None, reward=None):
    def apply(c):
        if rollout is not None:
            c["native"]["rollout"] = dict(rollout)
        if reward is not None:
            c["native"]["reward"] = dict(reward)
    return apply


def paths(prefix, block):
    return {f"native.{prefix}.{k}" for k in block}


# (arm, human-readable change, transform, expected changed paths).
ARMS = [
    ("base", "v5.0-p4-ultra unchanged", lambda c: None, set()),
    ("ID", "identity point: native.rollout policy sampled, native.reward kind blend (gates only)",
     native({"policy": "sampled"}, {"kind": "blend"}), {"native.rollout.policy", "native.reward.kind"}),
    ("P1S", "rollout over all legal moves, size weight only (fitted 1.4347)", native(SIZE_ONLY), paths("rollout", SIZE_ONLY)),
    ("P1L", "rollout over all legal moves, size + local response (fitted 1.3995 / 0.7185 / own ×0.6515)", native(FIT), paths("rollout", FIT)),
    ("P1X", "rollout over all legal moves, size + steep local response (local 6.0; size and own as fitted)", native(STEEP), paths("rollout", STEEP)),
    ("P3A", "rank reward + quality bonus 0.1 (tanh of the standardised margin), length 0.1", native(reward=P3A), paths("reward", P3A)),
    ("P3B", "rank reward + quality bonus 0.25 (tanh of the standardised margin), length 0.1", native(reward=P3B), paths("reward", P3B)),
    ("P1LP3B", "P1L and P3B together", native(FIT, P3B), paths("rollout", FIT) | paths("reward", P3B)),
]


def main():
    args = [a for a in sys.argv[1:]]
    equal_time = None
    if "--equal-time" in args:
        i = args.index("--equal-time")
        equal_time = (args[i + 1], float(args[i + 2]))
        del args[i:i + 3]
    out_dir = args[0] if args else "tmp/p13/configs"
    base = json.load(open(BASE))
    flat_base = flatten(base)
    os.makedirs(out_dir, exist_ok=True)
    arms = list(ARMS)
    if equal_time:
        name, ratio = equal_time
        src = next(a for a in ARMS if a[0] == name)
        scale = round(base["search"]["iterationScale"] / ratio, 3)

        def et(c, f=src[2], scale=scale):
            f(c)
            c["search"]["iterationScale"] = scale

        arms.append((f"{name}-ET", f"{name} at equal time: search.iterationScale 16 -> {scale} (16 / {ratio})", et,
                     src[3] | {"search.iterationScale"}))
    manifest = []
    for arm, change, transform, expected in arms:
        c = copy.deepcopy(base)
        transform(c)
        flat = flatten(c)
        assert set(flat_base) <= set(flat), f"{arm}: a base key was removed"
        changed = {k for k in set(flat) | set(flat_base) if flat.get(k) != flat_base.get(k)}
        assert changed == expected, f"{arm}: changed {sorted(changed)}, expected {sorted(expected)}"
        path = os.path.join(out_dir, f"p13-{arm}.json")
        with open(path, "w") as f:
            json.dump(c, f, indent=1)
            f.write("\n")
        diff = {k: [flat_base.get(k), flat[k]] for k in sorted(flat) if flat.get(k) != flat_base.get(k)}
        manifest.append({"arm": arm, "change": change, "config": path, "diff": diff})
        print(f"{arm:<8} {path}  {change}")
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
