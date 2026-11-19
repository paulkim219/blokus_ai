"""Network v3's fixed policy indexing (hybrid H1): 91 piece-orientations × 400 anchor cells.

Every placement on the 20×20 board is one of the 91 fixed orientations of the 21 pieces at one
offset. In the **mover's frame** (the board rotated so the mover's home corner is cell 0, as in
`features.canonical_cell`), a placement p of mover seat s becomes the placement p' whose cells are
the rotated cells of p. Its policy index is

    index(p') = 400 · orientation_global(p') + 20 · anchor_y(p') + anchor_x(p')

- `orientation_global(p') = first_orientation[piece(p')] + orientation(p')`, with the engine's own
  orientation numbering (`placements.rs`, `orientations`), pieces in id order (I1 has 1 orientation,
  so I1 = 0, I2 = 1–2, …, X5 = 90);
- the anchor is the top-left corner of the placement's bounding box: `anchor_x = min x`,
  `anchor_y = min y` over its cells (x = cell % 20, y = cell // 20). Every placement's normalised
  shape has its bounding box at (0, 0), so this is the offset of the shape.

So the head is a (91, 20, 20) map: channel o, cell (y, x) is the logit of placing orientation o with
its bounding box's top-left corner at (x, y) in the mover's frame. 30,433 of the 36,400 slots are
placements; the other 5,967 (shapes that would leave the board) are never legal.

`engine-rs/src/net_v3.rs` builds the same table from the engine's placements and is tested against
this module's output (`h1_policy_index` example + `h1_parity.py`).
"""

from __future__ import annotations

import json

import numpy as np

from features import CANON

ORIENTATIONS = 91
CELLS = 400
POLICY_SIZE = ORIENTATIONS * CELLS  # 36,400


class PolicyIndex:
    """Placement ids ↔ policy indices, from `ml/data/placements.json` (the engine's own geometry)."""

    def __init__(self, path: str) -> None:
        raw = json.load(open(path))
        count = raw["count"]
        piece = np.array(raw["piece"], dtype=np.int64)
        orientation = np.array(raw["orientation"], dtype=np.int64)
        per_piece = np.array([orientation[piece == k].max() + 1 for k in range(piece.max() + 1)])
        first = np.concatenate([[0], np.cumsum(per_piece)[:-1]])
        assert per_piece.sum() == ORIENTATIONS, per_piece.sum()
        self.count = count
        self.piece = piece
        self.size = np.array(raw["size"], dtype=np.int64)
        index = np.empty(count, dtype=np.int64)
        cells = np.full((count, 5), CELLS, dtype=np.int64)
        by_cells: dict[tuple[int, ...], int] = {}
        for p, footprint in enumerate(raw["cells"]):
            xs = [c % 20 for c in footprint]
            ys = [c // 20 for c in footprint]
            index[p] = CELLS * (first[piece[p]] + orientation[p]) + 20 * min(ys) + min(xs)
            cells[p, : len(footprint)] = footprint
            by_cells[tuple(sorted(footprint))] = p
        assert len(np.unique(index)) == count, "policy index is not one-to-one"
        # board placement id → policy index in the board frame
        self.index = index
        self.cells = cells
        # canon[s, p]: placement id of p's image in mover s's frame.
        canon = np.empty((4, count), dtype=np.int64)
        for s in range(4):
            for p, footprint in enumerate(raw["cells"]):
                canon[s, p] = by_cells[tuple(sorted(int(CANON[s, c]) for c in footprint))]
        self.canon = canon
        # policy[s, p]: the policy index of board placement p when seat s moves.
        self.policy = index[canon]
        # Inverse: per policy slot, the canonical-frame placement id (−1 where none).
        slot = np.full(POLICY_SIZE, -1, dtype=np.int64)
        slot[index] = np.arange(count)
        self.slot = slot
        # Per policy slot: cells in the canonical frame (pad 400) and piece id (0 where none).
        self.slot_cells = np.full((POLICY_SIZE, 5), CELLS, dtype=np.int64)
        self.slot_cells[index] = cells
        self.slot_piece = np.zeros(POLICY_SIZE, dtype=np.int64)
        self.slot_piece[index] = piece
        self.slot_valid = slot >= 0
        # board placement id for (seat, policy slot): inverse of `policy`.
        board = np.full((4, POLICY_SIZE), -1, dtype=np.int64)
        for s in range(4):
            board[s, self.policy[s]] = np.arange(count)
        self.board = board
