"""P4/P5: fit the move prior (multinomial logit over all legal moves) on Pentobi's recorded moves.

    cargo run --release --manifest-path engine-rs/Cargo.toml --example p4_features -- \
        engine-rs/configs/v4.2-ultra.json 4 tmp/p4/fit/x1l6 tmp/d1/x1-l6a.moves.jsonl tmp/d1/x1-l6b.moves.jsonl
    python3 ml/p4_fit_prior.py tmp/p4/fit/x1l6 --out ml/v5-prior-weights.json --report tmp/p4/fit/report.md

Input: `<prefix>.f32` (rows of FEATURE_COUNT features, today's ordering score, rank in today's root
shortlist or -1, label) and `<prefix>.csv` (one line per decision) from `examples/p4_features.rs`,
which computes the features with the engine's own `feature_prior.rs`.

Split by game seed: every seed whose last digit is 4 or 9 (20 of the 100 X1 seeds, all eight games
played on each) is held out for test; nothing is tuned on it. Weights are fitted per own-move band
(a seat's i-th placement: 0-2, 3-8, 9-14, 15+) by L-BFGS on the softmax log-likelihood with a small
L2 penalty, on standardised columns; the export is unstandardised so the engine computes w . f
directly. The report compares, on the held-out games and by band, the fitted prior with today's
ordering (its score over all legal moves through a softmax, at the engine's temperature 6 and at
the best temperature fitted on the training games) and with today's actual 40-move root shortlist.
"""
import argparse
import csv
import json
import math
import sys

import numpy as np
from scipy.optimize import minimize, minimize_scalar

FEATURES = [
    *[f"piece{i}" for i in range(21)],
    "centre", "centre_sq", "home_far", "advance",
    "opp_cover", "opp_cover_next", "opp_cover_prev", "opp_adj", "own_lost",
    "new_f0", "new_f1", "new_f2", "new_contested",
    "opp_contact", "opp_diag", "border", "local_attach", "local_near",
]
NF = len(FEATURES)
COLS = NF + 3
BANDS = [(0, 3), (3, 9), (9, 15), (15, 22)]
BAND_NAMES = ["0-2", "3-8", "9-14", "15+"]
REPORT_BANDS = [(0, 3), (3, 9), (9, 15), (15, 22)]
REPORT_NAMES = ["0-2", "3-8", "9-14", "15+"]
L2 = 1e-3  # per decision, on standardised columns


def load(prefix):
    raw = np.memmap(prefix + ".f32", dtype="<f4", mode="r")
    data = raw.reshape(-1, COLS)
    rows = list(csv.DictReader(open(prefix + ".csv")))
    dec = {
        "seed": np.array([int(r["seed"]) for r in rows]),
        "own": np.array([int(r["own_idx"]) for r in rows]),
        "n": np.array([int(r["legal"]) for r in rows]),
        "start": np.array([int(r["row"]) for r in rows]),
        "file": np.array([int(r["file"]) for r in rows]),
    }
    assert dec["start"][-1] + dec["n"][-1] == data.shape[0]
    return data, dec


def segment_softmax_stats(scores, starts, counts):
    """log-sum-exp per segment (scores laid out contiguously, segment i = starts[i]:starts[i]+counts[i])."""
    seg_max = np.maximum.reduceat(scores, starts)
    rep = np.repeat(seg_max, counts)
    e = np.exp(scores - rep)
    seg_sum = np.add.reduceat(e, starts)
    lse = seg_max + np.log(seg_sum)
    return lse, e / np.repeat(seg_sum, counts)


class Block:
    """The candidate rows of a set of decisions, made contiguous."""

    def __init__(self, data, dec, mask):
        idx = np.nonzero(mask)[0]
        self.counts = dec["n"][idx]
        self.starts = np.concatenate([[0], np.cumsum(self.counts)[:-1]])
        sel = np.concatenate([np.arange(dec["start"][i], dec["start"][i] + dec["n"][i]) for i in idx]) if len(idx) else np.zeros(0, int)
        block = np.asarray(data[sel], dtype=np.float64)
        self.X = block[:, :NF]
        self.ord = block[:, NF]
        self.rank40 = block[:, NF + 1]
        self.y = block[:, NF + 2]
        self.label_rows = np.nonzero(self.y > 0.5)[0]
        assert len(self.label_rows) == len(idx), "one label per decision"
        self.decisions = len(idx)
        self.own = dec["own"][idx]


def fit_band(train, l2=L2):
    mu = train.X.mean(0)
    sd = train.X.std(0)
    sd[sd < 1e-9] = 1.0
    Z = (train.X - mu) / sd
    D = train.decisions

    def f(w):
        s = Z @ w
        lse, p = segment_softmax_stats(s, train.starts, train.counts)
        nll = (lse.sum() - s[train.label_rows].sum()) / D + 0.5 * l2 * w @ w
        g = (Z.T @ p - Z[train.label_rows].sum(0)) / D + l2 * w
        return nll, g

    res = minimize(f, np.zeros(NF), jac=True, method="L-BFGS-B", options={"maxiter": 500})
    w = res.x / sd
    # The per-band constant (mu . w) cancels inside a softmax over one decision, so it is dropped.
    return w, res


def rank_stats(scores, block, ks=(1, 5, 40, 96)):
    """Expected P(label in top k) under random tie-breaking, per decision."""
    out = {k: np.zeros(block.decisions) for k in ks}
    for i in range(block.decisions):
        a, n = block.starts[i], block.counts[i]
        s = scores[a:a + n]
        sl = scores[block.label_rows[i]]
        greater = np.sum(s > sl)
        equal = np.sum(s == sl)
        for k in ks:
            out[k][i] = min(1.0, max(0.0, (k - greater) / equal))
    return out


def loglik(scores, block, temp=1.0):
    s = scores / temp
    lse, _ = segment_softmax_stats(s, block.starts, block.counts)
    return s[block.label_rows] - lse


def fit_temperature(scores, block):
    r = minimize_scalar(lambda lt: -loglik(scores, block, math.exp(lt)).mean(), bounds=(-4, 4), method="bounded")
    return math.exp(r.x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix")
    ap.add_argument("--out", default="ml/v5-prior-weights.json")
    ap.add_argument("--report", default=None)
    ap.add_argument("--test-digits", default="4,9", help="seed last digits held out for test")
    ap.add_argument("--bands", default="0,3,6,9,12,15,22", help="own-move band edges of the model")
    ap.add_argument("--drop", default="", help="comma-separated features fixed at weight 0 (ablation)")
    args = ap.parse_args()
    edges = [int(x) for x in args.bands.split(",")]
    global BANDS, BAND_NAMES
    BANDS = list(zip(edges[:-1], edges[1:]))
    BAND_NAMES = [f"{lo}-{hi - 1}" if hi < 22 else f"{lo}+" for lo, hi in BANDS]
    drop = [FEATURES.index(d) for d in args.drop.split(",") if d]
    data, dec = load(args.prefix)
    test_digits = {int(d) for d in args.test_digits.split(",")}
    is_test = np.isin(dec["seed"] % 10, list(test_digits))
    lines = []
    say = lambda s="": (print(s), lines.append(s))
    say(f"Data: {args.prefix} — {len(dec['n'])} Pentobi decisions, {data.shape[0]} candidate moves; "
        f"test = seeds ending in {sorted(test_digits)} ({is_test.sum()} decisions), train {(~is_test).sum()}.")
    bands_out = []
    for (lo, hi), name in zip(BANDS, BAND_NAMES):
        in_band = (dec["own"] >= lo) & (dec["own"] < hi)
        train = Block(data, dec, in_band & ~is_test)
        train.X[:, drop] = 0.0
        w, res = fit_band(train)
        w[drop] = 0.0
        bands_out.append({"minOwnMove": lo, "maxOwnMove": hi, "weights": [float(x) for x in w]})
        say(f"model band {name}: train {train.decisions} decisions, L-BFGS {res.nit} it, "
            f"train NLL {res.fun:.4f}, converged={res.success}")
    W = np.array([b["weights"] for b in bands_out])
    band_index = np.zeros(32, dtype=int)
    for k, (lo, hi) in enumerate(BANDS):
        band_index[lo:hi] = k

    def fitted(block):
        per_row = np.repeat(band_index[block.own], block.counts)
        return np.einsum("ij,ij->i", block.X, W[per_row])

    table = []
    for (lo, hi), name in zip(REPORT_BANDS, REPORT_NAMES):
        in_band = (dec["own"] >= lo) & (dec["own"] < hi)
        train = Block(data, dec, in_band & ~is_test)
        test = Block(data, dec, in_band & is_test)
        t_ord = fit_temperature(train.ord, train)
        sl_scores = np.where(test.rank40 >= 0, 1000.0 - test.rank40, -1.0)  # actual shortlist order; outside = tied last
        rows = {
            "fitted prior": (fitted(test), 1.0),
            "ordering score, T=6": (test.ord, 6.0),
            f"ordering score, T={t_ord:.2f} (fit)": (test.ord, t_ord),
            "today's root shortlist (40)": (sl_scores, None),
            "uniform": (np.zeros_like(test.ord), 1.0),
        }
        for label, (sc, temp) in rows.items():
            rk = rank_stats(sc, test)
            ll = loglik(sc, test, temp).mean() if temp else float("nan")
            table.append((name, label, test.decisions, float(np.mean(test.counts)), rk[1].mean(), rk[5].mean(), ll, rk[40].mean(), rk[96].mean()))
    say()
    say("| Band | Scorer | Test decisions | Mean legal | Top-1 | Top-5 | Mean log-lik | In top 40 | In top 96 |")
    say("|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for name, label, n, legal, t1, t5, ll, t40, t96 in table:
        lls = "—" if math.isnan(ll) else f"{ll:.3f}"
        say(f"| {name} | {label} | {n} | {legal:.0f} | {t1:.3f} | {t5:.3f} | {lls} | {t40:.3f} | {t96:.3f} |")
    say()
    say("Weights (unstandardised; score = w . f):")
    say("| Feature | " + " | ".join(BAND_NAMES) + " |")
    say("|---|" + "---:|" * len(BAND_NAMES))
    for k, fname in enumerate(FEATURES):
        say(f"| {fname} | " + " | ".join(f"{b['weights'][k]:+.3f}" for b in bands_out) + " |")
    model = {
        "note": ("P4/P5 move prior (v5.0 port), fitted by ml/p4_fit_prior.py: multinomial logit over all legal "
                 f"moves, separate weights per own-move band (edges {args.bands}), L2 1e-3 on standardised columns, L-BFGS. "
                 f"Data: {len(dec['n'])} decisions by Pentobi 31.0 level-6 seats in the X1 games "
                 "tmp/d1/x1-l6a.moves.jsonl and x1-l6b.moves.jsonl (seeds 79,000,000-79,000,099); "
                 f"seeds ending in {sorted(test_digits)} held out for test. Features: engine-rs/src/feature_prior.rs. "
                 "No Pentobi code or weights used."),
        "features": FEATURES,
        "bands": bands_out,
        "dropped": [FEATURES[k] for k in drop],
        "testMetrics": [dict(zip(["band", "scorer", "decisions", "meanLegal", "top1", "top5", "meanLogLik", "top40", "top96"], r)) for r in table],
    }
    with open(args.out, "w") as f:
        json.dump(model, f, indent=1)
        f.write("\n")
    say(f"\nwrote {args.out}")
    if args.report:
        with open(args.report, "w") as f:
            f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
