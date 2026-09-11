"""Fit a cheap joint four-seat Gaussian continuation model for v4.7.

Mean values use game-disjoint ridge regression. A shrunk full covariance is selected on validation
games from repeated-rollout sufficient statistics, then exported as a constant Cholesky factor.
The browser forward pass is one linear layer; sampling, not model width, restores trajectory-level
variation and cross-seat dependence.
"""

import argparse
import json
import os

import numpy as np


def unpack_cov(rows):
    out = np.zeros((len(rows), 4, 4), np.float64)
    at = 0
    for row in range(4):
        for col in range(row + 1):
            out[:, row, col] = rows[:, at]
            out[:, col, row] = rows[:, at]
            at += 1
    return out


def fit_ridge(x, y, lam):
    design = np.concatenate([x, np.ones((len(x), 1))], axis=1)
    reg = np.eye(design.shape[1]) * lam
    reg[-1, -1] = 0
    return np.linalg.solve(design.T @ design + reg, design.T @ y)


def predict(x, weights):
    return x @ weights[:-1] + weights[-1]


def total_covariance(target_cov, target_mean, predicted):
    error = target_mean - predicted
    return np.mean(target_cov + error[:, :, None] * error[:, None, :], axis=0)


def nll(target_cov, target_mean, predicted, covariance):
    sign, logdet = np.linalg.slogdet(covariance)
    if sign <= 0:
        return float("inf")
    inverse = np.linalg.inv(covariance)
    error = target_mean - predicted
    second = target_cov + error[:, :, None] * error[:, None, :]
    return float(0.5 * np.mean(logdet + np.einsum("ij,nji->n", inverse, second)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--validation-games", type=int, default=4)
    parser.add_argument("--holdout-games", type=int, default=4)
    args = parser.parse_args()

    meta = json.load(open(f"{args.data}.meta.json"))
    features = int(meta["featureCount"])
    width = int(meta["targetWidth"])
    x = np.fromfile(f"{args.data}.x.f32", np.float32).reshape(-1, features).astype(np.float64)
    y = np.fromfile(f"{args.data}.y.f32", np.float32).reshape(-1, width).astype(np.float64)
    games = np.unique(y[:, 0].astype(np.int32))
    holdout = games[-args.holdout_games:]
    validation = games[-(args.holdout_games + args.validation_games):-args.holdout_games]
    game_ids = y[:, 0].astype(np.int32)
    test_mask = np.isin(game_ids, holdout)
    val_mask = np.isin(game_ids, validation)
    train_mask = ~(test_mask | val_mask)

    mean = x[train_mask].mean(0)
    scale = x[train_mask].std(0)
    scale[scale < 1e-6] = 1
    xn = (x - mean) / scale
    target_mean = y[:, 4:8]
    target_cov = unpack_cov(y[:, 8:18])

    ridge_rows = []
    for lam in (1.0, 10.0, 100.0, 1000.0, 10000.0):
        weights = fit_ridge(xn[train_mask], target_mean[train_mask], lam)
        rmse = np.sqrt(np.mean((predict(xn[val_mask], weights) - target_mean[val_mask]) ** 2))
        ridge_rows.append((rmse, lam, weights))
    _, ridge_lambda, weights = min(ridge_rows, key=lambda row: row[0])
    train_pred = predict(xn[train_mask], weights)
    base_cov = total_covariance(target_cov[train_mask], target_mean[train_mask], train_pred)
    diagonal = np.diag(np.diag(base_cov))

    choices = []
    for shrink in (0.0, 0.25, 0.5, 0.75, 1.0):
        for multiplier in (0.75, 1.0, 1.25, 1.5):
            covariance = multiplier * ((1 - shrink) * base_cov + shrink * diagonal)
            covariance += np.eye(4) * 1e-6
            score = nll(
                target_cov[val_mask], target_mean[val_mask], predict(xn[val_mask], weights), covariance
            )
            choices.append((score, shrink, multiplier, covariance))
    validation_nll, shrink, multiplier, covariance = min(choices, key=lambda row: row[0])
    cholesky = np.linalg.cholesky(covariance)
    packed_cholesky = [cholesky[row, col] for row in range(4) for col in range(row + 1)]

    hold_pred = predict(xn[test_mask], weights)
    hold_rmse = float(np.sqrt(np.mean((hold_pred - target_mean[test_mask]) ** 2)))
    hold_nll = nll(target_cov[test_mask], target_mean[test_mask], hold_pred, covariance)
    constant = np.broadcast_to(target_mean[train_mask].mean(0), target_mean[test_mask].shape)
    constant_rmse = float(np.sqrt(np.mean((constant - target_mean[test_mask]) ** 2)))

    head_w = np.zeros((14, features), np.float32)
    head_w[:4] = weights[:-1].T.astype(np.float32)
    head_b = np.concatenate([weights[-1], np.asarray(packed_cholesky)]).astype(np.float32)
    report = {
        "ridgeLambda": ridge_lambda,
        "validationRmse": float(min(row[0] for row in ridge_rows)),
        "holdoutRmse": hold_rmse,
        "constantHoldoutRmse": constant_rmse,
        "validationNll": validation_nll,
        "holdoutNll": hold_nll,
        "covarianceShrink": shrink,
        "covarianceMultiplier": multiplier,
        "validationGames": validation.tolist(),
        "holdoutGames": holdout.tolist(),
    }
    artifact = {
        "featureCount": features,
        "featureNames": meta["featureNames"],
        "mean": mean.astype(np.float32).tolist(),
        "scale": scale.astype(np.float32).tolist(),
        "layers": [],
        "head": {"w": head_w.ravel().tolist(), "b": head_b.tolist()},
        "outputContract": "meanValuesThenCholesky",
        "metrics": report,
        "trainedOn": meta,
    }
    json.dump(artifact, open(args.out, "w"))
    print(json.dumps(report, indent=2))
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
