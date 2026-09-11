"""
v4 — a learned Blokus evaluation, distilled from search.

Why this shape and not a policy-value CNN
-----------------------------------------
The investigation that produced v3 ended with one localised finding: v12's evaluation was the
*better* global predictor of final margin (Spearman 0.494 against v11's 0.444) and still lost the
match by 2.84 points. A better global predictor that loses is a ranking failure, not a calibration
failure — what decides a move is the ordering of one node's children, and a monotone transform of
the whole state space is free to preserve global correlation while scrambling that ordering.

So the primary loss here is *listwise over siblings*, not regression against the outcome. Each
training group is one search node's candidate children with the teacher's searched value attached;
the model is asked to reproduce the teacher's ordering within the group. Regression against the
final margin is kept as an auxiliary head on the single child that was actually played, because a
leaf value that has drifted out of score units is useless to the search that consumes it — but it
is explicitly the secondary objective.

A convnet over 20x20 planes would express more, and the reason it is not used is that the evaluation
runs at every MCTS leaf. v3 costs 41 ms/move at 300 iterations; a per-leaf convolution in JS would
price the network out of the search it exists to serve. The trunk here is a small MLP over features
the bitboard engine already computes for its own evaluation, so inference is a few microseconds and
the marginal cost over v3's hand-written evaluation is close to zero.

    ml/.venv/bin/python ml/train_v4.py --data ml/data/train --out ml/v4-weights.json
"""

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf


CANONICAL_TARGETS = [
    "group", "onPath", "teacher", "visits", "policy", "confidence", "m0", "m1", "m2", "m3"
]


def canonical_targets(raw, meta):
    """Map old and new export schemas to one stable in-memory layout."""
    names = meta.get("targets", ["group", "onPath", "teacher", "m0", "m1", "m2", "m3"])
    out = np.full((raw.shape[0], len(CANONICAL_TARGETS)), np.nan, np.float32)
    for i, name in enumerate(CANONICAL_TARGETS):
        if name in names:
            out[:, i] = raw[:, names.index(name)]
    return out


def load(prefixes):
    """Loads one or more export shards, keeping each shard's groups disjoint.

    Parallel exporters write independent shards on disjoint seed bases. Their group ids both start
    at zero, so concatenating naively would merge two unrelated search nodes into one training
    group — silently teaching the model to rank moves from different positions against each other.
    Each shard's ids are offset past the previous one.
    """
    xs, ys, metas = [], [], []
    offset = 0
    for prefix in prefixes:
        meta = json.load(open(f"{prefix}.meta.json"))
        f = meta["featureCount"]
        w = int(meta.get("targetWidth", 7))
        x = np.fromfile(f"{prefix}.x.f32", dtype=np.float32)
        y = np.fromfile(f"{prefix}.y.f32", dtype=np.float32)
        # A shard still being appended to can end mid-row; truncate to whole rows of both.
        n = min(x.size // f, y.size // w)
        if n == 0:
            continue
        x = x[: n * f].reshape(n, f)
        y = canonical_targets(y[: n * w].reshape(n, w), meta)
        y[:, 0] += offset
        offset = y[:, 0].max() + 1
        xs.append(x)
        ys.append(y)
        metas.append(meta)
        print(f"  {prefix}: {n} rows, {int(y[:,0].max()-y[:,0].min())+1} groups")
    if not xs:
        raise SystemExit("no data in any shard")
    for m in metas[1:]:
        if m["featureNames"] != metas[0]["featureNames"]:
            raise SystemExit("shards disagree on the feature contract; re-export them together")
    merged_meta = dict(metas[0])
    merged_meta["teachers"] = sorted({teacher for m in metas for teacher in m["teachers"]})
    iteration_counts = sorted({int(m["iterations"]) for m in metas})
    merged_meta["iterations"] = iteration_counts[0] if len(iteration_counts) == 1 else iteration_counts
    return merged_meta, np.concatenate(xs), np.concatenate(ys)


def group(x, y, max_k):
    """Pack flat rows into padded per-node sibling groups."""
    gid = y[:, 0].astype(np.int64)
    order = np.argsort(gid, kind="stable")
    gid, x, y = gid[order], x[order], y[order]
    starts = np.searchsorted(gid, np.unique(gid), side="left")
    ends = np.searchsorted(gid, np.unique(gid), side="right")

    g = len(starts)
    f = x.shape[1]
    xg = np.zeros((g, max_k, f), np.float32)
    mask = np.zeros((g, max_k), np.float32)
    teacher = np.zeros((g, max_k), np.float32)
    visits = np.full((g, max_k), np.nan, np.float32)
    policy = np.full((g, max_k), np.nan, np.float32)
    confidence = np.ones(g, np.float32)
    onpath = np.zeros((g, max_k), np.float32)
    outcome = np.zeros((g, 4), np.float32)

    for i, (a, b) in enumerate(zip(starts, ends)):
        k = min(b - a, max_k)
        xg[i, :k] = x[a : a + k]
        mask[i, :k] = 1.0
        teacher[i, :k] = y[a : a + k, 2]
        visits[i, :k] = y[a : a + k, 3]
        policy[i, :k] = y[a : a + k, 4]
        if np.isfinite(y[a, 5]):
            confidence[i] = y[a, 5]
        onpath[i, :k] = y[a : a + k, 1]
        outcome[i] = y[a, 6:10]
    return xg, mask, teacher, visits, policy, confidence, onpath, outcome


def build(n_features, width, depth, dropout, outputs=4):
    inp = tf.keras.Input((n_features,), name="features")
    h = inp
    for i in range(depth):
        h = tf.keras.layers.Dense(width, name=f"dense{i}")(h)
        h = tf.keras.layers.LayerNormalization(name=f"norm{i}")(h)
        h = tf.keras.layers.Activation("relu", name=f"relu{i}")(h)
        if dropout > 0:
            h = tf.keras.layers.Dropout(dropout)(h)
        width = max(32, width // 2)
    out = tf.keras.layers.Dense(outputs, name="value")(h)
    return tf.keras.Model(inp, out, name="v4")


NEG = -1e9


def losses(
    pred, mask, teacher, group_weight, onpath, outcome, tau, alpha, pairwise=0.0, margin_pow=1.0
):
    """Sibling ranking on the perspective seat + an on-path anchor over all four seats."""
    own = pred[..., 0]
    m = mask > 0

    # Teacher's ordering as a soft target over the siblings of one node. Softmax is shift-invariant,
    # so only the *spread* of teacher values inside a group matters — exactly the sibling
    # discrimination the hand-written evaluations were losing on.
    t_logits = tf.where(m, teacher / tau, NEG)
    p_logits = tf.where(m, own / tau, NEG)
    target = tf.nn.softmax(t_logits, axis=-1)
    logp = tf.nn.log_softmax(p_logits, axis=-1)
    listwise = -tf.reduce_sum(tf.where(m, target * logp, 0.0), axis=-1)
    weighted_listwise = tf.reduce_sum(listwise * group_weight) / (tf.reduce_sum(group_weight) + 1e-6)

    # Only the child that was actually played has a real outcome label; scoring the siblings against
    # the game's result would leak the result onto moves that were never made.
    # Every seat's margin is supervised here, not just the perspective seat's: max^n needs the whole
    # value vector, and the other three outputs would otherwise never receive a gradient.
    played = tf.reduce_sum(pred * onpath[..., None], axis=1)
    anchor = tf.reduce_mean(tf.square(played - outcome), axis=-1)

    # RankNet: every ordered sibling pair as a logistic classification, weighted by how far apart
    # the teacher actually put them. Listwise softmax spends most of its gradient on the *identity*
    # of the best child; what the search needs is the ordering of the whole shortlist, and near-ties
    # carry no information worth fitting. Weighting by |Δteacher| encodes exactly that.
    if pairwise > 0:
        dp = own[:, :, None] - own[:, None, :]
        pair_mask = m[:, :, None] & m[:, None, :]
        # Visit targets are NaN in padded slots. Mask before subtraction: multiplying a later NaN
        # loss by a zero validity weight still produces NaN and poisons the entire batch.
        safe_teacher = tf.where(m, teacher, 0.0)
        dt = safe_teacher[:, :, None] - safe_teacher[:, None, :]
        valid = tf.cast(pair_mask, tf.float32)
        valid *= tf.cast(dt > 1e-6, tf.float32)
        weight = valid * tf.pow(tf.abs(dt), margin_pow)
        weight *= group_weight[:, None, None]
        # softplus(-dp) is -log sigmoid(dp): the loss for saying "i beats j" when the teacher agrees.
        pair_loss = tf.math.softplus(-dp / tau) * weight
        rank = tf.reduce_sum(pair_loss) / (tf.reduce_sum(weight) + 1e-6)
    else:
        rank = weighted_listwise

    total = (1 - pairwise) * weighted_listwise + pairwise * rank + alpha * tf.reduce_mean(
        anchor
    )
    return rank if pairwise > 0 else weighted_listwise, tf.reduce_mean(anchor), total


def pairwise_accuracy(pred, mask, teacher):
    """Share of sibling pairs the model orders the way the teacher did — the metric that matters."""
    pred = pred[..., 0]
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


def top1_accuracy(pred, mask, teacher):
    """Share of nodes whose most-visited child is the model's highest-scored child."""
    pred = pred[..., 0]
    correct = total = 0
    for i in range(pred.shape[0]):
        k = int(mask[i].sum())
        if k < 2:
            continue
        correct += int(np.argmax(pred[i, :k]) == np.argmax(teacher[i, :k]))
        total += 1
    return correct / max(total, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/train",
                    help="comma-separated export prefixes; shards are merged with disjoint groups")
    ap.add_argument("--out", default="ml/v4-weights.json")
    ap.add_argument("--width", type=int, default=128)
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--tau", type=float, default=2.0)
    ap.add_argument("--alpha", type=float, default=0.02)
    ap.add_argument("--max-k", type=int, default=12)
    ap.add_argument("--val-frac", type=float, default=0.12)
    ap.add_argument("--patience", type=int, default=10)
    ap.add_argument("--pairwise", type=float, default=0.0,
                    help="weight on the RankNet pair loss vs the listwise softmax (0..1)")
    ap.add_argument("--margin-pow", type=float, default=1.0)
    ap.add_argument(
        "--rank-target",
        choices=("auto", "value", "visits", "consensus"),
        default="auto",
        help="policy target: root visit counts when available, or searched Q values for old data",
    )
    ap.add_argument("--weight-decay", type=float, default=0.0)
    ap.add_argument(
        "--confidence-power",
        type=float,
        default=1.0,
        help="raise repeated-search top-choice agreement to this power for group weighting",
    )
    ap.add_argument(
        "--feature-prefix",
        type=int,
        default=0,
        help="train on only the first N inputs (for controlled backward-compatible feature ablations)",
    )
    ap.add_argument("--seed", type=int, default=4104)
    args = ap.parse_args()

    np.random.seed(args.seed)
    tf.random.set_seed(args.seed)
    tf.config.experimental.enable_op_determinism()

    prefixes = [p.strip() for p in args.data.split(",") if p.strip()]
    print(f"loading {len(prefixes)} shard(s):")
    meta, x, y = load(prefixes)
    if args.feature_prefix:
        if args.feature_prefix <= 0 or args.feature_prefix > x.shape[1]:
            raise SystemExit(
                f"--feature-prefix must be in 1..{x.shape[1]}, got {args.feature_prefix}"
            )
        x = x[:, : args.feature_prefix]
        meta["featureNames"] = meta["featureNames"][: args.feature_prefix]
        meta["featureCount"] = args.feature_prefix
        print(f"using backward-compatible feature prefix: {args.feature_prefix}")
    print(f"{x.shape[0]} rows, {int(y[:,0].max())+1} groups, {x.shape[1]} features")

    xg, mask, teacher, visits, policy, confidence, onpath, outcome = group(x, y, args.max_k)
    print(f"{xg.shape[0]} groups, mean group size {mask.sum(1).mean():.1f}")

    has_visits = np.isfinite(visits[mask > 0]).all()
    rank_target = args.rank_target
    if rank_target == "auto":
        rank_target = "visits" if has_visits else "value"
    if rank_target == "visits" and not has_visits:
        raise SystemExit("visit-count target requested, but at least one input shard uses the old schema")
    has_consensus = np.isfinite(policy[mask > 0]).all()
    if rank_target == "consensus" and not has_consensus:
        raise SystemExit("consensus target requested, but the input has no repeated-search policy")
    # The search chooses by visit count. log1p keeps the most-visited child from monopolising the
    # listwise soft target while retaining the policy improvement the search actually produced.
    if rank_target == "visits":
        ranking = np.log1p(visits)
    elif rank_target == "consensus":
        ranking = np.log(np.maximum(policy, 1e-8))
    else:
        ranking = teacher
    group_weight = (
        np.power(np.clip(confidence, 1e-3, 1.0), args.confidence_power).astype(np.float32)
        if rank_target == "consensus"
        else np.ones_like(confidence)
    )
    print(f"ranking target: {rank_target}")

    # Groups are emitted in game order, so a contiguous tail is a game-level holdout. A random split
    # would put siblings of the same game on both sides and report a validation number that is
    # mostly memorisation.
    n_val = max(1, int(xg.shape[0] * args.val_frac))
    tr = slice(0, xg.shape[0] - n_val)
    va = slice(xg.shape[0] - n_val, xg.shape[0])

    flat_tr = xg[tr][mask[tr] > 0]
    mu, sd = flat_tr.mean(0), flat_tr.std(0)
    sd[sd < 1e-6] = 1.0

    def norm(a):
        return ((a - mu) / sd).astype(np.float32)

    xtr, xva = norm(xg[tr]), norm(xg[va])
    model = build(x.shape[1], args.width, args.depth, args.dropout)
    model.summary()
    opt = tf.keras.optimizers.AdamW(args.lr, weight_decay=args.weight_decay)

    @tf.function
    def step(xb, mb, tb, wb, ob, yb, training):
        shape = tf.shape(xb)
        flat = tf.reshape(xb, (-1, shape[-1]))
        if training:
            with tf.GradientTape() as tape:
                pred = tf.reshape(model(flat, training=True), (shape[0], shape[1], 4))
                lw, an, total = losses(pred, mb, tb, wb, ob, yb, args.tau, args.alpha,
                                       args.pairwise, args.margin_pow)
            grads = tape.gradient(total, model.trainable_variables)
            opt.apply_gradients(zip(grads, model.trainable_variables))
            return lw, an, total
        pred = tf.reshape(model(flat, training=False), (shape[0], shape[1], 4))
        return losses(pred, mb, tb, wb, ob, yb, args.tau, args.alpha, args.pairwise,
                      args.margin_pow)

    best, best_epoch, best_weights = -1.0, -1, None
    n = xtr.shape[0]
    for epoch in range(args.epochs):
        perm = np.random.permutation(n)
        tot_lw = tot_an = nb = 0.0
        for i in range(0, n, args.batch):
            idx = perm[i : i + args.batch]
            lw, an, _ = step(
                tf.constant(xtr[idx]),
                tf.constant(mask[tr][idx]),
                tf.constant(ranking[tr][idx]),
                tf.constant(group_weight[tr][idx]),
                tf.constant(onpath[tr][idx]),
                tf.constant(outcome[tr][idx]),
                True,
            )
            tot_lw += float(lw)
            tot_an += float(an)
            nb += 1

        pred_va = model(xva.reshape(-1, x.shape[1]), training=False).numpy().reshape(
            xva.shape[0], args.max_k, 4
        )
        acc = pairwise_accuracy(pred_va, mask[va], ranking[va])
        top1 = top1_accuracy(pred_va, mask[va], ranking[va])
        played = (pred_va * onpath[va][..., None]).sum(1)
        rmse = float(np.sqrt(np.mean((played - outcome[va]) ** 2)))
        flag = ""
        if acc > best:
            best, best_epoch = acc, epoch
            best_weights = [w.copy() for w in model.get_weights()]
            flag = "  *"
        print(
            f"epoch {epoch:3d}  rank {tot_lw/nb:.4f}  anchor {tot_an/nb:7.2f}  "
            f"val pair-acc {acc:.4f}  val top1 {top1:.4f}  val anchor RMSE {rmse:5.2f}{flag}"
        )
        if epoch - best_epoch >= args.patience:
            print(f"early stop — no improvement in {args.patience} epochs")
            break

    model.set_weights(best_weights)
    print(f"\nbest val pairwise accuracy {best:.4f} at epoch {best_epoch}")

    layers = []
    for i in range(args.depth):
        d = model.get_layer(f"dense{i}")
        nlayer = model.get_layer(f"norm{i}")
        w, b = d.get_weights()
        g, be = nlayer.get_weights()
        layers.append(
            {
                "w": w.T.astype(np.float32).ravel().tolist(),
                "b": b.astype(np.float32).tolist(),
                "gamma": g.astype(np.float32).tolist(),
                "beta": be.astype(np.float32).tolist(),
                "in": int(w.shape[0]),
                "out": int(w.shape[1]),
            }
        )
    w, b = model.get_layer("value").get_weights()
    out = {
        "featureCount": int(x.shape[1]),
        "featureNames": meta["featureNames"],
        "mean": mu.astype(np.float32).tolist(),
        "scale": sd.astype(np.float32).tolist(),
        "layers": layers,
        "head": {"w": w.T.astype(np.float32).ravel().tolist(), "b": b.astype(np.float32).tolist()},
        "valPairwiseAccuracy": float(best),
        "valTop1Accuracy": float(top1_accuracy(
            model(xva.reshape(-1, x.shape[1]), training=False).numpy().reshape(
                xva.shape[0], args.max_k, 4
            ),
            mask[va],
            ranking[va],
        )),
        "trainedOn": {
            "rows": int(x.shape[0]),
            "groups": int(xg.shape[0]),
            "shards": prefixes,
            "teachers": meta["teachers"],
            "iterations": meta["iterations"],
            "rankTarget": rank_target,
        },
        "hyperparameters": {
            "width": args.width,
            "depth": args.depth,
            "dropout": args.dropout,
            "epochs": args.epochs,
            "batch": args.batch,
            "learningRate": args.lr,
            "temperature": args.tau,
            "anchorWeight": args.alpha,
            "maxGroupSize": args.max_k,
            "validationFraction": args.val_frac,
            "patience": args.patience,
            "pairwiseWeight": args.pairwise,
            "marginPower": args.margin_pow,
            "weightDecay": args.weight_decay,
            "confidencePower": args.confidence_power,
            "featurePrefix": args.feature_prefix,
            "seed": args.seed,
        },
    }
    json.dump(out, open(args.out, "w"))
    size = os.path.getsize(args.out) / 1024
    print(f"wrote {args.out} ({size:.0f} KB)")


if __name__ == "__main__":
    main()
