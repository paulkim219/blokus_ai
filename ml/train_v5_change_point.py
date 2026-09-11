#!/usr/bin/env python3
"""Experiment L — preregistered change-point adaptation, development cycle.

Protocol: research_paper/v5_oracle_change_point_preregistered.md

Can a prediction-only model replace a confidently obsolete identity within four observed moves,
without giving back Experiment K's stable-player action-likelihood gain?

This script implements the frozen arms, the development-only selection rule, and the eight
variant-`e` gates. It reads only development variants a/b/c. It cannot open variant `e`: the
holdout corpora are refused by `forbid_holdout` unless `--stage holdout` is passed explicitly,
which the development cycle never does.

Everything is prediction-only. No output here may change a played move.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import dataclass, field

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

from train_v5_player_residual import (
    ACTUAL,
    COUNT,
    EMBED,
    FAMILIES,
    GAME,
    INTERACTION_FAMILIES,
    OFFSET,
    PROFILE,
    SEAT,
    SPLIT,
    TURN,
    WARMUP,
    ContextPopulation,
    HistoryResidual,
    load_raw,
    pad_raw,
)

SWITCH_AT = 6
GATE_WINDOW = 8
TEMPERATURES = (0.65, 0.8, 1.0, 1.25, 1.5, 1.8)
TRAINING_SEEDS = (5901, 5902, 5903)
BOOTSTRAP_SEED = 5_900_001
BOOTSTRAP_REPLICATES = 20_000
OFFSETS = (0, 1, 2, 3, 4)
RECOVERY_AT = 4


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", default="ml/data/v5-oracle-personalities")
    parser.add_argument("--switch", default="ml/data/v5-oracle-l-dev-switch")
    parser.add_argument("--checkpoint", default="ml/v5-oracle-player-residual.npz")
    parser.add_argument("--out", default="selfplay-results/v5-oracle-change-point-development.json")
    parser.add_argument("--checkpoint-out", default="ml/v5-oracle-change-point.npz")
    parser.add_argument("--stage", default="development", choices=("smoke", "development"))
    parser.add_argument("--epochs", type=int, default=70)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--sequence-batch", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--family-weight", type=float, default=0.15)
    parser.add_argument("--bootstrap", type=int, default=BOOTSTRAP_REPLICATES)
    parser.add_argument("--seeds", default=",".join(str(seed) for seed in TRAINING_SEEDS))
    # Pipeline rehearsal only: the protocol run uses the full grid and the default epoch budget.
    parser.add_argument("--limit-configs", type=int, default=0)
    parser.add_argument("--limit-trajectories", type=int, default=0)
    # Rehearsal only: exercises selection, retraining, confirmation and gates without waiting for a
    # genuinely eligible configuration. Never used for the preregistered run.
    parser.add_argument("--force-select", action="store_true")
    return parser.parse_args()


def forbid_holdout(*paths):
    """Variant `e` is sealed until the development cycle has passed. Make that mechanical."""
    for path in paths:
        if "holdout" in path or "-e" in os.path.basename(path):
            raise SystemExit(f"refusing to open a sealed holdout corpus in development: {path}")


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def corpus_digest(prefix):
    return file_digest(f"{prefix}.decisions.i32")[:16]


@dataclass
class Trajectory:
    """One seat's whole continuous game: time-varying families and a single change point."""

    game: int
    seat: int
    split: int
    rows: np.ndarray
    families: np.ndarray
    switch: int | None
    switching: bool
    corpus: str = ""

    def __len__(self):
        return len(self.rows)


@dataclass
class Encoded:
    meta: dict
    decisions: np.ndarray
    embeddings: np.ndarray
    base_logits: np.ndarray
    trajectories: list = field(default_factory=list)
    name: str = ""


def source_families(meta):
    index = {family: position for position, family in enumerate(FAMILIES)}
    if "profileSources" in meta:
        return {
            int(entry["index"]): index.get(entry["family"]) for entry in meta["profileSources"]
        }
    return {position: index[profile["family"]] for position, profile in enumerate(meta["profiles"])}


def build_trajectories(meta, decisions, name):
    """Group by (game, seat) so a switching seat stays one continuous trajectory."""
    lookup = source_families(meta)
    groups = {}
    for row, decision in enumerate(decisions):
        groups.setdefault((int(decision[GAME]), int(decision[SEAT])), []).append(row)
    trajectories = []
    for (game, seat), rows in sorted(groups.items()):
        ordered = np.asarray(sorted(rows, key=lambda row: int(decisions[row, TURN])), np.int64)
        families = np.asarray([lookup[int(decisions[row, PROFILE])] for row in ordered], np.int32)
        changes = np.flatnonzero(families[1:] != families[:-1]) + 1
        switch = int(changes[0]) if len(changes) else None
        trajectories.append(
            Trajectory(
                game=game,
                seat=seat,
                split=int(decisions[ordered[0], SPLIT]),
                rows=ordered,
                families=families,
                switch=switch,
                switching=switch is not None,
                corpus=name,
            )
        )
    return trajectories


def encode(population, prefix, architecture, name):
    raw = load_raw(prefix, architecture)
    embeddings = np.empty((len(raw.candidates), EMBED), np.float16)
    base_logits = np.empty(len(raw.candidates), np.float32)
    rows = np.arange(len(raw.decisions), dtype=np.int64)
    for start in range(0, len(rows), 48):
        block = rows[start : start + 48]
        candidate, mask, states, boards, _ = pad_raw(block, raw)
        encoded, logits = population(
            tf.constant(candidate), tf.constant(mask), tf.constant(states), tf.constant(boards)
        )
        encoded, logits = encoded.numpy(), logits.numpy()
        for local, row in enumerate(block):
            offset, count = int(raw.decisions[row, OFFSET]), int(raw.decisions[row, COUNT])
            embeddings[offset : offset + count] = encoded[local, :count].astype(np.float16)
            base_logits[offset : offset + count] = logits[local, :count]
    return Encoded(
        meta=raw.meta,
        decisions=raw.decisions,
        embeddings=embeddings,
        base_logits=base_logits,
        trajectories=build_trajectories(raw.meta, raw.decisions, name),
        name=name,
    )


def pad_batch(trajectories, corpora):
    """Dense tensors for a mixed stable/switching batch, with per-decision family labels."""
    batch = len(trajectories)
    time = max(len(item) for item in trajectories)
    width = max(
        int(corpora[item.corpus].decisions[row, COUNT]) for item in trajectories for row in item.rows
    )
    embedding = np.zeros((batch, time, width, EMBED), np.float32)
    base = np.full((batch, time, width), -1e9, np.float32)
    candidate_mask = np.zeros((batch, time, width), np.float32)
    time_mask = np.zeros((batch, time), np.float32)
    targets = np.zeros((batch, time), np.int32)
    families = np.zeros((batch, time), np.int32)
    switch_flag = np.zeros((batch, time), np.float32)
    surprise = np.zeros((batch, time), np.float32)
    for b, item in enumerate(trajectories):
        corpus = corpora[item.corpus]
        for t, row in enumerate(item.rows):
            offset = int(corpus.decisions[row, OFFSET])
            count = int(corpus.decisions[row, COUNT])
            embedding[b, t, :count] = corpus.embeddings[offset : offset + count]
            base[b, t, :count] = corpus.base_logits[offset : offset + count]
            candidate_mask[b, t, :count] = 1
            time_mask[b, t] = 1
            targets[b, t] = int(corpus.decisions[row, ACTUAL])
            families[b, t] = item.families[t]
            # The gate's development-only target: one for the first eight observations after a
            # real switch, zero on stable and pre-switch history.
            if item.switch is not None and item.switch <= t < item.switch + GATE_WINDOW:
                switch_flag[b, t] = 1
        # The gate may read how surprising the *previous* observed action was under the fixed
        # model. Shifted by one so nothing at turn t depends on the action played at turn t.
        fixed = np.array(
            [fixed_nll(base[b, t, : int(candidate_mask[b, t].sum())], int(targets[b, t]))
             for t in range(len(item))],
            np.float32,
        )
        surprise[b, 1 : len(item)] = fixed[: len(item) - 1]
    return embedding, base, candidate_mask, time_mask, targets, families, switch_flag, surprise


def fixed_nll(logits, target):
    shifted = logits - logits.max()
    probabilities = np.exp(shifted)
    probabilities /= probabilities.sum()
    return float(-np.log(max(probabilities[target], 1e-12)))


def chosen_actions(embedding, targets):
    """The embedding of the action actually played at each turn."""
    return tf.gather(embedding, targets, axis=2, batch_dims=2)


def causal_history(actual):
    """Shift by one: the prediction at turn t may only see turns strictly before t."""
    return tf.concat([tf.zeros_like(actual[:, :1]), actual[:, :-1]], axis=1)


def window_stack(history, window):
    """Right-aligned windows of the last `window` observed actions, one per decision.

    Position t receives history[t-window:t] left-padded, so the fast path is re-encoded from a
    bounded suffix instead of the whole prefix.
    """
    batch = tf.shape(history)[0]
    time = tf.shape(history)[1]
    padded = tf.concat([tf.zeros((batch, window, EMBED), history.dtype), history], axis=1)
    indices = tf.range(time)[:, None] + tf.range(1, window + 1)[None, :]
    gathered = tf.gather(padded, indices, axis=1)
    # `history` is already causally shifted, so history[0] is the zero token rather than an
    # observation. A window step is real only when it lands on index >= 1.
    positions = tf.range(time)[:, None] + (tf.range(1, window + 1)[None, :] - window)
    valid = tf.cast(positions >= 1, tf.float32)[None, :, :]
    return gathered, tf.tile(valid, [batch, 1, 1])


def masked_action_loss(logits, targets, time_mask):
    loss = tf.nn.sparse_softmax_cross_entropy_with_logits(labels=targets, logits=logits)
    return tf.reduce_sum(loss * time_mask) / tf.maximum(1.0, tf.reduce_sum(time_mask))


def observed_mask(time_mask):
    """Turn 0 has no prior observation, so identity losses start at turn 1."""
    time = tf.shape(time_mask)[1]
    return tf.cast(tf.range(time) > 0, tf.float32)[None, :] * time_mask


class SwitchTrainedGru(tf.keras.Model):
    """Eligible arm B — K's architecture, initialized from K, trained on stable+switching data."""

    name_prefix = "arm-b"

    def __init__(self, l2):
        super().__init__()
        self.inner = HistoryResidual("gru")
        self.l2 = l2

    def build_from(self, checkpoint):
        materialize(self.inner)
        restore(checkpoint, "gru", self.inner)

    def call(self, embedding, base, targets, time_mask, surprise=None):
        actual = chosen_actions(embedding, targets)
        history = causal_history(actual)
        latent = self.inner.encode_history(history) * observed_mask(time_mask)[:, :, None]
        query = self.inner.query(embedding)
        residual = tf.einsum("btce,bte->btc", query, latent) / np.sqrt(EMBED)
        return {
            "logits": base + residual,
            "family": self.inner.family_head(latent),
            "gate": tf.zeros_like(time_mask),
            "latent": latent,
        }

    def penalty(self):
        return self.l2 * tf.reduce_sum(tf.square(self.inner.query.kernel))


class FastOnlyWindow(tf.keras.Model):
    """Control 3 — the fast path alone, to price discarding the slow state. Not eligible."""

    name_prefix = "fast-only"

    def __init__(self, window=8):
        super().__init__()
        self.window = window
        self.history = tf.keras.layers.GRU(EMBED, return_sequences=True)
        self.query = tf.keras.layers.Dense(EMBED, use_bias=False, kernel_initializer="zeros")
        self.family_head = tf.keras.layers.Dense(len(FAMILIES))

    def call(self, embedding, base, targets, time_mask, surprise=None):
        actual = chosen_actions(embedding, targets)
        history = causal_history(actual)
        windows, valid = window_stack(history, self.window)
        shape = tf.shape(windows)
        flat = tf.reshape(windows, [shape[0] * shape[1], self.window, EMBED])
        flat_valid = tf.reshape(valid, [shape[0] * shape[1], self.window])
        encoded = self.history(flat, mask=flat_valid > 0.5)[:, -1]
        latent = tf.reshape(encoded, [shape[0], shape[1], EMBED]) * observed_mask(time_mask)[:, :, None]
        query = self.query(embedding)
        residual = tf.einsum("btce,bte->btc", query, latent) / np.sqrt(EMBED)
        return {
            "logits": base + residual,
            "family": self.family_head(latent),
            "gate": tf.zeros_like(time_mask),
            "latent": latent,
        }

    def penalty(self):
        return tf.constant(0.0)


class FastSlowGated(tf.keras.Model):
    """Eligible arm C — frozen long memory for likelihood, replaceable short memory for identity."""

    name_prefix = "arm-c"

    def __init__(self, window, gate_weight):
        super().__init__()
        self.window = window
        self.gate_weight = gate_weight
        self.slow = HistoryResidual("gru")
        self.fast = tf.keras.layers.GRU(EMBED, return_sequences=True)
        self.fast_family = tf.keras.layers.Dense(len(FAMILIES))
        self.gate = tf.keras.Sequential(
            [tf.keras.layers.Dense(16, activation="relu"), tf.keras.layers.Dense(1)]
        )

    def build_from(self, checkpoint):
        # Build the slow sub-model through its own call first: that fixes K's weight ordering, so
        # the checkpoint assigns into the layers it was saved from.
        materialize(self.slow)
        restore(checkpoint, "gru", self.slow)
        # The slow path and its action query carry K's stable-player gain and never move again.
        self.slow.trainable = False
        materialize(self)

    def call(self, embedding, base, targets, time_mask, surprise=None):
        actual = chosen_actions(embedding, targets)
        history = causal_history(actual)
        observed = observed_mask(time_mask)[:, :, None]
        slow_latent = self.slow.encode_history(history) * observed

        windows, valid = window_stack(history, self.window)
        shape = tf.shape(windows)
        flat = tf.reshape(windows, [shape[0] * shape[1], self.window, EMBED])
        flat_valid = tf.reshape(valid, [shape[0] * shape[1], self.window])
        encoded = self.fast(flat, mask=flat_valid > 0.5)[:, -1]
        fast_latent = tf.reshape(encoded, [shape[0], shape[1], EMBED]) * observed

        slow_family = self.slow.family_head(slow_latent)
        fast_family = self.fast_family(fast_latent)
        disagreement = 0.5 * tf.reduce_sum(
            tf.abs(tf.nn.softmax(slow_family, axis=-1) - tf.nn.softmax(fast_family, axis=-1)),
            axis=-1,
            keepdims=True,
        )
        if surprise is None:
            surprise = tf.zeros_like(time_mask)
        gate_input = tf.concat(
            [
                slow_latent,
                fast_latent,
                tf.abs(slow_latent - fast_latent),
                disagreement,
                surprise[:, :, None],
            ],
            axis=-1,
        )
        gate = tf.nn.sigmoid(tf.squeeze(self.gate(gate_input), axis=-1)) * observed_mask(time_mask)
        blended = (1 - gate)[:, :, None] * slow_latent + gate[:, :, None] * fast_latent
        # The frozen K query keeps the residual in K's action space, so gate 0 reproduces K exactly.
        query = self.slow.query(embedding)
        residual = tf.einsum("btce,bte->btc", query, blended) / np.sqrt(EMBED)
        family = (1 - gate)[:, :, None] * slow_family + gate[:, :, None] * fast_family
        return {
            "logits": base + residual,
            "family": family,
            "gate": gate,
            "latent": blended,
        }

    def penalty(self):
        return tf.constant(0.0)


def materialize(model):
    """Create weights with one throwaway call so a checkpoint can be assigned into them."""
    model(
        tf.zeros((1, 2, 3, EMBED)),
        tf.zeros((1, 2, 3)),
        tf.zeros((1, 2), tf.int32),
        tf.ones((1, 2)),
    )


def restore(checkpoint, name, model):
    for index, weight in enumerate(model.weights):
        weight.assign(checkpoint[f"{name}_{index}"])


def balanced_batches(stable, switching, rng, size):
    """Equal numbers of stable and switching seat-trajectories in every batch."""
    half = max(1, size // 2)
    stable_order = rng.permutation(len(stable))
    switch_order = rng.permutation(len(switching))
    count = min(len(stable_order), len(switch_order)) // half
    for index in range(count):
        picks = stable_order[index * half : (index + 1) * half]
        yield [stable[i] for i in picks] + [
            switching[i] for i in switch_order[index * half : (index + 1) * half]
        ]


def build_model(spec, checkpoint):
    if spec["arm"] == "arm-b":
        model = SwitchTrainedGru(spec["l2"])
    elif spec["arm"] == "arm-c":
        model = FastSlowGated(spec["window"], spec["gateWeight"])
    else:
        model = FastOnlyWindow(spec.get("window", 8))
    if hasattr(model, "build_from"):
        model.build_from(checkpoint)
    else:
        materialize(model)
    return model


def forward(model, batch):
    embedding, base, candidate_mask, time_mask, targets, families, switch_flag, surprise = batch
    out = model(
        tf.constant(embedding),
        tf.constant(base),
        tf.constant(targets),
        tf.constant(time_mask),
        tf.constant(surprise),
    )
    out["logits"] += (1 - tf.constant(candidate_mask)) * -1e9
    return out


def batch_loss(model, batch, family_weight):
    embedding, base, candidate_mask, time_mask, targets, families, switch_flag, surprise = batch
    out = forward(model, batch)
    time_mask_t = tf.constant(time_mask)
    action = masked_action_loss(out["logits"], tf.constant(targets), time_mask_t)
    observed = observed_mask(time_mask_t)
    family = tf.nn.sparse_softmax_cross_entropy_with_logits(
        labels=tf.constant(families), logits=out["family"]
    )
    family = tf.reduce_sum(family * observed) / tf.maximum(1.0, tf.reduce_sum(observed))
    total = action + family_weight * family + model.penalty()
    if isinstance(model, FastSlowGated):
        gate_loss = tf.keras.losses.binary_crossentropy(
            tf.constant(switch_flag)[:, :, None], out["gate"][:, :, None], from_logits=False
        )
        gate_loss = tf.reduce_sum(gate_loss * observed) / tf.maximum(1.0, tf.reduce_sum(observed))
        total += model.gate_weight * gate_loss
    return total, action


def validation_action_nll(model, trajectories, corpora, family_weight, size=8):
    values = []
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        out = forward(model, batch)
        time_mask = batch[3]
        loss = tf.nn.sparse_softmax_cross_entropy_with_logits(
            labels=tf.constant(batch[4]), logits=out["logits"]
        ).numpy()
        values.extend(loss[time_mask > 0])
    return float(np.mean(values))


def train_arm(spec, checkpoint, train_sets, validation, corpora, args, seed):
    """Deterministic given the seed: weights, batching order and dropout are all seeded here."""
    tf.keras.utils.set_random_seed(seed)
    model = build_model(spec, checkpoint)
    optimizer = tf.keras.optimizers.Adam(args.learning_rate)
    rng = np.random.default_rng(seed)
    stable, switching = train_sets
    best = (np.inf, None, -1)
    waited = 0
    trace = []
    for epoch in range(args.epochs):
        for chunk in balanced_batches(stable, switching, rng, args.sequence_batch):
            batch = pad_batch(chunk, corpora)
            with tf.GradientTape() as tape:
                total, _ = batch_loss(model, batch, args.family_weight)
            variables = model.trainable_variables
            optimizer.apply_gradients(zip(tape.gradient(total, variables), variables))
        value = validation_action_nll(model, validation, corpora, args.family_weight)
        trace.append(round(value, 5))
        if value < best[0] - 1e-5:
            best = (value, [w.numpy().copy() for w in model.weights], epoch)
            waited = 0
        else:
            waited += 1
            if waited >= args.patience:
                break
    for weight, value in zip(model.weights, best[1]):
        weight.assign(value)
    return model, {"bestEpoch": best[2], "epochsRun": len(trace), "validationTrace": trace}


def donor_map(trajectories):
    """Each trajectory is paired with one whose starting family differs, for the shuffled control."""
    donors = {}
    for index, item in enumerate(trajectories):
        for offset in range(1, len(trajectories)):
            candidate = (index + offset) % len(trajectories)
            if trajectories[candidate].families[0] != item.families[0]:
                donors[index] = candidate
                break
        donors.setdefault(index, (index + 1) % len(trajectories))
    return donors


def ensemble_outputs(models, trajectories, corpora, size=8):
    """Per-trajectory logits, family logits and latents, averaged over the seed ensemble."""
    results = []
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        stacked_logits, stacked_family, stacked_latent, stacked_gate = [], [], [], []
        for model in models:
            out = forward(model, batch)
            stacked_logits.append(out["logits"].numpy())
            stacked_family.append(out["family"].numpy())
            stacked_latent.append(out["latent"].numpy())
            stacked_gate.append(out["gate"].numpy())
        # Pre-softmax averaging: no lucky seed is selected, per the protocol.
        logits = np.mean(stacked_logits, axis=0)
        family = np.mean(stacked_family, axis=0)
        latent = np.mean(stacked_latent, axis=0)
        gate = np.mean(stacked_gate, axis=0)
        for b, item in enumerate(chunk):
            length = len(item)
            results.append(
                {
                    "trajectory": item,
                    "logits": logits[b, :length],
                    "family": family[b, :length],
                    "latent": latent[b, :length],
                    "gate": gate[b, :length],
                    "base": batch[1][b, :length],
                    "mask": batch[2][b, :length],
                    "targets": batch[4][b, :length],
                }
            )
    return results


def softmax_rows(logits, mask, temperature):
    scaled = np.where(mask > 0.5, logits / temperature, -1e9)
    scaled = scaled - scaled.max(axis=-1, keepdims=True)
    probabilities = np.exp(scaled)
    return probabilities / probabilities.sum(axis=-1, keepdims=True)


def stable_records(outputs, temperature):
    """Per-decision stable-block metrics from own turn index 3 onward."""
    nll, top1, top5, confidence, game, family_hit4 = [], [], [], [], [], []
    family_game = []
    for entry in outputs:
        item = entry["trajectory"]
        probabilities = softmax_rows(entry["logits"], entry["mask"], temperature)
        fixed = softmax_rows(entry["base"], entry["mask"], temperature)
        for t in range(len(item)):
            if t < WARMUP:
                continue
            actual = int(entry["targets"][t])
            nll.append(-np.log(max(probabilities[t, actual], 1e-12)))
            order = np.argsort(-probabilities[t])
            top1.append(float(order[0] == actual))
            top5.append(float(actual in order[:5]))
            confidence.append(float(probabilities[t].max()))
            game.append(item.game)
        if len(item) > RECOVERY_AT:
            family_hit4.append(
                float(int(np.argmax(entry["family"][RECOVERY_AT])) == int(item.families[RECOVERY_AT]))
            )
            family_game.append(item.game)
    return {
        "nll": np.asarray(nll),
        "top1": np.asarray(top1),
        "top5": np.asarray(top5),
        "confidence": np.asarray(confidence),
        "game": np.asarray(game),
        "familyAt4": np.asarray(family_hit4),
        "familyGame": np.asarray(family_game),
    }


def fixed_stable_records(outputs, temperature):
    nll, game = [], []
    for entry in outputs:
        item = entry["trajectory"]
        fixed = softmax_rows(entry["base"], entry["mask"], temperature)
        for t in range(len(item)):
            if t < WARMUP:
                continue
            nll.append(-np.log(max(fixed[t, int(entry["targets"][t])], 1e-12)))
            game.append(item.game)
    return {"nll": np.asarray(nll), "game": np.asarray(game)}


def switch_records(outputs, temperature, counts):
    """Family identification and action safety, indexed by observations since the switch."""
    family = {count: {"hit": [], "old": [], "game": []} for count in counts}
    action = {offset: {"model": [], "fixed": [], "game": []} for offset in OFFSETS}
    for entry in outputs:
        item = entry["trajectory"]
        if item.switch is None:
            continue
        switch = item.switch
        new_family = int(item.families[switch])
        old_family = int(item.families[switch - 1])
        for count in counts:
            index = switch + count
            if index >= len(item):
                continue
            prediction = int(np.argmax(entry["family"][index]))
            family[count]["hit"].append(float(prediction == new_family))
            family[count]["old"].append(float(prediction == old_family))
            family[count]["game"].append(item.game)
        probabilities = softmax_rows(entry["logits"], entry["mask"], temperature)
        fixed = softmax_rows(entry["base"], entry["mask"], temperature)
        for offset in OFFSETS:
            index = switch + offset
            if index >= len(item):
                continue
            actual = int(entry["targets"][index])
            action[offset]["model"].append(-np.log(max(probabilities[index, actual], 1e-12)))
            action[offset]["fixed"].append(-np.log(max(fixed[index, actual], 1e-12)))
            action[offset]["game"].append(item.game)
    for table in (family, action):
        for key in table:
            for name in table[key]:
                table[key][name] = np.asarray(table[key][name])
    return {"family": family, "action": action}


def bootstrap(values, games, replicates, seed, paired=None):
    """Whole-game percentile bootstrap. Seat decisions from one game are never split.

    Resampling is done on per-game sums and counts rather than on rows, which is identical
    arithmetic and fast enough to run at the protocol's 20,000 replicates everywhere.
    """
    if len(values) == 0:
        return None, None, None
    unique, inverse = np.unique(games, return_inverse=True)
    sums = np.bincount(inverse, weights=values, minlength=len(unique))
    counts = np.bincount(inverse, minlength=len(unique)).astype(np.float64)
    rng = np.random.default_rng(seed)
    picks = rng.integers(0, len(unique), size=(replicates, len(unique)))
    drawn_sums = sums[picks].sum(axis=1)
    drawn_counts = counts[picks].sum(axis=1)
    samples = drawn_sums / np.maximum(drawn_counts, 1e-9)
    point = float(values.mean())
    if paired is not None:
        other_values, other_games = paired
        # The same resampled games must drive both sides, or the pairing is lost.
        other_inverse = np.searchsorted(unique, other_games)
        other_sums = np.bincount(other_inverse, weights=other_values, minlength=len(unique))
        other_counts = np.bincount(other_inverse, minlength=len(unique)).astype(np.float64)
        other = other_sums[picks].sum(axis=1) / np.maximum(other_counts[picks].sum(axis=1), 1e-9)
        samples = samples - other
        point = point - float(other_values.mean())
    return (
        point,
        float(np.percentile(samples, 2.5)),
        float(np.percentile(samples, 97.5)),
    )


def expected_calibration_error(confidence, correct, bins=10):
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = len(confidence)
    error = 0.0
    for lower, upper in zip(edges[:-1], edges[1:]):
        inside = (confidence > lower) & (confidence <= upper) if lower > 0 else (confidence <= upper)
        if not inside.any():
            continue
        error += inside.sum() / total * abs(correct[inside].mean() - confidence[inside].mean())
    return float(error)


def residual_from_latent(model, embedding, latent):
    """Apply this model's frozen action query to an externally supplied identity state."""
    if isinstance(model, FastSlowGated):
        query = model.slow.query(embedding)
    elif isinstance(model, SwitchTrainedGru):
        query = model.inner.query(embedding)
    else:
        query = model.query(embedding)
    return tf.einsum("btce,bte->btc", query, latent) / np.sqrt(EMBED)


def per_model_latents(models, trajectories, corpora, size=8):
    """Latents kept per model, because each model's query lives in its own space."""
    latents = [[None] * len(trajectories) for _ in models]
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        for m, model in enumerate(models):
            out = forward(model, batch)
            values = out["latent"].numpy()
            for b, item in enumerate(chunk):
                latents[m][start + b] = values[b, : len(item)]
    return latents


def shuffled_ensemble_logits(models, trajectories, corpora, donors, size=8):
    """Correct-position, donor-identity logits: the shuffled control from Experiment K."""
    latents = per_model_latents(models, trajectories, corpora, size)
    results = [None] * len(trajectories)
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        embedding = tf.constant(batch[0])
        base = batch[1]
        stacked = []
        for m, model in enumerate(models):
            donor_latent = np.zeros((len(chunk), embedding.shape[1], EMBED), np.float32)
            for b, item in enumerate(chunk):
                donor = latents[m][donors[start + b]]
                for t in range(len(item)):
                    donor_latent[b, t] = donor[min(t, len(donor) - 1)]
            residual = residual_from_latent(model, embedding, tf.constant(donor_latent)).numpy()
            stacked.append(base + residual)
        averaged = np.mean(stacked, axis=0)
        for b, item in enumerate(chunk):
            results[start + b] = averaged[b, : len(item)]
    return results


def interaction_gain(models, outputs, trajectories, corpora, temperature, replicates, seed):
    """K's interaction gate: correct minus shuffled identity on the four interaction families."""
    donors = donor_map(trajectories)
    shuffled = shuffled_ensemble_logits(models, trajectories, corpora, donors)
    per_family = {FAMILIES[index]: {"values": [], "game": []} for index in INTERACTION_FAMILIES}
    for index, entry in enumerate(outputs):
        item = entry["trajectory"]
        name = FAMILIES[int(item.families[0])]
        if name not in per_family:
            continue
        correct_p = softmax_rows(entry["logits"], entry["mask"], temperature)
        shuffled_p = softmax_rows(shuffled[index], entry["mask"], temperature)
        for t in range(len(item)):
            if t < WARMUP:
                continue
            actual = int(entry["targets"][t])
            gain = float(-np.log(max(shuffled_p[t, actual], 1e-12))) - float(
                -np.log(max(correct_p[t, actual], 1e-12))
            )
            per_family[name]["values"].append(gain)
            per_family[name]["game"].append(item.game)
    summary = {}
    for name, table in per_family.items():
        values = np.asarray(table["values"])
        games = np.asarray(table["game"])
        point, low, high = bootstrap(values, games, replicates, seed)
        summary[name] = {"gain": point, "lower": low, "upper": high, "decisions": len(values)}
    return summary


def evaluate(models, stable_traj, switch_traj, corpora, temperature, replicates, seed):
    """Every quantity the eight gates are written in terms of, with whole-game intervals."""
    stable_out = ensemble_outputs(models, stable_traj, corpora)
    switch_out = ensemble_outputs(models, switch_traj, corpora)
    stable = stable_records(stable_out, temperature)
    fixed = fixed_stable_records(stable_out, temperature)
    counts = (1, 2, 3, 4, 5, 6, 8, 12)
    switch = switch_records(switch_out, temperature, counts)

    stable_nll, stable_low, stable_high = bootstrap(
        stable["nll"], stable["game"], replicates, seed
    )
    # Fixed minus candidate: positive means the identity state is paying for itself.
    identity_point, identity_low, identity_high = bootstrap(
        fixed["nll"], fixed["game"], replicates, seed, paired=(stable["nll"], stable["game"])
    )
    family = {}
    for count in counts:
        table = switch["family"][count]
        hit, hit_low, hit_high = bootstrap(table["hit"], table["game"], replicates, seed)
        old, old_low, old_high = bootstrap(table["old"], table["game"], replicates, seed)
        family[count] = {
            "newFamily": hit,
            "newFamilyLower": hit_low,
            "newFamilyUpper": hit_high,
            "stillOld": old,
            "stillOldLower": old_low,
            "stillOldUpper": old_high,
            "trajectories": len(table["hit"]),
        }
    action = {}
    excess_values, excess_games = [], []
    for offset in OFFSETS:
        table = switch["action"][offset]
        point, low, high = bootstrap(
            table["model"], table["game"], replicates, seed, paired=(table["fixed"], table["game"])
        )
        action[offset] = {"excess": point, "lower": low, "upper": high, "decisions": len(table["model"])}
        if offset >= 1:
            excess_values.append(table["model"] - table["fixed"])
            excess_games.append(table["game"])
    joined_values = np.concatenate(excess_values) if excess_values else np.asarray([])
    joined_games = np.concatenate(excess_games) if excess_games else np.asarray([])
    mean_excess, excess_low, excess_high = bootstrap(joined_values, joined_games, replicates, seed)

    matched = float(stable["familyAt4"].mean()) if len(stable["familyAt4"]) else None
    recovery = (
        family[RECOVERY_AT]["newFamily"] / matched
        if matched and family[RECOVERY_AT]["newFamily"] is not None
        else None
    )
    return {
        "temperature": temperature,
        "stableNll": stable_nll,
        "stableNllLower": stable_low,
        "stableNllUpper": stable_high,
        "fixedStableNll": float(fixed["nll"].mean()),
        "identityGain": identity_point,
        "identityGainLower": identity_low,
        "identityGainUpper": identity_high,
        "top5": float(stable["top5"].mean()),
        "ece": expected_calibration_error(stable["confidence"], stable["top1"]),
        "matchedFamilyAt4": matched,
        "recoveryRatio": recovery,
        "family": family,
        "action": action,
        "meanExcess1to4": mean_excess,
        "meanExcess1to4Lower": excess_low,
        "meanExcess1to4Upper": excess_high,
        "_stableOutputs": stable_out,
        "_stableTrajectories": stable_traj,
    }


def fixed_ece(models, stable_traj, corpora, temperature):
    outputs = ensemble_outputs(models, stable_traj, corpora)
    confidence, correct = [], []
    for entry in outputs:
        item = entry["trajectory"]
        fixed = softmax_rows(entry["base"], entry["mask"], temperature)
        for t in range(len(item)):
            if t < WARMUP:
                continue
            confidence.append(float(fixed[t].max()))
            correct.append(float(int(np.argmax(fixed[t])) == int(entry["targets"][t])))
    return expected_calibration_error(np.asarray(confidence), np.asarray(correct))


def exact_fallback_error(models, trajectories, corpora, size=8):
    """Empty history must reproduce the fixed-population logits exactly."""
    worst = 0.0
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        embedding, base, candidate_mask = batch[0], batch[1], batch[2]
        zero_latent = tf.zeros((len(chunk), embedding.shape[1], EMBED))
        for model in models:
            residual = residual_from_latent(model, tf.constant(embedding), zero_latent).numpy()
            worst = max(worst, float(np.max(np.abs(residual) * candidate_mask)))
    return worst


def gates(result, frozen_k, fixed_ece_value, interaction):
    """The eight preregistered variant-`e` gates, evaluated exactly as written."""
    retention = result["stableNll"] - frozen_k["stableNll"]
    retention_upper = retention + (result["stableNllUpper"] - result["stableNll"])
    four = result["family"][RECOVERY_AT]
    per_offset_ok = all(
        result["action"][offset]["excess"] is None or result["action"][offset]["excess"] <= 0.20
        for offset in (1, 2, 3, 4)
    )
    interaction_values = [entry["gain"] for entry in interaction.values() if entry["gain"] is not None]
    table = {
        "stableRetention": {
            "value": retention,
            "upper": retention_upper,
            "thresholds": {"point": 0.01, "upper": 0.02},
            "pass": retention <= 0.01 and retention_upper <= 0.02,
        },
        "stableIdentityValue": {
            "identityGainLower": result["identityGainLower"],
            "top5": result["top5"],
            "ece": result["ece"],
            "fixedEce": fixed_ece_value,
            "pass": (
                result["identityGainLower"] is not None
                and result["identityGainLower"] > 0.03
                and result["top5"] > 0.65
                and result["ece"] <= 0.08
                and result["ece"] <= fixed_ece_value + 0.01
            ),
        },
        "fourMoveRecovery": {
            "newFamily": four["newFamily"],
            "lower": four["newFamilyLower"],
            "recoveryRatio": result["recoveryRatio"],
            "pass": (
                four["newFamily"] is not None
                and four["newFamily"] >= 0.50
                and four["newFamilyLower"] > 0.40
                and result["recoveryRatio"] is not None
                and result["recoveryRatio"] >= 0.70
            ),
        },
        "staleRejection": {
            "stillOld": four["stillOld"],
            "upper": four["stillOldUpper"],
            "pass": four["stillOld"] is not None
            and four["stillOld"] <= 0.25
            and four["stillOldUpper"] < 0.35,
        },
        "postSwitchSafety": {
            "meanExcess": result["meanExcess1to4"],
            "upper": result["meanExcess1to4Upper"],
            "perOffset": {str(k): v["excess"] for k, v in result["action"].items()},
            "pass": (
                result["meanExcess1to4"] is not None
                and result["meanExcess1to4"] <= 0.05
                and result["meanExcess1to4Upper"] <= 0.10
                and per_offset_ok
            ),
        },
        "interactionFloor": {
            "perFamily": {name: entry["gain"] for name, entry in interaction.items()},
            "mean": float(np.mean(interaction_values)) if interaction_values else None,
            "minimum": float(np.min(interaction_values)) if interaction_values else None,
            "pass": bool(
                interaction_values
                and float(np.mean(interaction_values)) > 0.04
                and float(np.min(interaction_values)) >= -0.01
            ),
        },
    }
    return table


def structural_check(stable, switch):
    """Gate 1 — the corpora must be what the protocol says before any metric is believed."""
    switching = [item for item in switch.trajectories if item.switching]
    at_six = all(item.switch == SWITCH_AT for item in switching)
    single = all(
        len(np.flatnonzero(item.families[1:] != item.families[:-1])) == 1 for item in switching
    )
    stable_constant = all(not item.switching for item in stable.trajectories)
    return {
        "stableGames": int(stable.meta["finishedGames"]),
        "switchGames": int(switch.meta["finishedGames"]),
        "stableMissingActions": int(stable.meta["missingPlayedActions"]),
        "switchMissingActions": int(switch.meta["missingPlayedActions"]),
        "switchingTrajectories": len(switching),
        "allSwitchAtSix": bool(at_six),
        "exactlyOneChange": bool(single),
        "stableNeverChanges": bool(stable_constant),
        "pass": bool(
            at_six
            and single
            and stable_constant
            and int(stable.meta["missingPlayedActions"]) == 0
            and int(switch.meta["missingPlayedActions"]) == 0
        ),
    }


def configurations():
    specs = []
    for l2 in (1e-4, 3e-4, 1e-3):
        specs.append({"arm": "arm-b", "l2": l2, "id": f"arm-b-l2{l2:g}"})
    for window in (4, 6, 8):
        for gate_weight in (0.10, 0.25):
            specs.append(
                {
                    "arm": "arm-c",
                    "window": window,
                    "gateWeight": gate_weight,
                    "id": f"arm-c-w{window}-g{gate_weight:g}",
                }
            )
    return specs


def split_trajectories(corpus, split):
    return [item for item in corpus.trajectories if item.split == split]


def pick_temperature(models, stable_traj, switch_traj, corpora, replicates, seed):
    """Temperature is chosen on the selection split only, by stable action NLL."""
    outputs = ensemble_outputs(models, stable_traj, corpora)
    best = (np.inf, 1.0)
    for temperature in TEMPERATURES:
        value = float(stable_records(outputs, temperature)["nll"].mean())
        if value < best[0]:
            best = (value, temperature)
    return best[1]


def eligible(result, frozen_k):
    """The four development eligibility conditions, evaluated on the selection split."""
    checks = {
        "stableWithin002": result["stableNll"] - frozen_k["stableNll"] <= 0.02,
        "recoveryAtLeast25": (result["family"][RECOVERY_AT]["newFamily"] or 0.0) >= 0.25,
        "excessAtMost020": (result["meanExcess1to4"] is not None)
        and result["meanExcess1to4"] <= 0.20,
    }
    return checks, all(checks.values())


def lexicographic(candidates):
    """Highest recovery, then lowest post-switch excess, then lowest stable NLL, then simplicity."""
    ordered = sorted(
        candidates,
        key=lambda entry: (
            -round(entry["result"]["family"][RECOVERY_AT]["newFamily"] or 0.0, 4),
            round(entry["result"]["meanExcess1to4"] or 9.9, 4),
            round(entry["result"]["stableNll"] or 9.9, 4),
            entry["parameters"],
            entry["spec"].get("window", 99),
            entry["spec"].get("gateWeight", 9.9),
        ),
    )
    best = ordered[0]
    top = best["result"]["family"][RECOVERY_AT]["newFamily"] or 0.0
    within = [
        entry
        for entry in ordered
        if (entry["result"]["family"][RECOVERY_AT]["newFamily"] or 0.0) >= top - 0.02
    ]
    within.sort(
        key=lambda entry: (
            round(entry["result"]["meanExcess1to4"] or 9.9, 4),
            round(entry["result"]["stableNll"] or 9.9, 4),
            entry["parameters"],
            entry["spec"].get("window", 99),
            entry["spec"].get("gateWeight", 9.9),
        )
    )
    leader = within[0]
    close = [
        entry
        for entry in within
        if abs(
            (entry["result"]["meanExcess1to4"] or 9.9)
            - (leader["result"]["meanExcess1to4"] or 9.9)
        )
        <= 0.01
    ]
    close.sort(
        key=lambda entry: (
            round(entry["result"]["stableNll"] or 9.9, 4),
            entry["parameters"],
            entry["spec"].get("window", 99),
            entry["spec"].get("gateWeight", 9.9),
        )
    )
    return close[0], ordered


def parameter_count(model):
    return int(sum(int(np.prod(weight.shape)) for weight in model.trainable_variables))


def main():
    args = parse_args()
    forbid_holdout(args.stable, args.switch)
    seeds = [int(value) for value in args.seeds.split(",")]

    checkpoint = np.load(args.checkpoint)
    population = ContextPopulation()
    probe = load_raw(args.stable, "v5-oracle-strategic-personality-trajectories-v4")
    candidate, mask, states, boards, _ = pad_raw(np.arange(2, dtype=np.int64), probe)
    population(tf.constant(candidate), tf.constant(mask), tf.constant(states), tf.constant(boards))
    restore(checkpoint, "population", population)
    del probe

    stable = encode(
        population, args.stable, "v5-oracle-strategic-personality-trajectories-v4", "stable"
    )
    switch = encode(
        population, args.switch, "v5-oracle-personality-switch-trajectories-v6", "switch"
    )
    corpora = {"stable": stable, "switch": switch}
    structure = structural_check(stable, switch)
    print(f"structure: {json.dumps(structure)}", flush=True)
    if not structure["pass"]:
        raise SystemExit("development corpora failed structural validation")

    splits = {
        name: (split_trajectories(stable, index), split_trajectories(switch, index))
        for index, name in enumerate(("a", "b", "c"))
    }
    if args.limit_trajectories:
        limit = args.limit_trajectories
        splits = {name: (s[:limit], w[:limit]) for name, (s, w) in splits.items()}
    print(
        "trajectories "
        + ", ".join(f"{name}={len(s)}stable/{len(w)}switch" for name, (s, w) in splits.items()),
        flush=True,
    )

    replicates = args.bootstrap
    # Control 2 — the exact Experiment K checkpoint and temperature, never eligible for selection.
    frozen = SwitchTrainedGru(0.0)
    frozen.build_from(checkpoint)
    frozen_models = [frozen]
    frozen_temperature = 1.25
    frozen_b = evaluate(
        frozen_models, splits["b"][0], splits["b"][1], corpora, frozen_temperature, replicates,
        BOOTSTRAP_SEED,
    )
    print(
        f"frozen K on b: stable {frozen_b['stableNll']:.4f} "
        f"recovery@4 {frozen_b['family'][4]['newFamily']:.3f} "
        f"excess1-4 {frozen_b['meanExcess1to4']:+.3f}",
        flush=True,
    )

    if args.stage == "smoke":
        summary = {
            "experiment": "v5-oracle-change-point-experiment-l",
            "stage": "smoke",
            "structure": structure,
            "frozenKOnSelection": {
                "stableNll": frozen_b["stableNll"],
                "recoveryAt4": frozen_b["family"][4]["newFamily"],
                "meanExcess1to4": frozen_b["meanExcess1to4"],
            },
        }
        write_output(args, summary)
        return

    specs = configurations()
    if args.limit_configs:
        specs = specs[: args.limit_configs]
    trained = []
    for spec in specs:
        models, fits = [], []
        for seed in seeds:
            model, fit = train_arm(
                spec, checkpoint, splits["a"], splits["b"][0] + splits["b"][1], corpora, args, seed
            )
            models.append(model)
            fits.append(fit)
        temperature = pick_temperature(
            models, splits["b"][0], splits["b"][1], corpora, replicates, BOOTSTRAP_SEED
        )
        result = evaluate(
            models, splits["b"][0], splits["b"][1], corpora, temperature, replicates, BOOTSTRAP_SEED
        )
        fallback = exact_fallback_error(models, splits["b"][0][:8], corpora)
        checks, ok = eligible(result, frozen_b)
        checks["exactFallback"] = fallback <= 1e-6
        ok = ok and checks["exactFallback"]
        entry = {
            "spec": spec,
            "result": result,
            "fits": fits,
            "temperature": temperature,
            "parameters": parameter_count(models[0]),
            "fallbackError": fallback,
            "eligibility": checks,
            "eligible": bool(ok),
            "models": models,
        }
        trained.append(entry)
        print(
            f"{spec['id']:<20} T {temperature:.2f}  stable {result['stableNll']:.4f}  "
            f"recovery@4 {result['family'][4]['newFamily']:.3f}  "
            f"stillOld@4 {result['family'][4]['stillOld']:.3f}  "
            f"excess1-4 {result['meanExcess1to4']:+.3f}  "
            f"eligible {ok}",
            flush=True,
        )

    candidates = [entry for entry in trained if entry["eligible"]]
    if args.force_select and not candidates:
        print("REHEARSAL: forcing selection past the eligibility rule", flush=True)
        candidates = trained
    if not candidates:
        summary = development_summary(args, structure, frozen_b, trained, None, None, splits)
        write_output(args, summary)
        print("\nno eligible configuration on variant b; Experiment L stops before variant c")
        return

    selected, ordering = lexicographic(candidates)
    print(f"\nselected {selected['spec']['id']} (temperature {selected['temperature']:.2f})", flush=True)

    retrained, retrained_fits = [], []
    combined = (splits["a"][0] + splits["b"][0], splits["a"][1] + splits["b"][1])
    for seed in seeds:
        model, fit = train_arm(
            selected["spec"], checkpoint, combined, splits["b"][0] + splits["b"][1], corpora, args, seed
        )
        retrained.append(model)
        retrained_fits.append(fit)

    confirmation = evaluate(
        retrained, splits["c"][0], splits["c"][1], corpora, selected["temperature"], replicates,
        BOOTSTRAP_SEED,
    )
    frozen_c = evaluate(
        frozen_models, splits["c"][0], splits["c"][1], corpora, frozen_temperature, replicates,
        BOOTSTRAP_SEED,
    )
    fixed_ece_c = fixed_ece(retrained, splits["c"][0], corpora, selected["temperature"])
    interaction = interaction_gain(
        retrained, confirmation["_stableOutputs"], splits["c"][0], corpora,
        selected["temperature"], replicates, BOOTSTRAP_SEED,
    )
    fallback_c = exact_fallback_error(retrained, splits["c"][0][:8], corpora)
    table = gates(confirmation, frozen_c, fixed_ece_c, interaction)
    table["structuralIntegrity"] = structure
    table["exactFallback"] = {"value": fallback_c, "threshold": 1e-6, "pass": fallback_c <= 1e-6}
    passed = all(entry["pass"] for entry in table.values())

    store = {}
    for index, model in enumerate(retrained):
        for position, weight in enumerate(model.weights):
            store[f"seed{seeds[index]}_{position}"] = weight.numpy()
    np.savez(args.checkpoint_out, **store)

    summary = development_summary(
        args, structure, frozen_b, trained, selected, {
            "confirmation": confirmation,
            "frozenK": frozen_c,
            "fixedEce": fixed_ece_c,
            "interaction": interaction,
            "gates": table,
            "passed": bool(passed),
            "fits": retrained_fits,
        }, splits
    )
    write_output(args, summary)

    print("\nvariant c confirmation:")
    for name, entry in table.items():
        print(f"{'PASS' if entry['pass'] else 'FAIL'} {name}")
    print(f"\nvariant c readiness: {passed}")
    print("variant e remains unopened")


def strip(result):
    return {key: value for key, value in result.items() if not key.startswith("_")}


def development_summary(args, structure, frozen_b, trained, selected, confirmation, splits):
    return {
        "experiment": "v5-oracle-change-point-experiment-l",
        "stage": "development",
        "protocol": "research_paper/v5_oracle_change_point_preregistered.md",
        "holdoutOpened": False,
        "corpora": {
            "stable": {"prefix": args.stable, "digest": corpus_digest(args.stable)},
            "switch": {"prefix": args.switch, "digest": corpus_digest(args.switch)},
            "kCheckpoint": file_digest(args.checkpoint)[:16],
        },
        "seeds": [int(value) for value in args.seeds.split(",")],
        "bootstrapSeed": BOOTSTRAP_SEED,
        "bootstrapReplicates": args.bootstrap,
        "structure": structure,
        "frozenKOnSelection": strip(frozen_b),
        "configurations": [
            {
                "id": entry["spec"]["id"],
                "spec": entry["spec"],
                "temperature": entry["temperature"],
                "parameters": entry["parameters"],
                "fallbackError": entry["fallbackError"],
                "eligibility": entry["eligibility"],
                "eligible": entry["eligible"],
                "result": strip(entry["result"]),
                "fits": entry["fits"],
            }
            for entry in trained
        ],
        "selected": selected["spec"]["id"] if selected else None,
        "confirmation": (
            {
                "gates": confirmation["gates"],
                "passed": confirmation["passed"],
                "result": strip(confirmation["confirmation"]),
                "frozenK": strip(confirmation["frozenK"]),
                "fixedEce": confirmation["fixedEce"],
                "interaction": confirmation["interaction"],
                "fits": confirmation["fits"],
            }
            if confirmation
            else None
        ),
    }


def write_output(args, summary):
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2, default=float)
        handle.write("\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
