#!/usr/bin/env python3
"""Compare scalar and board-conditioned online opponent adapters on the contextual corpus."""

from __future__ import annotations

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

from train_v5_online_adapter import (
    EXPERTS,
    evaluate_adaptive,
    evaluate_fixed,
    evaluate_shuffled,
    splice_report,
    summarize,
    tune_filter,
)
from train_v5_trajectory_policy import (
    SPLITS,
    WARMUP,
    bootstrap_lower_bound,
    build_sequences,
)

SCALAR_FEATURES = 9
CONTEXT_FEATURES = 59
STATE_FEATURES = 109
CELL_FEATURE_START = 54
EMBED = 32
BOARD_CHANNELS = 16

# decision columns
GAME, PROFILE, SEAT, PLY, TURN, OFFSET, COUNT, ACTUAL, SPLIT = range(9)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="ml/data/v5-oracle-context")
    parser.add_argument("--out", default="selfplay-results/v5-oracle-context-policy.json")
    parser.add_argument("--checkpoint", default="ml/v5-oracle-context-policy.npz")
    parser.add_argument("--epochs", type=int, default=220)
    parser.add_argument("--patience", type=int, default=30)
    parser.add_argument("--batch", type=int, default=12)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--bootstrap", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=5601)
    return parser.parse_args()


def load_context(prefix):
    with open(f"{prefix}.meta.json") as handle:
        meta = json.load(handle)
    if meta["architecture"] != "v5-oracle-context-trajectories-v3":
        raise SystemExit("context trainer requires v5-oracle-context-trajectories-v3")
    if int(meta["featureCount"]) != CONTEXT_FEATURES:
        raise SystemExit(f"expected {CONTEXT_FEATURES} candidate features")
    if int(meta["stateFeatureCount"]) != STATE_FEATURES:
        raise SystemExit(f"expected {STATE_FEATURES} state features")
    width = int(meta["decisionWidth"])
    dec = np.fromfile(f"{prefix}.decisions.i32", np.int32).reshape(-1, width)
    cand = np.fromfile(f"{prefix}.candidates.f32", np.float32).reshape(-1, CONTEXT_FEATURES)
    states = np.fromfile(f"{prefix}.states.f32", np.float32).reshape(-1, STATE_FEATURES)
    boards = np.fromfile(f"{prefix}.boards.u8", np.uint8).reshape(-1, 20, 20, 4)
    if len(states) != len(dec) or len(boards) != len(dec):
        raise SystemExit("shared context rows do not align with decisions")
    if int(meta["missingPlayedActions"]) != 0:
        raise SystemExit("dataset contains a played action outside the legal set")
    if int(meta["finishedGames"]) != len(meta["games"]):
        raise SystemExit("dataset contains unfinished games")
    return meta, dec, cand, states, boards


def pad_candidates(rows, dec, cand):
    counts = dec[rows, COUNT]
    maximum = int(counts.max())
    out = np.zeros((len(rows), maximum, cand.shape[1]), np.float32)
    mask = np.zeros((len(rows), maximum), np.float32)
    for index, row in enumerate(rows):
        offset, count = int(dec[row, OFFSET]), int(dec[row, COUNT])
        out[index, :count] = cand[offset : offset + count]
        mask[index, :count] = 1.0
    return out, mask, dec[rows, ACTUAL].astype(np.int32)


class ScalarExpertPolicy(tf.keras.Model):
    def __init__(self):
        super().__init__()
        self.trunk1 = tf.keras.layers.Dense(EMBED, activation="relu")
        self.trunk2 = tf.keras.layers.Dense(EMBED, activation="relu")
        self.expert_vectors = self.add_weight(
            shape=(EXPERTS, EMBED), initializer="orthogonal", name="expert_vectors"
        )

    def call(self, candidates, candidate_mask, states=None, boards=None):
        del states, boards
        embedded = self.trunk2(self.trunk1(candidates[:, :, :SCALAR_FEATURES]))
        logits = tf.einsum("bce,ke->bck", embedded, self.expert_vectors)
        return logits + (1.0 - candidate_mask[:, :, None]) * -1e9


class ContextExpertPolicy(tf.keras.Model):
    def __init__(self):
        super().__init__()
        self.conv = [
            tf.keras.layers.Conv2D(BOARD_CHANNELS, 3, padding="same", activation="relu")
            for _ in range(3)
        ]
        self.candidate1 = tf.keras.layers.Dense(64, activation="relu")
        self.candidate2 = tf.keras.layers.Dense(48, activation="relu")
        self.state1 = tf.keras.layers.Dense(64, activation="relu")
        self.state2 = tf.keras.layers.Dense(32, activation="relu")
        self.combined1 = tf.keras.layers.Dense(64, activation="relu")
        self.combined2 = tf.keras.layers.Dense(EMBED, activation="relu")
        self.expert_vectors = self.add_weight(
            shape=(EXPERTS, EMBED), initializer="orthogonal", name="expert_vectors"
        )

    def call(self, candidates, candidate_mask, states, boards):
        spatial = tf.cast(boards, tf.float32)
        for layer in self.conv:
            spatial = layer(spatial)
        flat = tf.reshape(spatial, [tf.shape(spatial)[0], 400, BOARD_CHANNELS])
        cell_values = candidates[:, :, CELL_FEATURE_START : CELL_FEATURE_START + 5]
        valid_cells = tf.cast(cell_values >= 0.0, tf.float32)
        cell_indices = tf.cast(tf.round(tf.maximum(cell_values, 0.0) * 399.0), tf.int32)
        gathered = tf.gather(flat, cell_indices, axis=1, batch_dims=1)
        local = tf.reduce_sum(gathered * valid_cells[:, :, :, None], axis=2)
        local /= tf.maximum(1.0, tf.reduce_sum(valid_cells, axis=2, keepdims=True))

        candidate = self.candidate2(self.candidate1(candidates))
        state = self.state2(self.state1(states))
        global_board = tf.reduce_mean(spatial, axis=(1, 2))
        shared = tf.concat([state, global_board], axis=1)
        shared = tf.tile(shared[:, None, :], [1, tf.shape(candidates)[1], 1])
        embedded = self.combined2(self.combined1(tf.concat([candidate, local, shared], axis=2)))
        logits = tf.einsum("bce,ke->bck", embedded, self.expert_vectors)
        return logits + (1.0 - candidate_mask[:, :, None]) * -1e9


def model_batch(sequences, dec, cand, states, boards):
    rows, segment = [], []
    for index, sequence in enumerate(sequences):
        rows.extend(int(row) for row in sequence.rows)
        segment.extend([index] * len(sequence))
    rows = np.asarray(rows, np.int64)
    candidates, mask, targets = pad_candidates(rows, dec, cand)
    return (
        tf.constant(candidates),
        tf.constant(mask),
        tf.constant(states[rows]),
        tf.constant(boards[rows]),
        tf.constant(targets),
        tf.constant(segment, tf.int32),
        tf.constant([len(sequence) for sequence in sequences], tf.float32),
    )


def objective(model, candidates, mask, states, boards, targets, segment, lengths, regularize=True):
    logits = model(candidates, mask, states, boards)
    log_policy = tf.nn.log_softmax(logits, axis=1)
    actual = tf.gather(log_policy, targets, axis=1, batch_dims=1)
    sequence_ll = tf.math.unsorted_segment_sum(actual, segment, tf.shape(lengths)[0])
    log_marginal = tf.reduce_logsumexp(sequence_ll - tf.math.log(float(EXPERTS)), axis=1)
    nll = tf.reduce_mean(-log_marginal / lengths)
    if not regularize:
        return nll
    responsibilities = tf.nn.softmax(sequence_ll, axis=1)
    usage = tf.reduce_mean(responsibilities, axis=0)
    balance = tf.reduce_sum(usage * tf.math.log(tf.maximum(usage * EXPERTS, 1e-8)))
    normalized = tf.math.l2_normalize(model.expert_vectors, axis=1)
    cosine = normalized @ tf.transpose(normalized)
    diversity = tf.reduce_mean(tf.square(cosine - tf.eye(EXPERTS)))
    return nll + 0.05 * balance + 0.01 * diversity


def validation_nll(model, sequences, dec, cand, states, boards, batch_size):
    values = []
    for start in range(0, len(sequences), batch_size):
        batch = sequences[start : start + batch_size]
        values.append(
            float(
                objective(
                    model,
                    *model_batch(batch, dec, cand, states, boards),
                    regularize=False,
                )
            )
        )
    return float(np.mean(values))


def train_model(kind, model, train_sequences, validation_sequences, dec, cand, states, boards, args):
    tf.keras.utils.set_random_seed(args.seed + (1 if kind == "context" else 0))
    optimizer = tf.keras.optimizers.Adam(args.lr)

    @tf.function(reduce_retracing=True)
    def step(candidates, mask, state, board, targets, segment, lengths):
        with tf.GradientTape() as tape:
            loss = objective(model, candidates, mask, state, board, targets, segment, lengths)
        gradients = tape.gradient(loss, model.trainable_variables)
        optimizer.apply_gradients(zip(gradients, model.trainable_variables))
        return loss

    rng = np.random.default_rng(args.seed + (1 if kind == "context" else 0))
    best, best_epoch, best_weights, waited, trace = np.inf, -1, None, 0, []
    for epoch in range(args.epochs):
        order = rng.permutation(len(train_sequences))
        for start in range(0, len(order), args.batch):
            batch = [train_sequences[index] for index in order[start : start + args.batch]]
            step(*model_batch(batch, dec, cand, states, boards))
        value = validation_nll(
            model, validation_sequences, dec, cand, states, boards, args.batch
        )
        trace.append(round(value, 5))
        if value < best - 1e-5:
            best, best_epoch, waited = value, epoch, 0
            best_weights = [weight.numpy().copy() for weight in model.weights]
        else:
            waited += 1
            if waited >= args.patience:
                break
    if best_weights is None:
        raise RuntimeError(f"{kind} did not produce a checkpoint")
    for weight, value in zip(model.weights, best_weights):
        weight.assign(value)
    return {"bestEpoch": best_epoch, "epochsRun": len(trace), "validationTrace": trace}


def logits_by_sequence(model, sequences, dec, cand, states, boards, chunk=96):
    output = []
    for sequence in sequences:
        rows = np.asarray(sequence.rows, np.int64)
        sequence_logits = []
        for start in range(0, len(rows), chunk):
            block = rows[start : start + chunk]
            candidates, mask, _ = pad_candidates(block, dec, cand)
            scores = model(
                tf.constant(candidates),
                tf.constant(mask),
                tf.constant(states[block]),
                tf.constant(boards[block]),
            ).numpy()
            for local, row in enumerate(block):
                sequence_logits.append(scores[local, : int(dec[row, COUNT])].astype(np.float64))
        output.append(sequence_logits)
    return output


def evaluate_arm(model, sequences, dec, cand, states, boards):
    logits = logits_by_sequence(model, sequences, dec, cand, states, boards)
    temperature, learning_rate, drift = tune_filter(sequences, logits, dec)
    validation_splice = splice_report(
        sequences, logits, dec, temperature, learning_rate, drift
    )
    return {
        "logits": logits,
        "temperature": temperature,
        "learningRate": learning_rate,
        "drift": drift,
        "resetThreshold": validation_splice["threshold"],
        "validationSplice": validation_splice,
    }


def holdout_arm(arm, sequences, dec):
    adaptive = evaluate_adaptive(
        sequences,
        arm["logits"],
        dec,
        arm["temperature"],
        arm["learningRate"],
        arm["drift"],
        arm["resetThreshold"],
    )
    adaptive["temperature"] = arm["temperature"]
    fixed = evaluate_fixed(sequences, arm["logits"], dec, arm["temperature"])
    shuffled = evaluate_shuffled(sequences, arm["logits"], dec, adaptive)
    splice = splice_report(
        sequences,
        arm["logits"],
        dec,
        arm["temperature"],
        arm["learningRate"],
        arm["drift"],
        arm["resetThreshold"],
    )
    return {"adaptive": adaptive, "fixed": fixed, "shuffled": shuffled, "splice": splice}


def main():
    args = parse_args()
    meta, dec, cand, states, boards = load_context(args.data)
    sequences = build_sequences(dec)
    by_split = {
        name: [sequence for sequence in sequences if sequence.split == index]
        for index, name in enumerate(SPLITS)
    }
    print(
        "sequences " + ", ".join(f"{name}={len(by_split[name])}" for name in SPLITS),
        f"decisions={len(dec)}",
        flush=True,
    )

    models = {"scalar": ScalarExpertPolicy(), "context": ContextExpertPolicy()}
    fits, validation = {}, {}
    for kind, model in models.items():
        fits[kind] = train_model(
            kind,
            model,
            by_split["train"],
            by_split["validation"],
            dec,
            cand,
            states,
            boards,
            args,
        )
        validation[kind] = evaluate_arm(
            model, by_split["validation"], dec, cand, states, boards
        )
        validation_result = evaluate_adaptive(
            by_split["validation"],
            validation[kind]["logits"],
            dec,
            validation[kind]["temperature"],
            validation[kind]["learningRate"],
            validation[kind]["drift"],
            validation[kind]["resetThreshold"],
        )
        fits[kind]["validation"] = summarize(validation_result)
        fits[kind]["parameters"] = int(sum(np.prod(weight.shape) for weight in model.weights))
        print(
            f"{kind:8s} validation nll {fits[kind]['validation']['nll']:.4f} "
            f"top5 {fits[kind]['validation']['top5']:.3f}",
            flush=True,
        )

    holdout_sequences = by_split["holdout"]
    holdout = {}
    for kind, model in models.items():
        logits = logits_by_sequence(model, holdout_sequences, dec, cand, states, boards)
        arm = {**validation[kind], "logits": logits}
        holdout[kind] = holdout_arm(arm, holdout_sequences, dec)

    context = holdout["context"]
    scalar = holdout["scalar"]
    warm = context["adaptive"]["turn"] >= WARMUP
    games = context["adaptive"]["game"][warm]
    context_gain = scalar["adaptive"]["nll"][warm] - context["adaptive"]["nll"][warm]
    fixed_gain = context["fixed"]["nll"][warm] - context["adaptive"]["nll"][warm]
    identity_gain = context["shuffled"]["nll"][warm] - context["adaptive"]["nll"][warm]
    context_interval = bootstrap_lower_bound(context_gain, games, args.bootstrap, args.seed + 1)
    fixed_interval = bootstrap_lower_bound(fixed_gain, games, args.bootstrap, args.seed + 2)
    identity_interval = bootstrap_lower_bound(identity_gain, games, args.bootstrap, args.seed + 3)

    train_logits = logits_by_sequence(
        models["context"], by_split["train"], dec, cand, states, boards
    )
    train_adaptive = evaluate_adaptive(
        by_split["train"],
        train_logits,
        dec,
        validation["context"]["temperature"],
        validation["context"]["learningRate"],
        validation["context"]["drift"],
        validation["context"]["resetThreshold"],
    )
    responsibility = np.mean(
        np.stack([run["final"] for run in train_adaptive["runs"]]), axis=0
    )
    context_summary = summarize(context["adaptive"])
    fixed_summary = summarize(context["fixed"])
    gates = {
        "contextGain": {
            "value": context_interval[0],
            "interval": list(context_interval[1:]),
            "threshold": 0.05,
            "pass": context_interval[1] > 0.05,
        },
        "fixedGain": {
            "value": fixed_interval[0],
            "interval": list(fixed_interval[1:]),
            "threshold": 0.03,
            "pass": fixed_interval[1] > 0.03,
        },
        "identityChannel": {
            "value": identity_interval[0],
            "interval": list(identity_interval[1:]),
            "threshold": 0.06,
            "pass": identity_interval[1] > 0.06,
        },
        "topFiveRecall": {
            "value": context_summary["top5"],
            "threshold": 0.65,
            "pass": context_summary["top5"] > 0.65,
        },
        "calibration": {
            "value": context_summary["ece"],
            "fixedValue": fixed_summary["ece"],
            "threshold": 0.08,
            "pass": context_summary["ece"] <= 0.08
            and context_summary["ece"] <= fixed_summary["ece"] + 0.01,
        },
        "expertUsage": {
            "value": float(responsibility.min()),
            "responsibilities": responsibility.tolist(),
            "threshold": 0.03,
            "pass": float(responsibility.min()) >= 0.03,
        },
        "changePointReset": {
            "resetMinusContaminated": context["splice"]["resetMinusContaminated"],
            "tailResetMinusClean": context["splice"]["tailResetMinusClean"],
            "threshold": 0.10,
            "pass": context["splice"]["resetMinusContaminated"] <= 0.0
            and context["splice"]["tailResetMinusClean"] <= 0.10,
        },
    }

    def arm_report(kind):
        return {
            "fit": fits[kind],
            "selectedFilter": {
                key: validation[kind][key]
                for key in ("temperature", "learningRate", "drift", "resetThreshold")
            },
            "holdout": {
                "adaptive": summarize(holdout[kind]["adaptive"]),
                "fixed": summarize(holdout[kind]["fixed"]),
                "shuffled": summarize(holdout[kind]["shuffled"]),
            },
            "splice": {
                "validation": validation[kind]["validationSplice"],
                "holdout": holdout[kind]["splice"],
            },
        }

    output = {
        "experiment": "v5-oracle-context-policy",
        "preregistration": "research_paper/v5_oracle_context_policy.md",
        "dataset": {
            "architecture": meta["architecture"],
            "games": int(meta["finishedGames"]),
            "profiles": len(meta["profiles"]),
            "decisions": int(meta["decisions"]),
            "candidates": int(meta["candidates"]),
            "featureCount": int(meta["featureCount"]),
            "stateFeatureCount": int(meta["stateFeatureCount"]),
            "missingPlayedActions": int(meta["missingPlayedActions"]),
            "seedBase": int(meta["seedBase"]),
        },
        "scalar": arm_report("scalar"),
        "context": arm_report("context"),
        "contextTrainingResponsibilities": responsibility.tolist(),
        "gates": gates,
        "searchIntegrationAuthorized": all(gate["pass"] for gate in gates.values()),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
    checkpoint = {}
    for kind, model in models.items():
        for index, weight in enumerate(model.weights):
            checkpoint[f"{kind}_{index}"] = weight.numpy()
    np.savez(args.checkpoint, **checkpoint)

    print(f"holdout scalar  {summarize(scalar['adaptive'])['nll']:.4f}")
    print(f"holdout context {context_summary['nll']:.4f}")
    for name, gate in gates.items():
        print(f"{'PASS' if gate['pass'] else 'FAIL'} {name}: {json.dumps(gate)}")
    print(f"search integration authorized: {output['searchIntegrationAuthorized']}")
    print(f"wrote {args.out} and {args.checkpoint}")


if __name__ == "__main__":
    main()
