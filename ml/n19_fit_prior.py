"""N19 (round 4): does adding mobility features to the move prior predict Pentobi's moves better?

    python3 ml/n19_fit_prior.py --dump tmp/n11/l6 --mob tmp/v51d/n19/l6.mob.f32 --out-dir tmp/v51d/n19/fit

Data: the level-6 decisions of the P4/N11 dump (`examples/n11_features.rs` on tmp/d1/x1-l6{a,b}), the
same data the current prior was fitted on, with the mobility columns of `examples/n19_features.rs`
aligned row for row. Split by seed as P4/N11 (seeds ending in 4 or 9 held out). Same model and fit as
N11 (multinomial logit over all legal moves, six own-move bands, L-BFGS on standardised columns, L2 1e-3).
Models: `current` (the weights in engine-rs/configs/v5.1-ultra.json), `refit39` (the 39 features refitted
on this split, to separate the refit from the features), and refits with mobility columns added:
`exact` (own gain + removed from next / opposite / previous), `exact-opp` (removed only, no own gain),
`exact-sum` (own gain + removed sum), `cheap` (per-cell pressure on the three opponents + own corner gain).
Reported on held-out decisions: mean log-likelihood, top-1 and top-5 agreement (ties broken at random),
by own-move band.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from n11_fit_prior import BANDS6, NF, STATIC, Dump, fit_band  # noqa: E402
from p4_fit_prior import FEATURES, segment_softmax_stats  # noqa: E402

K = 9
MOB = ["own_gain", "rm_next", "rm_opp", "rm_prev", "rm_sum", "pr_next", "pr_opp", "pr_prev", "own_live"]
VARIANTS = {
    "refit39": [],
    "exact": [0, 1, 2, 3],
    "exact-opp": [1, 2, 3],
    "exact-sum": [0, 4],
    "cheap": [5, 6, 7, 8],
}
REPORT = [("0-2", 0, 3), ("3-8", 3, 9), ("9-14", 9, 15), ("15+", 15, 22), ("3+", 3, 22)]


class Block:
    def __init__(self, dump, mob, idx, cols):
        self.counts = dump.n[idx]
        self.starts = np.concatenate([[0], np.cumsum(self.counts)[:-1]]).astype(np.int64)
        total = int(self.counts.sum())
        offs = np.arange(total) - np.repeat(self.starts, self.counts)
        sel = np.repeat(dump.start[idx], self.counts) + offs
        r = dump.rows[sel]
        self.X = np.empty((total, NF + len(cols)), dtype=np.float64)
        self.X[:, :STATIC] = dump.static[r["id"].astype(np.int64)]
        self.X[:, STATIC:NF] = r["f"]
        if cols:
            self.X[:, NF:] = mob[sel][:, cols]
        self.label_rows = np.nonzero(r["label"])[0]
        assert len(self.label_rows) == len(idx)
        self.own = dump.own[idx]
        self.decisions = len(idx)


def metrics(s, b):
    lse, _ = segment_softmax_stats(s, b.starts, b.counts)
    ll = s[b.label_rows] - lse
    sl = np.repeat(s[b.label_rows], b.counts)
    greater = np.add.reduceat((s > sl).astype(np.int64), b.starts)
    equal = np.add.reduceat((s == sl).astype(np.int64), b.starts)
    top = {k: float(np.clip((k - greater) / equal, 0.0, 1.0).mean()) for k in (1, 5)}
    return float(ll.mean()), top[1], top[5], b.decisions


def band_scores(b, bands, ncols):
    W = np.array([x["weights"] for x in bands])[:, :ncols]
    idx = np.full(64, len(bands) - 1)
    for k in range(len(bands) - 1, -1, -1):
        idx[bands[k]["minOwnMove"]:bands[k]["maxOwnMove"]] = k
    per = np.repeat(idx[b.own], b.counts)
    return np.einsum("ij,ij->i", b.X[:, :ncols], W[per])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--mob", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--config", default="engine-rs/configs/v5.1-ultra.json")
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)
    d = Dump(a.dump)
    mob = np.fromfile(a.mob, dtype="<f4").reshape(-1, K).astype(np.float64)
    assert len(mob) == len(d.rows), (len(mob), len(d.rows))
    current = json.load(open(a.config))["native"]["candidates"]["model"]
    assert current["features"] == FEATURES
    print(f"{len(d.n)} decisions, {d.test.sum()} held out; {len(d.rows)} rows", flush=True)
    models = {"current": (current["bands"], [])}
    for name, cols in VARIANTS.items():
        bands = []
        for lo, hi in zip(BANDS6[:-1], BANDS6[1:]):
            train = Block(d, mob, np.nonzero((d.own >= lo) & (d.own < hi) & ~d.test)[0], cols)
            w, res = fit_band(train)
            bands.append({"minOwnMove": lo, "maxOwnMove": hi, "weights": [float(x) for x in w]})
            print(f"{name} band {lo}-{hi - 1}: {train.decisions} train decisions, train NLL {res.fun:.4f}, it {res.nit}", flush=True)
            del train
        models[name] = (bands, cols)
        json.dump({"features": FEATURES + [MOB[c] for c in cols], "bands": bands,
                   "note": f"N19 {name}: 39 prior features + {[MOB[c] for c in cols]} (mobility columns / 10 as in n19_features)"},
                  open(os.path.join(a.out_dir, f"n19-{name}.json"), "w"), indent=1)
    rows = []
    for band, lo, hi in REPORT:
        idx = np.nonzero((d.own >= lo) & (d.own < hi) & d.test)[0]
        for name, (bands, cols) in models.items():
            b = Block(d, mob, idx, cols)
            ll, t1, t5, n = metrics(band_scores(b, bands, NF + len(cols)), b)
            rows.append((band, name, n, ll, t1, t5))
            del b
    print("\n| Own moves | Model | Held-out decisions | Log-likelihood | Top-1 | Top-5 |")
    print("|---|---|---:|---:|---:|---:|")
    for band, name, n, ll, t1, t5 in rows:
        print(f"| {band} | {name} | {n} | {ll:.4f} | {t1:.3f} | {t5:.3f} |")


if __name__ == "__main__":
    main()
