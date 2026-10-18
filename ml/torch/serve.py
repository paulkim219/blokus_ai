"""Batched policy server for the native engine's learned root prior (experiment E3a).

    ml/.venv-torch/bin/python ml/torch/serve.py --checkpoint ml/torch/results/vit-patch-g18500-s0.pt \
        --socket /tmp/blokee-prior.sock

Protocol (see `engine-rs/src/prior.rs`): each request is one 512-byte self-play record (only the
board, hands, seat and candidate fields are read); each response is 64 little-endian float32
logits, one per candidate slot. Requests from every connected worker are pooled for up to
`--max-wait-ms` (or until `--max-batch`) and run through the network as one batch, through exactly
the encoder the network was trained with.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from features import Encoder, Placements  # noqa: E402
from model import ARMS  # noqa: E402
from records import RECORD  # noqa: E402
from train import device  # noqa: E402


class Batcher:
    def __init__(self, model, encoder: Encoder, max_batch: int, max_wait: float) -> None:
        self.model, self.encoder = model, encoder
        self.max_batch, self.max_wait = max_batch, max_wait
        self.queue: asyncio.Queue = asyncio.Queue()
        self.served = 0
        self.batches = 0
        self.started = time.time()

    async def submit(self, raw: bytes) -> bytes:
        future = asyncio.get_running_loop().create_future()
        await self.queue.put((raw, future))
        return await future

    async def run(self) -> None:
        while True:
            items = [await self.queue.get()]
            deadline = time.perf_counter() + self.max_wait
            while len(items) < self.max_batch:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    break
                try:
                    items.append(await asyncio.wait_for(self.queue.get(), remaining))
                except asyncio.TimeoutError:
                    break
            records = np.frombuffer(b"".join(raw for raw, _ in items), dtype=RECORD)
            with torch.no_grad():
                planes, hands = self.encoder.board(records)
                footprint, pieces, mask, _ = self.encoder.candidates(records)
                logits, _, _ = self.model(planes, hands, footprint, pieces, mask)
            out = logits.masked_fill(~mask, 0).float().cpu().numpy().astype("<f4")
            for (_, future), row in zip(items, out):
                future.set_result(row.tobytes())
            self.served += len(items)
            self.batches += 1
            if self.batches % 500 == 0:
                rate = self.served / (time.time() - self.started)
                print(f"served {self.served} positions in {self.batches} batches ({rate:.0f}/s)", flush=True)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--socket", default="/tmp/blokee-prior.sock")
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--max-batch", type=int, default=64)
    parser.add_argument("--max-wait-ms", type=float, default=2.0)
    args = parser.parse_args()

    dev = device()
    checkpoint = torch.load(args.checkpoint, map_location=dev)
    model = ARMS[checkpoint["arm"]]().to(dev)
    model.load_state_dict(checkpoint["state"])
    model.eval()
    encoder = Encoder(Placements(args.placements), dev)
    batcher = Batcher(model, encoder, args.max_batch, args.max_wait_ms / 1000)

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                raw = await reader.readexactly(RECORD.itemsize)
                writer.write(await batcher.submit(raw))
                await writer.drain()
        except asyncio.IncompleteReadError:
            pass
        finally:
            writer.close()

    if os.path.exists(args.socket):
        os.unlink(args.socket)
    server = await asyncio.start_unix_server(handle, path=args.socket)
    print(f"serving {checkpoint['arm']} from {args.checkpoint} on {args.socket} ({dev})", flush=True)
    asyncio.create_task(batcher.run())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
