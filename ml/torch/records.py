"""Readers for the native self-play records written by `engine-rs/src/bin/blokee-selfplay.rs`.

One record is 512 bytes; `meta.json` in each run directory documents the layout. Seats are in turn
order (0 blue, 1 green, 2 purple, 3 yellow), matching the engine.
"""

from __future__ import annotations

import glob
import json
import os

import numpy as np

RECORD = np.dtype(
    [
        ("game", "<u4"),
        ("ply", "<u2"),
        ("seat", "u1"),
        ("source", "u1"),
        ("own", "<u4", (4, 13)),
        ("hand", "<u4", (4,)),
        ("last_piece", "i1", (4,)),
        ("candidates", "u1"),
        ("_pad", "u1"),
        ("chosen", "<u2"),
        ("moves", "<u2", (64,)),
        ("visits", "<u2", (64,)),
        ("root_value", "<f4"),
        ("iterations", "<u4"),
        ("_tail", "u1", (8,)),
    ]
)
assert RECORD.itemsize == 512

SOURCE_SEARCH, SOURCE_HEURISTIC, SOURCE_PACKER, SOURCE_GREEDY = 0, 1, 2, 3


def load_run(directory: str) -> tuple[np.ndarray, dict[int, dict]]:
    """All records of a run (concatenated shards, sorted by game then ply) and its games by id."""
    shards = sorted(glob.glob(os.path.join(directory, "shard-*.bin")))
    records = np.concatenate([np.fromfile(path, dtype=RECORD) for path in shards]) if shards else np.zeros(0, RECORD)
    records = records[np.lexsort((records["ply"], records["game"]))]
    games: dict[int, dict] = {}
    with open(os.path.join(directory, "games.jsonl")) as handle:
        for line in handle:
            game = json.loads(line)
            games[game["game"]] = game
    # A game whose line is missing was interrupted mid-write; its records are unusable.
    keep = np.isin(records["game"], np.fromiter(games.keys(), dtype=np.uint32))
    return records[keep], games


def own_planes(records: np.ndarray) -> np.ndarray:
    """(N, 4, 400) uint8 occupancy per seat, unpacked from the 13-word bitboards."""
    words = records["own"].astype("<u4")
    bits = np.unpackbits(words.view(np.uint8).reshape(len(records), 4, 52), axis=2, bitorder="little")
    return bits[:, :, :400]
