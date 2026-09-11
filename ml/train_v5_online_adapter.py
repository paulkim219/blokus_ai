#!/usr/bin/env python3
"""Learn policy experts offline and infer an unseen player's mixture online with Bayes' rule."""

from __future__ import annotations

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

from train_v5_trajectory_policy import (
    ACTUAL,
    COUNT,
    OFFSET,
    SPLITS,
    WARMUP,
    bootstrap_lower_bound,
    build_sequences,
    expected_calibration_error,
    load,
    pad_candidates,
)

FEATURES = 9
EMBED = 32
EXPERTS = 8
RESET_RUN = 2
TEMPERATURE_GRID = tuple(float(x) for x in np.arange(0.7, 2.01, 0.1))
LEARNING_GRID = (0.25, 0.5, 0.75, 1.0)
DRIFT_GRID = (0.0, 0.01, 0.03, 0.07)
RESET_GRID = tuple(float(x) for x in np.arange(2.5, 7.01, 0.25))
SPLICE_POINT = 8


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="ml/data/v5-oracle-adapter")
    parser.add_argument("--out", default="selfplay-results/v5-oracle-online-adapter.json")
    parser.add_argument("--checkpoint", default="ml/v5-oracle-online-adapter.npz")
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--patience", type=int, default=35)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--bootstrap", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=5501)
    return parser.parse_args()


class ExpertPolicy(tf.keras.Model):
    def __init__(self):
        super().__init__()
        self.trunk1 = tf.keras.layers.Dense(EMBED, activation="relu")
        self.trunk2 = tf.keras.layers.Dense(EMBED, activation="relu")
        self.expert_vectors = self.add_weight(
            shape=(EXPERTS, EMBED), initializer="orthogonal", name="expert_vectors"
        )

    def call(self, candidates, candidate_mask):
        embedded = self.trunk2(self.trunk1(candidates))
        logits = tf.einsum("bce,ke->bck", embedded, self.expert_vectors)
        return logits + (1.0 - candidate_mask[:, :, None]) * -1e9


def latent_batch(sequences, dec, cand):
    rows, segment = [], []
    for index, sequence in enumerate(sequences):
        rows.extend(int(row) for row in sequence.rows)
        segment.extend([index] * len(sequence))
    rows = np.asarray(rows, np.int64)
    candidates, mask, targets = pad_candidates(rows, dec, cand)
    return (
        tf.constant(candidates),
        tf.constant(mask),
        tf.constant(targets),
        tf.constant(segment, tf.int32),
        tf.constant([len(sequence) for sequence in sequences], tf.float32),
    )


def latent_loss(model, candidates, mask, targets, segment, lengths, regularize=True):
    logits = model(candidates, mask)
    log_policy = tf.nn.log_softmax(logits, axis=1)
    actual = tf.gather(log_policy, targets, axis=1, batch_dims=1)
    sequence_log_likelihood = tf.math.unsorted_segment_sum(
        actual, segment, tf.shape(lengths)[0]
    )
    log_marginal = tf.reduce_logsumexp(
        sequence_log_likelihood - tf.math.log(float(EXPERTS)), axis=1
    )
    nll = tf.reduce_mean(-log_marginal / lengths)
    if not regularize:
        return nll

    responsibilities = tf.nn.softmax(sequence_log_likelihood, axis=1)
    usage = tf.reduce_mean(responsibilities, axis=0)
    balance = tf.reduce_sum(usage * tf.math.log(tf.maximum(usage * EXPERTS, 1e-8)))
    normalized = tf.math.l2_normalize(model.expert_vectors, axis=1)
    cosine = normalized @ tf.transpose(normalized)
    off_diagonal = cosine - tf.eye(EXPERTS)
    diversity = tf.reduce_mean(tf.square(off_diagonal))
    return nll + 0.05 * balance + 0.01 * diversity


def validation_latent_nll(model, sequences, dec, cand, batch_size=16):
    weighted, decisions = 0.0, 0
    for start in range(0, len(sequences), batch_size):
        batch = sequences[start : start + batch_size]
        tensors = latent_batch(batch, dec, cand)
        count = sum(len(sequence) for sequence in batch)
        weighted += float(latent_loss(model, *tensors, regularize=False)) * count
        decisions += count
    return weighted / max(1, decisions)


def train(model, train_sequences, validation_sequences, dec, cand, args):
    optimizer = tf.keras.optimizers.Adam(args.lr)

    @tf.function(reduce_retracing=True)
    def step(candidates, mask, targets, segment, lengths):
        with tf.GradientTape() as tape:
            loss = latent_loss(model, candidates, mask, targets, segment, lengths)
        gradients = tape.gradient(loss, model.trainable_variables)
        optimizer.apply_gradients(zip(gradients, model.trainable_variables))
        return loss

    rng = np.random.default_rng(args.seed)
    best, best_epoch, best_weights, waited, trace = np.inf, -1, None, 0, []
    for epoch in range(args.epochs):
        order = rng.permutation(len(train_sequences))
        for start in range(0, len(order), args.batch):
            batch = [train_sequences[index] for index in order[start : start + args.batch]]
            step(*latent_batch(batch, dec, cand))
        value = validation_latent_nll(model, validation_sequences, dec, cand, args.batch)
        trace.append(round(value, 5))
        if value < best - 1e-5:
            best, best_epoch, waited = value, epoch, 0
            best_weights = [weight.numpy().copy() for weight in model.weights]
        else:
            waited += 1
            if waited >= args.patience:
                break
    if best_weights is None:
        raise RuntimeError("training did not produce a checkpoint")
    for weight, value in zip(model.weights, best_weights):
        weight.assign(value)
    return {"bestEpoch": best_epoch, "epochsRun": len(trace), "validationTrace": trace}


def logits_by_sequence(model, sequences, dec, cand, chunk=128):
    output = []
    for sequence in sequences:
        rows = np.asarray(sequence.rows, np.int64)
        sequence_logits = []
        for start in range(0, len(rows), chunk):
            block = rows[start : start + chunk]
            candidates, mask, _ = pad_candidates(block, dec, cand)
            logits = model(tf.constant(candidates), tf.constant(mask)).numpy()
            for local, row in enumerate(block):
                count = int(dec[row, COUNT])
                sequence_logits.append(logits[local, :count].astype(np.float64))
        output.append(sequence_logits)
    return output


def expert_policy(logits, temperature):
    scaled = logits / temperature
    scaled -= scaled.max(axis=0, keepdims=True)
    values = np.exp(scaled)
    return values / values.sum(axis=0, keepdims=True)


def advance(posterior, likelihood, learning_rate, drift):
    updated = posterior * np.maximum(likelihood, 1e-12) ** learning_rate
    updated /= max(1e-12, updated.sum())
    return updated * (1.0 - drift) + np.full(EXPERTS, drift / EXPERTS)


def run_sequence(
    sequence,
    logits,
    dec,
    temperature,
    learning_rate,
    drift,
    reset_threshold=np.inf,
    initial=None,
    start=0,
):
    posterior = (
        np.full(EXPERTS, 1.0 / EXPERTS) if initial is None else np.asarray(initial).copy()
    )
    nll, confidence, hit1, hit5, pre = [], [], [], [], []
    surprising, resets = 0, 0
    for turn in range(start, len(sequence)):
        row = int(sequence.rows[turn])
        actual = int(dec[row, ACTUAL])
        policies = expert_policy(logits[turn], temperature)
        pre.append(posterior.copy())
        probabilities = policies @ posterior
        probability = max(1e-12, float(probabilities[actual]))
        loss = -np.log(probability)
        nll.append(loss)
        confidence.append(float(probabilities.max()))
        hit1.append(float(int(probabilities.argmax()) == actual))
        top = np.argpartition(-probabilities, min(4, len(probabilities) - 1))[:5]
        hit5.append(float(actual in top))
        posterior = advance(posterior, policies[actual], learning_rate, drift)
        if loss > reset_threshold:
            surprising += 1
            if surprising >= RESET_RUN:
                posterior.fill(1.0 / EXPERTS)
                surprising = 0
                resets += 1
        else:
            surprising = 0
    return {
        "nll": np.asarray(nll),
        "confidence": np.asarray(confidence),
        "hit1": np.asarray(hit1),
        "hit5": np.asarray(hit5),
        "pre": np.asarray(pre),
        "final": posterior,
        "resets": resets,
    }


def evaluate_adaptive(
    sequences, logits, dec, temperature, learning_rate, drift, reset_threshold=np.inf
):
    runs = [
        run_sequence(
            sequence,
            sequence_logits,
            dec,
            temperature,
            learning_rate,
            drift,
            reset_threshold,
        )
        for sequence, sequence_logits in zip(sequences, logits)
    ]
    return flatten_runs(sequences, runs)


def flatten_runs(sequences, runs):
    result = {key: [] for key in ("nll", "confidence", "hit1", "hit5")}
    turns, games = [], []
    for sequence, run in zip(sequences, runs):
        for key in result:
            result[key].append(run[key])
        turns.append(np.arange(len(run["nll"])))
        games.append(np.full(len(run["nll"]), sequence.game))
    return {
        **{key: np.concatenate(value) for key, value in result.items()},
        "turn": np.concatenate(turns),
        "game": np.concatenate(games),
        "runs": runs,
    }


def evaluate_fixed(sequences, logits, dec, temperature, mean_logits=False):
    runs = []
    for sequence, sequence_logits in zip(sequences, logits):
        nll, confidence, hit1, hit5 = [], [], [], []
        for turn, raw in enumerate(sequence_logits):
            actual = int(dec[int(sequence.rows[turn]), ACTUAL])
            if mean_logits:
                score = raw.mean(axis=1) / temperature
                score -= score.max()
                probabilities = np.exp(score)
                probabilities /= probabilities.sum()
            else:
                probabilities = expert_policy(raw, temperature).mean(axis=1)
            nll.append(-np.log(max(1e-12, probabilities[actual])))
            confidence.append(float(probabilities.max()))
            hit1.append(float(int(probabilities.argmax()) == actual))
            top = np.argpartition(-probabilities, min(4, len(probabilities) - 1))[:5]
            hit5.append(float(actual in top))
        runs.append(
            {
                "nll": np.asarray(nll),
                "confidence": np.asarray(confidence),
                "hit1": np.asarray(hit1),
                "hit5": np.asarray(hit5),
                "pre": np.tile(np.full(EXPERTS, 1 / EXPERTS), (len(nll), 1)),
                "final": np.full(EXPERTS, 1 / EXPERTS),
                "resets": 0,
            }
        )
    return flatten_runs(sequences, runs)


def donor_indices(sequences):
    donors = []
    for index, sequence in enumerate(sequences):
        options = [
            candidate
            for candidate, other in enumerate(sequences)
            if other.profile != sequence.profile and len(other) >= len(sequence)
        ]
        if not options:
            options = [
                candidate
                for candidate, other in enumerate(sequences)
                if other.profile != sequence.profile
            ]
        donors.append(options[index % len(options)])
    return donors


def evaluate_shuffled(sequences, logits, dec, adaptive):
    runs = []
    donors = donor_indices(sequences)
    for index, (sequence, sequence_logits) in enumerate(zip(sequences, logits)):
        donor = adaptive["runs"][donors[index]]["pre"]
        nll, confidence, hit1, hit5 = [], [], [], []
        for turn, raw in enumerate(sequence_logits):
            posterior = donor[min(turn, len(donor) - 1)]
            probabilities = expert_policy(raw, adaptive["temperature"]) @ posterior
            actual = int(dec[int(sequence.rows[turn]), ACTUAL])
            nll.append(-np.log(max(1e-12, probabilities[actual])))
            confidence.append(float(probabilities.max()))
            hit1.append(float(int(probabilities.argmax()) == actual))
            top = np.argpartition(-probabilities, min(4, len(probabilities) - 1))[:5]
            hit5.append(float(actual in top))
        runs.append(
            {
                "nll": np.asarray(nll),
                "confidence": np.asarray(confidence),
                "hit1": np.asarray(hit1),
                "hit5": np.asarray(hit5),
                "pre": donor[: len(nll)],
                "final": donor[-1],
                "resets": 0,
            }
        )
    return flatten_runs(sequences, runs)


def summarize(result):
    warm = result["turn"] >= WARMUP
    return {
        "nll": float(result["nll"][warm].mean()),
        "allTurnNll": float(result["nll"].mean()),
        "top1": float(result["hit1"][warm].mean()),
        "top5": float(result["hit5"][warm].mean()),
        "ece": expected_calibration_error(result["confidence"][warm], result["hit1"][warm]),
        "decisions": int(warm.sum()),
    }


def tune_filter(sequences, logits, dec):
    best_temperature = min(
        TEMPERATURE_GRID,
        key=lambda temperature: summarize(
            evaluate_fixed(sequences, logits, dec, temperature)
        )["nll"],
    )
    best = (np.inf, LEARNING_GRID[0], DRIFT_GRID[0])
    for learning_rate in LEARNING_GRID:
        for drift in DRIFT_GRID:
            result = evaluate_adaptive(
                sequences, logits, dec, best_temperature, learning_rate, drift
            )
            value = summarize(result)["nll"]
            if value < best[0]:
                best = (value, learning_rate, drift)
    return best_temperature, best[1], best[2]


def splice_report(
    sequences,
    logits,
    dec,
    temperature,
    learning_rate,
    drift,
    threshold=None,
):
    clean = evaluate_adaptive(sequences, logits, dec, temperature, learning_rate, drift)
    donors = donor_indices(sequences)

    def score(candidate_threshold):
        contaminated, reset, clean_values, reset_tail, clean_tail, resets = [], [], [], [], [], 0
        for index, sequence in enumerate(sequences):
            if len(sequence) < SPLICE_POINT + 4:
                continue
            donor_run = clean["runs"][donors[index]]
            initial = donor_run["pre"][min(SPLICE_POINT, len(donor_run["pre"]) - 1)]
            no_reset = run_sequence(
                sequence,
                logits[index],
                dec,
                temperature,
                learning_rate,
                drift,
                np.inf,
                initial,
                SPLICE_POINT,
            )
            with_reset = run_sequence(
                sequence,
                logits[index],
                dec,
                temperature,
                learning_rate,
                drift,
                candidate_threshold,
                initial,
                SPLICE_POINT,
            )
            clean_nll = clean["runs"][index]["nll"][SPLICE_POINT:]
            contaminated.append(no_reset["nll"].mean())
            reset.append(with_reset["nll"].mean())
            clean_values.append(clean_nll.mean())
            reset_tail.append(with_reset["nll"][-4:].mean())
            clean_tail.append(clean_nll[-4:].mean())
            resets += with_reset["resets"]
        return {
            "threshold": float(candidate_threshold),
            "sequences": len(reset),
            "resets": int(resets),
            "contaminatedNll": float(np.mean(contaminated)),
            "resetNll": float(np.mean(reset)),
            "cleanNll": float(np.mean(clean_values)),
            "resetMinusContaminated": float(np.mean(reset) - np.mean(contaminated)),
            "tailResetMinusClean": float(np.mean(reset_tail) - np.mean(clean_tail)),
        }

    if threshold is None:
        reports = [score(candidate) for candidate in RESET_GRID]
        return min(reports, key=lambda report: report["resetNll"])
    return score(threshold)


def main() -> None:
    args = parse_args()
    tf.keras.utils.set_random_seed(args.seed)
    meta, dec, cand = load(args.data)
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

    model = ExpertPolicy()
    fit = train(model, by_split["train"], by_split["validation"], dec, cand, args)
    logits = {
        name: logits_by_sequence(model, by_split[name], dec, cand) for name in SPLITS
    }
    temperature, learning_rate, drift = tune_filter(
        by_split["validation"], logits["validation"], dec
    )
    validation_splice = splice_report(
        by_split["validation"],
        logits["validation"],
        dec,
        temperature,
        learning_rate,
        drift,
    )
    threshold = validation_splice["threshold"]
    print(
        f"validation selected T={temperature:.2f} lr={learning_rate:.2f} "
        f"drift={drift:.2f} reset={threshold:.2f}",
        flush=True,
    )

    holdout_sequences = by_split["holdout"]
    holdout_logits = logits["holdout"]
    adaptive = evaluate_adaptive(
        holdout_sequences,
        holdout_logits,
        dec,
        temperature,
        learning_rate,
        drift,
        threshold,
    )
    adaptive["temperature"] = temperature
    fixed = evaluate_fixed(holdout_sequences, holdout_logits, dec, temperature)
    stateless = evaluate_fixed(
        holdout_sequences, holdout_logits, dec, temperature, mean_logits=True
    )
    shuffled = evaluate_shuffled(holdout_sequences, holdout_logits, dec, adaptive)
    holdout_splice = splice_report(
        holdout_sequences,
        holdout_logits,
        dec,
        temperature,
        learning_rate,
        drift,
        threshold,
    )

    warm = adaptive["turn"] >= WARMUP
    fixed_delta = fixed["nll"][warm] - adaptive["nll"][warm]
    shuffled_delta = shuffled["nll"][warm] - adaptive["nll"][warm]
    fixed_interval = bootstrap_lower_bound(
        fixed_delta, adaptive["game"][warm], args.bootstrap, args.seed + 1
    )
    shuffled_interval = bootstrap_lower_bound(
        shuffled_delta, adaptive["game"][warm], args.bootstrap, args.seed + 2
    )
    training_adaptive = evaluate_adaptive(
        by_split["train"],
        logits["train"],
        dec,
        temperature,
        learning_rate,
        drift,
        threshold,
    )
    responsibility = np.mean(
        np.stack([run["final"] for run in training_adaptive["runs"]]), axis=0
    )
    adaptive_summary, fixed_summary = summarize(adaptive), summarize(fixed)

    gates = {
        "fixedGain": {
            "value": fixed_interval[0],
            "interval": list(fixed_interval[1:]),
            "threshold": 0.03,
            "pass": fixed_interval[1] > 0.03,
        },
        "identityChannel": {
            "value": shuffled_interval[0],
            "interval": list(shuffled_interval[1:]),
            "threshold": 0.06,
            "pass": shuffled_interval[1] > 0.06,
        },
        "topFiveRecall": {
            "value": adaptive_summary["top5"],
            "threshold": 0.65,
            "pass": adaptive_summary["top5"] > 0.65,
        },
        "calibration": {
            "value": adaptive_summary["ece"],
            "fixedValue": fixed_summary["ece"],
            "threshold": 0.08,
            "pass": adaptive_summary["ece"] <= 0.08
            and adaptive_summary["ece"] <= fixed_summary["ece"] + 0.01,
        },
        "expertUsage": {
            "value": float(responsibility.min()),
            "responsibilities": responsibility.tolist(),
            "threshold": 0.03,
            "pass": float(responsibility.min()) >= 0.03,
        },
        "changePointReset": {
            "resetMinusContaminated": holdout_splice["resetMinusContaminated"],
            "tailResetMinusClean": holdout_splice["tailResetMinusClean"],
            "threshold": 0.10,
            "pass": holdout_splice["resetMinusContaminated"] <= 0.0
            and holdout_splice["tailResetMinusClean"] <= 0.10,
        },
    }
    output = {
        "experiment": "v5-oracle-online-adapter",
        "preregistration": "research_paper/v5_oracle_online_adapter.md",
        "dataset": {
            "architecture": meta["architecture"],
            "games": int(meta["finishedGames"]),
            "profiles": len(meta["profiles"]),
            "decisions": int(meta["decisions"]),
            "candidates": int(meta["candidates"]),
            "missingPlayedActions": int(meta["missingPlayedActions"]),
            "seedBase": int(meta["seedBase"]),
        },
        "fit": {
            **fit,
            "parameters": int(sum(np.prod(weight.shape) for weight in model.weights)),
            "trainingFinalResponsibilities": responsibility.tolist(),
        },
        "selectedFilter": {
            "temperature": temperature,
            "learningRate": learning_rate,
            "drift": drift,
            "resetThreshold": threshold,
        },
        "holdout": {
            "adaptive": adaptive_summary,
            "fixed": fixed_summary,
            "shuffled": summarize(shuffled),
            "stateless": summarize(stateless),
        },
        "splice": {"validation": validation_splice, "holdout": holdout_splice},
        "gates": gates,
        "searchIntegrationAuthorized": all(gate["pass"] for gate in gates.values()),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
    arrays = {f"weight_{index}": weight.numpy() for index, weight in enumerate(model.weights)}
    arrays["temperature"] = np.asarray([temperature], np.float32)
    arrays["learning_rate"] = np.asarray([learning_rate], np.float32)
    arrays["drift"] = np.asarray([drift], np.float32)
    arrays["reset_threshold"] = np.asarray([threshold], np.float32)
    np.savez(args.checkpoint, **arrays)

    print(f"holdout adaptive {adaptive_summary['nll']:.4f}")
    print(f"holdout fixed    {fixed_summary['nll']:.4f}")
    print(f"holdout shuffled {summarize(shuffled)['nll']:.4f}")
    for name, gate in gates.items():
        print(f"{'PASS' if gate['pass'] else 'FAIL'} {name}: {json.dumps(gate)}")
    print(f"search integration authorized: {output['searchIntegrationAuthorized']}")
    print(f"wrote {args.out} and {args.checkpoint}")


if __name__ == "__main__":
    main()
