"""Batched network server for the native engine (E3a root prior; E6 model-v2 evaluations).

    ml/.venv-torch/bin/python ml/torch/serve.py --checkpoint ml/torch/results/vit-patch-g18500-s0.pt \
        --socket /tmp/blokee-prior.sock [--protocol 2]

Requests from every connected worker are pooled for up to `--max-wait-ms` (or until `--max-batch`)
and run through the network as one batch, through exactly the encoder the network was trained with.

**Protocol 1** (default; see `engine-rs/src/prior.rs`): each request is one 512-byte self-play
record (only the board, hands, seat and candidate fields are read); each response is 64
little-endian float32 logits, one per candidate slot (0 for padding). Any checkpoint (v1 or v2)
serves it; for a v2 checkpoint the logits are its main policy head.

**Protocol 2** (model-v2 checkpoints only): the request is the same 512-byte record. A client may
pipeline any number of requests on one connection before reading; the server reads them as they
arrive, batches them with everyone else's, and writes the responses back on that connection in
request order. Each response is 76 little-endian float32 (304 bytes):

- [0, 64): policy logits by candidate slot, 0 for padding slots (≥ the record's candidate count);
- [64, 76): utilities, relative seat r = 0..3 (absolute seat (mover + r) % 4, mover = byte 6 of the
  request) × [margin, rank, first], i.e. index 64 + 3·r + k. Each is a probability in [0, 1]:
  margin = sigmoid(head) ≈ E[sigmoid((score − best other) / 12)], rank = sigmoid(head) ≈ expected
  fraction of opponents beaten (ties ½), first = softmax over the four seats ≈ P(first place), ties
  split; the four `first` values sum to 1.

`--selftest` connects to an already-running server instead of serving, pipelines 41 records from
the test games over two interleaved connections, and checks response sizes, order and values
against the same checkpoint run in-process.
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
from model import ARMS, model_version, utility_probabilities  # noqa: E402
from records import RECORD  # noqa: E402
from train import device  # noqa: E402

RESPONSE_FLOATS = {1: 64, 2: 76}


class Batcher:
    def __init__(self, model, encoder: Encoder, max_batch: int, max_wait: float, protocol: int = 1) -> None:
        self.model, self.encoder = model, encoder
        self.max_batch, self.max_wait = max_batch, max_wait
        self.protocol = protocol
        self.version = model_version(model)
        self.queue: asyncio.Queue = asyncio.Queue()
        self.served = 0
        self.batches = 0
        self.started = time.time()

    async def submit(self, raw: bytes) -> bytes:
        return await self.enqueue(raw)

    def enqueue(self, raw: bytes) -> asyncio.Future:
        """Queue one request without waiting for it; the future resolves to the response bytes."""
        future = asyncio.get_running_loop().create_future()
        self.queue.put_nowait((raw, future))
        return future

    def infer(self, records: np.ndarray) -> np.ndarray:
        """(B, 64) or (B, 76) little-endian float32 responses."""
        with torch.no_grad():
            planes, hands = self.encoder.board(records)
            footprint, pieces, mask, _ = self.encoder.candidates(records)
            if self.version == 2:
                out = self.model(planes, hands, footprint, pieces, mask, self.encoder.seat(records))
                logits = out["policy"]
            else:
                logits, _, _ = self.model(planes, hands, footprint, pieces, mask)
            logits = logits.masked_fill(~mask, 0).float()
            if self.protocol == 2:
                utilities = utility_probabilities(out["utility"].float()).reshape(len(records), 12)
                logits = torch.cat([logits, utilities], dim=1)
        return logits.cpu().numpy().astype("<f4")

    async def run(self) -> None:
        while True:
            items = [await self.queue.get()]
            deadline = time.perf_counter() + self.max_wait
            while len(items) < self.max_batch:
                # Take whatever is already queued without yielding, then wait out the deadline.
                while len(items) < self.max_batch and not self.queue.empty():
                    items.append(self.queue.get_nowait())
                remaining = deadline - time.perf_counter()
                if remaining <= 0 or len(items) >= self.max_batch:
                    break
                try:
                    items.append(await asyncio.wait_for(self.queue.get(), remaining))
                except asyncio.TimeoutError:
                    break
            records = np.frombuffer(b"".join(raw for raw, _ in items), dtype=RECORD)
            out = self.infer(records)
            for (_, future), row in zip(items, out):
                if not future.cancelled():
                    future.set_result(row.tobytes())
            self.served += len(items)
            self.batches += 1
            if self.batches % 500 == 0:
                rate = self.served / (time.time() - self.started)
                print(f"served {self.served} positions in {self.batches} batches ({rate:.0f}/s)", flush=True)


def load(path: str, dev: torch.device):
    checkpoint = torch.load(path, map_location=dev)
    model = ARMS[checkpoint["arm"]]().to(dev)
    model.load_state_dict(checkpoint["state"])
    model.eval()
    return model, checkpoint["arm"]


async def serve(args) -> None:
    dev = device()
    model, arm = load(args.checkpoint, dev)
    if args.protocol == 2 and model_version(model) != 2:
        raise SystemExit(f"--protocol 2 needs a model-v2 checkpoint; {args.checkpoint} is {arm}")
    encoder = Encoder(Placements(args.placements), dev)
    batcher = Batcher(model, encoder, args.max_batch, args.max_wait_ms / 1000, args.protocol)

    async def handle_v1(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                raw = await reader.readexactly(RECORD.itemsize)
                writer.write(await batcher.submit(raw))
                await writer.drain()
        except asyncio.IncompleteReadError:
            pass
        finally:
            writer.close()

    async def handle_v2(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # The reader queues every request as soon as it arrives; a separate task writes the
        # responses in request order, so a pipelining client's records share one batch.
        pending: asyncio.Queue = asyncio.Queue()

        async def write_back() -> None:
            while True:
                future = await pending.get()
                if future is None:
                    break
                writer.write(await future)
                if pending.empty():
                    await writer.drain()
            await writer.drain()

        writing = asyncio.create_task(write_back())
        try:
            while True:
                raw = await reader.readexactly(RECORD.itemsize)
                pending.put_nowait(batcher.enqueue(raw))
        except asyncio.IncompleteReadError:
            pass
        except ConnectionError:
            pass
        finally:
            pending.put_nowait(None)
            try:
                await writing
            except ConnectionError:
                pass
            writer.close()

    # Warm the device so the first real batch is not a cold start.
    batcher.infer(np.zeros(1, dtype=RECORD))
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    server = await asyncio.start_unix_server(handle_v2 if args.protocol == 2 else handle_v1, path=args.socket)
    print(f"serving {arm} from {args.checkpoint} on {args.socket} ({dev}), protocol {args.protocol}, "
          f"max batch {args.max_batch}, max wait {args.max_wait_ms} ms", flush=True)
    asyncio.create_task(batcher.run())
    async with server:
        await server.serve_forever()


def selftest(args) -> None:
    """Pipeline 41 records over two interleaved connections and check every response."""
    import socket

    from records import load_run

    floats = RESPONSE_FLOATS[args.protocol]
    records, _ = load_run(args.run)
    rng = np.random.default_rng(1)
    pool = np.nonzero((records["game"] >= 19000) & (records["candidates"] >= 2) & (records["source"] == 0))[0]
    picks = records[np.sort(rng.choice(pool, 41, replace=False))]
    dev = device()
    model, arm = load(args.checkpoint, dev)
    expected = Batcher(model, Encoder(Placements(args.placements), dev), 64, 0.0, args.protocol).infer(picks)

    def read(sock: socket.socket, n: int) -> bytes:
        data = b""
        while len(data) < n:
            chunk = sock.recv(n - len(data))
            if not chunk:
                raise SystemExit(f"server closed after {len(data)} of {n} bytes")
            data += chunk
        return data

    a, b = socket.socket(socket.AF_UNIX), socket.socket(socket.AF_UNIX)
    a.connect(args.socket)
    b.connect(args.socket)
    # Connection a gets records 0..40 in order (one 41-record pipeline, written before any read);
    # connection b gets the same 41 in reverse order, interleaved with a's writes.
    started = time.perf_counter()
    for i in range(41):
        a.sendall(picks[i : i + 1].tobytes())
        b.sendall(picks[40 - i : 41 - i].tobytes())
    got_a = np.frombuffer(read(a, 41 * floats * 4), dtype="<f4").reshape(41, floats)
    got_b = np.frombuffer(read(b, 41 * floats * 4), dtype="<f4").reshape(41, floats)[::-1]
    elapsed = time.perf_counter() - started
    a.close()
    b.close()
    errors = []
    for label, got in (("a", got_a), ("b (reversed)", got_b)):
        diff = np.abs(got - expected).max()
        if diff > 1e-3:
            row = int(np.abs(got - expected).max(1).argmax())
            errors.append(f"connection {label}: max |diff| {diff:.4g} (worst row {row})")
    count = picks["candidates"].astype(int)
    if np.any(got_a[:, :64][np.arange(64)[None, :] >= count[:, None]] != 0):
        errors.append("non-zero logit in a padding slot")
    if args.protocol == 2:
        util = got_a[:, 64:].reshape(41, 4, 3)
        if util.min() < 0 or util.max() > 1:
            errors.append("utility outside [0, 1]")
        if np.abs(util[:, :, 2].sum(1) - 1).max() > 1e-4:
            errors.append("P(first) does not sum to 1 across seats")
    print(f"selftest {arm}, protocol {args.protocol}: 2 connections × 41 pipelined records, "
          f"{floats} floats each, {elapsed * 1000:.0f} ms round trip")
    if args.protocol == 2:
        print("first record utilities (rel seat × [margin, rank, first]):")
        print(np.array2string(got_a[0, 64:].reshape(4, 3), precision=3))
    if errors:
        raise SystemExit("SELFTEST FAILED: " + "; ".join(errors))
    # Latency of the E6 pattern: one move's 41 positions written at once, then read back.
    c = socket.socket(socket.AF_UNIX)
    c.connect(args.socket)
    payload = picks.tobytes()
    times = []
    for _ in range(20):
        t0 = time.perf_counter()
        c.sendall(payload)
        got = np.frombuffer(read(c, 41 * floats * 4), dtype="<f4").reshape(41, floats)
        times.append(time.perf_counter() - t0)
    c.close()
    if np.abs(got - expected).max() > 1e-3:
        raise SystemExit("SELFTEST FAILED: single-write 41-record pipeline returned wrong values")
    print(f"41 records in one write, 20 rounds: median {np.median(times) * 1000:.1f} ms, "
          f"min {min(times) * 1000:.1f} ms per round trip")
    print("SELFTEST OK: shapes, order (both connections) and values match the in-process model")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--socket", default="/tmp/blokee-prior.sock")
    parser.add_argument("--placements", default="ml/data/placements.json")
    parser.add_argument("--protocol", type=int, choices=[1, 2], default=1)
    parser.add_argument("--max-batch", type=int, default=None, help="default 64 (protocol 1), 512 (protocol 2)")
    parser.add_argument("--max-wait-ms", type=float, default=2.0)
    parser.add_argument("--selftest", action="store_true", help="act as a test client of a running server")
    parser.add_argument("--run", default="ml/data/selfplay-v41u-300", help="--selftest: where to take records from")
    args = parser.parse_args()
    if args.max_batch is None:
        args.max_batch = 512 if args.protocol == 2 else 64
    if args.selftest:
        selftest(args)
    else:
        asyncio.run(serve(args))


if __name__ == "__main__":
    main()
