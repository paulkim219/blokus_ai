"""N11: re-fit the move prior on stronger games (Pentobi level 7), offline evaluation.

    cargo run --release --manifest-path engine-rs/Cargo.toml --example n11_features -- 10 tmp/n11/l6 \
        tmp/d1/x1-l6a.moves.jsonl tmp/d1/x1-l6b.moves.jsonl
    cargo run --release --manifest-path engine-rs/Cargo.toml --example n11_features -- 10 tmp/n11/l7 \
        tmp/x2/x2-l7ext.moves.jsonl tmp/x3/x3-l7-p4.moves.jsonl tmp/x3/x3-l7-p4i.moves.jsonl
    python3 ml/n11_fit_prior.py --l6 tmp/n11/l6 --l7 tmp/n11/l7 --out-dir tmp/n11/fit

Same model and fit as ml/p4_fit_prior.py (multinomial logit over all legal moves of a decision, one
weight vector per own-move band, L-BFGS on standardised columns, L2 1e-3 per decision; the export is
unstandardised), on the compact dumps of examples/n11_features.rs. No game outcome is used.

Split by game seed, as P4/P5: seeds whose last digit is 4 or 9 are held out, for both levels (so the
level-6 held-out set is exactly P4/P5's test set). Every model is evaluated on held-out level-7 and
held-out level-6 decisions: mean log-likelihood, top-1 / top-10 / top-40 (expected, ties broken at
random), by own-move band, beside the current weights (ml/v5-prior-weights.json).

Models: `current`; (a) `L7` the same 39-feature, 6-band model fitted on level-7 training decisions;
(b) `pooled` on level-6 and level-7 training decisions together; (c) `L7-fine` and `pooled-fine`, a
richer variant with one band per own move from 3 to 14 (no engine change: the model JSON carries any
bands), if the held-out numbers point at capacity (train and held-out likelihood close, i.e. no
overfitting, and the larger data set fitting no better than the smaller).
"""
import argparse
import csv
import json
import math
import os
import sys

import numpy as np
from scipy.optimize import minimize

sys.path.insert(0, os.path.dirname(__file__))
from p4_fit_prior import FEATURES, segment_softmax_stats  # noqa: E402

NF = len(FEATURES)
STATIC = 23
ROW = np.dtype([("id", "<u2"), ("f", "u1", (NF - STATIC,)), ("label", "u1")])
L2 = 1e-3
BANDS6 = [0, 3, 6, 9, 12, 15, 22]
BANDS_FINE = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 22]
REPORT = [("0-2", 0, 3), ("3-8", 3, 9), ("9-14", 9, 15), ("15+", 15, 22), ("3+", 3, 22)]
TEST_DIGITS = (4, 9)


class Dump:
    def __init__(self, prefix):
        self.rows = np.fromfile(prefix + ".bin", dtype=ROW)
        self.static = np.fromfile(prefix + ".static.f32", dtype="<f4").reshape(-1, STATIC)
        recs = list(csv.DictReader(open(prefix + ".csv")))
        self.seed = np.array([int(r["seed"]) for r in recs])
        self.own = np.array([int(r["own_idx"]) for r in recs])
        self.n = np.array([int(r["legal"]) for r in recs])
        self.start = np.array([int(r["row"]) for r in recs])
        assert self.start[-1] + self.n[-1] == len(self.rows)
        self.test = np.isin(self.seed % 10, TEST_DIGITS)

    def block(self, mask):
        return Block(self, np.nonzero(mask)[0])


class Block:
    """Candidate rows of a set of decisions, contiguous, with the full 39-feature matrix."""

    def __init__(self, dump, idx):
        self.counts = dump.n[idx]
        self.starts = np.concatenate([[0], np.cumsum(self.counts)[:-1]]).astype(np.int64)
        total = int(self.counts.sum())
        # Row indices: for each decision, start..start+n.
        offs = np.arange(total) - np.repeat(self.starts, self.counts)
        sel = np.repeat(dump.start[idx], self.counts) + offs
        r = dump.rows[sel]
        self.X = np.empty((total, NF), dtype=np.float64)
        self.X[:, :STATIC] = dump.static[r["id"].astype(np.int64)]
        self.X[:, STATIC:] = r["f"]
        y = r["label"]
        self.label_rows = np.nonzero(y)[0]
        assert len(self.label_rows) == len(idx), "one label per decision"
        self.own = dump.own[idx]
        self.decisions = len(idx)

    @staticmethod
    def concat(blocks):
        b = Block.__new__(Block)
        b.counts = np.concatenate([x.counts for x in blocks])
        b.starts = np.concatenate([[0], np.cumsum(b.counts)[:-1]]).astype(np.int64)
        b.X = np.concatenate([x.X for x in blocks])
        offs = np.cumsum([0] + [len(x.X) for x in blocks[:-1]])
        b.label_rows = np.concatenate([x.label_rows + o for x, o in zip(blocks, offs)])
        b.own = np.concatenate([x.own for x in blocks])
        b.decisions = sum(x.decisions for x in blocks)
        return b


# Offline capacity diagnostic only (not playable without an engine change): the 14 count features
# 25-38 times piece size / 5, and squared.
DYN = list(range(25, NF))
SIZES = np.array([1, 2, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], dtype=np.float64)


def augment(X):
    size = X[:, :21] @ SIZES / 5.0
    return np.concatenate([X, X[:, DYN] * size[:, None], X[:, DYN] ** 2], axis=1)


def design(block, model):
    return augment(block.X) if model.get("augment") else block.X


def fit_band(train, l2=L2, X=None):
    X = train.X if X is None else X
    mu = X.mean(0)
    sd = X.std(0)
    sd[sd < 1e-9] = 1.0
    Z = (X - mu) / sd
    D = train.decisions

    def f(w):
        s = Z @ w
        lse, p = segment_softmax_stats(s, train.starts, train.counts)
        nll = (lse.sum() - s[train.label_rows].sum()) / D + 0.5 * l2 * w @ w
        g = (Z.T @ p - Z[train.label_rows].sum(0)) / D + l2 * w
        return nll, g

    res = minimize(f, np.zeros(X.shape[1]), jac=True, method="L-BFGS-B", options={"maxiter": 1000})
    return res.x / sd, res


def scores(block, model):
    """w · f with each decision's band weights (bands as in the engine: first band containing own,
    else the last)."""
    bands = model["bands"]
    W = np.array([b["weights"] for b in bands])
    idx = np.full(64, len(bands) - 1)
    for k in range(len(bands) - 1, -1, -1):
        lo, hi = bands[k]["minOwnMove"], bands[k]["maxOwnMove"]
        idx[lo:hi] = k
    per_row = np.repeat(idx[block.own], block.counts)
    return np.einsum("ij,ij->i", design(block, model), W[per_row])


def metrics(s, block):
    lse, _ = segment_softmax_stats(s, block.starts, block.counts)
    ll = s[block.label_rows] - lse
    sl = np.repeat(s[block.label_rows], block.counts)
    greater = np.add.reduceat((s > sl).astype(np.int64), block.starts)
    equal = np.add.reduceat((s == sl).astype(np.int64), block.starts)
    top = {k: np.clip((k - greater) / equal, 0.0, 1.0).mean() for k in (1, 10, 40)}
    return {"loglik": float(ll.mean()), "top1": float(top[1]), "top10": float(top[10]), "top40": float(top[40]),
            "decisions": block.decisions, "legal": float(block.counts.mean())}


def fit_model(dumps, edges, name, note, aug=False):
    bands = []
    log = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        parts = [d.block((d.own >= lo) & (d.own < hi) & ~d.test) for d in dumps]
        train = Block.concat(parts) if len(parts) > 1 else parts[0]
        w, res = fit_band(train, X=augment(train.X) if aug else None)
        bands.append({"minOwnMove": lo, "maxOwnMove": hi, "weights": [float(x) for x in w]})
        log.append(f"{name} band {lo}-{hi - 1}: train {train.decisions} decisions, {res.nit} it, train NLL {res.fun:.4f}, converged={res.success}")
        print(log[-1], flush=True)
        del train, parts
    m = {"note": note, "features": FEATURES, "bands": bands, "fitLog": log}
    if aug:
        m["augment"] = True
    return m


def evaluate(models, dumps, which):
    """{(model, level, band, split): metrics}; split 'test' (held out) or 'train'."""
    out = {}
    for level, d in dumps.items():
        for band, lo, hi in REPORT:
            for split in which:
                mask = (d.own >= lo) & (d.own < hi) & (d.test if split == "test" else ~d.test)
                if not mask.any():
                    continue
                b = d.block(mask)
                for name, m in models.items():
                    out[(name, level, band, split)] = metrics(scores(b, m), b)
                out[("uniform", level, band, split)] = metrics(np.zeros(len(b.X)), b)
                del b
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--l6", required=True)
    ap.add_argument("--l7", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--current", default="ml/v5-prior-weights.json")
    ap.add_argument("--fine", action="store_true", help="also fit the richer variant (c)")
    ap.add_argument("--only-c", action="store_true", help="skip (a) and (b): fit (c) and the interaction diagnostic only")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    l6, l7 = Dump(args.l6), Dump(args.l7)
    for name, d in (("level 6", l6), ("level 7", l7)):
        print(f"{name}: {len(d.n)} decisions ({d.test.sum()} held out, seeds ending in {TEST_DIGITS}), "
              f"{len(d.rows)} candidate rows, {len(set(d.seed))} seeds", flush=True)
    cur = json.load(open(args.current))
    models = {"current": {"bands": cur["bands"]}}
    base_note = ("N11 move prior, fitted by ml/n11_fit_prior.py: the P4/P5 model (multinomial logit over all legal moves, "
                 "39 features of engine-rs/src/feature_prior.rs, separate weights per own-move band, L2 1e-3 on standardised "
                 "columns, L-BFGS). Seeds ending in 4 or 9 held out. No Pentobi code or weights used; no game outcome used. ")
    l7_src = "Pentobi 31.0 level-7 seats in tmp/x2/x2-l7ext and tmp/x3/x3-l7-p4 / x3-l7-p4i (seeds 79,200,040-199 and 86,100,000-199)"
    l6_src = "Pentobi 31.0 level-6 seats in the X1 games tmp/d1/x1-l6a / x1-l6b (seeds 79,000,000-099)"
    if args.only_c:
        for name in ("L7", "pooled"):
            models[name] = json.load(open(os.path.join(args.out_dir, f"w-{name}.json")))
    else:
        models["L7"] = fit_model([l7], BANDS6, "L7", base_note + f"Bands {BANDS6}. Data: {l7_src}.")
        models["pooled"] = fit_model([l6, l7], BANDS6, "pooled", base_note + f"Bands {BANDS6}. Data: {l6_src}; and {l7_src}.")
    if args.fine:
        models["L7-fine"] = fit_model([l7], BANDS_FINE, "L7-fine", base_note + f"Bands {BANDS_FINE}. Data: {l7_src}.")
        models["pooled-fine"] = fit_model([l6, l7], BANDS_FINE, "pooled-fine", base_note + f"Bands {BANDS_FINE}. Data: {l6_src}; and {l7_src}.")
        models["L7-interact"] = fit_model([l7], BANDS6, "L7-interact", "Offline diagnostic, not playable: " + base_note
                                          + f"Bands {BANDS6}; 28 extra columns (counts 25-38 times size/5, and squared). Data: {l7_src}.", aug=True)
    for name, m in models.items():
        if name != "current":
            json.dump(m, open(os.path.join(args.out_dir, f"w-{name}.json"), "w"), indent=1)
    res = evaluate(models, {"L7": l7, "L6": l6}, ("test", "train"))
    lines = []
    say = lambda s="": (print(s), lines.append(s))
    say(f"Level 6: {len(l6.n)} decisions ({l6.test.sum()} held out); level 7: {len(l7.n)} decisions ({l7.test.sum()} held out).")
    for level in ("L7", "L6"):
        say()
        say(f"Held-out {'level-7' if level == 'L7' else 'level-6'} decisions:")
        say("| Band | Model | Decisions | Mean legal | Mean log-lik | Top-1 | Top-10 | Top-40 | Train log-lik (same level) |")
        say("|---|---|---:|---:|---:|---:|---:|---:|---:|")
        for band, _, _ in REPORT:
            for name in list(models) + ["uniform"]:
                k = (name, level, band, "test")
                if k not in res:
                    continue
                m = res[k]
                tr = res.get((name, level, band, "train"))
                say(f"| {band} | {name} | {m['decisions']} | {m['legal']:.0f} | {m['loglik']:.3f} | {m['top1']:.3f} | {m['top10']:.3f} | "
                    f"{m['top40']:.3f} | {tr['loglik']:.3f} |")
    json.dump({"|".join(k): v for k, v in res.items()}, open(os.path.join(args.out_dir, "metrics.json"), "w"), indent=1)
    open(os.path.join(args.out_dir, "report.md"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
