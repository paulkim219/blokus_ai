#!/usr/bin/env python3
"""Build and run the controlled v6 opponent-information replay on Linux/WSL2 or macOS."""

import argparse
import fcntl
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import monotonic


ROOT = Path(__file__).resolve().parents[2]
CRATE = ROOT / "engine-rs"
EXAMPLE = "v6_opponent_replay"
UINT32_MAX = 2**32 - 1


def positive(text):
    value = int(text)
    if not 1 <= value <= UINT32_MAX:
        raise argparse.ArgumentTypeError("expected a positive 32-bit integer")
    return value


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smoke", action="store_true", help="use tiny budgets to verify installation")
    parser.add_argument("--homogeneous", action="store_true", help="identical known and generic policies; paired result must be zero")
    parser.add_argument("--seeds", type=positive, help="seed blocks of four seat rotations (default 32)")
    parser.add_argument("--seed-base", type=int, help="first seed block (default 146000000 for the pilot)")
    parser.add_argument("--workers", type=positive, default=2, help="simultaneous CPU searches; start with two")
    parser.add_argument("--planning", type=positive, help="terminal samples per candidate per planner (default 32)")
    parser.add_argument("--evaluation", type=positive, help="fresh paired samples per changed decision (default 64)")
    parser.add_argument("--out", type=Path, help="new or matching result directory, resumed by complete seed")
    args = parser.parse_args()
    if args.seed_base is None:
        args.seed_base = 145_900_000 if args.smoke else 146_000_000
    args.seeds = args.seeds or (1 if args.smoke else 32)
    args.planning = args.planning or (2 if args.smoke else 32)
    args.evaluation = args.evaluation or (2 if args.smoke else 64)
    if not 0 <= args.seed_base <= UINT32_MAX - args.seeds + 1:
        parser.error("seed block would exceed the 32-bit range")
    mode = "smoke" if args.smoke else "pilot"
    label = mode + ("-homogeneous" if args.homogeneous else "")
    args.out = (args.out or ROOT / "tmp" / "v6-replay" / label).resolve()
    return args


def write_json(path, obj):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(obj, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def build():
    manifest = str(CRATE / "Cargo.toml")
    subprocess.run(["cargo", "build", "--locked", "--release", "--manifest-path", manifest,
                    "--example", EXAMPLE], cwd=ROOT, check=True)
    metadata = subprocess.check_output(["cargo", "metadata", "--format-version", "1",
                                        "--no-deps", "--manifest-path", manifest], cwd=ROOT)
    return Path(json.loads(metadata)["target_directory"]) / "release" / "examples" / EXAMPLE


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(rows, seed, homogeneous):
    if len(rows) != 4 or [r["hero"] for r in rows] != list(range(4)):
        raise ValueError(f"incomplete rotations for seed {seed}")
    for r in rows:
        same = r["generic_move"] == r["informed_move"]
        if r["seed"] != seed or not math.isfinite(r["delta"]) or (same and r["delta"] != 0):
            raise ValueError(f"invalid paired row for seed {seed}")
        if homogeneous and (not same or r["generic_planning_margin"] != r["informed_planning_margin"]):
            raise ValueError(f"homogeneous identity failed for seed {seed}")


def summarize(blocks):
    deltas = [statistics.mean(row["delta"] for row in block) for block in blocks]
    rows = [r for block in blocks for r in block]
    changed = [r for r in rows if r["generic_move"] != r["informed_move"]]
    interval = None
    if len(deltas) > 1:
        rng = random.Random(611)
        boot = sorted(statistics.mean(rng.choices(deltas, k=len(deltas))) for _ in range(2000))
        interval = [boot[49], boot[1949]]
    return {"seed_blocks": len(blocks), "scheduled_decisions": len(rows),
            "multi_candidate_decisions": sum(len(r["candidate_moves"]) > 1 for r in rows),
            "changed_decisions": len(changed), "changed_fraction": len(changed) / len(rows),
            "mean_paired_margin_gain": statistics.mean(deltas), "seed_bootstrap_95": interval,
            "mean_gain_when_changed": statistics.mean(r["delta"] for r in changed) if changed else None}


def run(args, binary):
    candidates, budget = (2, 1) if args.smoke else (4, 300)
    config = ROOT / "engine-rs/configs/v5.2-pro.json"
    table = ROOT / json.loads(config.read_text())["search"]["playoutTablePath"]
    protocol = {"protocol": 1, "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "binary_sha256": sha256(binary), "config_sha256": sha256(config), "table_sha256": sha256(table),
                "smoke": args.smoke, "homogeneous": args.homogeneous, "seed_base": args.seed_base,
                "seeds": args.seeds, "candidates": candidates, "planning": args.planning,
                "evaluation": args.evaluation, "root_budget": budget}
    manifest = args.out / "manifest.json"
    if manifest.exists():
        if json.loads(manifest.read_text()) != protocol:
            raise SystemExit(f"Settings, binary or revision differ from {manifest}; use a new --out.")
    elif any(p.name != ".lock" for p in args.out.iterdir()):
        raise SystemExit(f"Existing data without a manifest in {args.out}; use a new --out.")
    else:
        write_json(manifest, protocol)

    def block(seed):
        path = args.out / f"seed-{seed}.json"
        if path.exists():
            rows = json.loads(path.read_text())
            validate(rows, seed, args.homogeneous)
            return rows
        raw = subprocess.check_output([str(binary), *map(str, (seed, candidates, args.planning,
                                      args.evaluation, budget, int(args.homogeneous)))], cwd=ROOT)
        rows = json.loads(raw)
        validate(rows, seed, args.homogeneous)
        write_json(path, rows)
        return rows

    started = monotonic()
    blocks = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = [pool.submit(block, args.seed_base + i) for i in range(args.seeds)]
        for done in as_completed(jobs):
            blocks.append(done.result())
            print(f"{len(blocks)}/{args.seeds} blocks complete ({monotonic()-started:.1f}s)", flush=True)
    result = summarize(sorted(blocks, key=lambda b: b[0]["seed"]))
    write_json(args.out / "summary.json", result)
    print(json.dumps(result, indent=2), flush=True)
    print(f"Results: {args.out}")


if __name__ == "__main__":
    args = arguments()
    try:
        binary = build()
    except FileNotFoundError:
        raise SystemExit("Rust cargo is required. In WSL2, load your Rust toolchain first.")
    args.out.mkdir(parents=True, exist_ok=True)
    with (args.out / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(f"Another runner is writing {args.out}.")
        run(args, binary)
