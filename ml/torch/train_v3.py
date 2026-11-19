"""Hybrid H1: train network v3 (`model.ResNet3`) on record-format-v3 caches (`h1_data.py`).

    ml/.venv-hybrid/bin/python ml/torch/train_v3.py --selfplay tmp/h1/cache/turbo tmp/h1/cache/pro \
        --teacher tmp/h1/cache/L7 tmp/h1/cache/L8 [--old tmp/h1/cache/old --old-share 0.25] \
        --steps 30000 --name h1-A

Splits are by game (seed's last digit 8 validation, 9 test; `h1_data.split_of`); test games are never
read here. Each batch of 512 is drawn uniformly over the training records of the new corpora (natural
proportions), or, with `--old`, a fixed share `--old-share` of it from the old corpus.

Losses (weights in `WEIGHTS3`): policy head 0 on the search's root visits (search records with ≥ 2
legal moves), policy head 1 on the teacher's move (teacher records with ≥ 2 legal moves), both a
cross-entropy over the **legal moves only** (log-softmax over the mask from `h1_data.legal_mask`);
margins, utilities (margin, rank, first), the search's root value and ownership as in E5's `losses2`.
Each head's loss is the mean over the rows that carry its target.

Selection: every `--eval-every` steps the EMA weights are scored on the validation set (every record of
the validation games of the new corpora, subsampled uniformly to at most `--val-limit` with seed 0), and
the checkpoint with the lowest weighted validation loss (same weights, same per-head means) is kept.
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
from h1_data import Corpus, Tables, make_batch  # noqa: E402
from model import ARMS, cosine, parameter_count  # noqa: E402
from policy_index import PolicyIndex  # noqa: E402
from train import EMA  # noqa: E402

WEIGHTS3 = {"policy": 1.0, "teacher": 1.0, "margins": 1.0, "margin": 0.5, "rank": 0.5, "first": 0.25, "search": 2.0, "ownership": 0.25}
SEARCH_DELTA = 0.5
KEYS = ["planes", "hands", "seat", "legal", "target", "head", "margins", "utility", "ownership", "search", "searched"]


def cat(batches: list[dict]) -> dict:
    return {k: torch.cat([b[k] for b in batches]) for k in KEYS}


def masked_log_softmax(logits: torch.Tensor, legal: torch.Tensor) -> torch.Tensor:
    return F.log_softmax(logits.masked_fill(~legal, -1e9), dim=-1)


def head_mean(per: torch.Tensor, rows: torch.Tensor) -> torch.Tensor:
    return (per * rows).sum() / rows.sum().clamp(min=1)


def losses3(model, b: dict, weights: dict = WEIGHTS3, amp: torch.dtype | None = None):
    with torch.autocast(device_type=b["planes"].device.type, dtype=amp, enabled=amp is not None):
        out = model(b["planes"], b["hands"], b["seat"])
    legal, target, head = b["legal"], b["target"], b["head"]
    parts = {}
    for k, name in enumerate(["policy", "teacher"]):
        rows = (head == k).float()
        if rows.sum() > 0:
            logp = masked_log_softmax(out["policy"][:, k], legal)
            per = -(target * logp).sum(1)
            parts[name] = head_mean(per, rows)
        else:
            parts[name] = out["policy"].sum() * 0.0
    parts["margins"] = F.mse_loss(out["margins"], b["margins"])
    parts["margin"] = F.binary_cross_entropy_with_logits(out["utility"][..., 0], b["utility"][..., 0])
    parts["rank"] = F.binary_cross_entropy_with_logits(out["utility"][..., 1], b["utility"][..., 1])
    parts["first"] = -(b["utility"][..., 2] * F.log_softmax(out["utility"][..., 2], dim=1)).sum(1).mean()
    parts["search"] = head_mean(F.huber_loss(out["search"], b["search"], reduction="none", delta=SEARCH_DELTA), b["searched"])
    parts["ownership"] = F.cross_entropy(out["ownership"].reshape(-1, 5), b["ownership"].reshape(-1))
    total = sum(weights[k] * v for k, v in parts.items())
    return total, parts, out


@torch.no_grad()
def evaluate3(model, tables: Tables, corpora: list[Corpus], val: list[np.ndarray], amp=None, batch: int = 512) -> dict:
    """Validation metrics, pooled over the corpora's validation rows. Per-head losses are means over
    the rows carrying that head (as in training), so the total is comparable across checkpoints."""
    model.eval()
    sums: dict[str, float] = {}
    counts: dict[str, float] = {}

    def add(key, value, n):
        sums[key] = sums.get(key, 0.0) + float(value) * n
        counts[key] = counts.get(key, 0.0) + n

    margins_true, margins_pred = [], []
    for corpus, rows in zip(corpora, val):
        for lo in range(0, len(rows), batch):
            b = make_batch(tables, corpus, rows[lo : lo + batch])
            _, parts, out = losses3(model, b, amp=amp)
            n = len(rows[lo : lo + batch])
            for k in ("margins", "margin", "rank", "first", "ownership"):
                add(k, parts[k].item(), n)
            ns = b["searched"].sum().item()
            if ns:
                add("search", parts["search"].item(), ns)
            for k, name in enumerate(["policy", "teacher"]):
                r = b["head"] == k
                nr = int(r.sum())
                if not nr:
                    continue
                add(name, parts[name].item(), nr)
                logits = out["policy"][r, k].masked_fill(~b["legal"][r], -1e9)
                tgt = b["target"][r]
                best = tgt.argmax(1)
                top = logits.topk(40, dim=1).indices
                add(name + "_top1", (top[:, 0] == best).float().mean().item(), nr)
                add(name + "_top40", (top == best.unsqueeze(1)).any(1).float().mean().item(), nr)
                ent = -(tgt * torch.log(tgt.clamp(min=1e-12))).sum(1).mean().item()
                add(name + "_kl", parts[name].item() - ent, nr)
            margins_true.append(b["margins"][:, 0].cpu().numpy() * 20.0)
            margins_pred.append(out["margins"][:, 0].float().cpu().numpy() * 20.0)
    model.train()
    res = {k: sums[k] / counts[k] for k in sums}
    res["loss"] = sum(WEIGHTS3[k] * res.get(k, 0.0) for k in WEIGHTS3)
    t = np.concatenate(margins_true)
    p = np.concatenate(margins_pred)
    res["marginR2"] = float(1 - ((t - p) ** 2).mean() / t.var())
    res["positions"] = int(sum(len(v) for v in val))
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selfplay", nargs="*", default=[])
    ap.add_argument("--teacher", nargs="*", default=[])
    ap.add_argument("--old", nargs="*", default=[])
    ap.add_argument("--old-share", type=float, default=0.25)
    ap.add_argument("--arm", default="resnet3-b8w96")
    ap.add_argument("--placements", default="ml/data/placements.json")
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--val-limit", type=int, default=40000)
    ap.add_argument("--ema", type=float, default=0.999)
    ap.add_argument("--amp", choices=["off", "bf16", "fp16"], default="off")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="tmp/h1/train")
    ap.add_argument("--name", required=True)
    ap.add_argument("--log-every", type=int, default=200)
    ap.add_argument("--check-legal", action="store_true", help="assert the GPU legal mask on every training batch")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    dev = torch.device("cuda")
    torch.backends.cudnn.benchmark = True
    amp = {"off": None, "bf16": torch.bfloat16, "fp16": torch.float16}[args.amp]
    tables = Tables(PolicyIndex(args.placements), dev)
    new = [Corpus(d, dev, os.path.basename(d.rstrip("/"))) for d in args.selfplay + args.teacher]
    old = [Corpus(d, dev, os.path.basename(d.rstrip("/"))) for d in args.old]
    train_rows = [c.indices(0) for c in new]
    old_rows = [np.arange(c.n_records) for c in old]
    # Validation: every record of the validation games, pooled, subsampled uniformly to --val-limit.
    pooled = [(i, r) for i, c in enumerate(new) for r in c.indices(1)]
    rng = np.random.default_rng(0)
    if len(pooled) > args.val_limit:
        pick = np.sort(rng.choice(len(pooled), args.val_limit, replace=False))
        pooled = [pooled[j] for j in pick]
    val = [np.array([r for i, r in pooled if i == k], dtype=np.int64) for k in range(len(new))]
    for c, tr, v in zip(new, train_rows, val):
        heads = np.bincount(c.head[tr] + 1, minlength=3)
        print(f"{c.name}: {c.n_records} records, train {len(tr)} (no policy {heads[0]}, visits {heads[1]}, teacher {heads[2]}), "
              f"val sample {len(v)}, test records {len(c.indices(2))}", flush=True)
    for c in old:
        print(f"{c.name} (old corpus, value/ownership only): {c.n_records} records, share {args.old_share}", flush=True)

    model = ARMS[args.arm]().to(dev)
    shadow = ARMS[args.arm]().to(dev)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    ema = EMA(model, args.ema)
    os.makedirs(args.out, exist_ok=True)
    print(f"{args.name}: {args.arm}, {parameter_count(model):,} parameters, lr {args.lr}, batch {args.batch}, EMA {args.ema}, amp {args.amp}", flush=True)
    print(f"loss weights {WEIGHTS3}", flush=True)

    sizes = np.array([len(r) for r in train_rows], dtype=np.float64)
    share = sizes / sizes.sum()
    n_old = int(round(args.batch * args.old_share)) if old else 0
    n_new = args.batch - n_old
    old_sizes = np.array([len(r) for r in old_rows], dtype=np.float64)
    best, best_state, best_step, history = float("inf"), None, 0, []
    started = last = time.time()
    for step in range(args.steps):
        for group in optimizer.param_groups:
            group["lr"] = args.lr * cosine(step, args.steps, warmup=500)
        per = rng.multinomial(n_new, share)
        parts_b = [make_batch(tables, c, rng.choice(r, k), check_legal=args.check_legal) for c, r, k in zip(new, train_rows, per) if k]
        if n_old:
            per_old = rng.multinomial(n_old, old_sizes / old_sizes.sum())
            parts_b += [make_batch(tables, c, rng.choice(r, k)) for c, r, k in zip(old, old_rows, per_old) if k]
        b = cat(parts_b)
        loss, parts, _ = losses3(model, b, amp=amp)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        ema.update(model)
        if (step + 1) % args.log_every == 0:
            now = time.time()
            print(f"{args.name} step {step + 1}: loss {loss.item():.4f} {{{', '.join(f'{k}: {v.item():.4f}' for k, v in parts.items())}}} | "
                  f"{(now - last) / args.log_every * 1000:.0f} ms/step", flush=True)
            last = now
        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            shadow.load_state_dict(ema.state)
            v = evaluate3(shadow, tables, new, val, amp=amp)
            history.append({"step": step + 1, "val": v, "seconds": round(time.time() - started)})
            print(f"{args.name} step {step + 1} EVAL: val loss {v['loss']:.4f} | visits CE {v.get('policy', float('nan')):.3f} "
                  f"top1 {v.get('policy_top1', float('nan')):.3f} | teacher CE {v.get('teacher', float('nan')):.3f} "
                  f"top1 {v.get('teacher_top1', float('nan')):.3f} top40 {v.get('teacher_top40', float('nan')):.3f} | "
                  f"margin R2 {v['marginR2']:.3f} own {v['ownership']:.3f} search {v.get('search', float('nan')):.4f} | "
                  f"{time.time() - started:.0f}s", flush=True)
            if v["loss"] < best:
                best, best_step = v["loss"], step + 1
                best_state = {k: t.detach().clone() for k, t in shadow.state_dict().items()}
            last = time.time()
    meta = {"arm": args.arm, "name": args.name, "steps": args.steps, "bestStep": best_step, "bestValLoss": best,
            "selfplay": args.selfplay, "teacher": args.teacher, "old": args.old, "oldShare": args.old_share if old else 0.0,
            "batch": args.batch, "lr": args.lr, "ema": args.ema, "amp": args.amp, "weights": WEIGHTS3,
            "parameters": parameter_count(model), "seconds": round(time.time() - started)}
    torch.save({"arm": args.arm, "state": best_state, "meta": meta}, os.path.join(args.out, f"{args.name}.pt"))
    json.dump(meta | {"history": history}, open(os.path.join(args.out, f"{args.name}.json"), "w"), indent=1)
    print(json.dumps(meta), flush=True)


if __name__ == "__main__":
    main()
