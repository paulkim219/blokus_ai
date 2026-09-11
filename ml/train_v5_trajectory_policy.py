#!/usr/bin/env python3
"""Train and gate the v5 Oracle learned trajectory policy.

Prediction only. Nothing here is connected to move selection. Four candidates share one learned
legal-candidate scorer and differ only in how they encode the player's prior selected actions:

  stateless    population scorer with a constant readout;
  gru          one-layer GRU, width 64;
  mixture      the same GRU gating eight linear policy experts;
  transformer  two-layer causal transformer, width 96, four heads, feed-forward width 192.

The scorer maps a candidate's nine within-legal-set standardized features to a 32-dim embedding.
The history encoder produces a readout vector and bias; the score is their inner product. The
architectures are therefore comparable: only the readout's source changes.

Selection order is fixed by the preregistration in research_paper/v5_oracle_learned_policy.md:
early stopping and architecture choice read validation NLL only, temperature is scaled on
validation NLL, and the holdout is read once at the end.
"""

from __future__ import annotations

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

FEATURES = 9
SPLITS = ("train", "validation", "holdout")
WARMUP = 3
EMBED = 32
GRU_WIDTH = 64
EXPERTS = 8
TF_WIDTH = 96
TF_HEADS = 4
TF_FF = 192
TF_LAYERS = 2
KINDS = ("stateless", "gru", "mixture", "transformer")

# decision columns
GAME, PROFILE, SEAT, PLY, TURN, OFFSET, COUNT, ACTUAL, SPLIT = range(9)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/v5-oracle-policy")
    ap.add_argument("--out", default="selfplay-results/v5-oracle-learned-policy.json")
    ap.add_argument("--epochs", type=int, default=400)
    ap.add_argument("--patience", type=int, default=40)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=5001)
    ap.add_argument("--bootstrap", type=int, default=10000)
    return ap.parse_args()


def load(prefix: str):
    meta = json.load(open(f"{prefix}.meta.json"))
    width = int(meta["decisionWidth"])
    features = int(meta["featureCount"])
    dec = np.fromfile(f"{prefix}.decisions.i32", np.int32).reshape(-1, width)
    cand = np.fromfile(f"{prefix}.candidates.f32", np.float32).reshape(-1, features)
    if features != FEATURES:
        raise SystemExit(f"expected {FEATURES} features, dataset has {features}")
    if int(meta["missingPlayedActions"]) != 0:
        raise SystemExit("dataset contains played moves outside the legal set")
    if int(meta["finishedGames"]) != len(meta["games"]):
        raise SystemExit("dataset contains unfinished games")
    return meta, dec, cand


class Sequence:
    """One seat's ordered decisions inside one game."""

    def __init__(self, game: int, seat: int, profile: int, split: int, rows: np.ndarray):
        self.game = game
        self.seat = seat
        self.profile = profile
        self.split = split
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)


def build_sequences(dec: np.ndarray) -> list[Sequence]:
    order = np.lexsort((dec[:, TURN], dec[:, SEAT], dec[:, GAME]))
    groups: dict[tuple[int, int], list[int]] = {}
    for row in order:
        groups.setdefault((int(dec[row, GAME]), int(dec[row, SEAT])), []).append(int(row))
    out = []
    for (game, seat), rows in sorted(groups.items()):
        first = rows[0]
        out.append(
            Sequence(game, seat, int(dec[first, PROFILE]), int(dec[first, SPLIT]), np.array(rows))
        )
    return out


def selected_vectors(seq: Sequence, dec: np.ndarray, cand: np.ndarray) -> np.ndarray:
    idx = dec[seq.rows, OFFSET] + dec[seq.rows, ACTUAL]
    return cand[idx]


def pad_histories(seqs, dec, cand, tmax):
    hist = np.zeros((len(seqs), tmax, FEATURES), np.float32)
    mask = np.zeros((len(seqs), tmax), np.float32)
    for j, seq in enumerate(seqs):
        vectors = selected_vectors(seq, dec, cand)
        hist[j, : len(seq)] = vectors
        mask[j, : len(seq)] = 1.0
    return hist, mask


def pad_candidates(rows, dec, cand):
    counts = dec[rows, COUNT]
    cmax = int(counts.max())
    out = np.zeros((len(rows), cmax, FEATURES), np.float32)
    mask = np.zeros((len(rows), cmax), np.float32)
    for j, row in enumerate(rows):
        offset, count = int(dec[row, OFFSET]), int(dec[row, COUNT])
        out[j, :count] = cand[offset : offset + count]
        mask[j, :count] = 1.0
    return out, mask, dec[rows, ACTUAL].astype(np.int32)


class CausalBlock(tf.keras.layers.Layer):
    """Pre-norm causal self-attention block with an explicit incremental path."""

    def __init__(self, width, heads, ff, **kwargs):
        super().__init__(**kwargs)
        self.width = width
        self.heads = heads
        self.head_dim = width // heads
        self.norm1 = tf.keras.layers.LayerNormalization(epsilon=1e-5)
        self.query = tf.keras.layers.Dense(width)
        self.key = tf.keras.layers.Dense(width)
        self.value = tf.keras.layers.Dense(width)
        self.proj = tf.keras.layers.Dense(width)
        self.norm2 = tf.keras.layers.LayerNormalization(epsilon=1e-5)
        self.ff1 = tf.keras.layers.Dense(ff, activation="gelu")
        self.ff2 = tf.keras.layers.Dense(width)

    def split(self, x):
        shape = tf.shape(x)
        x = tf.reshape(x, [shape[0], shape[1], self.heads, self.head_dim])
        return tf.transpose(x, [0, 2, 1, 3])

    def merge(self, x):
        x = tf.transpose(x, [0, 2, 1, 3])
        shape = tf.shape(x)
        return tf.reshape(x, [shape[0], shape[1], self.width])

    def call(self, h, mask):
        normed = self.norm1(h)
        q, k, v = self.split(self.query(normed)), self.split(self.key(normed)), self.split(
            self.value(normed)
        )
        length = tf.shape(h)[1]
        logits = tf.matmul(q, k, transpose_b=True) / np.sqrt(self.head_dim).astype(np.float32)
        causal = tf.linalg.band_part(tf.ones((length, length), tf.float32), -1, 0)
        keep = causal[None, None, :, :] * mask[:, None, None, :]
        logits += (1.0 - keep) * -1e9
        attended = self.merge(tf.matmul(tf.nn.softmax(logits, axis=-1), v))
        h = h + self.proj(attended)
        return h + self.ff2(self.ff1(self.norm2(h)))

    def step(self, h, key_cache, value_cache):
        """One position at a time; caches hold every earlier position's keys and values."""
        normed = self.norm1(h)
        q = self.split(self.query(normed))
        k = self.split(self.key(normed))
        v = self.split(self.value(normed))
        k = k if key_cache is None else tf.concat([key_cache, k], axis=2)
        v = v if value_cache is None else tf.concat([value_cache, v], axis=2)
        logits = tf.matmul(q, k, transpose_b=True) / np.sqrt(self.head_dim).astype(np.float32)
        attended = self.merge(tf.matmul(tf.nn.softmax(logits, axis=-1), v))
        h = h + self.proj(attended)
        return h + self.ff2(self.ff1(self.norm2(h))), k, v


class TrajectoryPolicy(tf.keras.Model):
    def __init__(self, kind, tmax, **kwargs):
        super().__init__(**kwargs)
        if kind not in KINDS:
            raise ValueError(kind)
        self.kind = kind
        self.tmax = tmax
        self.trunk1 = tf.keras.layers.Dense(EMBED, activation="relu")
        self.trunk2 = tf.keras.layers.Dense(EMBED, activation="relu")
        if kind == "stateless":
            self.context_dim = 1
            self.readout_vector = self.add_weight(
                shape=(EMBED,), initializer="glorot_uniform", name="readout_vector"
            )
            self.readout_bias = self.add_weight(shape=(1,), initializer="zeros", name="readout_bias")
        elif kind in ("gru", "mixture"):
            self.context_dim = GRU_WIDTH
            self.project = tf.keras.layers.Dense(GRU_WIDTH)
            self.start = self.add_weight(shape=(1, 1, GRU_WIDTH), initializer="zeros", name="start")
            self.gru = tf.keras.layers.GRU(GRU_WIDTH, return_sequences=True)
            if kind == "gru":
                self.readout = tf.keras.layers.Dense(EMBED + 1)
            else:
                self.gate = tf.keras.layers.Dense(EXPERTS)
                self.expert_vectors = self.add_weight(
                    shape=(EXPERTS, EMBED), initializer="glorot_uniform", name="expert_vectors"
                )
                self.expert_biases = self.add_weight(
                    shape=(EXPERTS,), initializer="zeros", name="expert_biases"
                )
        else:
            self.context_dim = TF_WIDTH
            self.project = tf.keras.layers.Dense(TF_WIDTH)
            self.start = self.add_weight(shape=(1, 1, TF_WIDTH), initializer="zeros", name="start")
            self.positions = tf.keras.layers.Embedding(tmax + 1, TF_WIDTH)
            self.blocks = [CausalBlock(TF_WIDTH, TF_HEADS, TF_FF) for _ in range(TF_LAYERS)]
            self.norm_final = tf.keras.layers.LayerNormalization(epsilon=1e-5)
            self.readout = tf.keras.layers.Dense(EMBED + 1)

    def shifted_inputs(self, history, mask):
        """Position t sees the start token plus the t actions observed before decision t."""
        batch = tf.shape(history)[0]
        projected = self.project(history)
        start = tf.tile(self.start, [batch, 1, 1])
        shifted = tf.concat([start, projected[:, :-1]], axis=1)
        shifted_mask = tf.concat([tf.ones((batch, 1), tf.float32), mask[:, :-1]], axis=1)
        return shifted, shifted_mask

    def contexts(self, history, mask):
        """(B, T, C) contexts, where position t has seen exactly the t prior observed actions."""
        if self.kind == "stateless":
            shape = tf.shape(history)
            return tf.zeros((shape[0], shape[1], 1), tf.float32)
        shifted, shifted_mask = self.shifted_inputs(history, mask)
        if self.kind in ("gru", "mixture"):
            return self.gru(shifted, mask=shifted_mask > 0.5)
        length = tf.shape(shifted)[1]
        h = shifted + self.positions(tf.range(length))[None]
        for block in self.blocks:
            h = block(h, shifted_mask)
        return self.norm_final(h)

    def cached_contexts(self, history, mask):
        """Incremental transformer path: one prefix cache extended one observed action at a time."""
        if self.kind != "transformer":
            raise ValueError("cached path is only defined for the transformer")
        shifted, _ = self.shifted_inputs(history, mask)
        caches = [(None, None) for _ in self.blocks]
        outputs = []
        for position in range(int(shifted.shape[1])):
            h = shifted[:, position : position + 1] + self.positions(
                tf.constant([position], tf.int32)
            )[None]
            for index, block in enumerate(self.blocks):
                key_cache, value_cache = caches[index]
                h, key_cache, value_cache = block.step(h, key_cache, value_cache)
                caches[index] = (key_cache, value_cache)
            outputs.append(self.norm_final(h))
        return tf.concat(outputs, axis=1)

    def readout_params(self, context):
        if self.kind == "stateless":
            rows = tf.shape(context)[0]
            vector = tf.tile(self.readout_vector[None], [rows, 1])
            bias = tf.tile(self.readout_bias, [rows])
            return vector, bias
        if self.kind == "mixture":
            gates = tf.nn.softmax(self.gate(context), axis=-1)
            return gates @ self.expert_vectors, tf.linalg.matvec(gates, self.expert_biases)
        out = self.readout(context)
        return out[:, :EMBED], out[:, EMBED]

    def score(self, candidates, candidate_mask, context):
        embedded = self.trunk2(self.trunk1(candidates))
        vector, bias = self.readout_params(context)
        scores = tf.reduce_sum(embedded * vector[:, None, :], axis=-1) + bias[:, None]
        return scores + (1.0 - candidate_mask) * -1e9


def batch_tensors(seqs, dec, cand):
    tmax = max(len(seq) for seq in seqs)
    history, history_mask = pad_histories(seqs, dec, cand, tmax)
    rows, seq_index, positions = [], [], []
    for j, seq in enumerate(seqs):
        for t, row in enumerate(seq.rows):
            rows.append(int(row))
            seq_index.append(j)
            positions.append(t)
    rows = np.array(rows, np.int64)
    candidates, candidate_mask, targets = pad_candidates(rows, dec, cand)
    gather = np.stack([np.array(seq_index, np.int32), np.array(positions, np.int32)], axis=1)
    return {
        "history": tf.constant(history),
        "history_mask": tf.constant(history_mask),
        "gather": tf.constant(gather),
        "candidates": tf.constant(candidates),
        "candidate_mask": tf.constant(candidate_mask),
        "targets": tf.constant(targets.astype(np.int32)),
        "rows": rows,
    }


def batch_loss(model, batch):
    contexts = model.contexts(batch["history"], batch["history_mask"])
    context = tf.gather_nd(contexts, batch["gather"])
    scores = model.score(batch["candidates"], batch["candidate_mask"], context)
    return tf.reduce_mean(
        tf.nn.sparse_softmax_cross_entropy_with_logits(labels=batch["targets"], logits=scores)
    )


def sequence_contexts(model, seqs, dec, cand, cached=False):
    """Per-sequence context arrays, computed in one padded pass."""
    tmax = max(len(seq) for seq in seqs)
    history, mask = pad_histories(seqs, dec, cand, tmax)
    fn = model.cached_contexts if cached else model.contexts
    out = fn(tf.constant(history), tf.constant(mask)).numpy()
    return [out[j, : len(seq)] for j, seq in enumerate(seqs)]


def score_rows(model, rows, contexts, dec, cand, chunk=128):
    """Logit rows for the given decisions under the supplied per-decision contexts."""
    result = []
    for start in range(0, len(rows), chunk):
        block = rows[start : start + chunk]
        candidates, candidate_mask, targets = pad_candidates(block, dec, cand)
        context = tf.constant(contexts[start : start + chunk])
        scores = model.score(
            tf.constant(candidates), tf.constant(candidate_mask), context
        ).numpy()
        result.append((scores, candidate_mask, targets))
    return result


def decision_metrics(blocks, temperature=1.0):
    """Per-decision NLL, top-1 confidence, top-1 hit and top-5 hit."""
    nll, confidence, hit1, hit5 = [], [], [], []
    for scores, mask, targets in blocks:
        logits = scores / temperature
        logits = np.where(mask > 0.5, logits, -1e9)
        logits -= logits.max(axis=1, keepdims=True)
        probabilities = np.exp(logits)
        probabilities /= probabilities.sum(axis=1, keepdims=True)
        rows = np.arange(len(targets))
        chosen = probabilities[rows, targets]
        nll.append(-np.log(np.maximum(chosen, 1e-12)))
        confidence.append(probabilities.max(axis=1))
        hit1.append((probabilities.argmax(axis=1) == targets).astype(np.float64))
        top5 = np.argsort(-probabilities, axis=1)[:, :5]
        hit5.append((top5 == targets[:, None]).any(axis=1).astype(np.float64))
    return (
        np.concatenate(nll),
        np.concatenate(confidence),
        np.concatenate(hit1),
        np.concatenate(hit5),
    )


def expected_calibration_error(confidence, hit1, bins=10):
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = len(confidence)
    error = 0.0
    for lower, upper in zip(edges[:-1], edges[1:]):
        inside = (confidence > lower) & (confidence <= upper) if lower > 0 else (confidence <= upper)
        if not inside.any():
            continue
        error += inside.sum() / total * abs(hit1[inside].mean() - confidence[inside].mean())
    return float(error)


def bootstrap_lower_bound(values, groups, draws, seed):
    """Game-clustered bootstrap; returns mean and a 95% two-sided interval."""
    unique = np.unique(groups)
    index = {group: np.where(groups == group)[0] for group in unique}
    rng = np.random.default_rng(seed)
    samples = np.empty(draws)
    for draw in range(draws):
        picked = rng.integers(0, len(unique), len(unique))
        rows = np.concatenate([index[unique[p]] for p in picked])
        samples[draw] = values[rows].mean()
    return float(values.mean()), float(np.percentile(samples, 2.5)), float(np.percentile(samples, 97.5))


def shuffled_donors(seqs):
    """For each sequence, a same-length-or-longer sequence from a different profile."""
    donors = {}
    for i, seq in enumerate(seqs):
        options = [
            j
            for j, other in enumerate(seqs)
            if other.profile != seq.profile and len(other) >= len(seq)
        ]
        if not options:
            options = [
                j for j, other in enumerate(seqs) if other.profile != seq.profile
            ]
            options.sort(key=lambda j: -len(seqs[j]))
        donors[i] = options[i % len(options)]
    return donors


def evaluate(model, seqs, dec, cand, donors=None, temperature=1.0):
    contexts_by_sequence = sequence_contexts(model, seqs, dec, cand)
    rows, contexts, turns, games = [], [], [], []
    for i, seq in enumerate(seqs):
        source = contexts_by_sequence[i if donors is None else donors[i]]
        for t, row in enumerate(seq.rows):
            rows.append(int(row))
            contexts.append(source[min(t, len(source) - 1)])
            turns.append(t)
            games.append(seq.game)
    blocks = score_rows(model, np.array(rows, np.int64), np.stack(contexts), dec, cand)
    nll, confidence, hit1, hit5 = decision_metrics(blocks, temperature)
    return {
        "nll": nll,
        "confidence": confidence,
        "hit1": hit1,
        "hit5": hit5,
        "turn": np.array(turns),
        "game": np.array(games),
        "blocks": blocks,
    }


def summarize(result, temperature=1.0):
    warm = result["turn"] >= WARMUP
    return {
        "nll": float(result["nll"][warm].mean()),
        "allTurnNll": float(result["nll"].mean()),
        "top1": float(result["hit1"][warm].mean()),
        "top5": float(result["hit5"][warm].mean()),
        "ece": expected_calibration_error(result["confidence"][warm], result["hit1"][warm]),
        "decisions": int(warm.sum()),
        "temperature": float(temperature),
    }


def train_one(kind, train_seqs, val_seqs, dec, cand, args):
    tf.keras.utils.set_random_seed(args.seed)
    tmax = max(len(seq) for seq in train_seqs + val_seqs)
    model = TrajectoryPolicy(kind, tmax)
    optimizer = tf.keras.optimizers.Adam(args.lr)

    @tf.function(reduce_retracing=True)
    def step(history, history_mask, gather, candidates, candidate_mask, targets):
        with tf.GradientTape() as tape:
            contexts = model.contexts(history, history_mask)
            context = tf.gather_nd(contexts, gather)
            scores = model.score(candidates, candidate_mask, context)
            loss = tf.reduce_mean(
                tf.nn.sparse_softmax_cross_entropy_with_logits(labels=targets, logits=scores)
            )
        optimizer.apply_gradients(zip(tape.gradient(loss, model.trainable_variables), model.trainable_variables))
        return loss

    rng = np.random.default_rng(args.seed)
    best_nll, best_weights, waited, best_epoch = np.inf, None, 0, -1
    history_log = []
    for epoch in range(args.epochs):
        order = rng.permutation(len(train_seqs))
        for start in range(0, len(order), args.batch):
            chunk = [train_seqs[i] for i in order[start : start + args.batch]]
            batch = batch_tensors(chunk, dec, cand)
            step(
                batch["history"],
                batch["history_mask"],
                batch["gather"],
                batch["candidates"],
                batch["candidate_mask"],
                batch["targets"],
            )
        result = evaluate(model, val_seqs, dec, cand)
        warm = result["turn"] >= WARMUP
        value = float(result["nll"][warm].mean())
        history_log.append(round(value, 5))
        if value < best_nll - 1e-5:
            best_nll, best_epoch, waited = value, epoch, 0
            best_weights = [w.numpy().copy() for w in model.weights]
        else:
            waited += 1
            if waited >= args.patience:
                break
    for weight, value in zip(model.weights, best_weights):
        weight.assign(value)
    return model, {"bestEpoch": best_epoch, "epochsRun": len(history_log), "validationNllTrace": history_log}


def choose_temperature(model, seqs, dec, cand):
    result = evaluate(model, seqs, dec, cand)
    warm = result["turn"] >= WARMUP
    best = (np.inf, 1.0)
    for temperature in np.arange(0.5, 3.01, 0.05):
        nll, _, _, _ = decision_metrics(result["blocks"], float(temperature))
        value = float(nll[warm].mean())
        if value < best[0]:
            best = (value, float(temperature))
    return best[1], best[0]


def cache_equivalence(model, seqs, dec, cand):
    """The runtime contract: an incremental prefix cache must reproduce the full-prefix logits."""
    full = sequence_contexts(model, seqs, dec, cand, cached=False)
    cached = sequence_contexts(model, seqs, dec, cand, cached=True)
    context_error = max(float(np.abs(a - b).max()) for a, b in zip(full, cached))
    rows, full_contexts, cached_contexts = [], [], []
    for i, seq in enumerate(seqs):
        for t, row in enumerate(seq.rows):
            rows.append(int(row))
            full_contexts.append(full[i][t])
            cached_contexts.append(cached[i][t])
    rows = np.array(rows, np.int64)
    a = score_rows(model, rows, np.stack(full_contexts), dec, cand)
    b = score_rows(model, rows, np.stack(cached_contexts), dec, cand)
    logit_error = 0.0
    for (scores_a, mask, _), (scores_b, _, _) in zip(a, b):
        difference = np.abs(scores_a - scores_b) * (mask > 0.5)
        logit_error = max(logit_error, float(difference.max()))
    return {"contextMaxAbsError": context_error, "logitMaxAbsError": logit_error}


SPLICE_POINT = 8
SPLICE_MIN_LENGTH = 12
RESET_GRID = tuple(round(float(v), 2) for v in np.arange(2.0, 8.01, 0.25))
RESET_RUN = 2


def splice_pairs(seqs):
    pairs = []
    for i, seq in enumerate(seqs):
        if len(seq) < SPLICE_MIN_LENGTH:
            continue
        options = [
            j
            for j, other in enumerate(seqs)
            if other.profile != seq.profile and len(other) >= SPLICE_POINT
        ]
        pairs.append((i, options[i % len(options)]))
    return pairs


def splice_tables(model, seq, donor, dec, cand, temperature):
    """NLL for every (decision, reset point) pair on a history contaminated before the splice."""
    length = len(seq)
    own = selected_vectors(seq, dec, cand)
    contaminated = own.copy()
    contaminated[:SPLICE_POINT] = selected_vectors(donor, dec, cand)[:SPLICE_POINT]

    history = np.zeros((length, length, FEATURES), np.float32)
    mask = np.zeros((length, length), np.float32)
    for reset in range(length):
        history[reset, : length - reset] = contaminated[reset:]
        mask[reset, : length - reset] = 1.0
    contexts = model.contexts(tf.constant(history), tf.constant(mask)).numpy()

    rows, gathered, index = [], [], {}
    for turn in range(length):
        for reset in range(turn + 1):
            index[(turn, reset)] = len(rows)
            rows.append(int(seq.rows[turn]))
            gathered.append(contexts[reset, turn - reset])
    blocks = score_rows(model, np.array(rows, np.int64), np.stack(gathered), dec, cand)
    nll, _, _, _ = decision_metrics(blocks, temperature)
    table = np.full((length, length), np.inf)
    for (turn, reset), position in index.items():
        table[turn, reset] = nll[position]

    clean_history = own[None]
    clean_mask = np.ones((1, length), np.float32)
    clean_contexts = model.contexts(tf.constant(clean_history), tf.constant(clean_mask)).numpy()[0]
    clean_blocks = score_rows(
        model, np.array([int(r) for r in seq.rows], np.int64), clean_contexts, dec, cand
    )
    clean_nll, _, _, _ = decision_metrics(clean_blocks, temperature)
    return table, clean_nll


def simulate_reset(table, threshold):
    """Reset the prefix after two consecutive observations more surprising than the threshold."""
    length = table.shape[0]
    reset, run = 0, 0
    chosen = np.empty(length)
    resets = 0
    for turn in range(length):
        chosen[turn] = table[turn, reset]
        if chosen[turn] > threshold:
            run += 1
            if run >= RESET_RUN:
                reset, run = turn + 1, 0
                resets += 1
        else:
            run = 0
    return chosen, resets


def splice_report(model, seqs, dec, cand, temperature, threshold=None):
    tables = [
        splice_tables(model, seqs[i], seqs[j], dec, cand, temperature) for i, j in splice_pairs(seqs)
    ]
    if threshold is None:
        best = (np.inf, RESET_GRID[-1])
        for candidate_threshold in RESET_GRID:
            values = [
                simulate_reset(table, candidate_threshold)[0][SPLICE_POINT:].mean()
                for table, _ in tables
            ]
            score = float(np.mean(values))
            if score < best[0]:
                best = (score, candidate_threshold)
        threshold = best[1]
    contaminated, reset_rule, clean, tail_reset, tail_clean, resets = [], [], [], [], [], 0
    for table, clean_nll in tables:
        chosen, count = simulate_reset(table, threshold)
        resets += count
        contaminated.append(table[SPLICE_POINT:, 0].mean())
        reset_rule.append(chosen[SPLICE_POINT:].mean())
        clean.append(clean_nll[SPLICE_POINT:].mean())
        tail_reset.append(chosen[-4:].mean())
        tail_clean.append(clean_nll[-4:].mean())
    return {
        "threshold": float(threshold),
        "sequences": len(tables),
        "resets": int(resets),
        "contaminatedNll": float(np.mean(contaminated)),
        "resetRuleNll": float(np.mean(reset_rule)),
        "cleanNll": float(np.mean(clean)),
        "resetMinusContaminated": float(np.mean(reset_rule) - np.mean(contaminated)),
        "tailResetMinusClean": float(np.mean(tail_reset) - np.mean(tail_clean)),
    }


def main() -> None:
    args = parse_args()
    meta, dec, cand = load(args.data)
    sequences = build_sequences(dec)
    by_split = {name: [s for s in sequences if s.split == i] for i, name in enumerate(SPLITS)}
    print(
        "sequences " + ", ".join(f"{name}={len(by_split[name])}" for name in SPLITS),
        f"decisions={len(dec)}",
        flush=True,
    )

    models, report = {}, {}
    for kind in KINDS:
        model, fit = train_one(kind, by_split["train"], by_split["validation"], dec, cand, args)
        temperature, _ = choose_temperature(model, by_split["validation"], dec, cand)
        validation = evaluate(model, by_split["validation"], dec, cand, temperature=temperature)
        donors = shuffled_donors(by_split["validation"])
        shuffled = evaluate(
            model, by_split["validation"], dec, cand, donors=donors, temperature=temperature
        )
        warm = validation["turn"] >= WARMUP
        models[kind] = (model, temperature)
        report[kind] = {
            **fit,
            "validation": summarize(validation, temperature),
            "validationShuffledMinusPersonalized": float(
                shuffled["nll"][warm].mean() - validation["nll"][warm].mean()
            ),
            "parameters": int(sum(int(np.prod(w.shape)) for w in model.weights)),
        }
        print(
            f"{kind:12s} val nll {report[kind]['validation']['nll']:.4f} "
            f"top5 {report[kind]['validation']['top5']:.3f} "
            f"T {temperature:.2f} "
            f"shuffle-gain {report[kind]['validationShuffledMinusPersonalized']:+.4f} "
            f"params {report[kind]['parameters']}",
            flush=True,
        )

    selected = min(KINDS, key=lambda k: report[k]["validation"]["nll"])
    model, temperature = models[selected]
    holdout = by_split["holdout"]
    donors = shuffled_donors(holdout)
    personalized = evaluate(model, holdout, dec, cand, temperature=temperature)
    shuffled = evaluate(model, holdout, dec, cand, donors=donors, temperature=temperature)
    stateless_model, stateless_temperature = models["stateless"]
    stateless = evaluate(model=stateless_model, seqs=holdout, dec=dec, cand=cand, temperature=stateless_temperature)

    warm = personalized["turn"] >= WARMUP
    delta = shuffled["nll"][warm] - personalized["nll"][warm]
    mean, low, high = bootstrap_lower_bound(delta, personalized["game"][warm], args.bootstrap, args.seed)
    ece = expected_calibration_error(personalized["confidence"][warm], personalized["hit1"][warm])
    stateless_warm = stateless["turn"] >= WARMUP
    stateless_ece = expected_calibration_error(
        stateless["confidence"][stateless_warm], stateless["hit1"][stateless_warm]
    )
    cache = cache_equivalence(models["transformer"][0], holdout, dec, cand)
    validation_splice = splice_report(model, by_split["validation"], dec, cand, temperature)
    holdout_splice = splice_report(
        model, holdout, dec, cand, temperature, threshold=validation_splice["threshold"]
    )

    gates = {
        "identityChannel": {
            "value": mean,
            "interval": [low, high],
            "threshold": 0.06,
            "pass": low > 0.06,
        },
        "topFiveRecall": {
            "value": float(personalized["hit5"][warm].mean()),
            "threshold": 0.65,
            "pass": float(personalized["hit5"][warm].mean()) > 0.65,
        },
        "calibration": {
            "value": ece,
            "statelessValue": stateless_ece,
            "threshold": 0.08,
            "pass": ece <= 0.08 and ece <= stateless_ece + 0.01,
        },
        "cacheEquivalence": {
            "value": cache["logitMaxAbsError"],
            "threshold": 1e-5,
            "pass": cache["logitMaxAbsError"] < 1e-5,
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
        "experiment": "v5-oracle-learned-policy",
        "dataset": {
            "architecture": meta["architecture"],
            "decisions": int(meta["decisions"]),
            "candidates": int(meta["candidates"]),
            "games": int(meta["finishedGames"]),
            "seedBase": int(meta["seedBase"]),
            "missingPlayedActions": int(meta["missingPlayedActions"]),
        },
        "architectures": report,
        "selected": selected,
        "temperature": float(temperature),
        "holdout": {
            "personalized": summarize(personalized, temperature),
            "shuffled": summarize(shuffled, temperature),
            "statelessCalibrated": summarize(stateless, stateless_temperature),
        },
        "cacheEquivalence": cache,
        "splice": {"validation": validation_splice, "holdout": holdout_splice},
        "gates": gates,
        "searchIntegrationAuthorized": all(gate["pass"] for gate in gates.values()),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")

    print(f"\nselected {selected} (temperature {temperature:.2f})")
    print(f"holdout personalized nll {output['holdout']['personalized']['nll']:.4f}")
    print(f"holdout shuffled     nll {output['holdout']['shuffled']['nll']:.4f}")
    for name, gate in gates.items():
        print(f"{'PASS' if gate['pass'] else 'FAIL'} {name}: {json.dumps(gate)}")
    print(f"search integration authorized: {output['searchIntegrationAuthorized']}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
