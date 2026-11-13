"""Does the network know something the search does not? (E5/E6 motivation, now a script.)

    ml/.venv-torch/bin/python ml/torch/fuel.py --checkpoint ml/torch/results/resnet-g18500-s0.pt

On held-out games (default 19,000–19,999 of the base run), over searched records with at least two
candidates, fits ordinary least squares (with intercept, in sample) for the mover's final outcome
from (a) the search's recorded `root_value`, (b) the network's mover margin head, (c) both, and
reports R² for two targets:

- `mean`: the mover's final `score − mean(others)` (the margin head's own target);
- `best`: the mover's final `score − best other` (what the search's utility is built on).

The increment `R²(both) − R²(root_value)` is what the net adds over the search's own value. Its 95%
interval is a percentile bootstrap that resamples whole games (300 resamples, seed 0). The same
table is repeated by ply band. For a model-v2 checkpoint, extra rows use the v2 heads (the
search-value head, and the logit of the mover's utility-margin head) as alternative net predictors.

This is outcome prediction on positions the search visited, not sibling ranking: it says nothing
by itself about whether the network would make the search play better.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from features import Encoder, Placements, policy_mask  # noqa: E402
from model import load_checkpoint, predict  # noqa: E402
from records import load_run  # noqa: E402
from train import device  # noqa: E402

BANDS = [(0, 20), (20, 40), (40, 60), (60, 1000)]


def r2(features: np.ndarray, target: np.ndarray) -> float:
    x = np.column_stack([np.ones(len(target)), features])
    coef, *_ = np.linalg.lstsq(x, target, rcond=None)
    residual = target - x @ coef
    centred = target - target.mean()
    return float(1.0 - residual @ residual / (centred @ centred))


def bootstrap(game: np.ndarray, fn, resamples: int = 300, seed: int = 0) -> tuple[float, float]:
    """Percentile 95% interval of fn(index) over resamples of whole games."""
    rng = np.random.default_rng(seed)
    ids, inverse = np.unique(game, return_inverse=True)
    rows = [np.nonzero(inverse == i)[0] for i in range(len(ids))]
    values = []
    for _ in range(resamples):
        pick = rng.integers(0, len(ids), len(ids))
        values.append(fn(np.concatenate([rows[i] for i in pick])))
    lo, hi = np.percentile(values, [2.5, 97.5])
    return float(lo), float(hi)


def table(root: np.ndarray, nets: dict[str, np.ndarray], targets: dict[str, np.ndarray], game: np.ndarray,
          index: np.ndarray, resamples: int) -> list[dict]:
    rows = []
    for target_name, y in targets.items():
        base = r2(root[index], y[index])
        for net_name, net in nets.items():
            net_only = r2(net[index], y[index])
            both = r2(np.column_stack([root[index], net[index]]), y[index])

            def increment(sub: np.ndarray, net=net, y=y) -> float:
                sub = index[sub]
                return r2(np.column_stack([root[sub], net[sub]]), y[sub]) - r2(root[sub], y[sub])

            lo, hi = bootstrap(game[index], increment, resamples) if resamples else (float("nan"), float("nan"))
            rows.append({
                "target": target_name, "net": net_name, "positions": int(len(index)),
                "rootValue": base, "netOnly": net_only, "both": both,
                "increment": both - base, "ciLow": lo, "ciHigh": hi,
            })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--run", default="ml/data/selfplay-v41u-300")
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--first-game", type=int, default=19000)
    parser.add_argument("--last-game", type=int, default=19999)
    parser.add_argument("--resamples", type=int, default=300)
    parser.add_argument("--band-resamples", type=int, default=300)
    parser.add_argument("--json", default=None, help="also write the rows here")
    args = parser.parse_args()

    dev = device()
    records, games = load_run(args.run)
    game = records["game"].astype(np.int64)
    keep = policy_mask(records) & (game >= args.first_game) & (game <= args.last_game)
    records = records[keep]
    game = game[keep]
    model, arm = load_checkpoint(args.checkpoint, dev)
    out = predict(model, Encoder(Placements(args.placements), dev), records)

    scores = np.array([games[int(g)]["scores"] for g in game], dtype=np.float64)
    seat = records["seat"].astype(np.int64)
    mine = scores[np.arange(len(seat)), seat]
    others = scores.copy()
    others[np.arange(len(seat)), seat] = -np.inf
    best_other = others.max(1)
    mean_other = (scores.sum(1) - mine) / 3.0
    targets = {"mean": mine - mean_other, "best": mine - best_other}
    root = records["root_value"].astype(np.float64)

    nets = {"margin": out["margins"][:, 0].astype(np.float64)}
    if "utility" in out:
        p = np.clip(out["utility"][:, 0, 0].astype(np.float64), 1e-6, 1 - 1e-6)
        nets["utilityMargin"] = 12.0 * np.log(p / (1 - p))
        nets["searchHead"] = out["search"].astype(np.float64)

    print(f"{arm} from {args.checkpoint}: games {args.first_game}–{args.last_game}, "
          f"{len(records):,} searched positions with ≥2 candidates, {len(np.unique(game))} games")
    everything = np.arange(len(records))
    rows = [r | {"band": "all"} for r in table(root, nets, targets, game, everything, args.resamples)]
    for lo, hi in BANDS:
        index = np.nonzero((records["ply"] >= lo) & (records["ply"] < hi))[0]
        if len(index) < 100:
            continue
        label = f"ply {lo}–{hi - 1}" if hi < 1000 else f"ply {lo}+"
        rows += [r | {"band": label} for r in table(root, nets, targets, game, index, args.band_resamples)]

    print(f"{'band':<10} {'target':<6} {'net':<14} {'n':>7} {'R² root':>8} {'R² net':>8} {'R² both':>8} {'net adds [95% CI]':>26}")
    for r in rows:
        print(f"{r['band']:<10} {r['target']:<6} {r['net']:<14} {r['positions']:>7} {r['rootValue']:>8.3f} {r['netOnly']:>8.3f} "
              f"{r['both']:>8.3f}   {r['increment']:+.3f} [{r['ciLow']:.3f}, {r['ciHigh']:.3f}]")
    if args.json:
        with open(args.json, "w") as handle:
            json.dump({"arm": arm, "checkpoint": args.checkpoint, "rows": rows}, handle, indent=1)


if __name__ == "__main__":
    main()
