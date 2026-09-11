"""
Is the sibling-ranking ceiling a property of the task, or of the hand-picked features?

The MLP over 168 engineered features plateaus at ~0.57 pairwise accuracy on the teacher's ordering,
barely above a linear fit on the same features (0.573) and far above what v3's own evaluation terms
manage (0.51, i.e. chance). Three explanations fit that: the teacher's ordering is mostly noise; the
task needs more data; or the features throw away the information the task needs.

This settles it by giving a small convnet the raw board instead — one byte per cell, seat-relative —
and training it on exactly the same groups with exactly the same loss. If the convnet ranks
materially better, the ceiling is the *features*, and the next generation should be spatial. If it
lands in the same place, the ceiling is the task and no amount of feature engineering will move it.

This is a diagnostic, not a shipped model: a per-leaf convolution in JS would price the evaluation
out of the search it exists to serve.

    ml/.venv/bin/python ml/probe_spatial.py --data ml/data/planes
"""

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf


def pairwise_accuracy(pred, mask, teacher):
    correct = total = 0
    for i in range(pred.shape[0]):
        k = int(mask[i].sum())
        if k < 2:
            continue
        p, t = pred[i, :k], teacher[i, :k]
        dp = p[:, None] - p[None, :]
        dt = t[:, None] - t[None, :]
        valid = np.abs(dt) > 1e-6
        correct += int(((dp * dt > 0) & valid).sum())
        total += int(valid.sum())
    return correct / max(total, 1)


def make_groups(y, max_k):
    gid = y[:, 0].astype(np.int64)
    uq = np.unique(gid)
    idx = [np.where(gid == g)[0][:max_k] for g in uq]
    return [i for i in idx if len(i) > 1]


def pack(source, groups, max_k, shape):
    out = np.zeros((len(groups), max_k) + shape, np.float32)
    mask = np.zeros((len(groups), max_k), np.float32)
    for n, i in enumerate(groups):
        out[n, : len(i)] = source[i]
        mask[n, : len(i)] = 1
    return out, mask


def build_cnn(channels, width, depth=3):
    """Deliberately small. This is a probe on CPU, so the question is whether *any* spatial model
    beats the feature vector, not how good the best one could be — a positive here is a lower bound
    on what a spatial representation is worth."""
    inp = tf.keras.Input((20, 20, channels))
    h = inp
    for _ in range(depth):
        h = tf.keras.layers.Conv2D(width, 3, padding="same")(h)
        h = tf.keras.layers.LayerNormalization()(h)
        h = tf.keras.layers.Activation("relu")(h)
    # Strided reduction rather than global average pooling. Averaging over the board is nearly
    # translation-invariant, which throws away *where* a move went — the one thing a spatial
    # representation is supposed to contribute. Keeping a coarse 5x5 map preserves it.
    h = tf.keras.layers.Conv2D(width, 3, strides=2, padding="same", activation="relu")(h)
    h = tf.keras.layers.Conv2D(width, 3, strides=2, padding="same", activation="relu")(h)
    h = tf.keras.layers.Flatten()(h)
    h = tf.keras.layers.Dense(64, activation="relu")(h)
    return tf.keras.Model(inp, tf.keras.layers.Dense(1)(h))


def build_combined(channels, width, n_features, depth=3):
    """Board *and* features. The pure convnet cannot see which pieces are still in hand, which the
    MLP can — without this arm, a loss for the convnet would be confounded with that handicap."""
    bin_ = tf.keras.Input((20, 20, channels))
    fin = tf.keras.Input((n_features,))
    h = bin_
    for _ in range(depth):
        h = tf.keras.layers.Conv2D(width, 3, padding="same")(h)
        h = tf.keras.layers.LayerNormalization()(h)
        h = tf.keras.layers.Activation("relu")(h)
    h = tf.keras.layers.Conv2D(width, 3, strides=2, padding="same", activation="relu")(h)
    h = tf.keras.layers.Conv2D(width, 3, strides=2, padding="same", activation="relu")(h)
    h = tf.keras.layers.Flatten()(h)
    g = tf.keras.layers.Dense(96, activation="relu")(fin)
    h = tf.keras.layers.Concatenate()([h, g])
    h = tf.keras.layers.Dense(96, activation="relu")(h)
    return tf.keras.Model([bin_, fin], tf.keras.layers.Dense(1)(h))


def build_mlp(n, width):
    inp = tf.keras.Input((n,))
    h = inp
    w = width
    for _ in range(3):
        h = tf.keras.layers.Dense(w)(h)
        h = tf.keras.layers.LayerNormalization()(h)
        h = tf.keras.layers.Activation("relu")(h)
        w = max(32, w // 2)
    return tf.keras.Model(inp, tf.keras.layers.Dense(1)(h))


def train(model, xg, mask, teacher, tr, va, epochs, tau, lr, batch, label):
    opt = tf.keras.optimizers.Adam(lr)
    best, best_epoch = 0.0, -1
    n = len(tr)
    for epoch in range(epochs):
        perm = np.random.permutation(n)
        for i in range(0, n, batch):
            sel = [tr[j] for j in perm[i : i + batch]]
            multi = isinstance(xg, (list, tuple))
            xb = [tf.constant(a[sel]) for a in xg] if multi else tf.constant(xg[sel])
            mb = tf.constant(mask[sel])
            tb = tf.constant(teacher[sel])
            shape = tf.shape(xb[0] if multi else xb)
            with tf.GradientTape() as tape:
                if multi:
                    flat = [tf.reshape(a, tf.concat([[-1], tf.shape(a)[2:]], 0)) for a in xb]
                else:
                    flat = tf.reshape(xb, tf.concat([[-1], shape[2:]], 0))
                pred = tf.reshape(model(flat, training=True), (shape[0], shape[1]))
                m = mb > 0
                tgt = tf.nn.softmax(tf.where(m, tb / tau, -1e9), -1)
                logp = tf.nn.log_softmax(tf.where(m, pred / tau, -1e9), -1)
                loss = tf.reduce_mean(-tf.reduce_sum(tf.where(m, tgt * logp, 0.0), -1))
            opt.apply_gradients(zip(tape.gradient(loss, model.trainable_variables),
                                    model.trainable_variables))
        if isinstance(xg, (list, tuple)):
            xv = [a[va] for a in xg]
            flatv = [a.reshape((-1,) + a.shape[2:]) for a in xv]
            n0, k0 = xv[0].shape[0], xv[0].shape[1]
        else:
            xv = xg[va]
            flatv = xv.reshape((-1,) + xv.shape[2:])
            n0, k0 = xv.shape[0], xv.shape[1]
        pv = model(flatv, training=False).numpy().reshape(n0, k0, 1)[..., 0]
        acc = pairwise_accuracy(pv, mask[va], teacher[va])
        if acc > best:
            best, best_epoch = acc, epoch
        print(f"  {label} epoch {epoch:3d}  loss {float(loss):.4f}  val pair-acc {acc:.4f}"
              + ("  *" if best_epoch == epoch else ""))
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/planes")
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--max-k", type=int, default=12)
    ap.add_argument("--tau", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--max-groups", type=int, default=0)
    args = ap.parse_args()

    meta = json.load(open(f"{args.data}.meta.json"))
    f = meta["featureCount"]
    target_width = int(meta.get("targetWidth", 7))
    x = np.fromfile(f"{args.data}.x.f32", dtype=np.float32)
    y = np.fromfile(f"{args.data}.y.f32", dtype=np.float32)
    p = np.fromfile(f"{args.data}.p.u8", dtype=np.uint8)
    n = min(x.size // f, y.size // target_width, p.size // 400)
    X = x[: n * f].reshape(n, f)
    Y = y[: n * target_width].reshape(n, target_width)
    P = p[: n * 400].reshape(n, 20, 20)
    print(f"{n} rows, {f} features, planes {P.shape}")

    groups = make_groups(Y, args.max_k)
    if args.max_groups and len(groups) > args.max_groups:
        groups = groups[: args.max_groups]
    teacher_flat = Y[:, 2]
    split = int(len(groups) * 0.85)
    tr, va = list(range(split)), list(range(split, len(groups)))

    tg = np.zeros((len(groups), args.max_k), np.float32)
    for i, g in enumerate(groups):
        tg[i, : len(g)] = teacher_flat[g]

    # Seat-relative one-hot: own squares, then the three opponents in turn order from the mover.
    planes = np.stack([(P == c).astype(np.float32) for c in (1, 2, 3, 4)], -1)
    pg, mask = pack(planes, groups, args.max_k, (20, 20, 4))

    mu, sd = X.mean(0), X.std(0)
    sd[sd < 1e-6] = 1
    fg, _ = pack(((X - mu) / sd).astype(np.float32), groups, args.max_k, (f,))

    print(f"{len(groups)} groups, {len(tr)} train / {len(va)} val\n")
    print("MLP over the 168 engineered features:")
    mlp = train(build_mlp(f, 128), fg, mask, tg, tr, va, args.epochs, args.tau, args.lr,
                args.batch, "mlp")
    print("\nConvnet over the raw board:")
    cnn = train(build_cnn(4, args.width, args.depth), pg, mask, tg, tr, va, args.epochs, args.tau,
                args.lr, args.batch, "cnn")
    print("\nConvnet over the board plus the feature vector:")
    both = train(build_combined(4, args.width, f, args.depth), [pg, fg], mask, tg, tr, va,
                 args.epochs, args.tau, args.lr, args.batch, "both")
    print(f"\n=== best val pairwise accuracy ===\n  features   {mlp:.4f}\n  raw board  {cnn:.4f}"
          f"\n  board+feat {both:.4f}")
    print("\nIf the board is materially higher, the ceiling is the features and the next")
    print("generation should be spatial. If they match, the ceiling is the task.")


if __name__ == "__main__":
    main()
