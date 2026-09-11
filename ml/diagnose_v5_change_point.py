#!/usr/bin/env python3
"""Post-hoc diagnosis of Experiment L's two failed development gates.

The protocol permits diagnosis on consumed data. Variant `c` is development data, already read,
so nothing here touches the sealed variant `e` and nothing may change the recorded verdict.

Two questions the confirmation numbers cannot answer on their own:

  1. Stable retention degraded from +0.016 on variant `b` to +0.175 on variant `c`. How much of
     that is the temperature selected on `b`, and how much is genuine degradation?
  2. The fast/slow gate is supposed to stay shut on stable history. Does it?
"""

from __future__ import annotations

import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

from train_v5_change_point import (
    EMBED,
    TEMPERATURES,
    FastSlowGated,
    SwitchTrainedGru,
    encode,
    ensemble_outputs,
    forward,
    pad_batch,
    restore,
    split_trajectories,
    stable_records,
)
from train_v5_player_residual import ContextPopulation, load_raw, pad_raw

SEEDS = (5901, 5902, 5903)
WINDOW, GATE_WEIGHT = 8, 0.25


def load_ensemble(path):
    store = np.load(path)
    models = []
    for seed in SEEDS:
        model = FastSlowGated(WINDOW, GATE_WEIGHT)
        model.build_from(np.load("ml/v5-oracle-player-residual.npz"))
        for index, weight in enumerate(model.weights):
            weight.assign(store[f"seed{seed}_{index}"])
        models.append(model)
    return models


def gate_activity(models, trajectories, corpora, size=8):
    """Mean gate opening, split by whether the seat's objective ever changes."""
    stable_values, pre, post = [], [], []
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        gates = np.mean([forward(model, batch)["gate"].numpy() for model in models], axis=0)
        for b, item in enumerate(chunk):
            for t in range(1, len(item)):
                value = float(gates[b, t])
                if item.switch is None:
                    stable_values.append(value)
                elif t < item.switch:
                    pre.append(value)
                else:
                    post.append(value)
    return {
        "stableTrajectories": float(np.mean(stable_values)) if stable_values else None,
        "beforeSwitch": float(np.mean(pre)) if pre else None,
        "afterSwitch": float(np.mean(post)) if post else None,
    }


def gate_by_turn(models, stable_traj, switch_traj, corpora, size=8, limit=18):
    """Every switch in the corpus happens at own turn 6. Did the gate learn the clock instead?"""
    def profile(trajectories):
        totals = np.zeros(limit)
        counts = np.zeros(limit)
        for start in range(0, len(trajectories), size):
            chunk = trajectories[start : start + size]
            batch = pad_batch(chunk, corpora)
            gates = np.mean([forward(model, batch)["gate"].numpy() for model in models], axis=0)
            for b, item in enumerate(chunk):
                for t in range(1, min(len(item), limit)):
                    totals[t] += float(gates[b, t])
                    counts[t] += 1
        return [float(totals[t] / counts[t]) if counts[t] else None for t in range(limit)]

    return {"stable": profile(stable_traj), "switching": profile(switch_traj)}


def main():
    checkpoint = np.load("ml/v5-oracle-player-residual.npz")
    population = ContextPopulation()
    probe = load_raw("ml/data/v5-oracle-personalities", "v5-oracle-strategic-personality-trajectories-v4")
    candidate, mask, states, boards, _ = pad_raw(np.arange(2, dtype=np.int64), probe)
    population(tf.constant(candidate), tf.constant(mask), tf.constant(states), tf.constant(boards))
    restore(checkpoint, "population", population)
    del probe

    stable = encode(
        population, "ml/data/v5-oracle-personalities",
        "v5-oracle-strategic-personality-trajectories-v4", "stable",
    )
    switch = encode(
        population, "ml/data/v5-oracle-l-dev-switch",
        "v5-oracle-personality-switch-trajectories-v6", "switch",
    )
    corpora = {"stable": stable, "switch": switch}

    models = load_ensemble("ml/v5-oracle-change-point.npz")
    frozen = SwitchTrainedGru(0.0)
    frozen.build_from(checkpoint)

    report = {"experiment": "v5-oracle-change-point-diagnosis", "holdoutOpened": False, "splits": {}}
    # Split indices follow the corpus: 0=a, 1=b, 2=c. The retrained ensemble saw a+b, so only
    # variant c is a clean read for it; b is reported purely to show the training-set contrast.
    for index, name in ((1, "b (in retraining set)"), (2, "c (clean)")):
        stable_split = split_trajectories(stable, index)
        candidate_out = ensemble_outputs(models, stable_split, corpora)
        frozen_out = ensemble_outputs([frozen], stable_split, corpora)
        curve = {}
        for temperature in TEMPERATURES:
            curve[str(temperature)] = {
                "candidate": float(stable_records(candidate_out, temperature)["nll"].mean()),
                "frozenK": float(stable_records(frozen_out, temperature)["nll"].mean()),
            }
        best_candidate = min(curve.values(), key=lambda entry: entry["candidate"])["candidate"]
        best_frozen = min(curve.values(), key=lambda entry: entry["frozenK"])["frozenK"]
        report["splits"][name] = {
            "stableNllByTemperature": curve,
            "candidateAtProtocolTemperature": curve["0.8"]["candidate"],
            "frozenKAtProtocolTemperature": curve["1.25"]["frozenK"],
            "gapAtProtocolTemperatures": curve["0.8"]["candidate"] - curve["1.25"]["frozenK"],
            "bestCandidate": best_candidate,
            "bestFrozenK": best_frozen,
            "gapAtEachOwnBest": best_candidate - best_frozen,
            "gateActivity": gate_activity(
                models, stable_split + split_trajectories(switch, index), corpora
            ),
            "gateByTurn": gate_by_turn(
                models, stable_split, split_trajectories(switch, index), corpora
            ),
        }
        entry = report["splits"][name]
        print(f"variant {name}")
        print(f"  candidate @T0.80 {entry['candidateAtProtocolTemperature']:.4f}")
        print(f"  frozen K  @T1.25 {entry['frozenKAtProtocolTemperature']:.4f}")
        print(f"  gap at protocol temperatures {entry['gapAtProtocolTemperatures']:+.4f}")
        print(f"  gap with each at its own best temperature {entry['gapAtEachOwnBest']:+.4f}")
        print(f"  gate: {json.dumps(entry['gateActivity'])}")
        turns = entry["gateByTurn"]
        show = [t for t in range(1, 13)]
        print("  gate by own turn   " + " ".join(f"{t:>5}" for t in show))
        print("    stable games     " + " ".join(
            f"{turns['stable'][t]:5.2f}" if turns["stable"][t] is not None else "    -" for t in show))
        print("    switching games  " + " ".join(
            f"{turns['switching'][t]:5.2f}" if turns["switching"][t] is not None else "    -" for t in show))

    with open("selfplay-results/v5-oracle-change-point-diagnosis.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, default=float)
        handle.write("\n")
    print("\nwrote selfplay-results/v5-oracle-change-point-diagnosis.json")


if __name__ == "__main__":
    main()
