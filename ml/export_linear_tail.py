"""Distil the validated ridge skip head from a v4.7 residual artifact into a direct linear net.

The tail trainer initializes its mean path from ridge and stores those weights in `skipHead`.
For deterministic deployment, retaining the nonlinear variance trunk spends inference time on
outputs that are never read. This exporter preserves the ridge prediction exactly and drops that
dead computation.
"""

import argparse
import json
import os


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="input_path", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source = json.load(open(args.input_path))
    skip = source.get("skipHead")
    if not skip:
        raise ValueError(f"{args.input_path} has no ridge skipHead")
    artifact = {
        "featureCount": source["featureCount"],
        "featureNames": source.get("featureNames"),
        "mean": source["mean"],
        "scale": source["scale"],
        "layers": [],
        "head": skip,
        "outputContract": "backedValueMeans",
        "metrics": source.get("metrics"),
        "distilledFrom": args.input_path,
        "distillation": "exact ridge skip-head extraction; no fitted parameters changed",
    }
    json.dump(artifact, open(args.out, "w"))
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
