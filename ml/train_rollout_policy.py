"""Distil search visit targets into a phase-conditioned, constant-cost rollout policy.

Only features cheap enough for the terminal-rollout inner loop are retained. Training is listwise
over siblings; shards A-F train, G selects the checkpoint/blend, and H is read once as holdout.
"""

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf


def load(prefixes):
    xs, ys, groups = [], [], []
    offset = 0
    first = None
    for prefix in prefixes:
        meta = json.load(open(f"{prefix}.meta.json"))
        if first is None:
            first = meta
        f, w = int(meta["featureCount"]), int(meta["targetWidth"])
        x = np.fromfile(f"{prefix}.x.f32", np.float32).reshape(-1, f)
        y = np.fromfile(f"{prefix}.y.f32", np.float32).reshape(-1, w)
        n = min(len(x), len(y))
        x, y = x[:n], y[:n]
        group = y[:, 0].astype(np.int64) + offset
        offset = int(group.max()) + 1
        xs.append(x)
        ys.append(y)
        groups.append(group)
    return first, np.concatenate(xs), np.concatenate(ys), np.concatenate(groups)


def cheap_features(x, names):
    phase = x[:, [names.index("phaseOpening"), names.index("phaseMidgame"), names.index("phaseEndgame")]]
    action_indices = (
        [names.index(f"move_piece{i}") for i in range(21)]
        + [names.index(f"move_orientation{i}") for i in range(8)]
        + [names.index("move_size"), names.index("move_homeAnchorX"),
           names.index("move_homeAnchorY"), names.index("move_centreDistance")]
    )
    action = x[:, action_indices]
    # Separate action weights per phase; this is still one indexed dot product in deployment.
    return (phase[:, :, None] * action[:, None, :]).reshape(len(x), -1).astype(np.float32)


def incumbent_scores(x, names):
    phase = np.argmax(
        x[:, [names.index("phaseOpening"), names.index("phaseMidgame"), names.index("phaseEndgame")]],
        axis=1,
    )
    size = x[:, names.index("move_size")] * 5.0
    distance = x[:, names.index("move_centreDistance")] * 19.0
    size_weight = np.asarray([1.6, 0.9, 1.3], np.float32)[phase]
    centre_weight = np.asarray([0.55, 0.15, 0.0], np.float32)[phase]
    return size * size_weight - distance * centre_weight


def group_rows(group_ids, max_k=12):
    return [np.where(group_ids == group)[0][:max_k] for group in np.unique(group_ids)]


def pack(values, rows, max_k=12):
    shape = values.shape[1:]
    out = np.zeros((len(rows), max_k) + shape, np.float32)
    mask = np.zeros((len(rows), max_k), np.float32)
    for index, selected in enumerate(rows):
        out[index, :len(selected)] = values[selected]
        mask[index, :len(selected)] = 1
    return out, mask


def metrics(scores, mask, mass):
    top1 = 0
    regret = 0.0
    pair_correct = 0
    pair_total = 0
    roots = 0
    for row in range(len(scores)):
        k = int(mask[row].sum())
        if k < 2:
            continue
        pred = scores[row, :k]
        target = mass[row, :k]
        chosen = int(np.argmax(pred))
        teacher = int(np.argmax(target))
        top1 += chosen == teacher
        total = target.sum()
        if total > 0:
            regret += (target[teacher] - target[chosen]) / total
        dp = pred[:, None] - pred[None, :]
        dt = target[:, None] - target[None, :]
        valid = np.abs(dt) > 1e-8
        pair_correct += int(((dp * dt > 0) & valid).sum())
        pair_total += int(valid.sum())
        roots += 1
    return {
        "top1": top1 / max(1, roots),
        "regret": regret / max(1, roots),
        "pair": pair_correct / max(1, pair_total),
        "roots": roots,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--validation", required=True)
    parser.add_argument("--holdout", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--seed", type=int, default=4751)
    args = parser.parse_args()

    np.random.seed(args.seed)
    tf.random.set_seed(args.seed)
    tf.config.experimental.enable_op_determinism()
    meta, xtr, ytr, gtr = load(args.train.split(','))
    _, xva, yva, gva = load([args.validation])
    _, xte, yte, gte = load([args.holdout])
    names = meta["featureNames"]
    policy_at = meta["targets"].index("policy")
    ftr, fva, fte = cheap_features(xtr, names), cheap_features(xva, names), cheap_features(xte, names)
    tr_rows, va_rows, te_rows = group_rows(gtr), group_rows(gva), group_rows(gte)
    tr_x, tr_mask = pack(ftr, tr_rows)
    va_x, va_mask = pack(fva, va_rows)
    te_x, te_mask = pack(fte, te_rows)
    tr_mass, _ = pack(ytr[:, policy_at], tr_rows)
    va_mass, _ = pack(yva[:, policy_at], va_rows)
    te_mass, _ = pack(yte[:, policy_at], te_rows)

    model = tf.keras.Sequential([
        tf.keras.Input((ftr.shape[1],)),
        tf.keras.layers.Dense(1, use_bias=False, kernel_regularizer=tf.keras.regularizers.l2(1e-4)),
    ])
    optimizer = tf.keras.optimizers.Adam(2e-2)
    best = None
    best_weights = None
    stale = 0
    for epoch in range(args.epochs):
        order = np.random.permutation(len(tr_x))
        for start in range(0, len(order), 256):
            selected = order[start:start + 256]
            xb = tf.constant(tr_x[selected])
            mb = tf.constant(tr_mask[selected])
            target = tf.constant(tr_mass[selected])
            with tf.GradientTape() as tape:
                shape = tf.shape(xb)
                logits = tf.reshape(model(tf.reshape(xb, (-1, ftr.shape[1])), training=True), (shape[0], shape[1]))
                valid = mb > 0
                target_prob = target / tf.maximum(tf.reduce_sum(target, axis=1, keepdims=True), 1e-8)
                logp = tf.nn.log_softmax(tf.where(valid, logits, -1e9), axis=1)
                loss = -tf.reduce_mean(tf.reduce_sum(tf.where(valid, target_prob * logp, 0.0), axis=1))
                loss += sum(model.losses)
            gradients = tape.gradient(loss, model.trainable_variables)
            optimizer.apply_gradients(zip(gradients, model.trainable_variables))

        val_scores = model(fva, training=False).numpy().reshape(-1)
        packed_scores, _ = pack(val_scores, va_rows)
        score = metrics(packed_scores, va_mask, va_mass)
        if best is None or score["regret"] < best["regret"] - 1e-5:
            best = score
            best_weights = [weight.copy() for weight in model.get_weights()]
            stale = 0
        else:
            stale += 1
        if epoch % 5 == 0:
            print(f"epoch {epoch:2d} val top1={score['top1']:.3f} pair={score['pair']:.3f} regret={score['regret']:.4f}")
        if stale >= 12:
            break
    model.set_weights(best_weights)

    weights = model.get_weights()[0].reshape(3, -1)
    val_raw, _ = pack(model(fva, training=False).numpy().reshape(-1), va_rows)
    hold_raw, _ = pack(model(fte, training=False).numpy().reshape(-1), te_rows)
    val_incumbent, _ = pack(incumbent_scores(xva, names), va_rows)
    hold_incumbent, _ = pack(incumbent_scores(xte, names), te_rows)
    # Select the learned correction on top of the exact static score used by the incumbent rollout.
    # Scale zero is a load-bearing null: if validation picks it, deployment is not warranted.
    scales = (0.0, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0)
    scale_rows = [
        (metrics(val_incumbent + val_raw * scale, va_mask, va_mass)["regret"], scale)
        for scale in scales
    ]
    _, selected_scale = min(scale_rows)
    validation_baseline = metrics(val_incumbent, va_mask, va_mass)
    holdout_baseline = metrics(hold_incumbent, te_mask, te_mass)
    validation = metrics(val_incumbent + val_raw * selected_scale, va_mask, va_mass)
    holdout = metrics(hold_incumbent + hold_raw * selected_scale, te_mask, te_mass)
    artifact = {
        "kind": "phase-action-rollout-policy-v47",
        "featuresPerPhase": int(weights.shape[1]),
        "featureOrder": [
            *[f"piece{i}" for i in range(21)],
            *[f"orientation{i}" for i in range(8)],
            "size", "homeAnchorX", "homeAnchorY", "centreDistance",
        ],
        "weights": weights.astype(np.float32).ravel().tolist(),
        "scale": selected_scale,
        "validationBaseline": validation_baseline,
        "validation": validation,
        "holdoutBaseline": holdout_baseline,
        "holdout": holdout,
        "trainGroups": len(tr_rows),
        "validationGroups": len(va_rows),
        "holdoutGroups": len(te_rows),
        "source": {"train": args.train, "validation": args.validation, "holdout": args.holdout},
    }
    json.dump(artifact, open(args.out, "w"))
    print(json.dumps(artifact, indent=2))
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
