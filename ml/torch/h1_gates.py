"""Hybrid H1 offline gates (research_paper/v5_hybrid_preregistered.md, "H1"). Reads the test games only.

    ml/.venv-hybrid/bin/python ml/torch/h1_gates.py --checkpoint tmp/h1/train/<name>.pt \
        --teacher-cache tmp/h1/cache/L7 --n11-dump tmp/h1/n11/L7-test \
        --selfplay-cache tmp/h1/cache/turbo [--selfplay-cache2 tmp/h1/cache/pro] --out tmp/h1/gates.json

- **H1-G1** (top-40): on held-out Pentobi level-7 decisions (test seeds, last digit 9) at a seat's own
  moves 3–8 (pieces already placed 3..8) with at least 2 legal moves, the share of decisions where the
  move level 7 played is among the network's 40 highest-scoring legal moves (teacher head), ties
  counted in expectation as in N11 (`n11_fit_prior.metrics`). Reported beside v5.3's fitted prior
  (`ml/v5-prior-weights.json`, the bands in every v5.3 config) on the same decisions.
- **H1-G2** (log-likelihood): mean log-likelihood of level 7's move per decision, own moves 3+, network
  (teacher head, temperature 1, softmax over the legal moves) against the fitted prior (N11's tooling:
  `examples/n11_features.rs` features, `n11_fit_prior.scores`), paired by decision.
- **H1-G3** (value fuel): on held-out v5.3-turbo self-play games, searched records with ≥ 2 legal
  moves: R² of the mover's final `score − mean(others)` from the search's root value (the root's mean
  backed-up value for the mover, record v3) alone, and with the network's mover margin head added (OLS
  with intercept, in sample, as `fuel.py`); the increment with a 95% percentile bootstrap over games.

Intervals: 2,000 bootstrap resamples of whole games (G1, G2: paired differences), 300 for G3 (as
`fuel.py`). Seed 0.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from fuel import r2  # noqa: E402
from h1_data import Corpus, Tables, make_batch  # noqa: E402
from model import ARMS  # noqa: E402
from policy_index import PolicyIndex  # noqa: E402

BANDS = [("0-2", 0, 3), ("3-8", 3, 9), ("9-14", 9, 15), ("15+", 15, 22), ("3+", 3, 22)]


def load_model(path: str, dev) -> torch.nn.Module:
    ck = torch.load(path, map_location=dev)
    model = ARMS[ck["arm"]]().to(dev)
    model.load_state_dict(ck["state"])
    model.eval()
    return model


@torch.no_grad()
def network_teacher(model, tables, corpus: Corpus, rows: np.ndarray, head: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """Per decision: log-likelihood of the played move and the expected top-40 hit (ties in expectation)."""
    ll, top40 = [], []
    for lo in range(0, len(rows), 512):
        b = make_batch(tables, corpus, rows[lo : lo + 512])
        out = model(b["planes"], b["hands"], b["seat"])
        logits = out["policy"][:, head].masked_fill(~b["legal"], float("-inf"))
        logp = torch.log_softmax(logits, dim=1)
        chosen = corpus.chosen_index[torch.tensor(rows[lo : lo + 512], device=tables.dev)]
        s = logits.gather(1, chosen.view(-1, 1))
        greater = (logits > s).sum(1).float()
        equal = (logits == s).sum(1).float()
        ll.append(logp.gather(1, chosen.view(-1, 1)).squeeze(1).cpu().numpy())
        top40.append(((40 - greater) / equal).clamp(0, 1).cpu().numpy())
    return np.concatenate(ll).astype(np.float64), np.concatenate(top40).astype(np.float64)


def fitted_prior(dump_prefix: str, weights: str) -> dict[tuple[int, int], tuple[float, float]]:
    """(seed, ply) → (log-likelihood, expected top-40 hit) under the fitted prior, from an N11 dump."""
    from n11_fit_prior import Dump, scores  # ml/n11_fit_prior.py
    from p4_fit_prior import segment_softmax_stats

    d = Dump(dump_prefix)
    import csv
    recs = list(csv.DictReader(open(dump_prefix + ".csv")))
    plies = np.array([int(r["ply"]) for r in recs])
    block = d.block(np.ones(len(d.n), bool))
    s = scores(block, {"bands": json.load(open(weights))["bands"]})
    lse, _ = segment_softmax_stats(s, block.starts, block.counts)
    ll = s[block.label_rows] - lse
    sl = np.repeat(s[block.label_rows], block.counts)
    greater = np.add.reduceat((s > sl).astype(np.int64), block.starts)
    equal = np.add.reduceat((s == sl).astype(np.int64), block.starts)
    top = np.clip((40 - greater) / equal, 0.0, 1.0)
    return {(int(d.seed[i]), int(plies[i])): (float(ll[i]), float(top[i])) for i in range(len(d.n))}


def bootstrap_mean(values: np.ndarray, games: np.ndarray, resamples: int, seed: int = 0) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    ids, inverse = np.unique(games, return_inverse=True)
    sums = np.bincount(inverse, weights=values, minlength=len(ids))
    counts = np.bincount(inverse, minlength=len(ids)).astype(np.float64)
    stats = []
    for _ in range(resamples):
        pick = rng.integers(0, len(ids), len(ids))
        stats.append(sums[pick].sum() / counts[pick].sum())
    lo, hi = np.percentile(stats, [2.5, 97.5])
    return float(lo), float(hi)


@torch.no_grad()
def margin_head(model, tables, corpus: Corpus, rows: np.ndarray) -> np.ndarray:
    out = []
    for lo in range(0, len(rows), 1024):
        b = make_batch(tables, corpus, rows[lo : lo + 1024])
        out.append((model(b["planes"], b["hands"], b["seat"])["margins"][:, 0] * 20.0).cpu().numpy())
    return np.concatenate(out).astype(np.float64)


def gate3(model, tables, corpus: Corpus, resamples: int, split: int = 2) -> dict:
    rows = np.nonzero((corpus.record_split == split) & (corpus.head == 0))[0]
    root_all = corpus.root_values.cpu().numpy()
    seat = corpus.seat.cpu().numpy()
    root = root_all[rows, seat[rows]].astype(np.float64)
    ok = np.isfinite(root)
    rows, root = rows[ok], root[ok]
    game = corpus.game[rows]
    scores = corpus.game_scores_np[game].astype(np.float64)
    mine = scores[np.arange(len(rows)), seat[rows]]
    target = mine - (scores.sum(1) - mine) / 3.0
    net = margin_head(model, tables, corpus, rows)
    base, both = r2(root, target), r2(np.column_stack([root, net]), target)
    rng = np.random.default_rng(0)
    ids, inverse = np.unique(game, return_inverse=True)
    members = [np.nonzero(inverse == i)[0] for i in range(len(ids))]
    incs = []
    for _ in range(resamples):
        sub = np.concatenate([members[i] for i in rng.integers(0, len(ids), len(ids))])
        incs.append(r2(np.column_stack([root[sub], net[sub]]), target[sub]) - r2(root[sub], target[sub]))
    lo, hi = np.percentile(incs, [2.5, 97.5])
    return {"positions": int(len(rows)), "games": int(len(ids)), "r2Root": base, "r2Net": r2(net, target), "r2Both": both,
            "increment": both - base, "ciLow": float(lo), "ciHigh": float(hi)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--teacher-cache", required=True, help="Pentobi level-7 cache (h1_data build --kind teacher)")
    ap.add_argument("--n11-dump", required=True, help="examples/n11_features.rs dump of the same games' moves")
    ap.add_argument("--selfplay-cache", required=True)
    ap.add_argument("--selfplay-cache2", default=None)
    ap.add_argument("--weights", default="ml/v5-prior-weights.json")
    ap.add_argument("--placements", default="ml/data/placements.json")
    ap.add_argument("--resamples", type=int, default=2000)
    ap.add_argument("--fuel-resamples", type=int, default=300)
    ap.add_argument("--also-visits-head", action="store_true", help="also report G1/G2 for policy head 0 (descriptive)")
    ap.add_argument("--split", choices=["test", "val"], default="test", help="val: dry runs of this script only")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    split = {"test": 2, "val": 1}[args.split]
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    tables = Tables(PolicyIndex(args.placements), dev)
    model = load_model(args.checkpoint, dev)
    result = {"checkpoint": args.checkpoint, "split": args.split}

    # G1, G2: Pentobi level-7 test decisions.
    teacher = Corpus(args.teacher_cache, dev, "teacher")
    rows = np.nonzero((teacher.record_split == split) & (teacher.head == 1))[0]
    seeds = teacher.game_seed[teacher.game[rows]]
    plies = teacher.ply[rows]
    prior = fitted_prior(args.n11_dump, args.weights)
    missing = [(int(s), int(p)) for s, p in zip(seeds, plies) if (int(s), int(p)) not in prior]
    if missing:
        raise SystemExit(f"{len(missing)} test decisions missing from the N11 dump, e.g. {missing[:3]}")
    p_ll = np.array([prior[(int(s), int(p))][0] for s, p in zip(seeds, plies)])
    p_top = np.array([prior[(int(s), int(p))][1] for s, p in zip(seeds, plies)])
    own = teacher.own_moves[rows]
    heads = {"teacher": 1} | ({"visits": 0} if args.also_visits_head else {})
    for name, head in heads.items():
        n_ll, n_top = network_teacher(model, tables, teacher, rows, head)
        table = {}
        for band, lo, hi in BANDS:
            m = (own >= lo) & (own < hi)
            if not m.any():
                continue
            d_ll, d_top = n_ll[m] - p_ll[m], n_top[m] - p_top[m]
            table[band] = {
                "decisions": int(m.sum()), "games": int(len(np.unique(seeds[m]))),
                "netLogLik": float(n_ll[m].mean()), "priorLogLik": float(p_ll[m].mean()),
                "diffLogLik": float(d_ll.mean()), "diffLogLikCI": bootstrap_mean(d_ll, seeds[m], args.resamples),
                "netTop40": float(n_top[m].mean()), "netTop40CI": bootstrap_mean(n_top[m], seeds[m], args.resamples),
                "priorTop40": float(p_top[m].mean()),
                "diffTop40": float(d_top.mean()), "diffTop40CI": bootstrap_mean(d_top, seeds[m], args.resamples),
            }
        result[f"pentobiL7_{name}Head"] = table
    # G3: value fuel on self-play test games.
    for key, path in (("fuel", args.selfplay_cache), ("fuel2", args.selfplay_cache2)):
        if path:
            result[key] = {"cache": path} | gate3(model, tables, Corpus(path, dev, key), args.fuel_resamples, split)
    json.dump(result, open(args.out, "w"), indent=1)
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
