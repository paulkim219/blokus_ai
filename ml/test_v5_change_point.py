#!/usr/bin/env python3
"""Unit tests required by the Experiment L protocol before variant `e` may be exported.

Covers: causal shifting, time-varying labels, fast-window truncation, frozen slow weights, gate
inputs, paired whole-game bootstrap, and exact fallback. Runs without pytest:

    PYTHONPATH=ml ml/.venv/bin/python ml/test_v5_change_point.py
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

from train_v5_change_point import (
    EMBED,
    FAMILIES,
    GATE_WINDOW,
    FastSlowGated,
    SwitchTrainedGru,
    Trajectory,
    bootstrap,
    build_trajectories,
    causal_history,
    forbid_holdout,
    materialize,
    observed_mask,
    residual_from_latent,
    window_stack,
)

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"  pass  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


def test_causal_shift():
    print("causal shifting")
    actual = tf.constant(np.arange(1, 5, dtype=np.float32).reshape(1, 4, 1) * np.ones((1, 4, EMBED), np.float32))
    shifted = causal_history(actual).numpy()[0]
    check("turn 0 sees nothing", np.allclose(shifted[0], 0.0))
    check("turn t sees exactly turn t-1", np.allclose(shifted[1:], actual.numpy()[0, :-1]))
    mask = observed_mask(tf.ones((1, 4))).numpy()[0]
    check("identity loss skips turn 0", mask[0] == 0.0 and np.all(mask[1:] == 1.0))


def test_window_truncation():
    print("fast-window truncation")
    # Test the composed behaviour the model actually uses: real actions, causally shifted, then
    # windowed. Decision t must see exactly actions t-3 .. t-1 and nothing else.
    actual = tf.constant(
        (np.arange(6, dtype=np.float32) + 1).reshape(1, 6, 1) * np.ones((1, 6, EMBED), np.float32)
    )
    history = causal_history(actual)
    windows, valid = window_stack(history, 3)
    windows, valid = windows.numpy()[0], valid.numpy()[0]
    actions = actual.numpy()[0, :, 0]
    check("window length is bounded", windows.shape[1] == 3)
    check("turn 0 has no valid step", valid[0].sum() == 0.0, f"got {valid[0].sum()}")
    check("turn 1 sees one action", valid[1].sum() == 1.0, f"got {valid[1].sum()}")
    check("turn 2 sees two actions", valid[2].sum() == 2.0, f"got {valid[2].sum()}")
    check("turn 5 sees only three actions", valid[5].sum() == 3.0)
    visible = windows[5][valid[5] > 0][:, 0]
    check(
        "turn 5 sees exactly actions 3, 4 and 5",
        np.allclose(np.sort(visible), actions[2:5]),
        f"got {np.sort(visible)} want {actions[2:5]}",
    )
    check("the action played at turn 5 is never visible", actions[5] not in set(visible.tolist()))
    check("an action older than the window is dropped", actions[1] not in set(visible.tolist()))


def test_time_varying_labels():
    print("time-varying labels")
    decisions = np.zeros((8, 9), np.int32)
    for row in range(8):
        decisions[row, 0] = 0          # game
        decisions[row, 2] = 0          # seat
        decisions[row, 4] = row        # turn
        decisions[row, 1] = 0 if row < 6 else 1
        decisions[row, 8] = 0
    meta = {
        "profileSources": [
            {"index": 0, "family": "blocker"},
            {"index": 1, "family": "tempo"},
        ]
    }
    trajectories = build_trajectories(meta, decisions, "switch")
    check("one seat stays one trajectory", len(trajectories) == 1)
    item = trajectories[0]
    check("change point is the sixth own move", item.switch == 6, f"got {item.switch}")
    check("labels vary within the trajectory", len(set(item.families.tolist())) == 2)
    check(
        "pre-switch label is the initial family",
        item.families[0] == FAMILIES.index("blocker"),
    )
    check("post-switch label is the new family", item.families[6] == FAMILIES.index("tempo"))
    check("stable trajectories report no switch", build_trajectories(
        {"profileSources": [{"index": 0, "family": "blocker"}]},
        np.zeros((5, 9), np.int32),
        "stable",
    )[0].switch is None)


def test_gate_target_window():
    print("gate auxiliary target")
    switch, length = 6, 20
    flags = [1.0 if switch <= t < switch + GATE_WINDOW else 0.0 for t in range(length)]
    check("gate target is zero before the switch", sum(flags[:switch]) == 0.0)
    check("gate target covers exactly eight observations", sum(flags) == GATE_WINDOW)
    check("gate target returns to zero afterwards", flags[switch + GATE_WINDOW] == 0.0)


def test_frozen_slow_path():
    print("frozen slow path")
    checkpoint = np.load("ml/v5-oracle-player-residual.npz")
    model = FastSlowGated(window=4, gate_weight=0.25)
    model.build_from(checkpoint)
    slow_names = {id(weight) for weight in model.slow.weights}
    trainable = {id(weight) for weight in model.trainable_variables}
    check("no slow weight is trainable", not (slow_names & trainable))
    check("the model is fully built", len(model.fast.weights) > 0 and len(model.gate.weights) > 0)
    check("the fast path is trainable", any(id(w) in trainable for w in model.fast.weights))
    check("the gate is trainable", any(id(w) in trainable for w in model.gate.weights))
    before = [weight.numpy().copy() for weight in model.slow.weights]
    embedding = tf.random.stateless_normal((2, 3, 5, EMBED), seed=(1, 2))
    base = tf.zeros((2, 3, 5))
    targets = tf.zeros((2, 3), tf.int32)
    time_mask = tf.ones((2, 3))
    with tf.GradientTape() as tape:
        out = model(embedding, base, targets, time_mask, tf.zeros((2, 3)))
        loss = tf.reduce_mean(out["logits"])
    variables = model.trainable_variables
    gradients = tape.gradient(loss, variables)
    tf.keras.optimizers.Adam(1e-2).apply_gradients(zip(gradients, variables))
    after = [weight.numpy() for weight in model.slow.weights]
    check("slow weights are unchanged after a step", all(
        np.array_equal(a, b) for a, b in zip(before, after)
    ))


def test_slow_path_is_k():
    print("slow path identity with Experiment K")
    checkpoint = np.load("ml/v5-oracle-player-residual.npz")
    reference = SwitchTrainedGru(0.0)
    reference.build_from(checkpoint)
    gated = FastSlowGated(window=8, gate_weight=0.25)
    gated.build_from(checkpoint)
    same = all(
        np.array_equal(a.numpy(), b.numpy())
        for a, b in zip(reference.inner.weights, gated.slow.weights)
    )
    check("slow weights match the K checkpoint slot for slot", same)
    embedding = tf.random.stateless_normal((2, 5, 9, EMBED), seed=(21, 22))
    base = tf.random.stateless_normal((2, 5, 9), seed=(23, 24))
    targets = tf.zeros((2, 5), tf.int32)
    time_mask = tf.ones((2, 5))
    k_out = reference(embedding, base, targets, time_mask)
    # Forcing the gate shut must reproduce K exactly: that is what "frozen slow path" means.
    gated_out = gated(embedding, base, targets, time_mask, tf.zeros((2, 5)))
    original = gated.gate
    gated.gate = lambda value: tf.fill(tf.concat([tf.shape(value)[:-1], [1]], axis=0), -30.0)
    shut = gated(embedding, base, targets, time_mask, tf.zeros((2, 5)))
    gated.gate = original
    difference = float(np.max(np.abs(shut["logits"].numpy() - k_out["logits"].numpy())))
    check("gate shut reproduces K's logits", difference < 1e-4, f"max diff {difference:.2e}")


def test_gate_inputs():
    print("gate inputs")
    model = FastSlowGated(window=4, gate_weight=0.10)
    checkpoint = np.load("ml/v5-oracle-player-residual.npz")
    model.build_from(checkpoint)
    embedding = tf.random.stateless_normal((2, 4, 6, EMBED), seed=(3, 4))
    base = tf.zeros((2, 4, 6))
    targets = tf.zeros((2, 4), tf.int32)
    time_mask = tf.ones((2, 4))
    low = model(embedding, base, targets, time_mask, tf.zeros((2, 4)))
    high = model(embedding, base, targets, time_mask, tf.fill((2, 4), 5.0))
    check("gate is bounded in [0,1]", float(tf.reduce_min(low["gate"])) >= 0.0
          and float(tf.reduce_max(low["gate"])) <= 1.0)
    check("gate reads the fixed-model surprise input",
          not np.allclose(low["gate"].numpy(), high["gate"].numpy()))
    check("gate is zero at turn 0", float(low["gate"][0, 0]) == 0.0)


def test_exact_fallback():
    print("exact fallback")
    checkpoint = np.load("ml/v5-oracle-player-residual.npz")
    for model in (SwitchTrainedGru(1e-4), FastSlowGated(window=8, gate_weight=0.25)):
        model.build_from(checkpoint)
        embedding = tf.random.stateless_normal((2, 3, 7, EMBED), seed=(5, 6))
        zero = tf.zeros((2, 3, EMBED))
        residual = residual_from_latent(model, embedding, zero).numpy()
        check(
            f"{type(model).__name__}: empty history adds no residual",
            float(np.max(np.abs(residual))) <= 1e-6,
            f"max {np.max(np.abs(residual)):.2e}",
        )


def test_paired_bootstrap():
    print("paired whole-game bootstrap")
    rng = np.random.default_rng(0)
    games = np.repeat(np.arange(20), 5)
    values = rng.normal(1.0, 0.1, size=len(games))
    other = values - 0.25
    point, low, high = bootstrap(values, games, 2000, 1234, paired=(other, games))
    check("paired difference recovers the offset", abs(point - 0.25) < 1e-9, f"got {point}")
    check("interval brackets the point estimate", low <= point <= high)
    single, slow_, shigh = bootstrap(values, games, 2000, 1234)
    check("unpaired estimate is the plain mean", abs(single - values.mean()) < 1e-9)
    constant = bootstrap(np.ones(50), np.repeat(np.arange(10), 5), 500, 7)
    check("a constant metric has a degenerate interval", constant[1] == constant[2] == 1.0)


def test_holdout_seal():
    print("holdout seal")
    for path in (
        "ml/data/v5-oracle-l-holdout-stable",
        "ml/data/v5-oracle-l-holdout-switch",
    ):
        try:
            forbid_holdout(path)
            check(f"refuses {os.path.basename(path)}", False, "no error raised")
        except SystemExit:
            check(f"refuses {os.path.basename(path)}", True)
    try:
        forbid_holdout("ml/data/v5-oracle-l-dev-switch", "ml/data/v5-oracle-personalities")
        check("allows development corpora", True)
    except SystemExit:
        check("allows development corpora", False)


def main():
    tf.keras.utils.set_random_seed(11)
    test_causal_shift()
    test_window_truncation()
    test_time_varying_labels()
    test_gate_target_window()
    test_frozen_slow_path()
    test_slow_path_is_k()
    test_gate_inputs()
    test_exact_fallback()
    test_paired_bootstrap()
    test_holdout_seal()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failing check(s): {', '.join(FAILURES)}")
        sys.exit(1)
    print("all Experiment L implementation checks passed")


if __name__ == "__main__":
    main()
