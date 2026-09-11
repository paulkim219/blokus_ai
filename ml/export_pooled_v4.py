"""Convert selected pooled-policy NPZ checkpoints into the browser-safe JSON engine format."""

import argparse
import json

import numpy as np


def values(saved, at):
    return saved[f"weight_{at}"].astype(np.float32).reshape(-1).tolist()


def member(path):
    saved = np.load(path)
    return {
        "source": path,
        "mean": saved["mean"].astype(np.float32).tolist(),
        "scale": saved["scale"].astype(np.float32).tolist(),
        "conv": [
            {"kernel": values(saved, at), "bias": values(saved, at + 1),
             "gamma": values(saved, at + 2), "beta": values(saved, at + 3)}
            for at in (0, 4, 8)
        ],
        "vector": {"w": values(saved, 12), "b": values(saved, 13)},
        "scorer": {"w": values(saved, 14), "b": values(saved, 15)},
        "head": {"w": values(saved, 16), "b": values(saved, 17)},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True, help="comma-separated checkpoint NPZ files")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    raw = {
        "kind": "pooled-policy-v45",
        "featureCount": 256,
        "boardSize": 20,
        "channels": 16,
        "vectorWidth": 96,
        "hiddenWidth": 64,
        "members": [member(path) for path in args.weights.split(',')],
    }
    with open(args.out, "w") as handle:
        json.dump(raw, handle, separators=(",", ":"))
        handle.write("\n")
    print(f"wrote {len(raw['members'])} member(s) to {args.out}")


if __name__ == "__main__":
    main()
