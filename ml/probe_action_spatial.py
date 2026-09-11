"""Controlled v4.4 probe: 256 engineered inputs versus inputs plus an explicit action plane."""

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf


def load(prefixes):
    xs, ys, ps = [], [], []
    offset = 0
    first_meta = None
    for prefix in prefixes:
        meta = json.load(open(f"{prefix}.meta.json"))
        if first_meta is None:
            first_meta = meta
        elif meta["featureNames"] != first_meta["featureNames"] or meta["targets"] != first_meta["targets"]:
            raise SystemExit("shards disagree on feature or target contracts")
        f, w = meta["featureCount"], meta["targetWidth"]
        x = np.fromfile(f"{prefix}.x.f32", np.float32)
        y = np.fromfile(f"{prefix}.y.f32", np.float32)
        p = np.fromfile(f"{prefix}.p.u8", np.uint8)
        n = min(x.size // f, y.size // w, p.size // 400)
        x = x[: n * f].reshape(n, f)
        y = y[: n * w].reshape(n, w)
        p = p[: n * 400].reshape(n, 20, 20)
        y[:, 0] += offset
        offset = y[:, 0].max() + 1
        xs.append(x)
        ys.append(y)
        ps.append(p)
        print(f"  {prefix}: {n} rows")
    return first_meta, np.concatenate(xs), np.concatenate(ys), np.concatenate(ps)


def groups(y, max_k):
    ids = y[:, 0].astype(np.int64)
    return [np.where(ids == group)[0][:max_k] for group in np.unique(ids)]


def pack(source, index, max_k, shape):
    out = np.zeros((len(index), max_k) + shape, np.float32)
    mask = np.zeros((len(index), max_k), np.float32)
    for row, selected in enumerate(index):
        out[row, : len(selected)] = source[selected]
        mask[row, : len(selected)] = 1
    return out, mask


def build_mlp(features):
    inp = tf.keras.Input((features,))
    h = inp
    for width in (128, 64, 32):
        h = tf.keras.layers.Dense(width)(h)
        h = tf.keras.layers.LayerNormalization()(h)
        h = tf.keras.layers.Activation("relu")(h)
        h = tf.keras.layers.Dropout(0.1)(h)
    return tf.keras.Model(inp, tf.keras.layers.Dense(1)(h))


def build_spatial(features, channels=5, width=16):
    board = tf.keras.Input((20, 20, channels))
    vector = tf.keras.Input((features,))
    h = board
    for _ in range(3):
        h = tf.keras.layers.Conv2D(width, 3, padding="same")(h)
        h = tf.keras.layers.LayerNormalization()(h)
        h = tf.keras.layers.Activation("relu")(h)
    h = tf.keras.layers.Conv2D(width, 3, strides=2, padding="same", activation="relu")(h)
    h = tf.keras.layers.Conv2D(width, 3, strides=2, padding="same", activation="relu")(h)
    h = tf.keras.layers.Flatten()(h)
    v = tf.keras.layers.Dense(96, activation="relu")(vector)
    h = tf.keras.layers.Concatenate()([h, v])
    h = tf.keras.layers.Dense(96, activation="relu")(h)
    return tf.keras.Model([board, vector], tf.keras.layers.Dense(1)(h))


def build_pooled(features, max_k, width=16):
    """Encode the parent board, then pool local embeddings under the action footprint.

    The parent encoding is identical for every sibling and can be computed once in deployment;
    only the mask pooling and small scorer are action-specific.
    """
    board = tf.keras.Input((20, 20, 4))
    action = tf.keras.Input((max_k, 20, 20, 1))
    vector = tf.keras.Input((max_k, features))
    h = board
    for _ in range(3):
        h = tf.keras.layers.Conv2D(width, 3, padding="same")(h)
        h = tf.keras.layers.LayerNormalization()(h)
        h = tf.keras.layers.Activation("relu")(h)
    expanded = tf.keras.layers.Lambda(lambda x: tf.expand_dims(x, 1))(h)
    weighted = tf.keras.layers.Multiply()([expanded, action])
    summed = tf.keras.layers.Lambda(lambda x: tf.reduce_sum(x, axis=(2, 3)))(weighted)
    count = tf.keras.layers.Lambda(lambda x: tf.reduce_sum(x, axis=(2, 3)) + 1e-6)(action)
    local = tf.keras.layers.Lambda(lambda x: x[0] / x[1])([summed, count])
    v = tf.keras.layers.Dense(96, activation="relu")(vector)
    h = tf.keras.layers.Concatenate()([local, v])
    h = tf.keras.layers.Dense(64, activation="relu")(h)
    score = tf.keras.layers.Dense(1)(h)
    score = tf.keras.layers.Lambda(lambda x: tf.squeeze(x, -1))(score)
    return tf.keras.Model([board, action, vector], score)


def metrics(pred, mask, logits, mass):
    correct = pairs = top1 = roots = 0
    regret = 0.0
    for row in range(len(pred)):
        k = int(mask[row].sum())
        if k < 2:
            continue
        p, t = pred[row, :k], logits[row, :k]
        chosen, teacher = int(np.argmax(p)), int(np.argmax(t))
        roots += 1
        top1 += int(chosen == teacher)
        total_mass = mass[row, :k].sum()
        if total_mass > 0:
            regret += (mass[row, teacher] - mass[row, chosen]) / total_mass
        dp = p[:, None] - p[None, :]
        dt = t[:, None] - t[None, :]
        valid = np.abs(dt) > 1e-6
        correct += int(((dp * dt > 0) & valid).sum())
        pairs += int(valid.sum())
    return correct / max(pairs, 1), top1 / max(roots, 1), regret / max(roots, 1)


def predict(model, x, mask, grouped=False):
    if grouped:
        return model(x, training=False).numpy()
    multi = isinstance(x, list)
    flat = ([part.reshape((-1,) + part.shape[2:]) for part in x] if multi else
            x.reshape((-1,) + x.shape[2:]))
    return model(flat, training=False).numpy().reshape(len(mask), mask.shape[1])


def train(model, train_x, train_mask, train_logits, val_x, val_mask, val_logits, val_mass,
          epochs, batch, patience, label, grouped=False):
    opt = tf.keras.optimizers.Adam(1e-3)
    best_score = None
    best_weights = None
    best_epoch = -1
    stale = 0
    multi = isinstance(train_x, list)
    for epoch in range(epochs):
        order = np.random.permutation(len(train_mask))
        for at in range(0, len(order), batch):
            selected = order[at : at + batch]
            xb = [tf.constant(x[selected]) for x in train_x] if multi else tf.constant(train_x[selected])
            mb = tf.constant(train_mask[selected])
            tb = tf.constant(train_logits[selected])
            shape = tf.shape(xb[0] if multi else xb)
            with tf.GradientTape() as tape:
                if grouped:
                    pred = model(xb, training=True)
                else:
                    flat = ([tf.reshape(x, tf.concat([[-1], tf.shape(x)[2:]], 0)) for x in xb]
                            if multi else tf.reshape(xb, tf.concat([[-1], shape[2:]], 0)))
                    pred = tf.reshape(model(flat, training=True), (shape[0], shape[1]))
                valid = mb > 0
                target = tf.nn.softmax(tf.where(valid, tb, -1e9), -1)
                logp = tf.nn.log_softmax(tf.where(valid, pred, -1e9), -1)
                loss = tf.reduce_mean(-tf.reduce_sum(tf.where(valid, target * logp, 0.0), -1))
            grads = tape.gradient(loss, model.trainable_variables)
            opt.apply_gradients(zip(grads, model.trainable_variables))
        pred = predict(model, val_x, val_mask, grouped)
        score = metrics(pred, val_mask, val_logits, val_mass)
        if best_score is None or score[2] < best_score[2] - 1e-5:
            best_score = score
            best_weights = model.get_weights()
            best_epoch = epoch
            stale = 0
        else:
            stale += 1
        print(f"{label} epoch {epoch:2d}: pair={score[0]:.4f} top1={score[1]:.4f} "
              f"regret={score[2]:.4f} stale={stale}/{patience}")
        if stale >= patience:
            break
    model.set_weights(best_weights)
    return best_epoch, best_score


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="comma-separated training prefixes")
    ap.add_argument("--validation", required=True, help="checkpoint-selection prefix")
    ap.add_argument("--holdout", required=True)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--max-k", type=int, default=12)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--patience", type=int, default=6)
    ap.add_argument("--seed", type=int, default=4501)
    ap.add_argument("--model", choices=("features", "pooled", "both"), default="both")
    ap.add_argument("--out", help="optional JSON result path")
    ap.add_argument("--weights-dir", help="optional directory for selected checkpoint NPZ files")
    args = ap.parse_args()

    np.random.seed(args.seed)
    tf.random.set_seed(args.seed)
    tf.config.experimental.enable_op_determinism()
    train_meta, train_features, train_y, train_planes = load(args.data.split(','))
    val_meta, val_features, val_y, val_planes = load([args.validation])
    hold_meta, hold_features, hold_y, hold_planes = load([args.holdout])
    if (train_meta["featureNames"] != val_meta["featureNames"] or
            train_meta["featureNames"] != hold_meta["featureNames"]):
        raise SystemExit("validation/holdout feature contract differs")
    policy_at = train_meta["targets"].index("policy")
    train_index = groups(train_y, args.max_k)
    val_index = groups(val_y, args.max_k)
    hold_index = groups(hold_y, args.max_k)
    train_logits_flat = np.log(np.maximum(train_y[:, policy_at], 1e-8))
    val_mass_flat = val_y[:, policy_at]
    val_logits_flat = np.log(np.maximum(val_mass_flat, 1e-8))
    hold_mass_flat = hold_y[:, policy_at]
    hold_logits_flat = np.log(np.maximum(hold_mass_flat, 1e-8))

    mu, sd = train_features.mean(0), train_features.std(0)
    sd[sd < 1e-6] = 1
    train_vector, train_mask = pack(((train_features - mu) / sd).astype(np.float32), train_index,
                                    args.max_k, (train_features.shape[1],))
    val_vector, val_mask = pack(((val_features - mu) / sd).astype(np.float32), val_index,
                                args.max_k, (val_features.shape[1],))
    hold_vector, hold_mask = pack(((hold_features - mu) / sd).astype(np.float32), hold_index,
                                  args.max_k, (hold_features.shape[1],))
    train_logits, _ = pack(train_logits_flat, train_index, args.max_k, ())
    val_logits, _ = pack(val_logits_flat, val_index, args.max_k, ())
    val_mass, _ = pack(val_mass_flat, val_index, args.max_k, ())
    hold_logits, _ = pack(hold_logits_flat, hold_index, args.max_k, ())
    hold_mass, _ = pack(hold_mass_flat, hold_index, args.max_k, ())

    def canonicalize(raw, target, meta):
        seat_at = meta["targets"].index("seat") if "seat" in meta["targets"] else -1
        canonical = raw.copy()
        if seat_at < 0:
            print("warning: legacy planes have no mover seat; leaving board orientation absolute")
        else:
            seats = target[:, seat_at].astype(np.int8)
            for seat in range(4):
                selected = seats == seat
                if seat == 1:
                    canonical[selected] = raw[selected, ::-1, :]
                elif seat == 2:
                    canonical[selected] = raw[selected, ::-1, ::-1]
                elif seat == 3:
                    canonical[selected] = raw[selected, :, ::-1]
        return canonical

    def pack_spatial(raw, index):
        # One parent board per root, plus K action masks. Candidate cells were written over the
        # child position's own occupancy, so codes 1..4 reconstruct the identical parent board.
        board = np.zeros((len(index), 20, 20, 4), np.float32)
        action = np.zeros((len(index), args.max_k, 20, 20, 1), np.float32)
        for row, selected in enumerate(index):
            parent = raw[selected[0]]
            board[row] = np.stack([parent == owner for owner in range(1, 5)], axis=-1)
            action[row, :len(selected), ..., 0] = raw[selected] == 5
        return board, action

    train_board, train_action = pack_spatial(canonicalize(train_planes, train_y, train_meta),
                                             train_index)
    val_board, val_action = pack_spatial(canonicalize(val_planes, val_y, val_meta), val_index)
    hold_board, hold_action = pack_spatial(canonicalize(hold_planes, hold_y, hold_meta), hold_index)
    print(f"{len(train_index)} train / {len(val_index)} validation / {len(hold_index)} holdout groups")
    results = {"seed": args.seed, "trainGroups": len(train_index),
               "validationGroups": len(val_index), "holdoutGroups": len(hold_index)}

    def run(label, model, train_input, val_input, hold_input, grouped=False):
        epoch, validation = train(model, train_input, train_mask, train_logits, val_input,
                                  val_mask, val_logits, val_mass, args.epochs, args.batch,
                                  args.patience, label, grouped)
        hold_pred = predict(model, hold_input, hold_mask, grouped)
        holdout = metrics(hold_pred, hold_mask, hold_logits, hold_mass)
        result = {"bestEpoch": epoch,
                  "validation": {"pair": validation[0], "top1": validation[1],
                                 "regret": validation[2]},
                  "holdout": {"pair": holdout[0], "top1": holdout[1],
                              "regret": holdout[2]}}
        results[label] = result
        if args.weights_dir:
            os.makedirs(args.weights_dir, exist_ok=True)
            weights = model.get_weights()
            result["weightShapes"] = [list(weight.shape) for weight in weights]
            np.savez_compressed(
                os.path.join(args.weights_dir, f"{label}-seed{args.seed}.npz"),
                mean=mu.astype(np.float32), scale=sd.astype(np.float32),
                **{f"weight_{at}": weight for at, weight in enumerate(weights)},
            )
        print(f"FINAL {label}: epoch={epoch} holdout pair={holdout[0]:.4f} "
              f"top1={holdout[1]:.4f} regret={holdout[2]:.4f}")

    if args.model in ("features", "both"):
        run("features", build_mlp(train_features.shape[1]), train_vector, val_vector, hold_vector)
    if args.model in ("pooled", "both"):
        run("pooled", build_pooled(train_features.shape[1], args.max_k, width=args.width),
            [train_board, train_action, train_vector],
            [val_board, val_action, val_vector],
            [hold_board, hold_action, hold_vector], True)
    if args.out:
        with open(args.out, "w") as handle:
            json.dump(results, handle, indent=2)
            handle.write("\n")


if __name__ == "__main__":
    main()
