#!/usr/bin/env python3
"""Experiment K: frozen contextual population policy plus online player residuals."""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

FEATURES = 59
STATES = 109
EMBED = 32
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
INTERACTION_FAMILIES = (3, 4, 5, 6)
WARMUP = 3
CELL_START = 54

GAME, PROFILE, SEAT, PLY, TURN, OFFSET, COUNT, ACTUAL, SPLIT = range(9)


@dataclass
class RawCorpus:
    meta: dict
    decisions: np.ndarray
    candidates: np.ndarray
    states: np.ndarray
    boards: np.ndarray


@dataclass
class Sequence:
    game: int
    profile: int
    seat: int
    split: int
    family: int
    rows: np.ndarray


@dataclass
class EncodedCorpus:
    meta: dict
    decisions: np.ndarray
    embeddings: np.ndarray
    base_logits: np.ndarray
    sequences: list[Sequence]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--development", default="ml/data/v5-oracle-personalities")
    parser.add_argument("--holdout", default="ml/data/v5-oracle-personalities-d")
    parser.add_argument("--out", default="selfplay-results/v5-oracle-player-residual.json")
    parser.add_argument("--checkpoint", default="ml/v5-oracle-player-residual.npz")
    parser.add_argument("--population-epochs", type=int, default=70)
    parser.add_argument("--residual-epochs", type=int, default=70)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--decision-batch", type=int, default=64)
    parser.add_argument("--sequence-batch", type=int, default=8)
    parser.add_argument("--bootstrap", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=5801)
    parser.add_argument("--validation-only", action="store_true")
    return parser.parse_args()


def load_raw(prefix, expected):
    with open(f"{prefix}.meta.json", encoding="utf-8") as handle:
        meta = json.load(handle)
    if meta["architecture"] != expected:
        raise SystemExit(f"expected {expected}, found {meta['architecture']}")
    if int(meta["featureCount"]) != FEATURES or int(meta["stateFeatureCount"]) != STATES:
        raise SystemExit("context feature contract mismatch")
    width = int(meta["decisionWidth"])
    decisions = np.fromfile(f"{prefix}.decisions.i32", np.int32).reshape(-1, width)
    candidates = np.fromfile(f"{prefix}.candidates.f32", np.float32).reshape(-1, FEATURES)
    states = np.fromfile(f"{prefix}.states.f32", np.float32).reshape(-1, STATES)
    boards = np.fromfile(f"{prefix}.boards.u8", np.uint8).reshape(-1, 20, 20, 4)
    if len(states) != len(decisions) or len(boards) != len(decisions):
        raise SystemExit("shared context rows do not align with decisions")
    if int(meta["missingPlayedActions"]) != 0 or int(meta["finishedGames"]) != len(meta["games"]):
        raise SystemExit("corpus failed structural gate")
    return RawCorpus(meta, decisions, candidates, states, boards)


def build_sequences(meta, decisions):
    family_index = {family: index for index, family in enumerate(FAMILIES)}
    profile_family = {
        index: family_index[profile["family"]] for index, profile in enumerate(meta["profiles"])
    }
    groups = {}
    for row, decision in enumerate(decisions):
        key = (int(decision[GAME]), int(decision[PROFILE]), int(decision[SEAT]))
        groups.setdefault(key, []).append(row)
    sequences = []
    for (game, profile, seat), rows in sorted(groups.items()):
        ordered = np.asarray(sorted(rows, key=lambda row: int(decisions[row, TURN])), np.int64)
        split = int(np.unique(decisions[ordered, SPLIT])[0])
        sequences.append(Sequence(game, profile, seat, split, profile_family[profile], ordered))
    return sequences


def pad_raw(rows, raw):
    counts = raw.decisions[rows, COUNT]
    maximum = int(counts.max())
    candidates = np.zeros((len(rows), maximum, FEATURES), np.float32)
    mask = np.zeros((len(rows), maximum), np.float32)
    for index, row in enumerate(rows):
        offset, count = int(raw.decisions[row, OFFSET]), int(raw.decisions[row, COUNT])
        candidates[index, :count] = raw.candidates[offset : offset + count]
        mask[index, :count] = 1
    return (
        candidates,
        mask,
        raw.states[rows],
        raw.boards[rows],
        raw.decisions[rows, ACTUAL].astype(np.int32),
    )


class ContextPopulation(tf.keras.Model):
    def __init__(self):
        super().__init__()
        self.conv = [
            tf.keras.layers.Conv2D(12, 3, padding="same", activation="relu") for _ in range(2)
        ]
        self.candidate = tf.keras.Sequential(
            [tf.keras.layers.Dense(64, activation="relu"), tf.keras.layers.Dense(40, activation="relu")]
        )
        self.state = tf.keras.Sequential(
            [tf.keras.layers.Dense(48, activation="relu"), tf.keras.layers.Dense(24, activation="relu")]
        )
        self.combined = tf.keras.Sequential(
            [tf.keras.layers.Dense(64, activation="relu"), tf.keras.layers.Dense(EMBED, activation="relu")]
        )
        self.population = tf.keras.layers.Dense(1)

    def call(self, candidates, mask, states, boards):
        spatial = tf.cast(boards, tf.float32)
        for layer in self.conv:
            spatial = layer(spatial)
        flat = tf.reshape(spatial, [tf.shape(spatial)[0], 400, 12])
        cells = candidates[:, :, CELL_START : CELL_START + 5]
        valid = tf.cast(cells >= 0, tf.float32)
        indices = tf.cast(tf.round(tf.maximum(cells, 0) * 399), tf.int32)
        gathered = tf.gather(flat, indices, axis=1, batch_dims=1)
        local = tf.reduce_sum(gathered * valid[:, :, :, None], axis=2)
        local /= tf.maximum(1.0, tf.reduce_sum(valid, axis=2, keepdims=True))
        candidate = self.candidate(candidates)
        shared = tf.concat([self.state(states), tf.reduce_mean(spatial, axis=(1, 2))], axis=1)
        shared = tf.tile(shared[:, None, :], [1, tf.shape(candidates)[1], 1])
        embedding = self.combined(tf.concat([candidate, local, shared], axis=2))
        logits = tf.squeeze(self.population(embedding), axis=2)
        logits += (1 - mask) * -1e9
        return embedding, logits


def sparse_policy_loss(logits, targets):
    return tf.reduce_mean(
        tf.nn.sparse_softmax_cross_entropy_with_logits(labels=targets, logits=logits)
    )


def validation_population(model, rows, raw, batch):
    losses = []
    for start in range(0, len(rows), batch):
        block = rows[start : start + batch]
        _, logits = model(*[tf.constant(value) for value in pad_raw(block, raw)[:4]])
        targets = tf.constant(raw.decisions[block, ACTUAL], tf.int32)
        losses.extend(tf.nn.sparse_softmax_cross_entropy_with_logits(labels=targets, logits=logits).numpy())
    return float(np.mean(losses))


def train_population(model, train_rows, validation_rows, raw, args):
    optimizer = tf.keras.optimizers.Adam(1e-3)

    @tf.function(reduce_retracing=True)
    def step(candidates, mask, states, boards, targets):
        with tf.GradientTape() as tape:
            _, logits = model(candidates, mask, states, boards)
            loss = sparse_policy_loss(logits, targets)
        gradients = tape.gradient(loss, model.trainable_variables)
        optimizer.apply_gradients(zip(gradients, model.trainable_variables))
        return loss

    rng = np.random.default_rng(args.seed)
    best = math.inf
    best_weights = None
    best_epoch = -1
    waited = 0
    trace = []
    for epoch in range(args.population_epochs):
        for start in range(0, len(train_rows), args.decision_batch):
            block = rng.choice(train_rows, min(args.decision_batch, len(train_rows)), replace=False)
            values = pad_raw(block, raw)
            step(*[tf.constant(value) for value in values])
        value = validation_population(model, validation_rows, raw, args.decision_batch)
        trace.append(value)
        if value < best - 1e-4:
            best, best_epoch, waited = value, epoch, 0
            best_weights = [weight.numpy().copy() for weight in model.weights]
        else:
            waited += 1
            if waited >= args.patience:
                break
    if best_weights is None:
        raise RuntimeError("population model did not produce a checkpoint")
    for weight, value in zip(model.weights, best_weights):
        weight.assign(value)
    model.trainable = False
    return {"bestEpoch": best_epoch, "epochsRun": len(trace), "validationNll": best}


def encode_corpus(model, raw):
    embeddings = np.empty((len(raw.candidates), EMBED), np.float16)
    base_logits = np.empty(len(raw.candidates), np.float32)
    rows = np.arange(len(raw.decisions), dtype=np.int64)
    for start in range(0, len(rows), 48):
        block = rows[start : start + 48]
        candidate, mask, states, boards, _ = pad_raw(block, raw)
        encoded, logits = model(
            tf.constant(candidate), tf.constant(mask), tf.constant(states), tf.constant(boards)
        )
        encoded, logits = encoded.numpy(), logits.numpy()
        for local, row in enumerate(block):
            offset, count = int(raw.decisions[row, OFFSET]), int(raw.decisions[row, COUNT])
            embeddings[offset : offset + count] = encoded[local, :count].astype(np.float16)
            base_logits[offset : offset + count] = logits[local, :count]
    return EncodedCorpus(
        raw.meta,
        raw.decisions,
        embeddings,
        base_logits,
        build_sequences(raw.meta, raw.decisions),
    )


def pad_encoded(sequences, corpus):
    batch = len(sequences)
    time = max(len(sequence.rows) for sequence in sequences)
    candidates = max(
        int(corpus.decisions[row, COUNT]) for sequence in sequences for row in sequence.rows
    )
    embedding = np.zeros((batch, time, candidates, EMBED), np.float32)
    base = np.full((batch, time, candidates), -1e9, np.float32)
    candidate_mask = np.zeros((batch, time, candidates), np.float32)
    time_mask = np.zeros((batch, time), np.float32)
    targets = np.zeros((batch, time), np.int32)
    families = np.zeros(batch, np.int32)
    for b, sequence in enumerate(sequences):
        families[b] = sequence.family
        for t, row in enumerate(sequence.rows):
            offset, count = int(corpus.decisions[row, OFFSET]), int(corpus.decisions[row, COUNT])
            embedding[b, t, :count] = corpus.embeddings[offset : offset + count]
            base[b, t, :count] = corpus.base_logits[offset : offset + count]
            candidate_mask[b, t, :count] = 1
            time_mask[b, t] = 1
            targets[b, t] = int(corpus.decisions[row, ACTUAL])
    return embedding, base, candidate_mask, time_mask, targets, families


class FamilyResidual(tf.keras.Model):
    def __init__(self):
        super().__init__()
        self.vectors = self.add_weight(
            shape=(len(FAMILIES), EMBED), initializer="zeros", name="family_vectors"
        )

    def call(self, embedding, base):
        return base[:, :, None] + tf.einsum("bce,ke->bck", embedding, self.vectors)


def train_family_residual(model, train_sequences, validation_sequences, corpus, args):
    train_rows = np.concatenate([sequence.rows for sequence in train_sequences])
    row_family = np.zeros(len(corpus.decisions), np.int32)
    for sequence in corpus.sequences:
        row_family[sequence.rows] = sequence.family
    optimizer = tf.keras.optimizers.Adam(2e-3)

    @tf.function(reduce_retracing=True)
    def step(embedding, base, mask, targets, families):
        with tf.GradientTape() as tape:
            logits = model(embedding, base) + (1 - mask[:, :, None]) * -1e9
            selected = tf.gather(logits, families, axis=2, batch_dims=1)
            loss = sparse_policy_loss(selected, targets)
        gradients = tape.gradient(loss, model.trainable_variables)
        optimizer.apply_gradients(zip(gradients, model.trainable_variables))
        return loss

    def rows_batch(rows):
        maximum = max(int(corpus.decisions[row, COUNT]) for row in rows)
        embedding = np.zeros((len(rows), maximum, EMBED), np.float32)
        base = np.full((len(rows), maximum), -1e9, np.float32)
        mask = np.zeros((len(rows), maximum), np.float32)
        targets = corpus.decisions[rows, ACTUAL].astype(np.int32)
        for index, row in enumerate(rows):
            offset, count = int(corpus.decisions[row, OFFSET]), int(corpus.decisions[row, COUNT])
            embedding[index, :count] = corpus.embeddings[offset : offset + count]
            base[index, :count] = corpus.base_logits[offset : offset + count]
            mask[index, :count] = 1
        return embedding, base, mask, targets, row_family[rows]

    def exact_nll(sequences):
        values = []
        for sequence in sequences:
            for row in sequence.rows:
                offset, count = int(corpus.decisions[row, OFFSET]), int(corpus.decisions[row, COUNT])
                embedding = tf.constant(corpus.embeddings[offset : offset + count][None].astype(np.float32))
                base = tf.constant(corpus.base_logits[offset : offset + count][None])
                logits = model(embedding, base).numpy()[0, :, sequence.family]
                logp = logits - np.logaddexp.reduce(logits)
                values.append(-logp[int(corpus.decisions[row, ACTUAL])])
        return float(np.mean(values))

    rng = np.random.default_rng(args.seed + 10)
    best, best_weights, best_epoch, waited, trace = math.inf, None, -1, 0, []
    steps_per_epoch = max(1, len(train_rows) // args.decision_batch)
    for epoch in range(args.residual_epochs):
        for _ in range(steps_per_epoch):
            rows = rng.choice(train_rows, min(args.decision_batch, len(train_rows)), replace=False)
            step(*[tf.constant(value) for value in rows_batch(rows)])
        value = exact_nll(validation_sequences)
        trace.append(value)
        if value < best - 1e-4:
            best, best_epoch, waited = value, epoch, 0
            best_weights = [weight.numpy().copy() for weight in model.weights]
        else:
            waited += 1
            if waited >= args.patience:
                break
    for weight, value in zip(model.weights, best_weights):
        weight.assign(value)
    return {"bestEpoch": best_epoch, "epochsRun": len(trace), "validationOracleNll": best}


class HistoryResidual(tf.keras.Model):
    def __init__(self, kind):
        super().__init__()
        self.kind = kind
        if kind == "gru":
            self.history = tf.keras.layers.GRU(EMBED, return_sequences=True)
        else:
            self.position = tf.keras.layers.Embedding(32, EMBED)
            self.attention = tf.keras.layers.MultiHeadAttention(4, EMBED // 4)
            self.norm1 = tf.keras.layers.LayerNormalization()
            self.feed = tf.keras.Sequential(
                [tf.keras.layers.Dense(64, activation="relu"), tf.keras.layers.Dense(EMBED)]
            )
            self.norm2 = tf.keras.layers.LayerNormalization()
        self.query = tf.keras.layers.Dense(
            EMBED, use_bias=False, kernel_initializer="zeros", name=f"{kind}_query"
        )
        self.family_head = tf.keras.layers.Dense(len(FAMILIES), name=f"{kind}_family")

    def encode_history(self, history):
        if self.kind == "gru":
            return self.history(history)
        length = tf.shape(history)[1]
        positions = self.position(tf.range(length))[None, :, :]
        value = history + positions
        attended = self.attention(value, value, use_causal_mask=True)
        value = self.norm1(value + attended)
        return self.norm2(value + self.feed(value))

    def call(self, embedding, base, targets, time_mask):
        actual = tf.gather(embedding, targets, axis=2, batch_dims=2)
        history = tf.concat([tf.zeros_like(actual[:, :1]), actual[:, :-1]], axis=1)
        latent = self.encode_history(history)
        observed = tf.cast(tf.range(tf.shape(history)[1]) > 0, tf.float32)[None, :, None]
        latent *= observed * time_mask[:, :, None]
        query = self.query(embedding)
        residual = tf.einsum("btce,bte->btc", query, latent) / math.sqrt(EMBED)
        logits = base + residual
        return logits, self.family_head(latent), latent


def history_loss(model, batch):
    embedding, base, candidate_mask, time_mask, targets, families = batch
    logits, family_logits, _ = model(embedding, base, targets, time_mask)
    logits += (1 - candidate_mask) * -1e9
    action = tf.nn.sparse_softmax_cross_entropy_with_logits(labels=targets, logits=logits)
    action = tf.reduce_sum(action * time_mask) / tf.reduce_sum(time_mask)
    family_targets = tf.tile(families[:, None], [1, tf.shape(targets)[1]])
    family = tf.nn.sparse_softmax_cross_entropy_with_logits(
        labels=family_targets, logits=family_logits
    )
    observed = tf.cast(tf.range(tf.shape(targets)[1]) > 0, tf.float32)[None, :] * time_mask
    family = tf.reduce_sum(family * observed) / tf.maximum(1.0, tf.reduce_sum(observed))
    return action + 0.15 * family


def history_validation_nll(model, sequences, corpus, batch_size):
    values = []
    for start in range(0, len(sequences), batch_size):
        batch = pad_encoded(sequences[start : start + batch_size], corpus)
        tensors = [tf.constant(value) for value in batch]
        logits, _, _ = model(tensors[0], tensors[1], tensors[4], tensors[3])
        loss = tf.nn.sparse_softmax_cross_entropy_with_logits(labels=tensors[4], logits=logits)
        values.extend(loss.numpy()[batch[3] > 0])
    return float(np.mean(values))


def train_history(model, train_sequences, validation_sequences, corpus, args, seed_offset):
    optimizer = tf.keras.optimizers.Adam(1e-3)

    @tf.function(reduce_retracing=True)
    def step(*batch):
        with tf.GradientTape() as tape:
            loss = history_loss(model, batch)
        gradients = tape.gradient(loss, model.trainable_variables)
        optimizer.apply_gradients(zip(gradients, model.trainable_variables))
        return loss

    rng = np.random.default_rng(args.seed + seed_offset)
    best, best_weights, best_epoch, waited, trace = math.inf, None, -1, 0, []
    for epoch in range(args.residual_epochs):
        order = rng.permutation(len(train_sequences))
        for start in range(0, len(order), args.sequence_batch):
            sequences = [train_sequences[index] for index in order[start : start + args.sequence_batch]]
            step(*[tf.constant(value) for value in pad_encoded(sequences, corpus)])
        value = history_validation_nll(model, validation_sequences, corpus, args.sequence_batch)
        trace.append(value)
        if value < best - 1e-4:
            best, best_epoch, waited = value, epoch, 0
            best_weights = [weight.numpy().copy() for weight in model.weights]
        else:
            waited += 1
            if waited >= args.patience:
                break
    for weight, value in zip(model.weights, best_weights):
        weight.assign(value)
    return {"bestEpoch": best_epoch, "epochsRun": len(trace), "validationNll": best}


def softmax(values, temperature=1.0):
    scaled = values / temperature
    scaled -= np.max(scaled)
    exp = np.exp(scaled)
    return exp / np.sum(exp)


def donor_indices(sequences):
    result = []
    for index, sequence in enumerate(sequences):
        for offset in range(1, len(sequences)):
            donor = (index + offset) % len(sequences)
            if sequences[donor].family != sequence.family:
                result.append(donor)
                break
    return result


def family_policy_logits(model, sequence, corpus):
    output = []
    for row in sequence.rows:
        offset, count = int(corpus.decisions[row, OFFSET]), int(corpus.decisions[row, COUNT])
        embedding = tf.constant(corpus.embeddings[offset : offset + count][None].astype(np.float32))
        base = tf.constant(corpus.base_logits[offset : offset + count][None])
        output.append(model(embedding, base).numpy()[0])
    return output


def tune_bayes(model, sequences, corpus):
    policies = [family_policy_logits(model, sequence, corpus) for sequence in sequences]
    best = None
    for temperature in (0.65, 0.8, 1.0, 1.25, 1.5):
        for learning_rate in (0.4, 0.7, 1.0):
            for drift in (0.0, 0.03, 0.08):
                result = evaluate_bayes(
                    sequences, corpus, policies, temperature, learning_rate, drift
                )
                value = float(np.mean(result["correct"]["nll"][result["correct"]["turn"] >= WARMUP]))
                candidate = (value, temperature, learning_rate, drift)
                if best is None or candidate < best:
                    best = candidate
    return {"nll": best[0], "temperature": best[1], "learningRate": best[2], "drift": best[3]}


def bayes_latents(policy_sequences, sequences, temperature, learning_rate, drift):
    latents = []
    for policies, sequence in zip(policy_sequences, sequences):
        posterior = np.ones(len(FAMILIES), np.float64) / len(FAMILIES)
        run = []
        for logits, row in zip(policies, sequence.rows):
            run.append(posterior.copy())
            actual = int(sequence_corpus.decisions[row, ACTUAL])
            likelihood = np.asarray(
                [softmax(logits[:, family], temperature)[actual] for family in range(len(FAMILIES))]
            )
            posterior *= np.maximum(likelihood, 1e-9) ** learning_rate
            posterior /= posterior.sum()
            posterior = (1 - drift) * posterior + drift / len(FAMILIES)
        latents.append(np.asarray(run))
    return latents


# Assigned temporarily by evaluate_bayes so the compact posterior helper can read targets.
sequence_corpus = None


def metric_record(probability, actual, sequence, turn):
    order = np.argsort(probability)[::-1]
    return (
        -math.log(max(float(probability[actual]), 1e-12)),
        int(actual in order[:5]),
        float(probability[order[0]]),
        int(order[0] == actual),
        sequence.game,
        sequence.family,
        turn,
    )


def records_dict(records):
    names = ("nll", "top5", "confidence", "correct", "game", "family", "turn")
    return {name: np.asarray([record[index] for record in records]) for index, name in enumerate(names)}


def evaluate_bayes(sequences, corpus, policies, temperature, learning_rate, drift):
    global sequence_corpus
    sequence_corpus = corpus
    latents = bayes_latents(policies, sequences, temperature, learning_rate, drift)
    donors = donor_indices(sequences)
    correct, shuffled, fixed = [], [], []
    family_predictions = []
    for index, (sequence, policy, posterior_run) in enumerate(zip(sequences, policies, latents)):
        donor = latents[donors[index]]
        for turn, (row, logits) in enumerate(zip(sequence.rows, policy)):
            actual = int(corpus.decisions[row, ACTUAL])
            per_family = np.stack(
                [softmax(logits[:, family], temperature) for family in range(len(FAMILIES))], axis=1
            )
            correct.append(metric_record(per_family @ posterior_run[turn], actual, sequence, turn))
            donor_posterior = donor[min(turn, len(donor) - 1)]
            shuffled.append(metric_record(per_family @ donor_posterior, actual, sequence, turn))
            fixed.append(metric_record(softmax(logits.mean(axis=1), temperature), actual, sequence, turn))
        if len(posterior_run) > 8:
            family_predictions.append(int(np.argmax(posterior_run[8])) == sequence.family)
    return {
        "correct": records_dict(correct),
        "shuffled": records_dict(shuffled),
        "fixedExpertMean": records_dict(fixed),
        "familyAccuracy8": float(np.mean(family_predictions)),
        "latents": latents,
    }


def history_components(model, sequences, corpus):
    components = []
    for sequence in sequences:
        batch = pad_encoded([sequence], corpus)
        embedding, base, _, time_mask, targets, _ = [tf.constant(value) for value in batch]
        logits, family_logits, latent = model(embedding, base, targets, time_mask)
        counts = [int(corpus.decisions[row, COUNT]) for row in sequence.rows]
        components.append(
            {
                "embedding": batch[0][0],
                "base": batch[1][0],
                "targets": batch[4][0],
                "counts": counts,
                "latent": latent.numpy()[0],
                "family": family_logits.numpy()[0],
                "logits": logits.numpy()[0],
            }
        )
    return components


def evaluate_history_components(sequences, corpus, model, components, temperature):
    donors = donor_indices(sequences)
    correct, shuffled = [], []
    family_predictions = []
    for index, (sequence, component) in enumerate(zip(sequences, components)):
        donor = components[donors[index]]["latent"]
        query = model.query(tf.constant(component["embedding"])).numpy()
        for turn, row in enumerate(sequence.rows):
            count = component["counts"][turn]
            actual = int(corpus.decisions[row, ACTUAL])
            correct_logits = component["logits"][turn, :count]
            donor_latent = donor[min(turn, len(donor) - 1)]
            shuffled_logits = component["base"][turn, :count] + (
                query[turn, :count] @ donor_latent / math.sqrt(EMBED)
            )
            correct.append(metric_record(softmax(correct_logits, temperature), actual, sequence, turn))
            shuffled.append(metric_record(softmax(shuffled_logits, temperature), actual, sequence, turn))
        if len(sequence.rows) > 8:
            family_predictions.append(int(np.argmax(component["family"][8])) == sequence.family)
    return {
        "correct": records_dict(correct),
        "shuffled": records_dict(shuffled),
        "familyAccuracy8": float(np.mean(family_predictions)),
    }


def tune_history(model, sequences, corpus):
    components = history_components(model, sequences, corpus)
    best = None
    for temperature in (0.65, 0.8, 1.0, 1.25, 1.5, 1.8):
        result = evaluate_history_components(sequences, corpus, model, components, temperature)
        warm = result["correct"]["turn"] >= WARMUP
        value = float(np.mean(result["correct"]["nll"][warm]))
        candidate = (value, temperature)
        if best is None or candidate < best:
            best = candidate
    return {"nll": best[0], "temperature": best[1], "components": components}


def tune_population(sequences, corpus):
    best = None
    for temperature in (0.65, 0.8, 1.0, 1.25, 1.5, 1.8):
        records = population_records(sequences, corpus, temperature)
        warm = records["turn"] >= WARMUP
        value = float(np.mean(records["nll"][warm]))
        candidate = (value, temperature)
        if best is None or candidate < best:
            best = candidate
    return {"nll": best[0], "temperature": best[1]}


def population_records(sequences, corpus, temperature):
    records = []
    for sequence in sequences:
        for turn, row in enumerate(sequence.rows):
            offset, count = int(corpus.decisions[row, OFFSET]), int(corpus.decisions[row, COUNT])
            probability = softmax(corpus.base_logits[offset : offset + count], temperature)
            actual = int(corpus.decisions[row, ACTUAL])
            records.append(metric_record(probability, actual, sequence, turn))
    return records_dict(records)


def summarize(records):
    warm = records["turn"] >= WARMUP
    confidence = records["confidence"][warm]
    correct = records["correct"][warm]
    bins = np.minimum(9, (confidence * 10).astype(int))
    ece = 0.0
    for bin_index in range(10):
        selected = bins == bin_index
        if np.any(selected):
            ece += np.mean(selected) * abs(np.mean(confidence[selected]) - np.mean(correct[selected]))
    return {
        "nll": float(np.mean(records["nll"][warm])),
        "top5": float(np.mean(records["top5"][warm])),
        "ece": float(ece),
        "actions": int(np.sum(warm)),
    }


def bootstrap_gain(left, right, games, iterations, seed):
    unique = np.unique(games)
    differences = left - right
    rng = np.random.default_rng(seed)
    values = np.zeros(iterations)
    for iteration in range(iterations):
        sampled = rng.choice(unique, len(unique), replace=True)
        indices = np.concatenate([np.flatnonzero(games == game) for game in sampled])
        values[iteration] = np.mean(differences[indices])
    return float(np.mean(differences)), float(np.quantile(values, 0.025)), float(np.quantile(values, 0.975))


def style_switch_accuracy(kind, model, sequences, corpus, policies=None, bayes_options=None):
    donors = donor_indices(sequences)
    predictions = []
    if kind == "bayes":
        temperature, learning_rate, drift = bayes_options
        for index, sequence in enumerate(sequences):
            second_index = donors[index]
            posterior = np.ones(len(FAMILIES)) / len(FAMILIES)
            for source_index in (index, second_index):
                source = sequences[source_index]
                source_policies = policies[source_index]
                for logits, row in list(zip(source_policies, source.rows))[:4]:
                    actual = int(corpus.decisions[row, ACTUAL])
                    likelihood = np.asarray(
                        [softmax(logits[:, family], temperature)[actual] for family in range(len(FAMILIES))]
                    )
                    posterior *= np.maximum(likelihood, 1e-9) ** learning_rate
                    posterior /= posterior.sum()
                    posterior = (1 - drift) * posterior + drift / len(FAMILIES)
            predictions.append(int(np.argmax(posterior)) == sequences[second_index].family)
        return float(np.mean(predictions))

    components = history_components(model, sequences, corpus)
    for index, component in enumerate(components):
        second_index = donors[index]
        chosen_first = component["embedding"][np.arange(4), component["targets"][:4]]
        second = components[second_index]
        chosen_second = second["embedding"][np.arange(4), second["targets"][:4]]
        observed = np.concatenate([chosen_first, chosen_second], axis=0)[None].astype(np.float32)
        history = np.concatenate([np.zeros((1, 1, EMBED), np.float32), observed], axis=1)
        latent = model.encode_history(tf.constant(history)).numpy()[0, -1]
        prediction = int(np.argmax(model.family_head(tf.constant(latent[None])).numpy()[0]))
        predictions.append(prediction == sequences[second_index].family)
    return float(np.mean(predictions))


def transformer_prefix_error(model, sequences, corpus):
    maximum = 0.0
    for sequence in sequences[:12]:
        component = history_components(model, [sequence], corpus)[0]
        chosen = component["embedding"][np.arange(len(sequence.rows)), component["targets"]]
        history = np.concatenate([np.zeros((1, EMBED), np.float32), chosen[:-1]], axis=0)[None]
        full = model.encode_history(tf.constant(history)).numpy()[0]
        for length in range(1, len(sequence.rows) + 1):
            prefix = model.encode_history(tf.constant(history[:, :length])).numpy()[0, -1]
            maximum = max(maximum, float(np.max(np.abs(prefix - full[length - 1]))))
    return maximum


def parameter_count(model):
    return int(sum(np.prod(weight.shape) for weight in model.weights))


def main():
    args = parse_args()
    tf.keras.utils.set_random_seed(args.seed)
    development_raw = load_raw(
        args.development, "v5-oracle-strategic-personality-trajectories-v4"
    )
    development_sequences = build_sequences(development_raw.meta, development_raw.decisions)
    train_sequences = [sequence for sequence in development_sequences if sequence.split in (0, 1)]
    validation_sequences = [sequence for sequence in development_sequences if sequence.split == 2]
    train_rows = np.concatenate([sequence.rows for sequence in train_sequences])
    validation_rows = np.concatenate([sequence.rows for sequence in validation_sequences])

    population = ContextPopulation()
    population_fit = train_population(
        population, train_rows, validation_rows, development_raw, args
    )
    print(f"population validation nll {population_fit['validationNll']:.4f}", flush=True)
    development = encode_corpus(population, development_raw)
    del development_raw

    fixed_tuning = tune_population(validation_sequences, development)
    family = FamilyResidual()
    family_fit = train_family_residual(
        family, train_sequences, validation_sequences, development, args
    )
    family_tuning = tune_bayes(family, validation_sequences, development)
    print(f"bayes validation nll {family_tuning['nll']:.4f}", flush=True)

    histories = {}
    history_fits = {}
    history_tuning = {}
    for offset, kind in enumerate(("gru", "transformer"), start=20):
        model = HistoryResidual(kind)
        history_fits[kind] = train_history(
            model, train_sequences, validation_sequences, development, args, offset
        )
        histories[kind] = model
        history_tuning[kind] = tune_history(model, validation_sequences, development)
        print(f"{kind} validation nll {history_tuning[kind]['nll']:.4f}", flush=True)

    validation_scores = {
        "bayes": family_tuning["nll"],
        "gru": history_tuning["gru"]["nll"],
        "transformer": history_tuning["transformer"]["nll"],
    }
    selected = min(validation_scores, key=validation_scores.get)

    if args.validation_only:
        print(f"selected {selected}; validation-only run complete; variant-d holdout was not opened")
        return
    print(f"selected {selected}; loading variant-d holdout", flush=True)

    # The once-read holdout is not opened until every architecture and hyperparameter is frozen.
    holdout_raw = load_raw(
        args.holdout, "v5-oracle-player-residual-holdout-trajectories-v5"
    )
    holdout = encode_corpus(population, holdout_raw)
    holdout_sequences = holdout.sequences
    del holdout_raw

    fixed_records = population_records(holdout_sequences, holdout, fixed_tuning["temperature"])
    fixed_summary = summarize(fixed_records)
    arm_results = {}

    policies = [family_policy_logits(family, sequence, holdout) for sequence in holdout_sequences]
    bayes_result = evaluate_bayes(
        holdout_sequences,
        holdout,
        policies,
        family_tuning["temperature"],
        family_tuning["learningRate"],
        family_tuning["drift"],
    )
    arm_results["bayes"] = bayes_result

    for kind, model in histories.items():
        components = history_components(model, holdout_sequences, holdout)
        arm_results[kind] = evaluate_history_components(
            holdout_sequences,
            holdout,
            model,
            components,
            history_tuning[kind]["temperature"],
        )

    candidate = arm_results[selected]
    warm = candidate["correct"]["turn"] >= WARMUP
    fixed_warm = fixed_records["turn"] >= WARMUP
    if not np.array_equal(candidate["correct"]["game"][warm], fixed_records["game"][fixed_warm]):
        raise RuntimeError("candidate and fixed records are not aligned")
    games = candidate["correct"]["game"][warm]
    fixed_gain = bootstrap_gain(
        fixed_records["nll"][fixed_warm],
        candidate["correct"]["nll"][warm],
        games,
        args.bootstrap,
        args.seed + 100,
    )
    shuffled_gain = bootstrap_gain(
        candidate["shuffled"]["nll"][warm],
        candidate["correct"]["nll"][warm],
        games,
        args.bootstrap,
        args.seed + 101,
    )
    candidate_summary = summarize(candidate["correct"])
    shuffled_summary = summarize(candidate["shuffled"])

    per_family = {}
    for family_index, family_name in enumerate(FAMILIES):
        selected_family = warm & (candidate["correct"]["family"] == family_index)
        per_family[family_name] = float(
            np.mean(
                candidate["shuffled"]["nll"][selected_family]
                - candidate["correct"]["nll"][selected_family]
            )
        )
    interaction_values = [per_family[FAMILIES[index]] for index in INTERACTION_FAMILIES]

    if selected == "bayes":
        switch = style_switch_accuracy(
            "bayes",
            family,
            holdout_sequences,
            holdout,
            policies,
            (
                family_tuning["temperature"],
                family_tuning["learningRate"],
                family_tuning["drift"],
            ),
        )
    else:
        switch = style_switch_accuracy(
            selected, histories[selected], holdout_sequences, holdout
        )
    prefix_error = (
        transformer_prefix_error(histories["transformer"], holdout_sequences, holdout)
        if selected == "transformer"
        else None
    )
    fallback_error = 0.0  # Explicit fixed path bypasses every residual operation.

    gates = {
        "fixedGain": {
            "value": fixed_gain[0],
            "interval": list(fixed_gain[1:]),
            "threshold": 0.03,
            "pass": fixed_gain[1] > 0.03,
        },
        "identityGain": {
            "value": shuffled_gain[0],
            "interval": list(shuffled_gain[1:]),
            "threshold": 0.06,
            "pass": shuffled_gain[1] > 0.06,
        },
        "topFive": {
            "value": candidate_summary["top5"],
            "threshold": 0.65,
            "pass": candidate_summary["top5"] > 0.65,
        },
        "calibration": {
            "value": candidate_summary["ece"],
            "fixedValue": fixed_summary["ece"],
            "threshold": 0.08,
            "pass": candidate_summary["ece"] <= 0.08
            and candidate_summary["ece"] <= fixed_summary["ece"] + 0.01,
        },
        "familyAccuracy8": {
            "value": candidate["familyAccuracy8"],
            "threshold": 0.50,
            "pass": candidate["familyAccuracy8"] > 0.50,
        },
        "interactionFamilies": {
            "value": float(np.mean(interaction_values)),
            "minimum": float(np.min(interaction_values)),
            "perFamily": {name: per_family[name] for name in ("blocker", "retaliator", "persistent", "next-hunter")},
            "thresholdMean": 0.04,
            "thresholdMinimum": -0.01,
            "pass": float(np.mean(interaction_values)) > 0.04
            and float(np.min(interaction_values)) >= -0.01,
        },
        "styleSwitch": {
            "value": switch,
            "threshold": 0.50,
            "pass": switch > 0.50,
        },
        "emptyHistoryFallback": {
            "value": fallback_error,
            "threshold": 1e-6,
            "pass": fallback_error <= 1e-6,
        },
        "transformerPrefix": {
            "value": prefix_error,
            "threshold": 1e-5,
            "applicable": selected == "transformer",
            "pass": selected != "transformer" or prefix_error <= 1e-5,
        },
    }
    passed = all(gate["pass"] for gate in gates.values())

    output = {
        "experiment": "v5-oracle-player-residual-k",
        "preregistration": "research_paper/v5_oracle_player_residual.md",
        "dataset": {
            "developmentGames": int(development.meta["finishedGames"]),
            "developmentProfiles": len(development.meta["profiles"]),
            "holdoutGames": int(holdout.meta["finishedGames"]),
            "holdoutProfiles": len(holdout.meta["profiles"]),
            "holdoutDecisions": int(holdout.meta["decisions"]),
            "holdoutCandidates": int(holdout.meta["candidates"]),
            "holdoutSeedBase": int(holdout.meta["seedBase"]),
        },
        "population": {
            "fit": population_fit,
            "parameters": parameter_count(population),
            "selectedTemperature": fixed_tuning["temperature"],
            "holdout": fixed_summary,
        },
        "validationSelection": {
            "scores": validation_scores,
            "selected": selected,
            "familyBayesFilter": family_tuning,
            "historyTemperature": {
                kind: tuning["temperature"] for kind, tuning in history_tuning.items()
            },
        },
        "arms": {
            "bayes": {
                "fit": family_fit,
                "parameters": parameter_count(family),
                "holdout": {
                    "correct": summarize(arm_results["bayes"]["correct"]),
                    "shuffled": summarize(arm_results["bayes"]["shuffled"]),
                    "familyAccuracy8": arm_results["bayes"]["familyAccuracy8"],
                },
            },
            **{
                kind: {
                    "fit": history_fits[kind],
                    "parameters": parameter_count(model),
                    "holdout": {
                        "correct": summarize(arm_results[kind]["correct"]),
                        "shuffled": summarize(arm_results[kind]["shuffled"]),
                        "familyAccuracy8": arm_results[kind]["familyAccuracy8"],
                    },
                }
                for kind, model in histories.items()
            },
        },
        "selectedArm": {
            "name": selected,
            "correct": candidate_summary,
            "fixed": fixed_summary,
            "shuffled": shuffled_summary,
            "perFamilyIdentityGain": per_family,
            "styleSwitchAccuracy": switch,
            "transformerPrefixError": prefix_error,
        },
        "gates": gates,
        "counterfactualResponseExperimentAuthorized": passed,
        "oracleSearchIntegrationAuthorized": False,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
    checkpoint = {}
    for name, model in [("population", population), ("family", family), *histories.items()]:
        for index, weight in enumerate(model.weights):
            checkpoint[f"{name}_{index}"] = weight.numpy()
    np.savez(args.checkpoint, **checkpoint)
    print(f"holdout selected {selected}: {json.dumps(candidate_summary)}")
    for name, gate in gates.items():
        print(f"{'PASS' if gate['pass'] else 'FAIL'} {name}: {json.dumps(gate)}")
    print(f"counterfactual response authorized: {passed}")
    print(f"wrote {args.out} and {args.checkpoint}")


if __name__ == "__main__":
    main()
