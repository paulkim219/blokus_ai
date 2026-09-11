#!/usr/bin/env python3
"""Fit the v4.1 canonical rollout policy on counterfactual terminal-return groups."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


PHASES = ("opening", "midgame", "endgame")
ALPHAS = (1e-4, 1e-3, 1e-2, 1e-1, 1.0, 10.0, 100.0)
BLENDS = (0.0, 0.25, 0.5, 0.75, 1.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="ml/data/v41-rollout-policy")
    parser.add_argument("--out", default="ml/v41-rollout-policy.json")
    return parser.parse_args()


def centred(values: np.ndarray, groups: np.ndarray) -> np.ndarray:
    result = values.astype(np.float64, copy=True)
    for group in np.unique(groups):
        mask = groups == group
        result[mask] -= result[mask].mean(axis=0)
    return result


def ridge(x: np.ndarray, y: np.ndarray, alpha: float) -> np.ndarray:
    gram = x.T @ x
    return np.linalg.solve(gram + np.eye(gram.shape[0]) * alpha, x.T @ y)


def group_metrics(
    predictions: np.ndarray,
    targets: np.ndarray,
    groups: np.ndarray,
) -> dict[str, float]:
    regrets: list[float] = []
    top1 = 0
    for group in np.unique(groups):
        mask = np.flatnonzero(groups == group)
        chosen = mask[int(np.argmax(predictions[mask]))]
        best = float(np.max(targets[mask]))
        regrets.append(best - float(targets[chosen]))
        top1 += int(float(targets[chosen]) >= best - 1e-9)
    count = max(1, len(regrets))
    return {
        "groups": float(len(regrets)),
        "regret": float(np.mean(regrets)) if regrets else 0.0,
        "top1": top1 / count,
    }


def split_games(games: np.ndarray) -> tuple[set[int], set[int], set[int]]:
    unique = sorted(int(game) for game in np.unique(games))
    if len(unique) < 9:
        raise ValueError("v4.1 needs at least nine source games for game-disjoint splits")
    holdout_n = max(2, round(len(unique) * 0.17))
    validation_n = max(2, round(len(unique) * 0.17))
    holdout = set(unique[-holdout_n:])
    validation = set(unique[-holdout_n - validation_n : -holdout_n])
    train = set(unique) - validation - holdout
    return train, validation, holdout


def mask_for(games: np.ndarray, selected: set[int]) -> np.ndarray:
    return np.isin(games.astype(np.int64), np.asarray(sorted(selected), dtype=np.int64))


def main() -> None:
    args = parse_args()
    prefix = Path(args.data)
    meta = json.loads(prefix.with_suffix(".meta.json").read_text())
    feature_count = int(meta["featureCount"])
    target_width = int(meta["targetWidth"])
    x = np.fromfile(prefix.with_suffix(".x.f32"), dtype=np.float32).reshape(-1, feature_count)
    raw_y = np.fromfile(prefix.with_suffix(".y.f32"), dtype=np.float32).reshape(-1, target_width)
    games = raw_y[:, 0].astype(np.int64)
    groups = raw_y[:, 1].astype(np.int64)
    phases = raw_y[:, 2].astype(np.int64)
    targets = raw_y[:, 3].astype(np.float64)
    incumbent = raw_y[:, 4].astype(np.float64)
    train_games, validation_games, holdout_games = split_games(games)
    split_masks = {
        "train": mask_for(games, train_games),
        "validation": mask_for(games, validation_games),
        "holdout": mask_for(games, holdout_games),
    }

    weights: list[np.ndarray] = []
    selected_alphas: list[float] = []
    phase_diagnostics: dict[str, dict[str, float]] = {}
    predictions = np.zeros(len(targets), dtype=np.float64)

    for phase_index, phase_name in enumerate(PHASES):
        phase_mask = phases == phase_index
        train_mask = split_masks["train"] & phase_mask
        validation_mask = split_masks["validation"] & phase_mask
        if train_mask.sum() < feature_count or validation_mask.sum() == 0:
            raise ValueError(f"insufficient rows for {phase_name}")

        x_train = centred(x[train_mask], groups[train_mask])
        y_train = centred(targets[train_mask], groups[train_mask])
        scale = x_train.std(axis=0)
        scale[scale < 1e-6] = 1.0
        x_train_scaled = x_train / scale

        x_validation = centred(x[validation_mask], groups[validation_mask]) / scale
        y_validation = centred(targets[validation_mask], groups[validation_mask])
        best_alpha = ALPHAS[0]
        best_weight = ridge(x_train_scaled, y_train, best_alpha)
        best_mse = float(np.mean((x_validation @ best_weight - y_validation) ** 2))
        for alpha in ALPHAS[1:]:
            candidate = ridge(x_train_scaled, y_train, alpha)
            mse = float(np.mean((x_validation @ candidate - y_validation) ** 2))
            if mse < best_mse:
                best_alpha = alpha
                best_weight = candidate
                best_mse = mse

        raw_weight = best_weight / scale
        learned_train = x[train_mask] @ raw_weight
        learned_centered = centred(learned_train, groups[train_mask])
        incumbent_centered = centred(incumbent[train_mask], groups[train_mask])
        learned_std = float(learned_centered.std())
        incumbent_std = float(incumbent_centered.std())
        score_rescale = incumbent_std / max(1e-8, learned_std)
        raw_weight *= score_rescale
        weights.append(raw_weight)
        selected_alphas.append(best_alpha)
        predictions[phase_mask] = x[phase_mask] @ raw_weight
        phase_diagnostics[phase_name] = {
            "alpha": best_alpha,
            "validationCenteredMse": best_mse,
            "scoreRescale": score_rescale,
            "trainRows": float(train_mask.sum()),
            "validationRows": float(validation_mask.sum()),
        }

    validation_mask = split_masks["validation"]
    best_blend = BLENDS[0]
    best_validation = group_metrics(incumbent, targets, groups)
    best_validation = group_metrics(
        incumbent[validation_mask], targets[validation_mask], groups[validation_mask]
    )
    blend_diagnostics: dict[str, dict[str, float]] = {}
    for blend in BLENDS:
        combined = incumbent * (1.0 - blend) + predictions * blend
        metrics = group_metrics(
            combined[validation_mask], targets[validation_mask], groups[validation_mask]
        )
        blend_diagnostics[str(blend)] = metrics
        if (metrics["regret"], -metrics["top1"], blend) < (
            best_validation["regret"],
            -best_validation["top1"],
            best_blend,
        ):
            best_blend = blend
            best_validation = metrics

    diagnostics: dict[str, object] = {
        "selectedAlphas": selected_alphas,
        "selectedBlend": best_blend,
        "phase": phase_diagnostics,
        "validationByBlend": blend_diagnostics,
        "splits": {
            "trainGames": sorted(train_games),
            "validationGames": sorted(validation_games),
            "holdoutGames": sorted(holdout_games),
        },
    }
    for split_name, split_mask in split_masks.items():
        combined = incumbent * (1.0 - best_blend) + predictions * best_blend
        diagnostics[split_name] = {
            "incumbent": group_metrics(
                incumbent[split_mask], targets[split_mask], groups[split_mask]
            ),
            "learned": group_metrics(
                predictions[split_mask], targets[split_mask], groups[split_mask]
            ),
            "selected": group_metrics(
                combined[split_mask], targets[split_mask], groups[split_mask]
            ),
            "rows": int(split_mask.sum()),
        }

    artifact = {
        "kind": "canonical-rollout-policy-v41",
        "featureCount": feature_count,
        "featureNames": meta["featureNames"],
        "weights": [weight.tolist() for weight in weights],
        "blend": best_blend,
        "meta": {
            "source": str(prefix),
            "target": "counterfactualMoverBackedTerminalValue",
            "diagnostics": diagnostics,
        },
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, indent=2) + "\n")
    print(json.dumps(diagnostics, indent=2))
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()

