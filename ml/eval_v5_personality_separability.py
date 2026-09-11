#!/usr/bin/env python3
"""Blind family-classification audit for the synthetic Oracle personality league."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass

import numpy as np

FEATURES = 59
PREFIXES = (3, 5, 8, 12, 0)  # zero means the complete trajectory
FAMILIES = (
    "expansion",
    "center",
    "edge",
    "blocker",
    "retaliator",
    "persistent",
    "next-hunter",
    "tempo",
)

# decision columns
GAME, PROFILE, SEAT, PLY, TURN, OFFSET, COUNT, ACTUAL, SPLIT = range(9)


@dataclass
class Sequence:
    game: int
    profile: int
    seat: int
    split: int
    family: int
    rows: np.ndarray


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="ml/data/v5-oracle-personalities")
    parser.add_argument(
        "--out", default="selfplay-results/v5-oracle-personality-separability.json"
    )
    parser.add_argument("--bootstrap", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=5701)
    return parser.parse_args()


def load(prefix: str):
    with open(f"{prefix}.meta.json", encoding="utf-8") as handle:
        meta = json.load(handle)
    expected = "v5-oracle-strategic-personality-trajectories-v4"
    if meta.get("architecture") != expected:
        raise SystemExit(f"personality benchmark requires {expected}")
    if int(meta["featureCount"]) != FEATURES:
        raise SystemExit(f"expected {FEATURES} candidate features")
    width = int(meta["decisionWidth"])
    decisions = np.fromfile(f"{prefix}.decisions.i32", np.int32).reshape(-1, width)
    candidates = np.fromfile(f"{prefix}.candidates.f32", np.float32).reshape(-1, FEATURES)
    if int(meta["missingPlayedActions"]) != 0:
        raise SystemExit("dataset contains a played action outside the exact legal set")
    if int(meta["finishedGames"]) != len(meta["games"]):
        raise SystemExit("dataset contains unfinished games")
    return meta, decisions, candidates


def build_sequences(meta, decisions) -> list[Sequence]:
    family_index = {name: index for index, name in enumerate(FAMILIES)}
    profile_family = {
        index: family_index[profile["family"]] for index, profile in enumerate(meta["profiles"])
    }
    groups: dict[tuple[int, int, int], list[int]] = {}
    for row, decision in enumerate(decisions):
        key = (int(decision[GAME]), int(decision[PROFILE]), int(decision[SEAT]))
        groups.setdefault(key, []).append(row)
    sequences = []
    for (game, profile, seat), rows in sorted(groups.items()):
        ordered = np.asarray(sorted(rows, key=lambda row: int(decisions[row, TURN])), np.int64)
        splits = np.unique(decisions[ordered, SPLIT])
        if len(splits) != 1:
            raise SystemExit("one player-game trajectory crosses data splits")
        sequences.append(
            Sequence(
                game=game,
                profile=profile,
                seat=seat,
                split=int(splits[0]),
                family=profile_family[profile],
                rows=ordered,
            )
        )
    return sequences


def aggregate(sequence: Sequence, prefix: int, decisions, candidates) -> np.ndarray:
    rows = sequence.rows if prefix == 0 else sequence.rows[:prefix]
    selected = []
    for row in rows:
        offset = int(decisions[row, OFFSET])
        actual = int(decisions[row, ACTUAL])
        selected.append(candidates[offset + actual])
    values = np.asarray(selected, np.float64)
    return np.concatenate([values.mean(axis=0), values.std(axis=0)])


def dataset(sequences, prefix, decisions, candidates):
    usable = [sequence for sequence in sequences if prefix == 0 or len(sequence.rows) >= prefix]
    x = np.stack([aggregate(sequence, prefix, decisions, candidates) for sequence in usable])
    y = np.asarray([sequence.family for sequence in usable], np.int64)
    games = np.asarray([sequence.game for sequence in usable], np.int64)
    splits = np.asarray([sequence.split for sequence in usable], np.int64)
    return x, y, games, splits


def normalize_fit(x):
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return mean, scale


def normalize(x, mean, scale):
    return np.clip((x - mean) / scale, -6.0, 6.0)


def softmax(logits):
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def fit_classifier(x, y, l2, seed, steps=1800):
    del seed  # zero initialization is deterministic for this convex objective
    classes = len(FAMILIES)
    weights = np.zeros((x.shape[1], classes), np.float64)
    bias = np.zeros(classes, np.float64)
    one_hot = np.eye(classes)[y]
    mw = np.zeros_like(weights)
    vw = np.zeros_like(weights)
    mb = np.zeros_like(bias)
    vb = np.zeros_like(bias)
    for step in range(1, steps + 1):
        probabilities = softmax(x @ weights + bias)
        error = (probabilities - one_hot) / len(x)
        grad_w = x.T @ error + l2 * weights
        grad_b = error.sum(axis=0)
        mw = 0.9 * mw + 0.1 * grad_w
        vw = 0.999 * vw + 0.001 * grad_w * grad_w
        mb = 0.9 * mb + 0.1 * grad_b
        vb = 0.999 * vb + 0.001 * grad_b * grad_b
        rate = 0.03 * np.sqrt(1 - 0.999**step) / (1 - 0.9**step)
        weights -= rate * mw / (np.sqrt(vw) + 1e-8)
        bias -= rate * mb / (np.sqrt(vb) + 1e-8)
    return weights, bias


def predict(model, x):
    weights, bias = model
    return np.argmax(x @ weights + bias, axis=1)


def accuracy(y, prediction):
    return float(np.mean(y == prediction))


def cross_entropy(model, x, y):
    probabilities = softmax(x @ model[0] + model[1])
    return float(-np.mean(np.log(np.maximum(probabilities[np.arange(len(y)), y], 1e-12))))


def recalls(y, prediction):
    return np.asarray(
        [
            np.mean(prediction[y == family] == family) if np.any(y == family) else 0.0
            for family in range(len(FAMILIES))
        ],
        np.float64,
    )


def macro_f1(y, prediction):
    scores = []
    for family in range(len(FAMILIES)):
        true_positive = np.sum((y == family) & (prediction == family))
        false_positive = np.sum((y != family) & (prediction == family))
        false_negative = np.sum((y == family) & (prediction != family))
        precision = true_positive / max(1, true_positive + false_positive)
        recall = true_positive / max(1, true_positive + false_negative)
        scores.append(2 * precision * recall / max(1e-12, precision + recall))
    return float(np.mean(scores))


def confusion(y, prediction):
    matrix = np.zeros((len(FAMILIES), len(FAMILIES)), np.int64)
    for actual, predicted in zip(y, prediction):
        matrix[actual, predicted] += 1
    return matrix


def game_bootstrap(y, prediction, games, iterations, seed, other=None):
    rng = np.random.default_rng(seed)
    unique = np.unique(games)
    values = np.zeros(iterations, np.float64)
    for iteration in range(iterations):
        sampled = rng.choice(unique, len(unique), replace=True)
        indices = np.concatenate([np.flatnonzero(games == game) for game in sampled])
        value = accuracy(y[indices], prediction[indices])
        if other is not None:
            value -= accuracy(y[indices], other[indices])
        values[iteration] = value
    point = accuracy(y, prediction)
    if other is not None:
        point -= accuracy(y, other)
    return point, float(np.quantile(values, 0.025)), float(np.quantile(values, 0.975))


def evaluate_prefix(prefix, sequences, decisions, candidates, args):
    x, y, games, splits = dataset(sequences, prefix, decisions, candidates)
    train, validation, holdout = splits == 0, splits == 1, splits == 2
    train_mean, train_scale = normalize_fit(x[train])
    train_x = normalize(x[train], train_mean, train_scale)
    validation_x = normalize(x[validation], train_mean, train_scale)
    grid = (0.0003, 0.001, 0.003, 0.01, 0.03, 0.1)
    trials = []
    for index, l2 in enumerate(grid):
        model = fit_classifier(train_x, y[train], l2, args.seed + index)
        trials.append(
            {
                "l2": l2,
                "accuracy": accuracy(y[validation], predict(model, validation_x)),
                "nll": cross_entropy(model, validation_x, y[validation]),
            }
        )
    selected = min(trials, key=lambda trial: (-trial["accuracy"], trial["nll"], trial["l2"]))

    development = train | validation
    mean, scale = normalize_fit(x[development])
    development_x = normalize(x[development], mean, scale)
    holdout_x = normalize(x[holdout], mean, scale)
    model = fit_classifier(development_x, y[development], selected["l2"], args.seed + 101)
    prediction = predict(model, holdout_x)

    rng = np.random.default_rng(args.seed + 202 + prefix)
    shuffled_labels = rng.permutation(y[development])
    shuffled_model = fit_classifier(
        development_x, shuffled_labels, selected["l2"], args.seed + 303
    )
    shuffled_prediction = predict(shuffled_model, holdout_x)
    interval = game_bootstrap(
        y[holdout], prediction, games[holdout], args.bootstrap, args.seed + 404 + prefix
    )
    margin = game_bootstrap(
        y[holdout],
        prediction,
        games[holdout],
        args.bootstrap,
        args.seed + 505 + prefix,
        shuffled_prediction,
    )
    family_recalls = recalls(y[holdout], prediction)
    return {
        "observations": "complete" if prefix == 0 else prefix,
        "sequences": {
            "train": int(train.sum()),
            "validation": int(validation.sum()),
            "holdout": int(holdout.sum()),
        },
        "selectedL2": selected["l2"],
        "validationTrials": trials,
        "holdout": {
            "accuracy": interval[0],
            "accuracyInterval": list(interval[1:]),
            "macroF1": macro_f1(y[holdout], prediction),
            "perFamilyRecall": {
                family: float(family_recalls[index])
                for index, family in enumerate(FAMILIES)
            },
            "confusion": confusion(y[holdout], prediction).tolist(),
            "shuffledAccuracy": accuracy(y[holdout], shuffled_prediction),
            "accuracyMinusShuffled": margin[0],
            "marginInterval": list(margin[1:]),
        },
    }


def main():
    args = parse_args()
    meta, decisions, candidates = load(args.data)
    sequences = build_sequences(meta, decisions)
    reports = {
        str(prefix): evaluate_prefix(prefix, sequences, decisions, candidates, args)
        for prefix in PREFIXES
    }
    full = reports["0"]["holdout"]
    eight = reports["8"]["holdout"]
    structural = (
        int(meta["missingPlayedActions"]) == 0
        and int(meta["finishedGames"]) == len(meta["games"])
    )
    gates = {
        "completeAccuracy": {
            "value": full["accuracy"],
            "interval": full["accuracyInterval"],
            "threshold": 0.45,
            "pass": full["accuracyInterval"][0] > 0.45,
        },
        "eightMoveAccuracy": {
            "value": eight["accuracy"],
            "interval": eight["accuracyInterval"],
            "threshold": 0.35,
            "pass": eight["accuracyInterval"][0] > 0.35,
        },
        "macroF1": {
            "value": full["macroF1"],
            "threshold": 0.40,
            "pass": full["macroF1"] > 0.40,
        },
        "worstFamilyRecall": {
            "value": min(full["perFamilyRecall"].values()),
            "threshold": 0.20,
            "pass": min(full["perFamilyRecall"].values()) >= 0.20,
        },
        "shuffledControl": {
            "value": full["accuracyMinusShuffled"],
            "interval": full["marginInterval"],
            "threshold": 0.20,
            "pass": full["marginInterval"][0] > 0.20,
        },
        "structural": {
            "finishedGames": int(meta["finishedGames"]),
            "games": len(meta["games"]),
            "missingPlayedActions": int(meta["missingPlayedActions"]),
            "pass": bool(structural),
        },
    }
    accepted = all(gate["pass"] for gate in gates.values())
    output = {
        "experiment": "v5-oracle-personality-separability",
        "preregistration": "research_paper/v5_oracle_personality_league.md",
        "dataset": {
            "architecture": meta["architecture"],
            "games": int(meta["finishedGames"]),
            "profiles": len(meta["profiles"]),
            "families": len(FAMILIES),
            "decisions": int(meta["decisions"]),
            "candidates": int(meta["candidates"]),
            "seedBase": int(meta["seedBase"]),
        },
        "families": list(FAMILIES),
        "prefixes": reports,
        "gates": gates,
        "personalityLeagueAccepted": accepted,
        "playerResidualExperimentAuthorized": accepted,
        "oracleSearchIntegrationAuthorized": False,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
    for key in ("3", "5", "8", "12", "0"):
        report = reports[key]
        holdout = report["holdout"]
        print(
            f"{str(report['observations']):>8s} observations: "
            f"accuracy={holdout['accuracy']:.3f} "
            f"[{holdout['accuracyInterval'][0]:.3f}, {holdout['accuracyInterval'][1]:.3f}] "
            f"shuffled={holdout['shuffledAccuracy']:.3f} macroF1={holdout['macroF1']:.3f}"
        )
    for name, gate in gates.items():
        print(f"{'PASS' if gate['pass'] else 'FAIL'} {name}: {json.dumps(gate)}")
    print(f"personality league accepted: {accepted}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
