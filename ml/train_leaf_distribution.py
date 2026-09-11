"""Train the v4.6 pilot to emulate the incumbent rollout-return distribution.

The target contains sufficient statistics from repeated terminal rollouts: empirical mean and
variance for four seat-relative score margins. The Gaussian likelihood therefore includes both
within-state rollout noise and error in the predicted conditional mean. The exported eight-output
MLP is compatible with the JavaScript loader: outputs 0..3 are means, 4..7 are log variances.
"""

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf


def load(prefix):
    meta = json.load(open(f"{prefix}.meta.json"))
    f = int(meta["featureCount"])
    w = int(meta["targetWidth"])
    x = np.fromfile(f"{prefix}.x.f32", np.float32).reshape(-1, f)
    y = np.fromfile(f"{prefix}.y.f32", np.float32).reshape(-1, w)
    n = min(len(x), len(y))
    return meta, x[:n], y[:n]


def build(features, widths, dropout, residual_linear):
    inp = tf.keras.Input((features,), name="features")
    h = inp
    for i, width in enumerate(widths):
        h = tf.keras.layers.Dense(width, name=f"dense{i}")(h)
        h = tf.keras.layers.LayerNormalization(name=f"norm{i}")(h)
        h = tf.keras.layers.Activation("relu", name=f"relu{i}")(h)
        if dropout:
            h = tf.keras.layers.Dropout(dropout)(h)
    if residual_linear:
        residual = tf.keras.layers.Dense(
            4,
            kernel_initializer="zeros",
            bias_initializer="zeros",
            name="mean_residual",
        )(h)
        linear = tf.keras.layers.Dense(4, name="mean_linear")(inp)
        mean = tf.keras.layers.Add(name="mean")([linear, residual])
        log_variance = tf.keras.layers.Dense(4, name="log_variance")(h)
        out = tf.keras.layers.Concatenate(name="value")([mean, log_variance])
    else:
        out = tf.keras.layers.Dense(8, name="value")(h)
    return tf.keras.Model(inp, out, name="v46_leaf_distribution")


def metrics(pred, target_mean, target_var):
    mu = pred[:, :4]
    logvar = np.clip(pred[:, 4:], -4.0, 7.0)
    variance = np.exp(logvar)
    error = mu - target_mean
    rmse = float(np.sqrt(np.mean(error ** 2)))
    mae = float(np.mean(np.abs(error)))
    nll = float(np.mean(0.5 * (logvar + (target_var + error ** 2) / variance)))
    calibration_target = np.mean(target_var) if np.mean(target_var) > 1e-9 else np.mean(error ** 2)
    calibration = float(np.sqrt(np.mean(variance)) / np.sqrt(calibration_target))
    return {"rmse": rmse, "mae": mae, "gaussianNll": nll, "sdCalibration": calibration}


def fit_ridge(xtr, ytr, lam=10.0):
    design = np.concatenate([xtr, np.ones((len(xtr), 1), np.float32)], axis=1)
    reg = np.eye(design.shape[1], dtype=np.float32) * lam
    reg[-1, -1] = 0
    return np.linalg.solve(design.T @ design + reg, design.T @ ytr)


def apply_ridge(x, weights):
    design = np.concatenate([x, np.ones((len(x), 1), np.float32)], axis=1)
    return design @ weights


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/v46-leaf-pilot")
    ap.add_argument("--out", default="ml/v46-leaf-distribution.json")
    ap.add_argument("--widths", default="64,32")
    ap.add_argument("--dropout", type=float, default=0.05)
    ap.add_argument("--epochs", type=int, default=300)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument(
        "--mean-weight",
        type=float,
        default=0.05,
        help="additional raw-margin MSE weight; prevents the variance head hiding mean error",
    )
    ap.add_argument("--patience", type=int, default=30)
    ap.add_argument("--holdout-games", type=int, default=3)
    ap.add_argument("--validation-games", type=int, default=3)
    ap.add_argument("--seed", type=int, default=4601)
    ap.add_argument("--variance-epochs", type=int, default=120)
    ap.add_argument(
        "--no-residual-linear",
        action="store_true",
        help="disable the direct linear mean head (mainly an ablation)",
    )
    args = ap.parse_args()

    np.random.seed(args.seed)
    tf.random.set_seed(args.seed)
    tf.config.experimental.enable_op_determinism()
    meta, x, y = load(args.data)
    games = np.unique(y[:, 0].astype(np.int32))
    holdout_n = min(max(1, args.holdout_games), len(games) - 2)
    holdout_games = games[-holdout_n:]
    remaining_games = games[:-holdout_n]
    validation_n = min(max(1, args.validation_games), len(remaining_games) - 1)
    validation_games = remaining_games[-validation_n:]
    game_ids = y[:, 0].astype(np.int32)
    test_mask = np.isin(game_ids, holdout_games)
    val_mask = np.isin(game_ids, validation_games)
    train_mask = ~(test_mask | val_mask)
    xtr, xva, xte = x[train_mask], x[val_mask], x[test_mask]
    ytr, yva, yte = y[train_mask], y[val_mask], y[test_mask]
    target_tr, target_va, target_te = ytr[:, 4:8], yva[:, 4:8], yte[:, 4:8]
    repeated_targets = y.shape[1] >= 12
    variance_tr = ytr[:, 8:12] if repeated_targets else np.zeros_like(target_tr)
    variance_va = yva[:, 8:12] if repeated_targets else np.zeros_like(target_va)
    variance_te = yte[:, 8:12] if repeated_targets else np.zeros_like(target_te)

    feature_mean = xtr.mean(0)
    feature_scale = xtr.std(0)
    feature_scale[feature_scale < 1e-6] = 1
    xtr_n = ((xtr - feature_mean) / feature_scale).astype(np.float32)
    xva_n = ((xva - feature_mean) / feature_scale).astype(np.float32)
    xte_n = ((xte - feature_mean) / feature_scale).astype(np.float32)

    widths = [int(value) for value in args.widths.split(",") if value]
    residual_linear = not args.no_residual_linear
    model = build(x.shape[1], widths, args.dropout, residual_linear)
    ridge_candidates = []
    for ridge_lambda in (1.0, 10.0, 100.0, 1000.0, 10000.0):
        candidate_weights = fit_ridge(xtr_n, target_tr, ridge_lambda)
        candidate_validation = apply_ridge(xva_n, candidate_weights)
        candidate_rmse = float(np.sqrt(np.mean((candidate_validation - target_va) ** 2)))
        ridge_candidates.append((candidate_rmse, ridge_lambda, candidate_weights))
    _, ridge_lambda, ridge_weights = min(ridge_candidates, key=lambda row: row[0])
    print(
        "ridge validation sweep: "
        + "  ".join(f"lambda={lam:g}:{score:.3f}" for score, lam, _ in ridge_candidates)
        + f"; selected {ridge_lambda:g}"
    )
    if residual_linear:
        # Start at the strongest cheap baseline. The nonlinear path is zero-initialised, and the
        # validation checkpoint includes epoch -1, so training can only replace ridge if it proves
        # a game-disjoint nonlinear correction.
        model.get_layer("mean_linear").set_weights([ridge_weights[:-1], ridge_weights[-1]])
    optimizer = tf.keras.optimizers.Adam(args.lr)

    @tf.function
    def loss_for(xb, means, variances, training):
        pred = model(xb, training=training)
        mu = pred[:, :4]
        logvar = tf.clip_by_value(pred[:, 4:], -4.0, 7.0)
        # Expected Gaussian NLL over the empirical samples, expressed through sufficient stats.
        squared_error = tf.square(means - mu)
        nll = 0.5 * (logvar + (variances + squared_error) * tf.exp(-logvar))
        return tf.reduce_mean(nll) + args.mean_weight * tf.reduce_mean(squared_error)

    initial_pred = model(xva_n, training=False).numpy()
    best_score = metrics(initial_pred, target_va, variance_va)["rmse"]
    best_epoch = -1
    best_weights = [weight.copy() for weight in model.get_weights()]
    print(f"epoch  -1 val_rmse={best_score:.3f} (ridge-initialised residual model)")
    for epoch in range(args.epochs):
        order = np.random.permutation(len(xtr_n))
        for start in range(0, len(order), args.batch):
            idx = order[start:start + args.batch]
            with tf.GradientTape() as tape:
                loss = loss_for(xtr_n[idx], target_tr[idx], variance_tr[idx], True)
            gradients = tape.gradient(loss, model.trainable_variables)
            optimizer.apply_gradients(zip(gradients, model.trainable_variables))
        val_loss = float(loss_for(xva_n, target_va, variance_va, False))
        val_pred = model(xva_n, training=False).numpy()
        val_rmse = metrics(val_pred, target_va, variance_va)["rmse"]
        if val_rmse < best_score - 1e-4:
            best_score = val_rmse
            best_epoch = epoch
            best_weights = [weight.copy() for weight in model.get_weights()]
        if epoch % 10 == 0 or epoch == args.epochs - 1:
            print(f"epoch {epoch:3d} val_nll={val_loss:.4f} val_rmse={val_rmse:.3f}")
        if epoch - best_epoch >= args.patience:
            print(f"early stop at epoch {epoch}; best epoch {best_epoch}")
            break

    model.set_weights(best_weights)
    variance_best_epoch = -1
    if residual_linear and args.variance_epochs > 0:
        # Mean selection and uncertainty calibration are different problems. Freeze the validated
        # mean/trunk checkpoint, then fit only log-variance; otherwise early stopping on mean RMSE
        # necessarily captures an immature variance head and stochastic deployment is mis-scaled.
        for layer in model.layers:
            layer.trainable = layer.name == "log_variance"
        variance_optimizer = tf.keras.optimizers.Adam(args.lr)
        variance_optimizer.build(model.get_layer("log_variance").trainable_variables)

        @tf.function
        def variance_step(xb, means, variances, training):
            if training:
                with tf.GradientTape() as tape:
                    pred = model(xb, training=False)
                    mu = tf.stop_gradient(pred[:, :4])
                    logvar = tf.clip_by_value(pred[:, 4:], -4.0, 7.0)
                    nll = tf.reduce_mean(
                        0.5 * (logvar + (variances + tf.square(means - mu)) * tf.exp(-logvar))
                    )
                variables = model.get_layer("log_variance").trainable_variables
                gradients = tape.gradient(nll, variables)
                variance_optimizer.apply_gradients(zip(gradients, variables))
                return nll
            pred = model(xb, training=False)
            mu = pred[:, :4]
            logvar = tf.clip_by_value(pred[:, 4:], -4.0, 7.0)
            return tf.reduce_mean(
                0.5 * (logvar + (variances + tf.square(means - mu)) * tf.exp(-logvar))
            )

        best_variance_loss = float(variance_step(xva_n, target_va, variance_va, False))
        best_variance_weights = model.get_layer("log_variance").get_weights()
        stale = 0
        for epoch in range(args.variance_epochs):
            order = np.random.permutation(len(xtr_n))
            for start in range(0, len(order), args.batch):
                idx = order[start:start + args.batch]
                variance_step(xtr_n[idx], target_tr[idx], variance_tr[idx], True)
            val_variance_loss = float(variance_step(xva_n, target_va, variance_va, False))
            if val_variance_loss < best_variance_loss - 1e-5:
                best_variance_loss = val_variance_loss
                best_variance_weights = [weight.copy() for weight in model.get_layer("log_variance").get_weights()]
                variance_best_epoch = epoch
                stale = 0
            else:
                stale += 1
            if stale >= 20:
                break
        model.get_layer("log_variance").set_weights(best_variance_weights)
        print(f"variance calibration best epoch {variance_best_epoch}; val_nll={best_variance_loss:.4f}")

    pred_tr = model(xtr_n, training=False).numpy()
    pred_va = model(xva_n, training=False).numpy()
    pred_te = model(xte_n, training=False).numpy()
    ridge = apply_ridge(xte_n, ridge_weights)
    constant = np.broadcast_to(target_tr.mean(0), target_te.shape)
    report = {
        "train": metrics(pred_tr, target_tr, variance_tr),
        "validation": metrics(pred_va, target_va, variance_va),
        "holdout": metrics(pred_te, target_te, variance_te),
        "ridgeHoldoutRmse": float(np.sqrt(np.mean((ridge - target_te) ** 2))),
        "ridgeLambda": ridge_lambda,
        "constantHoldoutRmse": float(np.sqrt(np.mean((constant - target_te) ** 2))),
        "singleRolloutSd": (
            float(np.sqrt(np.mean(variance_te))) if repeated_targets
            else float(np.sqrt(np.mean((target_te - target_te.mean(0)) ** 2)))
        ),
        "targetKind": "repeatedSufficientStatistics" if repeated_targets else "individualRollouts",
        "bestEpoch": best_epoch,
        "varianceBestEpoch": variance_best_epoch,
        "validationGames": validation_games.tolist(),
        "holdoutGames": holdout_games.tolist(),
    }
    print(json.dumps(report, indent=2))

    layers = []
    for i in range(len(widths)):
        dense = model.get_layer(f"dense{i}")
        norm = model.get_layer(f"norm{i}")
        weights, bias = dense.get_weights()
        gamma, beta = norm.get_weights()
        layers.append({
            "w": weights.T.astype(np.float32).ravel().tolist(),
            "b": bias.astype(np.float32).tolist(),
            "gamma": gamma.astype(np.float32).tolist(),
            "beta": beta.astype(np.float32).tolist(),
            "in": int(weights.shape[0]),
            "out": int(weights.shape[1]),
        })
    if residual_linear:
        mean_weights, mean_bias = model.get_layer("mean_residual").get_weights()
        variance_weights, variance_bias = model.get_layer("log_variance").get_weights()
        weights = np.concatenate([mean_weights, variance_weights], axis=1)
        bias = np.concatenate([mean_bias, variance_bias], axis=0)
        skip_weights, skip_bias = model.get_layer("mean_linear").get_weights()
    else:
        weights, bias = model.get_layer("value").get_weights()
    artifact = {
        "featureCount": int(x.shape[1]),
        "featureNames": meta["featureNames"],
        "mean": feature_mean.astype(np.float32).tolist(),
        "scale": feature_scale.astype(np.float32).tolist(),
        "layers": layers,
        "head": {
            "w": weights.T.astype(np.float32).ravel().tolist(),
            "b": bias.astype(np.float32).tolist(),
        },
        "skipHead": ({
            "w": skip_weights.T.astype(np.float32).ravel().tolist(),
            "b": skip_bias.astype(np.float32).tolist(),
        } if residual_linear else None),
        "outputContract": "meanMarginsThenLogVariances",
        "metrics": report,
        "trainedOn": meta,
        "hyperparameters": vars(args),
    }
    json.dump(artifact, open(args.out, "w"))
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
