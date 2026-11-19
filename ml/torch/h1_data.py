"""Hybrid H1 training data: record-format-v3 corpora (and optionally the old v2 corpus) as one
in-memory table, with batches built on the GPU.

    ml/.venv-hybrid/bin/python ml/torch/h1_data.py build --out tmp/h1/cache/turbo --kind selfplay \
        --runs tmp/h1/data/turbo-a tmp/h1/data/turbo-b
    ml/.venv-hybrid/bin/python ml/torch/h1_data.py build --out tmp/h1/cache/L7 --kind teacher --runs tmp/h1/data/L7-v3

A cache directory holds one corpus as `.npy` files:

- per record: `seat`, `source`, `teacher`, `own_moves`, `ply`, `n` (legal moves), `game` (row of the
  corpus's game table), `own` (N,4,13) u32 bitboards, `hand` (N,4), `root_values` (N,4) f32, `chosen`
  (placement id), `chosen_index` (policy index in the mover's frame), `iterations`;
- the policy target in CSR form, **nonzero entries only**: `pol_start` (N+1), `pol_index` (u16 policy
  index in the mover's frame, `policy_index.py`), `pol_visits` (u32: real root visits for search
  records, 1 on the played move for teacher records); zero-visit legal moves are not stored, the
  legal-move mask is recomputed on the GPU from the board (`legal_mask`, checked against `n`);
- per game: `game_seed`, `game_scores` (G,4) per seat in turn order, `game_owner` (G,400) final owner
  of every cell (−1 empty), and `split` (G,) 0 train / 1 validation / 2 test by seed (last digit 8 →
  validation, 9 → test).

`kind` "old" reads a v2 run (`records.load_run`, 512-byte records with 64 candidates): it contributes
positions with value and ownership targets only (no policy entries, `n` = 0).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(__file__))
from features import CANON, HOME, PAD_CELL, SOURCE, game_utilities  # noqa: E402
from policy_index import POLICY_SIZE, PolicyIndex  # noqa: E402
from records_v3 import SOURCE_SEARCH, SOURCE_TEACHER, load_run_v3  # noqa: E402

PER_RECORD = ["seat", "source", "teacher", "own_moves", "ply", "n", "game", "own", "hand", "root_values", "chosen",
              "chosen_index", "iterations", "pol_start", "pol_index", "pol_visits"]
PER_GAME = ["game_seed", "game_scores", "game_owner", "split"]


def split_of(seed: np.ndarray) -> np.ndarray:
    digit = seed % 10
    return np.where(digit == 9, 2, np.where(digit == 8, 1, 0)).astype(np.int8)


def final_owner(moves: list[int], cells: np.ndarray) -> np.ndarray:
    board = np.full(400, -1, dtype=np.int8)
    for ply, mv in enumerate(moves):
        if mv >= 0:
            c = cells[mv]
            board[c[c < 400]] = ply % 4
    return board


def build_v3(runs: list[str], pi: PolicyIndex, kind: str) -> dict[str, np.ndarray]:
    parts = []
    game_rows = {"game_seed": [], "game_scores": [], "game_owner": []}
    offset = 0
    for run in runs:
        data, games = load_run_v3(run)
        h = data["header"]
        ids = sorted(games)
        row_of = {g: offset + i for i, g in enumerate(ids)}
        for g in ids:
            game = games[g]
            game_rows["game_seed"].append(game["seed"])
            game_rows["game_scores"].append(game["scores"])
            game_rows["game_owner"].append(final_owner(game["moves"], pi.cells))
        offset += len(ids)
        n = np.diff(data["start"])
        seat_rep = np.repeat(h["seat"].astype(np.int64), n)
        keep = data["visits"] > 0
        if kind == "teacher":
            keep &= h["source"][np.repeat(np.arange(len(h)), n)] == SOURCE_TEACHER
        else:
            keep &= h["source"][np.repeat(np.arange(len(h)), n)] == SOURCE_SEARCH
        rec = np.repeat(np.arange(len(h)), n)[keep]
        pol_index = pi.policy[seat_rep[keep], data["moves"][keep].astype(np.int64)].astype(np.uint16)
        pol_visits = data["visits"][keep].astype(np.uint32)
        counts = np.bincount(rec, minlength=len(h))
        parts.append({
            "seat": h["seat"].copy(), "source": h["source"].copy(), "teacher": h["teacher"].copy(),
            "own_moves": h["own_moves"].copy(), "ply": h["ply"].copy(), "n": h["n"].copy(),
            "game": np.array([row_of[int(g)] for g in h["game"]], dtype=np.int32),
            "own": h["own"].copy(), "hand": h["hand"].copy(), "root_values": h["root_values"].copy(),
            "chosen": h["chosen"].copy(),
            "chosen_index": pi.policy[h["seat"].astype(np.int64), h["chosen"].astype(np.int64)].astype(np.int32),
            "iterations": h["iterations"].copy(),
            "counts": counts, "pol_index": pol_index, "pol_visits": pol_visits,
        })
        print(f"{run}: {len(ids)} games, {len(h)} records, {len(pol_index)} policy entries", flush=True)
    out = {k: np.concatenate([p[k] for p in parts]) for k in parts[0] if k != "counts"}
    counts = np.concatenate([p["counts"] for p in parts])
    out["pol_start"] = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
    out["game_seed"] = np.array(game_rows["game_seed"], dtype=np.int64)
    out["game_scores"] = np.array(game_rows["game_scores"], dtype=np.float32)
    out["game_owner"] = np.stack(game_rows["game_owner"])
    out["split"] = split_of(out["game_seed"])
    return out


def build_old(runs: list[str], pi: PolicyIndex) -> dict[str, np.ndarray]:
    """The v2 corpus: positions with value/ownership targets, no policy."""
    from features import final_owners, Placements
    from records import load_run

    placements = Placements(os.path.join(os.path.dirname(__file__), "..", "data", "placements.json"))
    parts, seeds, scores, owners = [], [], [], []
    offset = 0
    for run in runs:
        records, games = load_run(run)
        meta = json.load(open(os.path.join(run, "meta.json")))
        ids = sorted(games)
        row_of = {g: offset + i for i, g in enumerate(ids)}
        own_by_game = final_owners(records, placements)
        for g in ids:
            seeds.append(games[g].get("seed", meta["seedBase"] + g))
            scores.append(games[g]["scores"])
            owners.append(own_by_game[g] if g in own_by_game else np.full(400, -1, np.int8))
        offset += len(ids)
        m = len(records)
        parts.append({
            "seat": records["seat"].copy(), "source": records["source"].copy(), "teacher": np.full(m, 255, np.uint8),
            "own_moves": (21 - np.array([bin(int(x)).count("1") for x in records["hand"][np.arange(m), records["seat"]]])).astype(np.uint8),
            "ply": records["ply"].copy(), "n": np.zeros(m, np.uint16),
            "game": np.array([row_of[int(g)] for g in records["game"]], dtype=np.int32),
            "own": records["own"].copy(), "hand": records["hand"].copy(), "root_values": np.full((m, 4), np.nan, np.float32),
            "chosen": records["chosen"].copy(), "chosen_index": np.full(m, -1, np.int32), "iterations": records["iterations"].copy(),
        })
        print(f"{run}: {len(ids)} games, {m} records (old format: value and ownership only)", flush=True)
    out = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    out["pol_start"] = np.zeros(len(out["seat"]) + 1, np.int64)
    out["pol_index"] = np.zeros(0, np.uint16)
    out["pol_visits"] = np.zeros(0, np.uint32)
    out["game_seed"] = np.array(seeds, dtype=np.int64)
    out["game_scores"] = np.array(scores, dtype=np.float32)
    out["game_owner"] = np.stack(owners)
    out["split"] = np.zeros(len(seeds), np.int8)  # training positions only
    return out


def save(cache: dict[str, np.ndarray], directory: str, meta: dict) -> None:
    os.makedirs(directory, exist_ok=True)
    for k, v in cache.items():
        np.save(os.path.join(directory, k + ".npy"), v)
    json.dump(meta, open(os.path.join(directory, "meta.json"), "w"), indent=1)


def load(directory: str) -> dict[str, np.ndarray]:
    return {k: np.load(os.path.join(directory, k + ".npy")) for k in PER_RECORD + PER_GAME}


# ---- GPU side ----------------------------------------------------------------------------------------


class Tables:
    """Constant lookup tables on the training device."""

    def __init__(self, pi: PolicyIndex, dev: torch.device) -> None:
        self.dev = dev
        self.source = torch.tensor(SOURCE, device=dev)
        orth = torch.tensor([[0, 1, 0], [1, 0, 1], [0, 1, 0]], dtype=torch.float32)
        diag = torch.tensor([[1, 0, 1], [0, 0, 0], [1, 0, 1]], dtype=torch.float32)
        self.orth = orth.view(1, 1, 3, 3).repeat(4, 1, 1, 1).to(dev)
        self.diag = diag.view(1, 1, 3, 3).repeat(4, 1, 1, 1).to(dev)
        homes = np.zeros((4, 4, 400), dtype=np.float32)
        for mover in range(4):
            for rel in range(4):
                homes[mover, rel, CANON[mover, HOME[(mover + rel) % 4]]] = 1.0
        self.homes = torch.tensor(homes, device=dev)
        self.shifts = torch.arange(32, device=dev, dtype=torch.int64)
        self.slot_cells = torch.tensor(pi.slot_cells.reshape(-1), device=dev)  # (36400·5,) canonical cells, 400 pad
        self.slot_piece = torch.tensor(pi.slot_piece, device=dev)
        self.slot_valid = torch.tensor(pi.slot_valid, device=dev)


def encode_board(t: Tables, own: torch.Tensor, hand: torch.Tensor, mover: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """`features.Encoder.board` from device tensors: own (B,4,13) int64 words, hand (B,4) int64, mover (B,)."""
    b = own.shape[0]
    bits = ((own.unsqueeze(-1) >> t.shifts) & 1).view(b, 4, 13 * 32)[:, :, :400].float()
    rel = (mover.view(b, 1) + torch.arange(4, device=t.dev).view(1, 4)) % 4
    own_rel = bits.gather(1, rel.view(b, 4, 1).expand(b, 4, 400))
    src = t.source[mover].view(b, 1, 400).expand(b, 4, 400)
    own_c = own_rel.gather(2, src).view(b, 4, 20, 20)
    occ = own_c.sum(1, keepdim=True).clamp(max=1)
    edge = (F.conv2d(own_c, t.orth, padding=1, groups=4) > 0).float() * (1 - own_c)
    corner = (F.conv2d(own_c, t.diag, padding=1, groups=4) > 0).float() * (1 - own_c)
    open_corners = corner * (1 - occ) * (1 - edge)
    unplayed = (own_c.flatten(2).sum(2) == 0).float().view(b, 4, 1, 1)
    home = t.homes[mover].view(b, 4, 20, 20) * (1 - occ)
    open_corners = torch.maximum(open_corners, home * unplayed)
    planes = torch.cat([own_c, edge, open_corners, 1 - occ], dim=1)
    hand_rel = hand.gather(1, rel)
    hand_bits = ((hand_rel.unsqueeze(-1) >> torch.arange(21, device=t.dev)) & 1).float()
    return planes, hand_bits


def legal_mask(t: Tables, planes: torch.Tensor, hand_bits: torch.Tensor) -> torch.Tensor:
    """(B, 36400) bool: the mover's legal placements in its frame, from the encoded planes. A placement is
    legal when every cell is empty and not edge-adjacent to the mover's stones, at least one cell is an
    open corner of the mover (its home corner before its first move), and the piece is in hand."""
    b = planes.shape[0]
    flat = planes.view(b, 13, 400)
    pad = torch.zeros(b, 1, device=planes.device)
    blocked = torch.cat([(1 - flat[:, 12]) + flat[:, 4], pad], 1) > 0  # occupied or own-edge
    corner = torch.cat([flat[:, 8], pad], 1) > 0
    bad = blocked[:, t.slot_cells].view(b, POLICY_SIZE, 5).any(-1)
    touch = corner[:, t.slot_cells].view(b, POLICY_SIZE, 5).any(-1)
    in_hand = hand_bits[:, 0, :].gather(1, t.slot_piece.view(1, -1).expand(b, -1)) > 0
    return t.slot_valid.view(1, -1) & ~bad & touch & in_hand


class Corpus:
    """One cache on the device (bitboards, targets) with the CSR policy entries."""

    def __init__(self, directory: str, dev: torch.device, name: str) -> None:
        c = load(directory)
        self.name = name
        self.n_records = len(c["seat"])
        self.dev = dev
        self.seat = torch.tensor(c["seat"].astype(np.int64), device=dev)
        self.source = torch.tensor(c["source"].astype(np.int64), device=dev)
        self.own = torch.tensor(c["own"].astype(np.int64), device=dev)
        self.hand = torch.tensor(c["hand"].astype(np.int64), device=dev)
        self.n = torch.tensor(c["n"].astype(np.int64), device=dev)
        self.own_moves = c["own_moves"].astype(np.int64)
        self.ply = c["ply"].astype(np.int64)
        self.game = c["game"].astype(np.int64)
        self.game_t = torch.tensor(self.game, device=dev)
        self.root_values = torch.tensor(c["root_values"].astype(np.float32), device=dev)
        self.chosen_index = torch.tensor(c["chosen_index"].astype(np.int64), device=dev)
        self.pol_start = torch.tensor(c["pol_start"], device=dev)
        # Converted on the device, to keep host memory low (the entries are the largest arrays).
        self.pol_index = torch.from_numpy(c["pol_index"].view(np.int16)).to(dev).int() & 0xFFFF
        self.pol_visits = torch.from_numpy(c["pol_visits"].view(np.int32)).to(dev).float()
        self.game_seed = c["game_seed"]
        self.game_scores_np = c["game_scores"]
        self.split = c["split"]
        self.game_owner = torch.tensor(c["game_owner"].astype(np.int64), device=dev)
        self.utilities = torch.tensor(game_utilities(c["game_scores"]), device=dev)  # (G,4,3) absolute seats
        self.scores = torch.tensor(c["game_scores"], device=dev)
        self.has_policy = (c["pol_start"][1:] - c["pol_start"][:-1]) > 0
        # Which policy head a record trains: 0 search visits (≥ 2 legal moves), 1 teacher move (≥ 2), else none.
        multi = c["n"] >= 2
        self.head = np.where(self.has_policy & multi & (c["source"] == SOURCE_SEARCH), 0,
                             np.where(self.has_policy & multi & (c["source"] == SOURCE_TEACHER), 1, -1)).astype(np.int64)
        self.record_split = self.split[self.game]

    def indices(self, split: int) -> np.ndarray:
        return np.nonzero(self.record_split == split)[0]


def make_batch(t: Tables, corpus: Corpus, index: np.ndarray, check_legal: bool = False) -> dict[str, torch.Tensor]:
    dev = t.dev
    idx = torch.tensor(index, device=dev)
    b = len(index)
    mover = corpus.seat[idx]
    planes, hands = encode_board(t, corpus.own[idx], corpus.hand[idx], mover)
    legal = legal_mask(t, planes, hands)
    if check_legal:
        counts = legal.sum(1)
        want = corpus.n[idx]
        ok = (want == 0) | (counts == want)
        if not bool(ok.all()):
            bad = int((~ok).sum())
            raise RuntimeError(f"{corpus.name}: GPU legal mask disagrees with the record's legal count on {bad}/{b} records")
    # Policy targets (dense) from the CSR entries.
    start, stop = corpus.pol_start[idx], corpus.pol_start[idx + 1]
    lengths = stop - start
    row = torch.repeat_interleave(torch.arange(b, device=dev), lengths)
    total = int(lengths.sum())
    within = torch.arange(total, device=dev) - torch.repeat_interleave(torch.cumsum(lengths, 0) - lengths, lengths)
    entry = torch.repeat_interleave(start, lengths) + within
    target = torch.zeros(b, POLICY_SIZE, device=dev)
    target.index_put_((row, corpus.pol_index[entry].long()), corpus.pol_visits[entry], accumulate=True)
    target = target / target.sum(1, keepdim=True).clamp(min=1e-9)
    if check_legal:
        outside = (target > 0) & ~legal
        if bool(outside.any()):
            raise RuntimeError(f"{corpus.name}: policy target on a move the GPU mask calls illegal")
    head = torch.tensor(corpus.head[index], device=dev)
    # Value targets in relative seat order (0 = mover).
    game = corpus.game_t[idx]
    rel = (mover.view(b, 1) + torch.arange(4, device=dev).view(1, 4)) % 4
    scores = corpus.scores[game].gather(1, rel)
    margins = scores - (scores.sum(1, keepdim=True) - scores) / 3.0
    utility = corpus.utilities[game].gather(1, rel.view(b, 4, 1).expand(b, 4, 3))
    board = corpus.game_owner[game]
    owner_rel = torch.where(board < 0, torch.zeros_like(board), 1 + (board - mover.view(b, 1)) % 4)
    ownership = owner_rel.gather(1, t.source[mover])
    root = corpus.root_values[idx].gather(1, mover.view(b, 1)).squeeze(1)
    searched = (head == 0) & torch.isfinite(root)
    return {
        "planes": planes, "hands": hands, "seat": mover, "legal": legal, "target": target, "head": head,
        "margins": margins / 20.0, "utility": utility, "ownership": ownership,
        "search": torch.where(searched, root, torch.zeros_like(root)), "searched": searched.float(),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--out", required=True)
    b.add_argument("--kind", choices=["selfplay", "teacher", "old"], required=True)
    b.add_argument("--runs", nargs="+", required=True)
    b.add_argument("--placements", default="ml/data/placements.json")
    c = sub.add_parser("check")
    c.add_argument("--cache", required=True)
    c.add_argument("--placements", default="ml/data/placements.json")
    c.add_argument("--limit", type=int, default=0, help="records to check (0 = all)")
    r = sub.add_parser("check-raw", help="GPU legal mask against every listed move of raw v3 records, as sets")
    r.add_argument("--run", required=True)
    r.add_argument("--placements", default="ml/data/placements.json")
    r.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    pi = PolicyIndex(args.placements)
    if args.cmd == "build":
        cache = build_old(args.runs, pi) if args.kind == "old" else build_v3(args.runs, pi, args.kind)
        meta = {"kind": args.kind, "runs": args.runs, "records": int(len(cache["seat"])), "games": int(len(cache["game_seed"])),
                "policyEntries": int(len(cache["pol_index"])),
                "splitGames": {s: int((cache["split"] == k).sum()) for k, s in enumerate(["train", "val", "test"])}}
        save(cache, args.out, meta)
        print(json.dumps(meta), flush=True)
    elif args.cmd == "check-raw":
        dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        t = Tables(pi, dev)
        data, _ = load_run_v3(args.run)
        h = data["header"]
        rows = np.arange(len(h)) if not args.limit else np.arange(min(args.limit, len(h)))
        mismatched = 0
        for lo in range(0, len(rows), 512):
            sub_rows = rows[lo : lo + 512]
            own = torch.tensor(h["own"][sub_rows].astype(np.int64), device=dev)
            hand = torch.tensor(h["hand"][sub_rows].astype(np.int64), device=dev)
            mover = torch.tensor(h["seat"][sub_rows].astype(np.int64), device=dev)
            planes, hands = encode_board(t, own, hand, mover)
            legal = legal_mask(t, planes, hands)
            want = torch.zeros_like(legal)
            for k, i in enumerate(sub_rows):
                mv = data["moves"][data["start"][i] : data["start"][i + 1]].astype(np.int64)
                want[k, torch.tensor(pi.policy[int(h["seat"][i]), mv], device=dev)] = True
            mismatched += int((legal != want).any(1).sum())
        print(f"{args.run}: {len(rows)} records, GPU legal set differs from the listed moves on {mismatched}", flush=True)
    else:
        dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        t = Tables(pi, dev)
        corpus = Corpus(args.cache, dev, os.path.basename(args.cache))
        rows = np.arange(corpus.n_records)
        rows = rows[corpus.n.cpu().numpy() > 0]
        if args.limit:
            rows = rows[: args.limit]
        for lo in range(0, len(rows), 1024):
            make_batch(t, corpus, rows[lo : lo + 1024], check_legal=True)
        print(f"{args.cache}: GPU legal mask equals every checked record's legal count ({len(rows)} records), "
              f"and every policy target lies on a legal move", flush=True)


if __name__ == "__main__":
    main()
