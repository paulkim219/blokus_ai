"""Batch encoding of self-play records into model inputs, computed on the training device.

Every position is put in the *mover's frame*:

- the board is rotated so the mover's home corner is the top-left cell (the same `canonicalCell`
  map the TS rollout policy and leaf features use), and
- seats are reordered relative to the mover: 0 = mover, 1 = next, 2 = diagonal, 3 = previous.

Only the bitboards are stored per record; haloes and open corners are recomputed here with fixed
convolutions, so the derived planes can change without regenerating data.
"""

from __future__ import annotations

import json

import numpy as np
import torch
import torch.nn.functional as F

from records import SOURCE_SEARCH, own_planes

HOME = [0, 380, 399, 19]  # blue (0,0), green (0,19), purple (19,19), yellow (19,0)
PAD_CELL = 400  # index of a zero "cell" used to pad short footprints


def canonical_cell(cell: int, seat: int) -> int:
    x, y = cell % 20, cell // 20
    if seat == 1:
        return (19 - y) + 20 * x
    if seat == 2:
        return (19 - x) + 20 * (19 - y)
    if seat == 3:
        return y + 20 * (19 - x)
    return cell


# CANON[s, c] = canonical index of board cell c for mover seat s; SOURCE[s, c'] is its inverse.
CANON = np.array([[canonical_cell(c, s) for c in range(400)] for s in range(4)], dtype=np.int64)
SOURCE = np.argsort(CANON, axis=1)


class Placements:
    """Placement geometry exported by `blokee-tables` (the engine's own ids)."""

    def __init__(self, path: str) -> None:
        raw = json.load(open(path))
        self.count = raw["count"]
        self.piece = np.array(raw["piece"], dtype=np.int64)
        cells = np.full((self.count, 5), PAD_CELL, dtype=np.int64)
        for p, footprint in enumerate(raw["cells"]):
            cells[p, : len(footprint)] = footprint
        self.cells = cells


class Encoder:
    """Turns a batch of records into device tensors. Holds the constant lookup tables on device."""

    def __init__(self, placements: Placements, device: torch.device) -> None:
        self.device = device
        self.placements = placements
        # Board cell → canonical cell per mover seat, with the pad cell fixed.
        canon = np.concatenate([CANON, np.full((4, 1), PAD_CELL)], axis=1)
        self.canon = torch.tensor(canon, device=device)
        self.source = torch.tensor(SOURCE, device=device)
        self.cells = torch.tensor(placements.cells, device=device)
        self.piece = torch.tensor(placements.piece, device=device)
        orth = torch.tensor([[0, 1, 0], [1, 0, 1], [0, 1, 0]], dtype=torch.float32)
        diag = torch.tensor([[1, 0, 1], [0, 0, 0], [1, 0, 1]], dtype=torch.float32)
        self.orth = orth.view(1, 1, 3, 3).repeat(4, 1, 1, 1).to(device)
        self.diag = diag.view(1, 1, 3, 3).repeat(4, 1, 1, 1).to(device)
        # Canonical home corner of each *relative* seat, as a one-hot plane per mover seat.
        homes = np.zeros((4, 4, 400), dtype=np.float32)
        for mover in range(4):
            for rel in range(4):
                homes[mover, rel, CANON[mover, HOME[(mover + rel) % 4]]] = 1.0
        self.homes = torch.tensor(homes, device=device)

    PLANES = 13

    def board(self, records: np.ndarray) -> tuple[torch.Tensor, torch.Tensor]:
        """(B, 13, 20, 20) planes and (B, 4, 21) relative hands, both float32 on device."""
        b = len(records)
        mover = torch.tensor(records["seat"].astype(np.int64), device=self.device)
        own_abs = torch.tensor(own_planes(records), device=self.device, dtype=torch.float32)  # (B,4,400)
        # Relative seat order, then rotate into the mover's frame.
        rel = (mover.view(b, 1) + torch.arange(4, device=self.device).view(1, 4)) % 4
        own = own_abs.gather(1, rel.view(b, 4, 1).expand(b, 4, 400))
        src = self.source[mover].view(b, 1, 400).expand(b, 4, 400)
        own = own.gather(2, src).view(b, 4, 20, 20)

        occ = own.sum(1, keepdim=True).clamp(max=1)
        edge = (F.conv2d(own, self.orth, padding=1, groups=4) > 0).float() * (1 - own)
        corner = (F.conv2d(own, self.diag, padding=1, groups=4) > 0).float() * (1 - own)
        open_corners = corner * (1 - occ) * (1 - edge)
        # A seat that has not opened yet has its home corner as its only foothold.
        unplayed = (own.flatten(2).sum(2) == 0).float().view(b, 4, 1, 1)
        home = self.homes[mover].view(b, 4, 20, 20) * (1 - occ)
        open_corners = torch.maximum(open_corners, home * unplayed)
        planes = torch.cat([own, edge, open_corners, 1 - occ], dim=1)

        hand_abs = torch.tensor(records["hand"].astype(np.int64), device=self.device)
        hand = hand_abs.gather(1, rel)
        bits = (hand.unsqueeze(-1) >> torch.arange(21, device=self.device)) & 1
        return planes, bits.float()

    def candidates(self, records: np.ndarray) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        """Footprints (B,64,5) in canonical cells, piece ids (B,64), mask (B,64), visit targets (B,64)."""
        b = len(records)
        mover = torch.tensor(records["seat"].astype(np.int64), device=self.device)
        moves = torch.tensor(records["moves"].astype(np.int64), device=self.device)
        count = torch.tensor(records["candidates"].astype(np.int64), device=self.device)
        mask = torch.arange(64, device=self.device).view(1, 64) < count.view(b, 1)
        cells = self.cells[moves]  # (B,64,5) board cells, padded with PAD_CELL
        canon = self.canon[mover].view(b, 1, 401).expand(b, 64, 401)
        footprint = canon.gather(2, cells.clamp(max=PAD_CELL)).view(b, 64, 5)
        footprint = torch.where(mask.unsqueeze(-1), footprint, torch.full_like(footprint, PAD_CELL))
        visits = torch.tensor(records["visits"].astype(np.float32), device=self.device) * mask
        return footprint, self.piece[moves] * mask, mask, visits


def value_targets(records: np.ndarray, games: dict[int, dict]) -> np.ndarray:
    """(N, 4) final `score − mean(other three)` in relative seat order, in squares."""
    scores = np.array([games[int(g)]["scores"] for g in records["game"]], dtype=np.float32)
    rel = (records["seat"].astype(np.int64)[:, None] + np.arange(4)[None, :]) % 4
    ordered = np.take_along_axis(scores, rel, axis=1)
    return ordered - (ordered.sum(1, keepdims=True) - ordered) / 3.0


def final_owners(records: np.ndarray, placements: Placements) -> dict[int, np.ndarray]:
    """Final absolute owner per cell (-1 empty, else seat) for every game, from its last decision."""
    owners: dict[int, np.ndarray] = {}
    last = np.r_[np.nonzero(np.diff(records["game"].astype(np.int64)))[0], len(records) - 1]
    planes = own_planes(records[last])
    for row, index in enumerate(last):
        board = np.full(400, -1, dtype=np.int8)
        for seat in range(4):
            board[planes[row, seat] == 1] = seat
        record = records[index]
        for cell in placements.cells[record["chosen"]]:
            if cell != PAD_CELL:
                board[cell] = record["seat"]
        owners[int(record["game"])] = board
    return owners


def ownership_targets(records: np.ndarray, owners: dict[int, np.ndarray]) -> np.ndarray:
    """(N, 400) final ownership class in the mover's frame: 0 empty, 1 + relative seat."""
    out = np.zeros((len(records), 400), dtype=np.int64)
    for i, record in enumerate(records):
        board = owners[int(record["game"])]
        mover = int(record["seat"])
        rel = np.where(board < 0, 0, 1 + (board.astype(np.int64) - mover) % 4)
        out[i] = rel[SOURCE[mover]]
    return out


def policy_mask(records: np.ndarray) -> np.ndarray:
    """Which records carry a real search distribution (not the opening shortcut or the packer)."""
    return (records["source"] == SOURCE_SEARCH) & (records["candidates"] >= 2)
