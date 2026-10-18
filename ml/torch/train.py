"""E1/E2: train one architecture arm on a self-play run and report held-out metrics.

    ml/.venv-torch/bin/python ml/torch/train.py --run ml/data/selfplay-v41u-300 \
        --arm vit-patch --train-games 18500 --steps 30000

Splits are by game, never by position (positions within a game are strongly correlated — the v4
programme's "823 rows per game, ~393 independent outcomes"): the last 1,000 games of the run are the
test set, the 500 before them are validation for checkpoint selection, and `--train-games` takes
the first N of the rest, so the data-scaling arms train on nested subsets.

Metrics, all on test games:
- policy KL(visits ‖ model) over the search's candidate set, and top-1 / top-5 agreement with the
  most-visited move (search decisions only);
- value: MSE and R² of the mover's final `score − mean(others)` margin;
- ownership: per-cell accuracy of the final-owner prediction;
- throughput: positions per second, forward only, batch 512, on the training device.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(__file__))
from features import SOURCE, Encoder, Placements, final_owners, policy_mask, value_targets  # noqa: E402
from model import ARMS, cosine, parameter_count  # noqa: E402
from records import load_run  # noqa: E402

VALUE_SCALE = 20.0


def device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


class Data:
    """One run's records, plus optional older runs that only ever contribute training positions.

    Game ids are offset by `RUN_STRIDE` per extra run so they stay unique; the main run keeps its own
    ids, so the test/validation split is always taken from the newest data.
    """

    RUN_STRIDE = 10_000_000

    def __init__(self, run: str, placements: Placements, dev: torch.device, extra_runs: tuple[str, ...] = ()) -> None:
        self.records, self.games = load_run(run)
        self.main_games = int(self.records["game"].max()) + 1 if len(self.records) else 0
        for n, extra in enumerate(extra_runs, start=1):
            records, games = load_run(extra)
            records = records.copy()
            records["game"] = records["game"] + n * self.RUN_STRIDE
            self.records = np.concatenate([self.records, records])
            self.games.update({g + n * self.RUN_STRIDE: v | {"game": g + n * self.RUN_STRIDE} for g, v in games.items()})
        self.values = value_targets(self.records, self.games) / VALUE_SCALE
        owners = final_owners(self.records, placements)
        game_ids = sorted(owners)
        self.game_row = {g: i for i, g in enumerate(game_ids)}
        self.owner_table = torch.tensor(np.stack([owners[g] for g in game_ids]).astype(np.int64), device=dev)
        self.record_owner_row = np.array([self.game_row[int(g)] for g in self.records["game"]], dtype=np.int64)
        self.policy = policy_mask(self.records)
        self.source = torch.tensor(SOURCE, device=dev)
        self.dev = dev
        self.max_game = self.main_games - 1

    def split(self, train_games: int, test_games: int = 1000, val_games: int = 500) -> dict[str, np.ndarray]:
        game = self.records["game"].astype(np.int64)
        total = self.max_game + 1
        test_start = total - test_games
        val_start = test_start - val_games
        if train_games > val_start:
            raise SystemExit(f"--train-games {train_games} overlaps validation (first {val_start} games available)")
        return {
            "train": np.nonzero((game < train_games) | (game >= self.RUN_STRIDE))[0],
            "val": np.nonzero((game >= val_start) & (game < test_start))[0],
            "test": np.nonzero((game >= test_start) & (game < self.RUN_STRIDE))[0],
        }

    def ownership(self, index: np.ndarray) -> torch.Tensor:
        """(B, 400) final-owner class in the mover's frame."""
        board = self.owner_table[torch.tensor(self.record_owner_row[index], device=self.dev)]
        mover = torch.tensor(self.records["seat"][index].astype(np.int64), device=self.dev).view(-1, 1)
        rel = torch.where(board < 0, torch.zeros_like(board), 1 + (board - mover) % 4)
        return rel.gather(1, self.source[mover.view(-1)])


def batch(data: Data, encoder: Encoder, index: np.ndarray):
    records = data.records[index]
    planes, hands = encoder.board(records)
    footprint, pieces, mask, visits = encoder.candidates(records)
    values = torch.tensor(data.values[index], device=encoder.device)
    ownership = data.ownership(index)
    policy = torch.tensor(data.policy[index], device=encoder.device)
    return planes, hands, footprint, pieces, mask, visits, values, ownership, policy


def losses(model, b, weights):
    planes, hands, footprint, pieces, mask, visits, values, ownership, policy = b
    logits, value, owner_logits = model(planes, hands, footprint, pieces, mask)
    target = visits / visits.sum(1, keepdim=True).clamp(min=1)
    log_probs = F.log_softmax(logits, dim=1)
    per_policy = -(target * log_probs.masked_fill(~mask, 0)).sum(1)
    policy_loss = (per_policy * policy).sum() / policy.sum().clamp(min=1)
    value_loss = F.mse_loss(value, values)
    owner_loss = F.cross_entropy(owner_logits.reshape(-1, 5), ownership.reshape(-1))
    total = weights["policy"] * policy_loss + weights["value"] * value_loss + weights["ownership"] * owner_loss
    return total, {"policy": policy_loss.item(), "value": value_loss.item(), "ownership": owner_loss.item()}, (logits, value, owner_logits, target)


@torch.no_grad()
def evaluate(model, data: Data, encoder: Encoder, index: np.ndarray, batch_size: int = 512, limit: int = 40000) -> dict:
    model.eval()
    rng = np.random.default_rng(0)
    if len(index) > limit:
        index = np.sort(rng.choice(index, limit, replace=False))
    kl_sum = top1 = top5 = policy_n = 0.0
    value_err = value_sq = value_mean = value_n = 0.0
    owner_right = owner_n = 0.0
    margins = []
    for start in range(0, len(index), batch_size):
        b = batch(data, encoder, index[start : start + batch_size])
        _, _, (logits, value, owner_logits, target) = losses(model, b, {"policy": 1, "value": 1, "ownership": 1})
        mask, policy, values, ownership = b[4], b[8], b[6], b[7]
        log_probs = F.log_softmax(logits, dim=1)
        kl = (target * (torch.log(target.clamp(min=1e-12)) - log_probs)).masked_fill(~mask, 0).sum(1)
        best = target.argmax(1)
        ranked = logits.topk(min(5, logits.shape[1]), dim=1).indices
        kl_sum += (kl * policy).sum().item()
        top1 += ((ranked[:, 0] == best).float() * policy).sum().item()
        top5 += ((ranked == best.unsqueeze(1)).any(1).float() * policy).sum().item()
        policy_n += policy.sum().item()
        mover_pred, mover_true = value[:, 0] * VALUE_SCALE, values[:, 0] * VALUE_SCALE
        value_err += ((mover_pred - mover_true) ** 2).sum().item()
        margins.append(mover_true.cpu().numpy())
        value_n += len(mover_true)
        owner_right += (owner_logits.argmax(-1) == ownership).float().sum().item()
        owner_n += ownership.numel()
    variance = float(np.var(np.concatenate(margins)))
    mse = value_err / value_n
    model.train()
    return {
        "policyKL": kl_sum / max(1, policy_n),
        "top1": top1 / max(1, policy_n),
        "top5": top5 / max(1, policy_n),
        "valueMSE": mse,
        "valueR2": 1 - mse / variance if variance > 0 else 0.0,
        "ownershipAcc": owner_right / owner_n,
        "positions": int(value_n),
        "policyPositions": int(policy_n),
    }


@torch.no_grad()
def throughput(model, data: Data, encoder: Encoder, index: np.ndarray, batch_size: int = 512, rounds: int = 10) -> float:
    model.eval()
    b = batch(data, encoder, index[:batch_size])
    args = b[:5]
    for _ in range(3):
        model(*args)
    if encoder.device.type == "mps":
        torch.mps.synchronize()
    started = time.perf_counter()
    for _ in range(rounds):
        model(*args)
    if encoder.device.type == "mps":
        torch.mps.synchronize()
    model.train()
    return batch_size * rounds / (time.perf_counter() - started)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", default="ml/data/selfplay-v41u-300")
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--arm", choices=sorted(ARMS), required=True)
    parser.add_argument("--train-games", type=int, required=True)
    parser.add_argument("--steps", type=int, default=20000)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=None)
    parser.add_argument("--eval-every", type=int, default=2000)
    parser.add_argument("--ownership-weight", type=float, default=0.25)
    parser.add_argument("--out", default="ml/torch/results")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--test-games", type=int, default=1000)
    parser.add_argument("--val-games", type=int, default=500)
    parser.add_argument("--extra-runs", nargs="*", default=[], help="older runs, training positions only")
    parser.add_argument("--init", default=None, help="warm-start from this checkpoint")
    parser.add_argument("--name", default=None)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    dev = device()
    placements = Placements(args.placements)
    encoder = Encoder(placements, dev)
    data = Data(args.run, placements, dev, tuple(args.extra_runs))
    splits = data.split(args.train_games, args.test_games, args.val_games)
    print(f"device {dev}; records {len(data.records)}; train {len(splits['train'])} val {len(splits['val'])} test {len(splits['test'])}", flush=True)

    model = ARMS[args.arm]().to(dev)
    if args.init:
        checkpoint = torch.load(args.init, map_location=dev)
        if checkpoint["arm"] != args.arm:
            raise SystemExit(f"--init is a {checkpoint['arm']} checkpoint, not {args.arm}")
        model.load_state_dict(checkpoint["state"])
    lr = args.lr if args.lr is not None else (1e-3 if args.arm in ("conv-small", "resnet") else 3e-4)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    weights = {"policy": 1.0, "value": 1.0, "ownership": args.ownership_weight}
    name = args.name or f"{args.arm}-g{args.train_games}-s{args.seed}"
    os.makedirs(args.out, exist_ok=True)
    print(f"{name}: {parameter_count(model):,} parameters, lr {lr}", flush=True)

    rng = np.random.default_rng(args.seed)
    train = splits["train"]
    best_val, best_state, best_step, history = float("inf"), None, 0, []
    started = time.time()
    for step in range(args.steps):
        for group in optimizer.param_groups:
            group["lr"] = lr * cosine(step, args.steps, warmup=500)
        b = batch(data, encoder, rng.choice(train, args.batch))
        loss, parts, _ = losses(model, b, weights)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            val = evaluate(model, data, encoder, splits["val"], limit=15000)
            # Selection on the sum the model is trained on, so no single head picks the checkpoint.
            score = val["policyKL"] + val["valueMSE"] / VALUE_SCALE**2
            history.append({"step": step + 1, "train": parts, "val": val, "seconds": round(time.time() - started)})
            print(f"{name} step {step + 1}: train {parts} | val KL {val['policyKL']:.3f} top1 {val['top1']:.3f} "
                  f"R2 {val['valueR2']:.3f} own {val['ownershipAcc']:.3f} | {time.time() - started:.0f}s", flush=True)
            if score < best_val:
                best_val, best_step = score, step + 1
                best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    test = evaluate(model, data, encoder, splits["test"])
    speed = throughput(model, data, encoder, splits["test"])
    result = {
        "arm": args.arm,
        "trainGames": args.train_games,
        "trainPositions": int(len(train)),
        "parameters": parameter_count(model),
        "steps": args.steps,
        "bestStep": best_step,
        "test": test,
        "positionsPerSecond": speed,
        "history": history,
        "seconds": round(time.time() - started),
    }
    with open(os.path.join(args.out, f"{name}.json"), "w") as handle:
        json.dump(result, handle, indent=1)
    torch.save({"arm": args.arm, "state": best_state}, os.path.join(args.out, f"{name}.pt"))
    print(json.dumps({k: v for k, v in result.items() if k != "history"}, indent=1), flush=True)


if __name__ == "__main__":
    main()
