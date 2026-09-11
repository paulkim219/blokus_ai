#!/usr/bin/env python3
"""Design probe: does randomizing the change point close Experiment L's clock shortcut?

L's gate opened to 0.66 at own turn 6 on games where nothing ever changed, because every switch in
that corpus happened at own move 6. This trains the selected architecture on a corpus whose change
points are drawn per seat, with a quarter of seats never switching, and asks one question:

    does the gate still fire on the clock?

This is a design probe, not an experiment. It has no preregistration, no gates, and no holdout —
its only job is to tell the next protocol whether the corpus fix works before anyone commits to it.
"""

from __future__ import annotations

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
import tensorflow as tf

from train_v5_change_point import (
    EMBED,
    FastSlowGated,
    encode,
    forward,
    pad_batch,
    restore,
    split_trajectories,
    stable_records,
    ensemble_outputs,
    train_arm,
)
from train_v5_player_residual import ContextPopulation, load_raw, pad_raw

WINDOW, GATE_WEIGHT = 8, 0.25


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stable", default="ml/data/v5-oracle-personalities")
    parser.add_argument("--switch", default="ml/data/v5-oracle-switch-randomized")
    parser.add_argument("--checkpoint", default="ml/v5-oracle-player-residual.npz")
    parser.add_argument("--out", default="selfplay-results/v5-oracle-randomized-switch-probe.json")
    parser.add_argument("--epochs", type=int, default=25)
    parser.add_argument("--patience", type=int, default=6)
    parser.add_argument("--sequence-batch", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--family-weight", type=float, default=0.15)
    parser.add_argument("--seed", type=int, default=5901)
    parser.add_argument("--bootstrap", type=int, default=2000)
    return parser.parse_args()


def gate_by_turn(model, trajectories, corpora, size=8, limit=16):
    totals, counts = np.zeros(limit), np.zeros(limit)
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        gates = forward(model, batch)["gate"].numpy()
        for b, item in enumerate(chunk):
            for t in range(1, min(len(item), limit)):
                totals[t] += float(gates[b, t])
                counts[t] += 1
    return [float(totals[t] / counts[t]) if counts[t] else None for t in range(limit)]


def gate_by_offset(model, trajectories, corpora, size=8, span=6):
    """Gate opening relative to each seat's own change point, wherever it fell."""
    totals, counts = np.zeros(span), np.zeros(span)
    for start in range(0, len(trajectories), size):
        chunk = trajectories[start : start + size]
        batch = pad_batch(chunk, corpora)
        gates = forward(model, batch)["gate"].numpy()
        for b, item in enumerate(chunk):
            if item.switch is None:
                continue
            for offset in range(span):
                index = item.switch + offset
                if index < len(item):
                    totals[offset] += float(gates[b, index])
                    counts[offset] += 1
    return [float(totals[o] / counts[o]) if counts[o] else None for o in range(span)]


def main():
    args = parse_args()
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

    switching = [t for t in switch.trajectories if t.switching]
    never = [t for t in switch.trajectories if not t.switching]
    points = np.asarray([t.switch for t in switching])
    print(
        f"corpus: {len(switching)} switching, {len(never)} never-switching "
        f"({len(never) / len(switch.trajectories):.0%}); change points {points.min()}-{points.max()}, "
        f"{len(np.unique(points))} distinct",
        flush=True,
    )

    spec = {"arm": "arm-c", "window": WINDOW, "gateWeight": GATE_WEIGHT, "id": "probe"}
    train_sets = (split_trajectories(stable, 0), split_trajectories(switch, 0))
    validation = split_trajectories(stable, 1) + split_trajectories(switch, 1)
    model, fit = train_arm(spec, checkpoint, train_sets, validation, corpora, args, args.seed)
    print(f"trained {fit['epochsRun']} epochs, best {fit['bestEpoch']}", flush=True)

    eval_stable = split_trajectories(stable, 1)
    eval_switch = split_trajectories(switch, 1)
    turns_stable = gate_by_turn(model, eval_stable, corpora)
    turns_switch = gate_by_turn(model, eval_switch, corpora)
    offsets = gate_by_offset(model, eval_switch, corpora)

    report = {
        "probe": "v5-oracle-randomized-switch",
        "note": "Design probe. No preregistration, no gates, no holdout.",
        "corpus": {
            "switch": args.switch,
            "switching": len(switching),
            "neverSwitching": len(never),
            "changePointMin": int(points.min()),
            "changePointMax": int(points.max()),
            "distinctChangePoints": int(len(np.unique(points))),
        },
        "gateByTurnStable": turns_stable,
        "gateByTurnSwitching": turns_switch,
        "gateByOffsetFromSwitch": offsets,
        "fit": fit,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, default=float)
        handle.write("\n")

    show = list(range(1, 13))
    print("\ngate by own turn    " + " ".join(f"{t:>5}" for t in show))
    print("  stable games      " + " ".join(
        f"{turns_stable[t]:5.2f}" if turns_stable[t] is not None else "    -" for t in show))
    print("  switching games   " + " ".join(
        f"{turns_switch[t]:5.2f}" if turns_switch[t] is not None else "    -" for t in show))
    print("\ngate by offset from each seat's own change point")
    print("  offset            " + " ".join(f"{o:>5}" for o in range(6)))
    print("  gate              " + " ".join(
        f"{offsets[o]:5.2f}" if offsets[o] is not None else "    -" for o in range(6)))
    peak = max(v for v in turns_stable[1:] if v is not None)
    print(f"\npeak gate on stable games: {peak:.2f} (Experiment L: 0.66 at turn 6)")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
