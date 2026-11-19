"""Readers for record format v3 (hybrid H1; `engine-rs/src/record_v3.rs` documents the layout).

A v3 shard is a sequence of variable-length records, each starting with the magic "BKR3" and its
own length. `read_shard` walks a shard and returns the fixed header fields as a structured array
(field names shared with the v2 `records.RECORD` where they mean the same thing: `game`, `ply`,
`seat`, `source`, `own`, `hand`, `chosen`, `iterations`) plus the per-move arrays in CSR form.
"""

from __future__ import annotations

import glob
import json
import os

import numpy as np

MAGIC = int.from_bytes(b"BKR3", "little")
HEADER_BYTES = 296

HEADER = np.dtype(
    [
        ("magic", "<u4"),
        ("length", "<u4"),
        ("game", "<u4"),
        ("ply", "<u2"),
        ("seat", "u1"),
        ("source", "u1"),
        ("own", "<u4", (4, 13)),
        ("hand", "<u4", (4,)),
        ("last_piece", "i1", (4,)),
        ("chosen", "<u2"),
        ("n", "<u2"),
        ("iterations", "<u4"),
        ("root_visits", "<u4"),
        ("root_values", "<f4", (4,)),
        ("final_scores", "<f4", (4,)),
        ("teacher", "u1"),
        ("own_moves", "u1"),
        ("_reserved", "<u2"),
        ("seed", "<u4"),
    ]
)
assert HEADER.itemsize == HEADER_BYTES, HEADER.itemsize

SOURCE_SEARCH, SOURCE_HEURISTIC, SOURCE_PACKER, SOURCE_GREEDY, SOURCE_TEACHER = 0, 1, 2, 3, 4


def record_offsets(data: np.ndarray) -> np.ndarray:
    """Start offset of every record in a shard's bytes (checked against the magic)."""
    offsets = []
    at, end = 0, len(data)
    view = memoryview(data)
    while at < end:
        length = int.from_bytes(view[at + 4 : at + 8], "little")
        if int.from_bytes(view[at : at + 4], "little") != MAGIC or length < HEADER_BYTES:
            raise ValueError(f"bad record at byte {at}")
        offsets.append(at)
        at += length
    if at != end:
        raise ValueError("truncated shard")
    return np.array(offsets, dtype=np.int64)


def read_shard(path: str) -> dict[str, np.ndarray]:
    """Header (N,) structured array; `start` (N+1,) CSR offsets; `moves` u16, `visits` u32, `priors` f32."""
    data = np.fromfile(path, dtype=np.uint8)
    if len(data) == 0:
        return {"header": np.zeros(0, HEADER), "start": np.zeros(1, np.int64), "moves": np.zeros(0, np.uint16),
                "visits": np.zeros(0, np.uint32), "priors": np.zeros(0, np.float32)}
    offsets = record_offsets(data)
    header = np.empty(len(offsets), HEADER)
    raw = header.view(np.uint8).reshape(len(offsets), HEADER_BYTES)
    for lo in range(0, len(offsets), 50_000):
        chunk = offsets[lo : lo + 50_000]
        raw[lo : lo + len(chunk)] = data[chunk[:, None] + np.arange(HEADER_BYTES)[None, :]]
    n = header["n"].astype(np.int64)
    start = np.concatenate([[0], np.cumsum(n)])
    total = int(start[-1])
    visits = np.empty(total, np.uint32)
    priors = np.empty(total, np.float32)
    moves = np.empty(total, np.uint16)

    def gather(at: np.ndarray, width: int, dtype) -> np.ndarray:
        idx = at[:, None] + np.arange(width)[None, :]
        return data[idx].view(dtype).reshape(-1)

    for lo in range(0, len(offsets), 20_000):
        hi = min(lo + 20_000, len(offsets))
        nn = n[lo:hi]
        a, b = start[lo], start[hi]
        within = np.arange(b - a) - np.repeat(start[lo:hi] - a, nn)
        base = np.repeat(offsets[lo:hi] + HEADER_BYTES, nn)
        nrep = np.repeat(nn, nn)
        visits[a:b] = gather(base + 4 * within, 4, "<u4")
        priors[a:b] = gather(base + 4 * nrep + 4 * within, 4, "<f4")
        moves[a:b] = gather(base + 8 * nrep + 2 * within, 2, "<u2")
    return {"header": header, "start": start, "moves": moves, "visits": visits, "priors": priors}


def load_run_v3(directory: str) -> tuple[dict[str, np.ndarray], dict[int, dict]]:
    """Every shard of a run, concatenated and sorted by (game, ply), and its games by id. Games whose
    line is missing from `games.jsonl` (interrupted) are dropped."""
    shards = sorted(glob.glob(os.path.join(directory, "v3-shard-*.bin")))
    parts = [read_shard(p) for p in shards]
    header = np.concatenate([p["header"] for p in parts])
    lengths = np.concatenate([np.diff(p["start"]) for p in parts])
    moves = np.concatenate([p["moves"] for p in parts])
    visits = np.concatenate([p["visits"] for p in parts])
    priors = np.concatenate([p["priors"] for p in parts])
    starts = np.concatenate([[0], np.cumsum(lengths)])
    games: dict[int, dict] = {}
    with open(os.path.join(directory, "games.jsonl")) as handle:
        for line in handle:
            g = json.loads(line)
            games[g["game"]] = g
    keep = np.isin(header["game"], np.fromiter(games.keys(), dtype=np.uint32))
    order = np.lexsort((header["ply"], header["game"]))
    order = order[keep[order]]
    n = lengths[order]
    new_start = np.concatenate([[0], np.cumsum(n)])
    idx = np.repeat(starts[order], n) + (np.arange(int(new_start[-1])) - np.repeat(new_start[:-1], n))
    return {"header": header[order], "start": new_start, "moves": moves[idx], "visits": visits[idx], "priors": priors[idx]}, games
