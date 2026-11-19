"""Hybrid H0 gate G2: the Rust encoder (`engine-rs/src/net_features.rs`) against `features.Encoder`.

    ml/.venv-hybrid/bin/python ml/torch/h0_encoding_parity.py --bin engine-rs/target/release/examples/h0_encode \
        --work tmp/h0/encoding --out tmp/h0/encoding-parity.json

Writes every record of the test games (games 19,000+) to `<work>/records.bin` exactly as stored, runs
the Rust encoder on that file, encodes the same records with `features.Encoder` on the CPU, and compares
the six model inputs element for element. Also writes `<work>/records.bin` for the other H0 tools.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from features import Encoder, Placements  # noqa: E402
from records import load_run  # noqa: E402

SHAPES = {"planes": ("planes.f32", "<f4", (13, 20, 20)), "hands": ("hands.f32", "<f4", (4, 21)),
          "footprint": ("footprint.i64", "<i8", (64, 5)), "pieces": ("pieces.i64", "<i8", (64,)),
          "mask": ("mask.u8", "u1", (64,)), "seat": ("seat.i64", "<i8", ())}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--run", default="ml/data/selfplay-v41u-300")
    parser.add_argument("--first-game", type=int, default=19000)
    parser.add_argument("--batch", type=int, default=4096)
    args = parser.parse_args()

    records, _ = load_run(args.run)
    records = records[records["game"] >= args.first_game]
    os.makedirs(args.work, exist_ok=True)
    path = os.path.join(args.work, "records.bin")
    records.tofile(path)
    rust_dir = os.path.join(args.work, "rust")
    log = subprocess.run([args.bin, path, rust_dir, "5"], check=True, capture_output=True, text=True).stdout.strip()
    print(log)
    n = len(records)
    rust = {k: np.fromfile(os.path.join(rust_dir, f), dtype=d).reshape((n, *s)) for k, (f, d, s) in SHAPES.items()}

    encoder = Encoder(Placements(args.placements), torch.device("cpu"))
    mismatches = {k: 0 for k in SHAPES}
    elements = {k: 0 for k in SHAPES}
    first_bad: dict[str, int] = {}
    for start in range(0, n, args.batch):
        chunk = records[start : start + args.batch]
        planes, hands = encoder.board(chunk)
        footprint, pieces, mask, _ = encoder.candidates(chunk)
        python = {"planes": planes, "hands": hands, "footprint": footprint, "pieces": pieces,
                  "mask": mask.to(torch.uint8), "seat": encoder.seat(chunk)}
        for key, value in python.items():
            mine = rust[key][start : start + len(chunk)]
            theirs = value.cpu().numpy().astype(mine.dtype).reshape(mine.shape)
            # Bit for bit: compare the raw bytes (planes and hands are 0.0 / 1.0 floats).
            bad = mine.view(np.uint8).reshape(len(chunk), -1) != theirs.view(np.uint8).reshape(len(chunk), -1)
            rows = np.nonzero(bad.any(1))[0]
            mismatches[key] += int(bad.sum())
            elements[key] += int(mine.size)
            if len(rows) and key not in first_bad:
                first_bad[key] = int(start + rows[0])
    result = {"records": n, "firstGame": args.first_game, "rustLog": log, "elements": elements,
              "mismatchedBytes": mismatches, "firstMismatchedRecord": first_bad,
              "recordsWithCandidates": int((records["candidates"] >= 1).sum()),
              "seats": np.bincount(records["seat"], minlength=4).tolist()}
    result["G2"] = "PASS" if not any(mismatches.values()) else "FAIL"
    print(json.dumps(result, indent=1))
    with open(args.out, "w") as handle:
        json.dump(result, handle, indent=1)


if __name__ == "__main__":
    main()
