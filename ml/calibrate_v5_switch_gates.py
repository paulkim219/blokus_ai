#!/usr/bin/env python3
"""Calibration read for Experiment L's gates, on real switching trajectories.

Every post-switch number available before this script came from splicing two players' prefixes
across two different games. That is a different — and probably easier — distribution than a real
mid-game objective change, so a gate calibrated on it would be set blind.

This runs the frozen Experiment K checkpoint against genuine switching games and reports the
quantities L's gates are written in terms of:

  * family accuracy N observations after a real switch, and the matched clean control;
  * action NLL after the switch against the fixed population model (the "do no harm" gate);
  * how far the identity channel survives on the pre-switch segment.

It trains nothing and selects nothing. The switching corpus uses only already-consumed development
variants; its internally named ``holdout`` split is not Experiment L's future fresh holdout.
Experiment L must still preregister against a fresh variant.
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
    COUNT,
    EMBED,
    FAMILIES,
    GAME,
    OFFSET,
    PROFILE,
    SEAT,
    SPLIT,
    TURN,
    ContextPopulation,
    HistoryResidual,
    encode_corpus,
    load_raw,
    pad_raw,
)

SPLIT_NAMES = ("train", "validation", "holdout")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default="ml/data/v5-oracle-switch-dev")
    parser.add_argument("--checkpoint", default="ml/v5-oracle-player-residual.npz")
    parser.add_argument("--out", default="selfplay-results/v5-oracle-switch-calibration.json")
    parser.add_argument(
        "--split",
        default="holdout",
        choices=SPLIT_NAMES,
        help="Which development split to read. 'holdout' here is variant c, already consumed by K.",
    )
    parser.add_argument("--counts", default="1,2,3,4,5,6,8,10,12")
    return parser.parse_args()


def restore(checkpoint, name, model):
    for weight, index in zip(model.weights, range(len(model.weights))):
        weight.assign(checkpoint[f"{name}_{index}"])


def build_models(args, raw):
    checkpoint = np.load(args.checkpoint)
    population = ContextPopulation()
    candidate, mask, states, boards, _ = pad_raw(np.arange(2, dtype=np.int64), raw)
    population(tf.constant(candidate), tf.constant(mask), tf.constant(states), tf.constant(boards))
    restore(checkpoint, "population", population)
    history = HistoryResidual("gru")
    history(tf.zeros((1, 2, 3, EMBED)), tf.zeros((1, 2, 3)), tf.zeros((1, 2), tf.int32), tf.ones((1, 2)))
    restore(checkpoint, "gru", history)
    return population, history


def switching_sequences(meta, decisions, split_index):
    """One entry per (game, seat): the whole continuous trajectory, plus where the family changes.

    The decision `profile` column indexes meta['profileSources'], which is the only mapping that
    stays correct when one seat contributes two objectives.
    """
    family_index = {family: index for index, family in enumerate(FAMILIES)}
    source_family = {
        int(entry["index"]): family_index.get(entry["family"])
        for entry in meta["profileSources"]
    }
    groups = {}
    for row, decision in enumerate(decisions):
        if int(decision[SPLIT]) != split_index:
            continue
        groups.setdefault((int(decision[GAME]), int(decision[SEAT])), []).append(row)
    sequences = []
    for (game, seat), rows in sorted(groups.items()):
        ordered = sorted(rows, key=lambda row: int(decisions[row, TURN]))
        families = [source_family[int(decisions[row, PROFILE])] for row in ordered]
        change = next(
            (index for index in range(1, len(families)) if families[index] != families[index - 1]),
            None,
        )
        sequences.append(
            {
                "game": game,
                "seat": seat,
                "rows": np.asarray(ordered, np.int64),
                "families": families,
                "change": change,
            }
        )
    return sequences


def components(model, corpus, sequence):
    """Candidate embeddings, base logits and played indices for one whole trajectory."""
    rows = sequence["rows"]
    embeddings, bases, targets, counts = [], [], [], []
    for row in rows:
        offset, count = int(corpus.decisions[row, OFFSET]), int(corpus.decisions[row, COUNT])
        embeddings.append(corpus.embeddings[offset : offset + count].astype(np.float32))
        bases.append(corpus.base_logits[offset : offset + count])
        targets.append(int(corpus.decisions[row, ACTUAL]))
        counts.append(count)
    return embeddings, bases, targets, counts


def latent_after(model, chosen, upto):
    history = np.concatenate(
        [np.zeros((1, EMBED), np.float32), chosen[:upto].astype(np.float32)], axis=0
    )[None]
    return model.encode_history(tf.constant(history)).numpy()[0, -1]


def nll_at(model, embeddings, bases, targets, turn, latent):
    query = model.query(tf.constant(embeddings[turn][None])).numpy()[0]
    logits = bases[turn] + (query @ latent) / np.sqrt(EMBED)
    logits = logits - logits.max()
    probabilities = np.exp(logits)
    probabilities /= probabilities.sum()
    return float(-np.log(max(probabilities[targets[turn]], 1e-12)))


def fixed_nll_at(bases, targets, turn):
    logits = bases[turn] - bases[turn].max()
    probabilities = np.exp(logits)
    probabilities /= probabilities.sum()
    return float(-np.log(max(probabilities[targets[turn]], 1e-12)))


def main():
    args = parse_args()
    counts = [int(value) for value in args.counts.split(",")]
    raw = load_raw(args.corpus, "v5-oracle-personality-switch-trajectories-v6")
    population, history = build_models(args, raw)
    corpus = encode_corpus(population, raw)
    split_index = SPLIT_NAMES.index(args.split)
    sequences = switching_sequences(corpus.meta, corpus.decisions, split_index)
    switched = [s for s in sequences if s["change"] is not None]

    post_hits = {count: [0, 0] for count in counts}
    stale_hits = {count: [0, 0] for count in counts}
    clean_hits = {count: [0, 0] for count in counts}
    post_nll, post_fixed_nll = {}, {}
    for offset in range(0, 5):
        post_nll[offset], post_fixed_nll[offset] = [], []

    for sequence in switched:
        embeddings, bases, targets, _ = components(history, corpus, sequence)
        chosen = np.stack(
            [embeddings[turn][targets[turn]] for turn in range(len(targets))]
        )
        change = sequence["change"]
        new_family = sequence["families"][change]
        old_family = sequence["families"][change - 1]

        for count in counts:
            # Post-switch: the seat's own continuous prefix, `count` observations past the change.
            if change + count <= len(targets):
                latent = latent_after(history, chosen, change + count)
                prediction = int(
                    np.argmax(history.family_head(tf.constant(latent[None])).numpy()[0])
                )
                post_hits[count][0] += int(prediction == new_family)
                post_hits[count][1] += 1
                stale_hits[count][0] += int(prediction == old_family)
                stale_hits[count][1] += 1
            # Matched clean control: the same model, same corpus, pre-switch segment only.
            if count <= change:
                latent = latent_after(history, chosen, count)
                prediction = int(
                    np.argmax(history.family_head(tf.constant(latent[None])).numpy()[0])
                )
                clean_hits[count][0] += int(prediction == old_family)
                clean_hits[count][1] += 1

        for offset in post_nll:
            turn = change + offset
            if turn >= len(targets):
                continue
            latent = latent_after(history, chosen, turn)
            post_nll[offset].append(nll_at(history, embeddings, bases, targets, turn, latent))
            post_fixed_nll[offset].append(fixed_nll_at(bases, targets, turn))

    def rate(table):
        return {count: (hits / total if total else None) for count, (hits, total) in table.items()}

    clean = rate(clean_hits)
    post = rate(post_hits)
    stale = rate(stale_hits)
    output = {
        "experiment": "v5-oracle-switch-gate-calibration",
        "note": (
            "Frozen Experiment K checkpoint on real switching games, already-consumed development "
            "variants only. Trains nothing, selects nothing, and does not consume Experiment L's "
            "future fresh holdout."
        ),
        "corpus": args.corpus,
        "split": args.split,
        "sequences": len(sequences),
        "sequencesWithASwitch": len(switched),
        "chance": 1.0 / len(FAMILIES),
        "cleanFamilyAccuracy": clean,
        "postSwitchFamilyAccuracy": post,
        "postSwitchStillOldFamily": stale,
        "postSwitchRatioOfClean": {
            count: (post[count] / clean[count])
            if clean.get(count) and post.get(count) is not None
            else None
            for count in counts
        },
        "postSwitchActionNll": {
            offset: {
                "model": float(np.mean(values)) if values else None,
                "fixedPopulation": float(np.mean(post_fixed_nll[offset]))
                if post_fixed_nll[offset]
                else None,
                "modelMinusFixed": float(np.mean(values) - np.mean(post_fixed_nll[offset]))
                if values
                else None,
                "decisions": len(values),
            }
            for offset, values in post_nll.items()
        },
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")

    print(f"{len(switched)}/{len(sequences)} {args.split} trajectories switch  chance {1/len(FAMILIES):.3f}\n")
    def cell(value):
        return "    -" if value is None else f"{value:.3f}"

    print("observations   clean(pre)   post-switch   still-old   ratio")
    for count in counts:
        c, p, o = clean[count], post[count], stale[count]
        ratio = f"{p / c:.2f}" if c and p is not None else "    -"
        print(f"{count:>10}   {cell(c):>10}   {cell(p):>11}   {cell(o):>9}   {ratio:>5}")
    print("\nturns after switch   model NLL   fixed NLL   model-fixed")
    for offset in sorted(post_nll):
        entry = output["postSwitchActionNll"][offset]
        if entry["model"] is None:
            continue
        print(
            f"{offset:>18}   {entry['model']:>9.3f}   {entry['fixedPopulation']:>9.3f}"
            f"   {entry['modelMinusFixed']:>+11.3f}"
        )
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
