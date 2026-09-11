"""Evaluate saved v4.5 pooled checkpoints and their pre-specified mean-logit ensemble."""

import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np

from probe_action_spatial import build_pooled, groups, load, metrics, pack, predict


def canonicalize(raw, target, meta):
    seat_at = meta["targets"].index("seat")
    seats = target[:, seat_at].astype(np.int8)
    out = raw.copy()
    for seat in range(4):
        selected = seats == seat
        if seat == 1:
            out[selected] = raw[selected, ::-1, :]
        elif seat == 2:
            out[selected] = raw[selected, ::-1, ::-1]
        elif seat == 3:
            out[selected] = raw[selected, :, ::-1]
    return out


def pack_spatial(raw, index, max_k):
    board = np.zeros((len(index), 20, 20, 4), np.float32)
    action = np.zeros((len(index), max_k, 20, 20, 1), np.float32)
    for row, selected in enumerate(index):
        parent = raw[selected[0]]
        board[row] = np.stack([parent == owner for owner in range(1, 5)], axis=-1)
        action[row, :len(selected), ..., 0] = raw[selected] == 5
    return board, action


def cross_entropy(pred, mask, mass, temperature):
    total = 0.0
    roots = 0
    for row in range(len(pred)):
        k = int(mask[row].sum())
        target = mass[row, :k]
        target_sum = target.sum()
        if k < 2 or target_sum <= 0:
            continue
        logits = pred[row, :k] / temperature
        logits -= logits.max()
        logp = logits - np.log(np.exp(logits).sum())
        total -= float(np.sum(target / target_sum * logp))
        roots += 1
    return total / max(roots, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", required=True)
    ap.add_argument("--weights", required=True, help="comma-separated pooled checkpoint NPZ files")
    ap.add_argument("--max-k", type=int, default=12)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--out")
    args = ap.parse_args()

    meta, features, y, raw_planes = load([args.holdout])
    policy_at = meta["targets"].index("policy")
    index = groups(y, args.max_k)
    mask = pack(np.zeros(len(y), np.float32), index, args.max_k, ())[1]
    mass, _ = pack(y[:, policy_at], index, args.max_k, ())
    logits, _ = pack(np.log(np.maximum(y[:, policy_at], 1e-8)), index, args.max_k, ())
    board, action = pack_spatial(canonicalize(raw_planes, y, meta), index, args.max_k)

    predictions = []
    results = {"holdoutGroups": len(index), "members": []}
    for path in args.weights.split(','):
        saved = np.load(path)
        mean, scale = saved["mean"], saved["scale"]
        vector, _ = pack(((features - mean) / scale).astype(np.float32), index, args.max_k,
                         (features.shape[1],))
        model = build_pooled(features.shape[1], args.max_k, args.width)
        weights = [saved[f"weight_{at}"] for at in range(len(saved.files) - 2)]
        model.set_weights(weights)
        pred = predict(model, [board, action, vector], mask, True)
        predictions.append(pred)
        score = metrics(pred, mask, logits, mass)
        results["members"].append({"path": path, "pair": score[0], "top1": score[1],
                                   "regret": score[2]})

    ensemble = metrics(np.mean(predictions, axis=0), mask, logits, mass)
    results["ensemble"] = {"pair": ensemble[0], "top1": ensemble[1], "regret": ensemble[2]}
    mean_prediction = np.mean(predictions, axis=0)
    phase_rows = {"opening": [], "midgame": [], "endgame": []}
    for row, selected in enumerate(index):
        phase = ("opening" if features[selected[0], 80] > 0.5 else
                 "midgame" if features[selected[0], 81] > 0.5 else "endgame")
        phase_rows[phase].append(row)
    results["ensembleByPhase"] = {}
    for phase, selected in phase_rows.items():
        selected = np.asarray(selected, np.int64)
        score = metrics(mean_prediction[selected], mask[selected], logits[selected], mass[selected])
        results["ensembleByPhase"][phase] = {
            "roots": len(selected), "pair": score[0], "top1": score[1], "regret": score[2]
        }
    results["temperatureCrossEntropy"] = {
        str(temp): cross_entropy(mean_prediction, mask, mass, temp)
        for temp in (0.5, 0.75, 1, 1.5, 2, 3, 4)
    }
    print(json.dumps(results, indent=2))
    if args.out:
        with open(args.out, "w") as handle:
            json.dump(results, handle, indent=2)
            handle.write("\n")


if __name__ == "__main__":
    main()
