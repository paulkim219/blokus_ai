#!/usr/bin/env python3
"""Diagnostic for Experiment K's failed style-switch gate.

The gate required >50% family identification four observations after a behavior switch and
measured 32.3%. That number alone cannot distinguish two very different causes:

  1. the recurrent state is sticky and stays anchored to the previous player, or
  2. four observations is simply too little evidence for any state, switched or not.

This script reloads the frozen Experiment K checkpoint and measures the matched control the
run never recorded — clean family accuracy as a function of observation count — alongside the
post-switch adaptation curve. It trains nothing and selects nothing.

Variant d is already consumed, so these numbers are diagnostic only. Experiment L must still
preregister its gate against a fresh variant and fresh switched trajectories.
"""

from __future__ import annotations

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

from train_v5_player_residual import (
    ACTUAL,
    EMBED,
    FAMILIES,
    ContextPopulation,
    FamilyResidual,
    HistoryResidual,
    family_policy_logits,
    softmax,
    donor_indices,
    encode_corpus,
    history_components,
    load_raw,
    pad_raw,
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--holdout", default="ml/data/v5-oracle-personalities-d")
    parser.add_argument("--checkpoint", default="ml/v5-oracle-player-residual.npz")
    parser.add_argument("--out", default="selfplay-results/v5-oracle-style-switch-diagnostic.json")
    parser.add_argument("--arm", default="gru", choices=("gru", "transformer"))
    # The validation-selected filter recorded by Experiment K; not re-tuned here.
    parser.add_argument("--bayes-temperature", type=float, default=1.25)
    parser.add_argument("--bayes-learning-rate", type=float, default=1.0)
    parser.add_argument("--bayes-drift", type=float, default=0.0)
    return parser.parse_args()


def restore(checkpoint, name, model):
    weights = [checkpoint[f"{name}_{index}"] for index in range(len(model.weights))]
    for weight, value in zip(model.weights, weights):
        weight.assign(value)


def build_models(args, raw):
    """Materialize both models on one real batch so their weights exist, then restore."""
    checkpoint = np.load(args.checkpoint)
    population = ContextPopulation()
    candidate, mask, states, boards, _ = pad_raw(np.arange(2, dtype=np.int64), raw)
    population(tf.constant(candidate), tf.constant(mask), tf.constant(states), tf.constant(boards))
    restore(checkpoint, "population", population)

    family = FamilyResidual()
    family(tf.zeros((1, 3, EMBED)), tf.zeros((1, 3)))
    restore(checkpoint, "family", family)

    history = HistoryResidual(args.arm)
    embedding = tf.zeros((1, 2, 3, EMBED))
    base = tf.zeros((1, 2, 3))
    targets = tf.zeros((1, 2), tf.int32)
    time_mask = tf.ones((1, 2))
    history(embedding, base, targets, time_mask)
    restore(checkpoint, args.arm, history)
    return population, history, family


def bayes_posterior(policies, rows, decisions, count, temperature, learning_rate, drift,
                    posterior=None):
    """Run the parameter-free family filter over the first `count` observations of a trajectory."""
    if posterior is None:
        posterior = np.ones(len(FAMILIES)) / len(FAMILIES)
    for logits, row in list(zip(policies, rows))[:count]:
        actual = int(decisions[row, ACTUAL])
        likelihood = np.asarray(
            [softmax(logits[:, family], temperature)[actual] for family in range(len(FAMILIES))]
        )
        posterior = posterior * np.maximum(likelihood, 1e-9) ** learning_rate
        posterior /= posterior.sum()
        posterior = (1 - drift) * posterior + drift / len(FAMILIES)
    return posterior


def bayes_curves(policies, sequences, corpus, donors, options, counts, donor_length=4):
    """The Bayes arm's clean and post-switch identification, matched to the GRU measurement."""
    temperature, learning_rate, drift = options
    clean, switched, stale = {}, {}, {}
    for count in counts:
        clean_hits = switch_hits = stale_hits = 0
        clean_total = switch_total = 0
        for index, sequence in enumerate(sequences):
            if len(sequence.rows) >= count:
                posterior = bayes_posterior(
                    policies[index], sequence.rows, corpus.decisions, count,
                    temperature, learning_rate, drift,
                )
                clean_hits += int(np.argmax(posterior) == sequence.family)
                clean_total += 1
            second_index = donors[index]
            second = sequences[second_index]
            if len(sequence.rows) >= donor_length and len(second.rows) >= count:
                posterior = bayes_posterior(
                    policies[index], sequence.rows, corpus.decisions, donor_length,
                    temperature, learning_rate, drift,
                )
                posterior = bayes_posterior(
                    policies[second_index], second.rows, corpus.decisions, count,
                    temperature, learning_rate, drift, posterior,
                )
                switch_hits += int(np.argmax(posterior) == second.family)
                stale_hits += int(np.argmax(posterior) == sequence.family)
                switch_total += 1
        clean[count] = clean_hits / max(1, clean_total)
        switched[count] = switch_hits / max(1, switch_total)
        stale[count] = stale_hits / max(1, switch_total)
    return {"clean": clean, "postSwitch": switched, "postSwitchOldFamily": stale}


def family_probabilities(model, latent):
    return tf.nn.softmax(model.family_head(tf.constant(latent))).numpy()


def clean_curve(model, components, sequences, counts):
    """Family accuracy from a player's own first N observations."""
    accuracy = {}
    for count in counts:
        hits, total = 0, 0
        for index, component in enumerate(components):
            available = len(component["targets"])
            if available < count:
                continue
            chosen = component["embedding"][np.arange(count), component["targets"][:count]]
            history = np.concatenate(
                [np.zeros((1, EMBED), np.float32), chosen.astype(np.float32)], axis=0
            )[None]
            latent = model.encode_history(tf.constant(history)).numpy()[0, -1]
            prediction = int(np.argmax(family_probabilities(model, latent[None])[0]))
            hits += int(prediction == sequences[index].family)
            total += 1
        accuracy[count] = hits / max(1, total)
    return accuracy


def switch_curve(model, components, sequences, donors, donor_lengths, after_counts):
    """Family accuracy for the *new* family after a switch, by donor prefix and evidence length."""
    curves = {}
    for donor_length in donor_lengths:
        curve = {}
        for after in after_counts:
            hits, total = 0, 0
            for index, component in enumerate(components):
                second_index = donors[index]
                second = components[second_index]
                if len(component["targets"]) < donor_length or len(second["targets"]) < after:
                    continue
                first_chosen = component["embedding"][
                    np.arange(donor_length), component["targets"][:donor_length]
                ]
                second_chosen = second["embedding"][np.arange(after), second["targets"][:after]]
                observed = np.concatenate([first_chosen, second_chosen], axis=0).astype(np.float32)
                history = np.concatenate([np.zeros((1, EMBED), np.float32), observed], axis=0)[None]
                latent = model.encode_history(tf.constant(history)).numpy()[0, -1]
                prediction = int(np.argmax(family_probabilities(model, latent[None])[0]))
                hits += int(prediction == sequences[second_index].family)
                total += 1
            curve[after] = hits / max(1, total)
        curves[donor_length] = curve
    return curves


def stale_curve(model, components, sequences, donors, donor_length, after_counts):
    """How often the state still reports the OLD family after the switch."""
    curve = {}
    for after in after_counts:
        hits, total = 0, 0
        for index, component in enumerate(components):
            second_index = donors[index]
            second = components[second_index]
            if len(component["targets"]) < donor_length or len(second["targets"]) < after:
                continue
            first_chosen = component["embedding"][
                np.arange(donor_length), component["targets"][:donor_length]
            ]
            second_chosen = second["embedding"][np.arange(after), second["targets"][:after]]
            observed = np.concatenate([first_chosen, second_chosen], axis=0).astype(np.float32)
            history = np.concatenate([np.zeros((1, EMBED), np.float32), observed], axis=0)[None]
            latent = model.encode_history(tf.constant(history)).numpy()[0, -1]
            prediction = int(np.argmax(family_probabilities(model, latent[None])[0]))
            hits += int(prediction == sequences[index].family)
            total += 1
        curve[after] = hits / max(1, total)
    return curve


def action_surprise(model, components, donors, donor_length, steps):
    """Is a switch even detectable? Action NLL under a contaminated versus a clean state.

    A surprise-triggered reset needs the contaminated state to be measurably worse at predicting
    the new player's moves. If the two curves coincide, no threshold detector can fire.
    """
    contaminated_by_step = {step: [] for step in steps}
    clean_by_step = {step: [] for step in steps}
    fixed_by_step = {step: [] for step in steps}
    for index, component in enumerate(components):
        second_index = donors[index]
        second = components[second_index]
        if len(component["targets"]) < donor_length:
            continue
        old_chosen = component["embedding"][
            np.arange(donor_length), component["targets"][:donor_length]
        ].astype(np.float32)
        new_chosen = second["embedding"][
            np.arange(len(second["targets"])), second["targets"]
        ].astype(np.float32)
        query = model.query(tf.constant(second["embedding"])).numpy()
        for step in steps:
            if len(second["targets"]) <= step:
                continue
            count = second["counts"][step]
            actual = int(second["targets"][step])
            base_only = second["base"][step, :count]
            base_only = base_only - base_only.max()
            base_probabilities = np.exp(base_only)
            base_probabilities /= base_probabilities.sum()
            fixed_by_step[step].append(
                float(-np.log(max(base_probabilities[actual], 1e-12)))
            )
            prior = new_chosen[:step]
            for label, prefix in (
                ("contaminated", np.concatenate([old_chosen, prior], axis=0)),
                ("clean", prior),
            ):
                history = np.concatenate([np.zeros((1, EMBED), np.float32), prefix], axis=0)[None]
                latent = model.encode_history(tf.constant(history)).numpy()[0, -1]
                count = second["counts"][step]
                actual = int(second["targets"][step])
                logits = second["base"][step, :count] + (
                    query[step, :count] @ latent / np.sqrt(EMBED)
                )
                logits = logits - logits.max()
                probabilities = np.exp(logits)
                probabilities /= probabilities.sum()
                value = float(-np.log(max(probabilities[actual], 1e-12)))
                (contaminated_by_step if label == "contaminated" else clean_by_step)[step].append(value)
    return {
        "contaminated": {step: float(np.mean(values)) for step, values in contaminated_by_step.items()},
        "clean": {step: float(np.mean(values)) for step, values in clean_by_step.items()},
        "fixedPopulation": {step: float(np.mean(values)) for step, values in fixed_by_step.items()},
    }


def window_cost(model, components, sequences, corpus, windows, warmup=3):
    """What a sliding window costs on STABLE players.

    Experiment L's own gate allows at most 0.01 nats/action of degradation on stable histories,
    so the window that repairs switching must be checked against the window that preserves
    likelihood. Each turn is re-encoded from only its last `window` observations.
    """
    results = {}
    for window in windows:
        losses, family_hits, family_total = [], 0, 0
        for index, component in enumerate(components):
            length = len(component["targets"])
            chosen = component["embedding"][np.arange(length), component["targets"]].astype(
                np.float32
            )
            query = model.query(tf.constant(component["embedding"])).numpy()
            prefixes, widths = [], []
            for turn in range(length):
                start = 0 if window is None else max(0, turn - window)
                prefix = chosen[start:turn]
                prefixes.append(prefix)
                widths.append(len(prefix))
            padded = np.zeros((length, max(widths) + 1, EMBED), np.float32)
            for turn, prefix in enumerate(prefixes):
                padded[turn, 1 : 1 + len(prefix)] = prefix
            latents = model.encode_history(tf.constant(padded)).numpy()
            for turn in range(length):
                latent = latents[turn, widths[turn]]
                count = component["counts"][turn]
                actual = int(component["targets"][turn])
                logits = component["base"][turn, :count] + (
                    query[turn, :count] @ latent / np.sqrt(EMBED)
                )
                logits = logits - logits.max()
                probabilities = np.exp(logits)
                probabilities /= probabilities.sum()
                if turn >= warmup:
                    losses.append(float(-np.log(max(probabilities[actual], 1e-12))))
                if turn == 8:
                    prediction = int(
                        np.argmax(family_probabilities(model, latent[None])[0])
                    )
                    family_hits += int(prediction == sequences[index].family)
                    family_total += 1
        results["full" if window is None else window] = {
            "nll": float(np.mean(losses)),
            "familyAccuracy8": family_hits / max(1, family_total),
        }
    return results


def main():
    args = parse_args()
    raw = load_raw(args.holdout, "v5-oracle-player-residual-holdout-trajectories-v5")
    population, history, family = build_models(args, raw)
    corpus = encode_corpus(population, raw)
    sequences = corpus.sequences
    components = history_components(history, sequences, corpus)
    donors = donor_indices(sequences)

    counts = [1, 2, 3, 4, 5, 6, 8, 12]
    clean = clean_curve(history, components, sequences, counts)
    switched = switch_curve(history, components, sequences, donors, [4, 8], counts)
    stale = stale_curve(history, components, sequences, donors, 4, counts)
    surprise = action_surprise(history, components, donors, 4, [0, 1, 2, 3, 4, 5])
    windows = window_cost(history, components, sequences, corpus, [3, 4, 6, 8, 12, None])
    bayes_options = (
        args.bayes_temperature, args.bayes_learning_rate, args.bayes_drift
    )
    policies = [family_policy_logits(family, sequence, corpus) for sequence in sequences]
    bayes = bayes_curves(policies, sequences, corpus, donors, bayes_options, counts)

    chance = 1.0 / len(FAMILIES)
    output = {
        "experiment": "v5-oracle-style-switch-diagnostic",
        "note": (
            "Diagnostic only on the already-consumed variant-d holdout. Nothing here selects a "
            "model or changes Experiment K's recorded verdict."
        ),
        "arm": args.arm,
        "sequences": len(sequences),
        "chance": chance,
        "cleanFamilyAccuracy": clean,
        "postSwitchNewFamilyAccuracy": switched,
        "postSwitchOldFamilyAccuracy": stale,
        "actionSurpriseAfterSwitch": surprise,
        "slidingWindowCostOnStablePlayers": windows,
        "bayesArm": {
            "filter": {
                "temperature": bayes_options[0],
                "learningRate": bayes_options[1],
                "drift": bayes_options[2],
            },
            **bayes,
        },
        "gateComparison": {
            "measuredInExperimentK": 0.3229166666666667,
            "matchedCleanControl": clean.get(4),
            "gateThreshold": 0.5,
        },
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")

    print(f"sequences {len(sequences)}  chance {chance:.3f}\n")
    print("observations   clean   switch(4)  switch(8)  still-old(4)")
    for count in counts:
        print(
            f"{count:>10}   {clean[count]:>6.3f}   {switched[4][count]:>8.3f}"
            f"   {switched[8][count]:>8.3f}   {stale[count]:>10.3f}"
        )
    print("\npost-switch step   contaminated   clean   fixed-population   contam-clean")
    for step in [0, 1, 2, 3, 4, 5]:
        gap = surprise["contaminated"][step] - surprise["clean"][step]
        print(
            f"{step:>16}   {surprise['contaminated'][step]:>12.3f}"
            f"   {surprise['clean'][step]:>5.3f}   {surprise['fixedPopulation'][step]:>16.3f}"
            f"   {gap:>+11.3f}"
        )
    print("\nsliding window   stable NLL (turns>=3)   family acc @8   NLL cost vs full")
    full = windows["full"]["nll"]
    for key in [3, 4, 6, 8, 12, "full"]:
        entry = windows[key]
        print(
            f"{str(key):>14}   {entry['nll']:>20.4f}   {entry['familyAccuracy8']:>13.3f}"
            f"   {entry['nll'] - full:>+15.4f}"
        )
    print("\nBayes arm      clean   post-switch   still-old")
    for count in counts:
        print(
            f"{count:>10}   {bayes['clean'][count]:>7.3f}   {bayes['postSwitch'][count]:>11.3f}"
            f"   {bayes['postSwitchOldFamily'][count]:>9.3f}"
        )
    print(f"\nExperiment K gate measured 0.323 at four post-switch observations.")
    print(f"Matched clean control at four observations: {clean[4]:.3f}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
