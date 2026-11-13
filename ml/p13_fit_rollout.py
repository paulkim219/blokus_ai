"""P1 rollout policy: fit its weights to Pentobi's moves by maximum likelihood.

    python3 ml/p13_fit_rollout.py tmp/p13/fit/l6-decisions.jsonl [out.json]

Input: one line per decision from `engine-rs/examples/p13_rollout_fit.rs` (the legal moves counted by
(size, local, localOwn), and the cell of the move played), for every Pentobi level-6 decision at own
move >= 3 in the X1 games. The policy is `native.rollout` "all":

    P(move) ∝ exp(sizeWeight · size + localWeight · (local + localOwnExtra · localOwn))

fitted in the linear form a·size + b·local + d·localOwn (so localOwnExtra = d / b), by L-BFGS on the
softmax log-likelihood. Split by game seed as in the P4 fit (`ml/p4_fit_prior.py`): seeds ending in
4 or 9 are the test set and nothing is tuned on them. Models: uniform; size only; size + local;
size + local + localOwn; and, for reference only, one free weight per piece size + local + localOwn.
Writes a JSON with every model's weights and train/test log-likelihood per decision.
"""
import json
import sys

import numpy as np
from scipy.optimize import minimize

SIZE = np.repeat(np.arange(1, 6), 36).astype(float)
LOCAL = np.tile(np.repeat(np.arange(6), 6), 5).astype(float)
OWN = np.tile(np.arange(6), 30).astype(float)


def load(path):
    counts, chosen, test, own = [], [], [], []
    for line in open(path):
        d = json.loads(line)
        counts.append(d["counts"])
        chosen.append(d["chosen"])
        test.append(d["seed"] % 10 in (4, 9))
        own.append(d["own"])
    return np.array(counts, float), np.array(chosen), np.array(test), np.array(own)


def design(kind):
    cols = {"uniform": [], "size": [SIZE], "size+local": [SIZE, LOCAL], "size+local+own": [SIZE, LOCAL, OWN],
            "piece-size+local+own": [(SIZE == k).astype(float) for k in range(2, 6)] + [LOCAL, OWN]}[kind]
    return np.stack(cols, 1) if cols else np.zeros((180, 0))


def nll(theta, X, counts, chosen):
    s = X @ theta if X.shape[1] else np.zeros(180)
    m = s.max()
    z = counts @ np.exp(s - m)  # partition per decision
    ll = s[chosen] - m - np.log(z)
    p = (counts * np.exp(s - m)) / z[:, None]  # expected cell occupancy
    grad = X[chosen].sum(0) - (p @ X).sum(0) if X.shape[1] else np.zeros(0)
    return -ll.sum(), -grad


def fit(kind, counts, chosen, train):
    X = design(kind)
    if X.shape[1] == 0:
        theta = np.zeros(0)
    else:
        r = minimize(nll, np.zeros(X.shape[1]), args=(X, counts[train], chosen[train]), jac=True, method="L-BFGS-B")
        assert r.success, r.message
        theta = r.x
    out = {"kind": kind, "theta": theta.tolist()}
    for name, mask in (("train", train), ("test", ~train)):
        out[f"{name}_ll"] = -nll(theta, X, counts[mask], chosen[mask])[0] / mask.sum()
        out[f"{name}_n"] = int(mask.sum())
    return out


def main():
    path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    counts, chosen, test, own = load(path)
    train = ~test
    models = [fit(k, counts, chosen, train) for k in ("uniform", "size", "size+local", "size+local+own", "piece-size+local+own")]
    for m in models:
        print(f"{m['kind']:>22}: theta {np.round(m['theta'], 4).tolist()}  train ll {m['train_ll']:.4f} ({m['train_n']})  "
              f"test ll {m['test_ll']:.4f} ({m['test_n']})")
    full = models[3]["theta"]
    config = {"sizeWeight": round(full[0], 4), "localWeight": round(full[1], 4), "localOwnExtra": round(full[2] / full[1], 4)}
    size_only = {"sizeWeight": round(models[1]["theta"][0], 4), "localWeight": 0.0, "localOwnExtra": 0.0}
    print("native.rollout (size + local + own):", config)
    print("native.rollout (size only):", size_only)
    # Local response by stage, descriptively: the share of decisions where some local move existed
    # and the played move covered a local square.
    has_local = counts.reshape(-1, 5, 6, 6)[:, :, 1:, :].sum((1, 2, 3)) > 0
    played_local = LOCAL[chosen] > 0
    for lo, hi in ((3, 8), (9, 14), (15, 21)):
        m = (own >= lo) & (own <= hi) & has_local
        print(f"own moves {lo}-{hi}: {m.sum()} decisions with a local move available; played one {played_local[m].mean():.3f}; "
              f"share of legal moves that are local {((counts.reshape(-1, 5, 6, 6)[:, :, 1:, :].sum((1, 2, 3)))[m] / counts[m].sum(1)).mean():.3f}")
    if out_path:
        json.dump({"data": path, "split": "test = seeds ending in 4 or 9", "models": models,
                   "config": config, "configSizeOnly": size_only}, open(out_path, "w"), indent=1)


if __name__ == "__main__":
    main()
