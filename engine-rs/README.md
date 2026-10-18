# blokee — native engine

A Rust port of the bitboard engine (`src/ai/bitboard/`) for offline work: matches, tuning and
self-play data. The TS engine remains the reference and the browser engine; this crate's first
contract is to make **exactly** the decisions the TS engine makes, so native workers drop into the
existing harness without changing any number it reports.

## What is ported

| TS | Rust |
|---|---|
| `src/ai/rng.ts` | `rng.rs` — mulberry32, same stream |
| `bitboard.ts`, `placements.ts`, `zobrist.ts`, `seats.ts`, `position.ts` | `bitboard.rs`, `placements.rs`, `position.rs` |
| `territory.ts`, `regions.ts`, `features.ts` | `territory.rs`, `regions.rs`, `features.rs` |
| `ordering.ts`, `backup.ts` | `ordering.rs`, `backup.rs` |
| `playout.ts`, `rolloutPolicy.ts` | `playout.rs`, `rollout_policy.rs` |
| `packer.ts` | `packer.rs` |
| `mcts.ts` (`V12Search`) | `search.rs` |
| `index.ts` (`searchBestMoveV12`, `rankMovesGreedyV12`), `openingSelect.ts` (heuristic) | `engine.rs` |
| `src/ai/selfplay.ts` (`playSeatedGame`) | `game.rs` |
| `scripts/tournamentWorker.ts` | `bin/blokee-worker.rs` |

Not ported, and **rejected** rather than ignored when a config asks for them
(`BitboardParams::unsupported`): learned leaf/prior networks from TS (`netPath`, `pooledNetPath`),
opening books, `treeReuse`, root ensembles, root audits, piece feasibility, iteration banking, root
grouping, sequential halving, RAVE, variance tuning, MAST and implicit max^n. 119 of the 196
registered bitboard versions use none of these — including every release and champion (v3.1, v3.2,
v3.5, v3.7, the v4.1 family); `cargo run --release --example support_report` lists the rest.

Stays in TS: the UI and browser worker, the legacy object engine (`src/engine`, `src/ai/mcts.ts`),
the version registry, and the harness's orchestration and statistics.

## Exactness

`cargo test --release` checks fixtures written by `scripts/dumpGoldens.ts` (regenerate with
`npm run native:goldens`) bit-for-bit: tables and hashes, the RNG stream, legal moves, territory,
E_i, ordering, the greedy ranker, playouts, full searches and whole seeded games. Floats are
compared with `==`.

Two V8 behaviours are reproduced explicitly in `jsmath.rs`: `Math.exp` is V8's fdlibm port **as
clang compiles it on arm64** (the polynomial is FMA-contracted), and `Math.pow` is the platform's
libm. Parity therefore holds between the two engines on the same machine, which is the same
guarantee the TS engine already gives across processes.

## Speed (M4 Pro)

| | TS | native |
|---|---:|---:|
| µs / iteration, `v4.1-ultra` params, opening / midgame / late | 145 / 125 / 94 | 24.6 / 22.0 / 17.2 |
| `v4.1-ultra` mirror, 8 games at base 300, CPU seconds | 191 | 34 |
| `v4.1-ultra` self-play at base 300, games per hour | ≈780 (8 workers) | ≈8,800 (11 threads) |

The two changes that mattered beyond the port itself, both decision-identical:

- the rollout's legality test runs on an 11×11 window around the drawn corner, packed into a u128,
  against a few hundred translation-invariant shapes instead of 13-word board masks;
- the territory BFS expands whole layers as 7×u64 bitboards.

## Binaries

```bash
cargo build --release --manifest-path engine-rs/Cargo.toml     # npm run native:build

# Harness workers: any script built on scripts/lib/pool.ts.
npm run match -- --native --challenger v4.1-ultra --champion v3.5 --iterations 300 --seeds 100
BLOKEE_NATIVE=1 npm run matrix -- ...

# Native-only matches (configs with `native` extensions), scored by the TS statistic.
engine-rs/target/release/blokee-match --challenger a.json --champion engine-rs/configs/v4.1-ultra.json \
  --seeds 100 --seed-base 72345678 --budget 300 --out selfplay-results/m.jsonl
npm run aggregate -- selfplay-results/m.jsonl

# Self-play training data (512-byte records; layout in <out>/meta.json, reader in ml/torch/records.py).
engine-rs/target/release/blokee-selfplay --config engine-rs/configs/v4.1-ultra.json \
  --games 20000 --budget 300 --threads 11 --seed-base 61000000 --out ml/data/selfplay-v41u-300

# Placement geometry for the Python trainers.
engine-rs/target/release/blokee-tables > ml/data/placements.json
```

`engine-rs/configs/` holds every bitboard version resolved by the TS registry
(`scripts/exportResolvedConfigs.ts`). Regenerate it whenever a version changes; never edit it.

## Native-only extensions

A config may carry a `native` block that the TS engine never sees, so such a config can only be
played natively:

```json
"native": { "prior": { "socket": "/tmp/blokee-prior.sock", "blend": 0.5, "temperature": 1.0,
                       "phase": "all", "pseudoVisits": 0 } }
```

`prior` blends a learned policy, served by `ml/torch/serve.py`, into the root PUCT prior with the
semantics of TS `netPrior`/`netPriorBlend`/`rootPriorPseudoVisits`.
