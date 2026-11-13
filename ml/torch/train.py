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

Model-v2 arms (`resnet2-*`, E5) train more heads (see `losses2` for the loss and its weights), use
batch 512 and an exponential moving average of the weights by default, select the checkpoint on the
weighted validation loss, and save the EMA weights. They add test metrics for each new head: soft
policy KL, Brier score of the margin / rank / first utilities, and the search-value head's R². The
v1 arms keep their old defaults and code path.
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
from features import (  # noqa: E402
    SOURCE, Encoder, Placements, final_owners, policy_mask, search_value_targets, utility_targets, value_targets,
)
from model import ARMS, UTILITY_KINDS, V2_ARMS, cosine, model_version, parameter_count  # noqa: E402
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
        self.utility = utility_targets(self.records, self.games)
        self.search_value, self.searched = search_value_targets(self.records)
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


# ---- model v2 (E5) -------------------------------------------------------------------------------

# Loss weights for the v2 heads. Policy, margins and ownership keep the v1 weights (1, 1, 0.25), so the
# trunk sees the same pressure from them as before. The rest were chosen, not tuned:
# - soft policy 1.0: an auxiliary on the same visits. In this corpus every candidate has visits, so
#   target^(1/4) is nearly uniform (KL to uniform 0.036 nats on the test games) and its gradient is
#   far smaller than the main policy's at equal weight; 1.0 keeps the head trained without KataGo's
#   8×, which assumes many zero-visit moves;
# - utility margin and rank 0.5 each (BCE, mean over the four seats), first 0.25 (cross-entropy over
#   the four seats): three views of one noisy outcome, together about 1.25 so the outcome signal
#   does not outweigh the policy;
# - search value 2.0 × Huber(δ = 0.5) in units of 20 squares: in the quadratic region (|error| < 10
#   squares, ~95% of positions) that equals weight 1 on an MSE, like the margins head; beyond it the
#   loss is linear, so the logit(Q) tails (up to ±50 squares) do not dominate.
WEIGHTS2 = {"policy": 1.0, "soft": 1.0, "margins": 1.0, "margin": 0.5, "rank": 0.5, "first": 0.25, "search": 2.0, "ownership": 0.25}
SOFT_POWER = 0.25
SEARCH_DELTA = 0.5


def batch2(data: Data, encoder: Encoder, index: np.ndarray) -> dict:
    records = data.records[index]
    dev = encoder.device
    planes, hands = encoder.board(records)
    footprint, pieces, mask, visits = encoder.candidates(records)
    return {
        "planes": planes, "hands": hands, "footprint": footprint, "pieces": pieces, "mask": mask, "visits": visits,
        "seat": encoder.seat(records),
        "values": torch.tensor(data.values[index], device=dev),
        "ownership": data.ownership(index),
        "policy": torch.tensor(data.policy[index], device=dev).float(),
        "utility": torch.tensor(data.utility[index], device=dev),
        "search": torch.tensor(data.search_value[index] / VALUE_SCALE, device=dev),
        "searched": torch.tensor(data.searched[index], device=dev).float(),
    }


def forward2(model, b: dict, amp: torch.dtype | None = None) -> dict:
    with torch.autocast(device_type=b["planes"].device.type, dtype=amp, enabled=amp is not None):
        return model(b["planes"], b["hands"], b["footprint"], b["pieces"], b["mask"], b["seat"])


def masked_mean(per: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
    return (per * weight).sum() / weight.sum().clamp(min=1)


def losses2(model, b: dict, weights: dict = WEIGHTS2, amp: torch.dtype | None = None):
    """Weighted total, per-head losses (floats), and the raw outputs and policy targets."""
    out = forward2(model, b, amp)
    mask, policy = b["mask"], b["policy"]
    target = b["visits"] / b["visits"].sum(1, keepdim=True).clamp(min=1)
    soft_target = target.pow(SOFT_POWER) * mask
    soft_target = soft_target / soft_target.sum(1, keepdim=True).clamp(min=1e-12)
    log_probs = F.log_softmax(out["policy"], dim=1).masked_fill(~mask, 0)
    soft_log_probs = F.log_softmax(out["soft"], dim=1).masked_fill(~mask, 0)
    parts = {
        "policy": masked_mean(-(target * log_probs).sum(1), policy),
        "soft": masked_mean(-(soft_target * soft_log_probs).sum(1), policy),
        "margins": F.mse_loss(out["margins"], b["values"]),
        "margin": F.binary_cross_entropy_with_logits(out["utility"][..., 0], b["utility"][..., 0]),
        "rank": F.binary_cross_entropy_with_logits(out["utility"][..., 1], b["utility"][..., 1]),
        "first": -(b["utility"][..., 2] * F.log_softmax(out["utility"][..., 2], dim=1)).sum(1).mean(),
        "search": masked_mean(F.huber_loss(out["search"], b["search"], reduction="none", delta=SEARCH_DELTA), b["searched"]),
        "ownership": F.cross_entropy(out["ownership"].reshape(-1, 5), b["ownership"].reshape(-1)),
    }
    total = sum(weights[k] * v for k, v in parts.items())
    return total, parts, out, (target, soft_target)


@torch.no_grad()
def evaluate2(model, data: Data, encoder: Encoder, index: np.ndarray, batch_size: int = 512, limit: int = 40000,
              amp: torch.dtype | None = None) -> dict:
    """Test/validation metrics for a v2 arm. Same subsample rule as `evaluate` (seed 0, 40k cap), so the
    shared metrics are on the same positions as E1/E2's."""
    model.eval()
    rng = np.random.default_rng(0)
    if len(index) > limit:
        index = np.sort(rng.choice(index, limit, replace=False))
    sums: dict[str, float] = {}

    def add(key: str, value) -> None:
        sums[key] = sums.get(key, 0.0) + float(value)

    movers, search_true, utilities = [], [], []
    for start in range(0, len(index), batch_size):
        b = batch2(data, encoder, index[start : start + batch_size])
        n = len(b["seat"])
        total, parts, out, (target, soft_target) = losses2(model, b, amp=amp)
        for key, value in parts.items():  # per-head losses, weighted by positions (approximately exact)
            add("loss_" + key, value.item() * n)
        add("loss", total.item() * n)
        mask, policy = b["mask"], b["policy"]
        log_probs = F.log_softmax(out["policy"], dim=1)
        kl = (target * (torch.log(target.clamp(min=1e-12)) - log_probs)).masked_fill(~mask, 0).sum(1)
        soft_log_probs = F.log_softmax(out["soft"], dim=1)
        soft_kl = (soft_target * (torch.log(soft_target.clamp(min=1e-12)) - soft_log_probs)).masked_fill(~mask, 0).sum(1)
        best = target.argmax(1)
        ranked = out["policy"].topk(5, dim=1).indices
        add("kl", (kl * policy).sum().item())
        add("softKL", (soft_kl * policy).sum().item())
        add("top1", ((ranked[:, 0] == best).float() * policy).sum().item())
        add("top5", ((ranked == best.unsqueeze(1)).any(1).float() * policy).sum().item())
        add("policyN", policy.sum().item())
        add("valueErr", ((out["margins"][:, 0] - b["values"][:, 0]) ** 2).sum().item() * VALUE_SCALE**2)
        movers.append(b["values"][:, 0].cpu().numpy() * VALUE_SCALE)
        searched = b["searched"].bool()
        add("searchErr", (((out["search"] - b["search"]) * VALUE_SCALE) ** 2)[searched].sum().item())
        add("searchN", searched.sum().item())
        search_true.append((b["search"][searched] * VALUE_SCALE).cpu().numpy())
        probs = torch.cat([torch.sigmoid(out["utility"][..., :2]), torch.softmax(out["utility"][..., 2], 1).unsqueeze(-1)], -1)
        utilities.append((probs.cpu().numpy(), b["utility"].cpu().numpy()))
        add("ownRight", (out["ownership"].argmax(-1) == b["ownership"]).float().sum().item())
        add("ownN", b["ownership"].numel())
        add("n", n)
    model.train()
    n = sums["n"]
    mover_var = float(np.var(np.concatenate(movers)))
    search_var = float(np.var(np.concatenate(search_true))) if search_true else 0.0
    probs = np.concatenate([p for p, _ in utilities])
    truth = np.concatenate([t for _, t in utilities])
    result = {
        "loss": sums["loss"] / n,
        "losses": {k[5:]: sums[k] / n for k in sums if k.startswith("loss_")},
        "policyKL": sums["kl"] / max(1, sums["policyN"]),
        "softPolicyKL": sums["softKL"] / max(1, sums["policyN"]),
        "top1": sums["top1"] / max(1, sums["policyN"]),
        "top5": sums["top5"] / max(1, sums["policyN"]),
        "valueMSE": sums["valueErr"] / n,
        "valueR2": 1 - (sums["valueErr"] / n) / mover_var if mover_var > 0 else 0.0,
        "searchMSE": sums["searchErr"] / max(1, sums["searchN"]),
        "searchR2": 1 - (sums["searchErr"] / max(1, sums["searchN"])) / search_var if search_var > 0 else 0.0,
        "ownershipAcc": sums["ownRight"] / sums["ownN"],
        "positions": int(n),
        "policyPositions": int(sums["policyN"]),
        "searchPositions": int(sums["searchN"]),
    }
    # Brier score per utility head: mean squared error of the probability, over all four relative
    # seats and over the mover alone. The reference is the evaluated set's own mean target per
    # relative seat (a constant forecast), so `brierSkill` = 1 − Brier / reference.
    for k, kind in enumerate(UTILITY_KINDS):
        err = (probs[:, :, k] - truth[:, :, k]) ** 2
        ref = (truth[:, :, k] - truth[:, :, k].mean(0, keepdims=True)) ** 2
        result[f"brier_{kind}"] = float(err.mean())
        result[f"brierSkill_{kind}"] = float(1 - err.mean() / ref.mean())
        result[f"brierMover_{kind}"] = float(err[:, 0].mean())
        result[f"brierSkillMover_{kind}"] = float(1 - err[:, 0].mean() / ref[:, 0].mean())
    return result


class EMA:
    """Exponential moving average of every floating-point tensor in the state dict (BatchNorm running
    statistics included); integer buffers are copied. The decay ramps as min(decay, (1+t)/(10+t)), so
    early evaluations are not dominated by the initial weights."""

    def __init__(self, model, decay: float) -> None:
        self.decay = decay
        self.updates = 0
        self.state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    @torch.no_grad()
    def update(self, model) -> None:
        self.updates += 1
        d = min(self.decay, (1 + self.updates) / (10 + self.updates))
        live = model.state_dict()
        floats = [k for k in self.state if self.state[k].dtype.is_floating_point]
        mine = [self.state[k] for k in floats]
        torch._foreach_mul_(mine, d)
        torch._foreach_add_(mine, [live[k].detach() for k in floats], alpha=1 - d)
        for k in self.state:
            if not self.state[k].dtype.is_floating_point:
                self.state[k].copy_(live[k])


@torch.no_grad()
def throughput(model, data: Data, encoder: Encoder, index: np.ndarray, batch_size: int = 512, rounds: int = 10) -> float:
    model.eval()
    if model_version(model) == 2:
        b2 = batch2(data, encoder, index[:batch_size])
        args = (b2["planes"], b2["hands"], b2["footprint"], b2["pieces"], b2["mask"], b2["seat"])
    else:
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
    parser.add_argument("--batch", type=int, default=None, help="default 256 (v1 arms), 512 (v2 arms)")
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
    parser.add_argument("--ema", type=float, default=0.999, help="v2 arms: EMA decay of the weights (0 = off)")
    parser.add_argument("--amp", choices=["off", "fp16", "bf16"], default="off", help="v2 arms: autocast dtype")
    parser.add_argument("--val-limit", type=int, default=15000, help="validation positions per evaluation")
    parser.add_argument("--log-every", type=int, default=100, help="v2 arms: training-loss line every N steps")
    args = parser.parse_args()
    if args.arm in V2_ARMS:
        return main2(args)
    if args.batch is None:
        args.batch = 256

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
            val = evaluate(model, data, encoder, splits["val"], limit=args.val_limit)
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


def main2(args) -> None:
    """Training loop for the v2 arms: batch 512, EMA weights, checkpoint by weighted validation loss."""
    torch.manual_seed(args.seed)
    dev = device()
    batch_size = args.batch or 512
    amp = {"off": None, "fp16": torch.float16, "bf16": torch.bfloat16}[args.amp]
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
    lr = args.lr if args.lr is not None else 1e-3
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    weights = dict(WEIGHTS2, ownership=args.ownership_weight)
    name = args.name or f"{args.arm}-g{args.train_games}-s{args.seed}"
    os.makedirs(args.out, exist_ok=True)
    print(f"{name}: {parameter_count(model):,} parameters, lr {lr}, batch {batch_size}, EMA {args.ema}, amp {args.amp}", flush=True)
    print(f"loss weights {weights}", flush=True)

    ema = EMA(model, args.ema) if args.ema > 0 else None
    # Evaluation and saving use a second module holding the EMA (or live) weights.
    shadow = ARMS[args.arm]().to(dev)
    rng = np.random.default_rng(args.seed)
    train = splits["train"]
    best_val, best_state, best_step, history = float("inf"), None, 0, []
    started = last = time.time()
    running: dict[str, float] = {}
    for step in range(args.steps):
        for group in optimizer.param_groups:
            group["lr"] = lr * cosine(step, args.steps, warmup=500)
        b = batch2(data, encoder, rng.choice(train, batch_size))
        loss, parts, _, _ = losses2(model, b, weights, amp)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        if ema is not None:
            ema.update(model)
        if args.log_every and (step + 1) % args.log_every == 0:
            parts = {k: round(v.item(), 4) for k, v in parts.items()}
            now = time.time()
            print(f"{name} step {step + 1}: loss {loss.item():.4f} {parts} | {(now - last) / args.log_every:.3f} s/step", flush=True)
            last = now
        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            shadow.load_state_dict(ema.state if ema is not None else model.state_dict())
            val = evaluate2(shadow, data, encoder, splits["val"], limit=args.val_limit, amp=amp)
            history.append({"step": step + 1, "val": val, "seconds": round(time.time() - started)})
            print(f"{name} step {step + 1} EVAL: val loss {val['loss']:.4f} KL {val['policyKL']:.3f} top1 {val['top1']:.3f} "
                  f"R2 {val['valueR2']:.3f} searchR2 {val['searchR2']:.3f} brier m/r/f {val['brier_margin']:.4f}/"
                  f"{val['brier_rank']:.4f}/{val['brier_first']:.4f} own {val['ownershipAcc']:.3f} | {time.time() - started:.0f}s", flush=True)
            if val["loss"] < best_val:
                best_val, best_step = val["loss"], step + 1
                best_state = {k: v.detach().clone() for k, v in shadow.state_dict().items()}
            last = time.time()
    shadow.load_state_dict(best_state)
    torch.save({"arm": args.arm, "state": best_state}, os.path.join(args.out, f"{name}.pt"))
    test = evaluate2(shadow, data, encoder, splits["test"], amp=amp)
    speed = throughput(shadow, data, encoder, splits["test"])
    result = {
        "arm": args.arm,
        "trainGames": args.train_games,
        "trainPositions": int(len(train)),
        "parameters": parameter_count(shadow),
        "steps": args.steps,
        "batch": batch_size,
        "ema": args.ema,
        "amp": args.amp,
        "lossWeights": weights,
        "bestStep": best_step,
        "bestValLoss": best_val,
        "test": test,
        "positionsPerSecond": speed,
        "history": history,
        "seconds": round(time.time() - started),
    }
    with open(os.path.join(args.out, f"{name}.json"), "w") as handle:
        json.dump(result, handle, indent=1)
    print(json.dumps({k: v for k, v in result.items() if k != "history"}, indent=1), flush=True)


if __name__ == "__main__":
    main()
