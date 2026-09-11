# v3.7 workstream D — per-iteration cost reduction

## Why this is first

No implementation-speedup pass has ever been run on this engine. Every "faster" number in the record
is either a design-time representation change (the bitboard rewrite, ~20% against the object engine,
`blokus_ai_research_report_v4.md:334`) or an *algorithmic* one — fewer iterations, cheaper rollouts, a
network replacing a playout. `v12_postmortem.md:271` asked for a per-iteration cost model twice; it
was never built.

Three properties make this outrank every other v3.7 arm:

1. **It shifts every tier left at once.** Nano through Pro Max, from one change. Workstreams A and B
   buy compute and therefore only apply where spending more is acceptable; A's own plan concedes it
   may be "named for only one tier".
2. **It pays about double at the cheap end.** A 20% per-iteration saving buys 25% more iterations at
   fixed wall clock: ≈+0.80 points at Lite (≈2.5 points/doubling near 300 iterations) against ≈+0.42
   at Pro (≈1.3). The measured frontier agrees — ≈4.3 points/doubling between 75 ms and 178 ms against
   ≈1.5 between 178 ms and 353 ms.
3. **It needs no strength ladder.** A behaviour-preserving change plays *identical moves on identical
   seeds*. That is an identity test costing seconds, not a 540-seed ladder costing hours. Strength is
   inherited, not re-measured.

`STRUCTURAL` The scope boundary is absolute: **any change that alters a single move is out of scope
for this workstream** and becomes an ordinary candidate under the master plan's ladder. This arm's
entire claim rests on the output being bit-identical, and a change that "should be equivalent" is not.

## The identity contract

Three layers already exist and are strong enough to carry this:

- `src/ai/bitboard/search.test.ts:42-64` asserts the **full ranked visit vector** for a fixed seed and
  budget, not merely the best move. That is exactly the invariant a refactor must preserve.
- `src/ai/bitboard/playout.test.ts:79` asserts rollout determinism under a fixed seed.
- `scripts/tournament.ts:203` fails any mirror match that does not print exactly `0.00`.

What is missing is a harness that applies the first of these at *real* budgets across *phase-
representative* positions; the vitest check runs 60–80 iterations on two positions.

## Tooling to build first

The arm cannot be measured with what exists.

- **`scripts/benchSearch.ts` benchmarks the wrong engine.** It imports `src/ai/mcts.ts` and
  `src/engine/game.ts` — the legacy object board — and never touches `src/ai/bitboard/`. It is the
  only script that reports iterations per second, and that number describes code the champion does not
  run. Do not extend it; write a bitboard equivalent.
- **No ms-per-iteration figure exists anywhere in the repo**, and no per-phase cost breakdown. The
  `v3*Bench.ts` family already samples plies 8 / 24 / 40 and then averages them away
  (`v43FeatureBench.ts:37`). Emitting per-fixture timings is a one-line change and immediately yields
  the opening/midgame/endgame cost profile.
- Machine noise is currently larger than several deltas these scripts report: two measurements of
  `v3.2-pro` on the same machine differ by 8% (`v45-spatial-benchmark.json` against
  `v43-feature-benchmark.json`). Any benchmark for this arm must warm up, repeat, and rotate arm order
  the way `v45SpatialBench.ts:78-85` does.

New: `scripts/benchBitboard.ts` (ms/iteration and ms/move by phase, warmed and order-rotated) and
`scripts/v37ReplayDiff.ts` (full visit-vector diff at real budgets across phase fixtures).

## Targets, in descending expected value

The engine is already disciplined about module-level scratch buffers — `territory.ts:66`,
`regions.ts:34`, `playout.ts:36`, the `V12Search` field block at `mcts.ts:227` — so the remaining wins
are concentrated, not diffuse.

| # | Target | Why |
|---|---|---|
| 1 | `Position.apply()` — `position.ts:404-419` | Allocates an `Undo` object **plus two `Uint32Array` halo snapshots** per move application. Called once per tree edge *and once per playout ply*; at the promoted 84-ply full-length rollout that is ~90 objects and ~180 typed arrays **per iteration**, and it is the dominant GC pressure in the engine. Replace with a depth-indexed preallocated undo stack. |
| 2 | `Playout.run` — `playout.ts:257-258, 285, 311, 336` | Two fresh arrays per playout, one object per ply, and a polymorphic `'record' in entry` check on every unwind and again in `updateMast`. `traceMovers`/`traceMoves` (`playout.ts:203`) already demonstrate the preallocated pattern in the same class. |
| 3 | `sampleMoves` dedup — `playout.ts:106-112` | O(n²) linear scan over everything accepted so far; up to ~1,100 comparisons per ply at the promoted move cap, ~90k per iteration. `Position.generateFromCorners` solves the identical problem with a generation stamp at `position.ts:335`. |
| 4 | `sortByScore` — `ordering.ts:309-317` | A boxed `Array` plus comparator closure plus two typed-array copies per expansion, over 96 candidates at the root. Use an in-place indirect sort on a preallocated `Int32Array`. **Preserve the `|| moves[a] - moves[b]` tie-break byte-for-byte** — that clause is load-bearing for determinism. |
| 5 | Loop-invariant hoists — `mcts.ts:1016, 1027, 1040-1041, 1046` and `mcts.ts:1502, 1521` | `this.params.search.*` re-read inside the per-child PUCT loop, and inside the per-seat backup loop (4× per node per iteration). Siblings are already destructured one line above at `mcts.ts:1021`. `Math.log(Math.max(2, node.visits))` at `:1046` is constant across the loop. |
| 6 | Dead work — `mcts.ts:611`, `mcts.ts:690` | `:611` slices a scratch array purely to satisfy a signature that already takes a count (`ordering.ts:280`). `:690` allocates a fresh `Uint8Array(PIECE_COUNT)` while the preallocated `this.amafSeen` (`mcts.ts:241`) sits unused on that path. |
| 7 | `refreshContext` caching — `features.ts:80-96` | A full board pass (territory + region labelling + ownership) called from `leafValue` three times, from `Playout.run` per truncated playout, and per Δsplit candidate. No allocations, but the most-called board-wide computation, and nothing caches it against `position.hashLo/hashHi` even when the position is unchanged between two calls on the same leaf. **Lower confidence than 1–6: caching has correctness risk that pure allocation removal does not.** |

## Protocol

1. Build `benchBitboard.ts` and `v37ReplayDiff.ts`. Record a baseline: ms/iteration and ms/move at
   each tier, split by phase.
2. Apply targets in order, one at a time. After each: `npm test`, then `v37ReplayDiff.ts` must report
   zero differing visit vectors, then re-benchmark.
3. A target whose identity check fails is reverted, not debugged into approximate equivalence.
4. After the final target, run one mirror match at 20 seeds; it must print exactly `0.00`.
5. Re-run `scripts/hanniGreedyTrajectories.ts` so the published cost axis reflects the new numbers,
   and update `costMsPerMove` in `site/src/data/models.ts` from measurement.

## Result — 2026-08-24

`MEASURED` **−29.5% per iteration, verified behaviour-identical.** Every tier and phase between −21%
and −39%. `scripts/v37ReplayDiff.ts --check` reports identical full visit vectors across three
versions and three phases; 193 tests pass; the mirror match prints `−0.00 [−0.00, 0.00]`, and that
80-game block ran in 3.7 min against 5.1 min for the same-size block before the change — an
independent end-to-end confirmation of the microbenchmark.

`MEASURED` **The profile inverted the target list above, and that is the main methodological lesson.**
Target 1 — pooling `Position.apply`'s undo records, the "dominant GC pressure" in the static reading —
measured **−0.9% against an 18% noise floor**, i.e. unmeasurable. A CPU profile of a real search
(`scripts/v37Profile.ts`) then showed:

| frame | share of engine self time |
|---|---:|
| `playout.ts sampleMoves` | **74.7%** |
| `territory.ts floodSeat` | 6.0% |
| `position.ts apply` — *target 1* | **1.9%** |

One function was three quarters of the engine. Reading source and ranking suspects by eye put a 1.9%
item first and the 74.7% item third. **Profile before optimising** is now a standing rule for this
workstream.

Three fixes to `sampleMoves`, each identity-checked before the next was applied:

| fix | cumulative |
|---|---:|
| Bound the two 13-word intersection loops to the 1–3 words a placement touches (`placements.ts maskLo/maskHi`) | −7.0% |
| Replace the O(n²) dedup with a generation stamp, as `position.ts:335` already did | −8.5% |
| Skip pieces no longer in hand via a per-(cell, piece) cover index (`coverPieceStart`) | **−29.5%** |

`STRUCTURAL` The third is the large one, and it is only behaviour-identical because `coverList` turned
out to be **already grouped by piece and ascending within a piece** — verified empirically before
relying on it, not assumed. Iterating the pieces still in hand therefore visits the same ids in the
same order. The payoff is in the rollout tail: a playout runs to the end of the game, and by then most
of a seat's 21 pieces are down, so most of the cover list was scanned only to fail the hand test.

`ESTIMATE` Converted at each tier's own exchange rate, 1/0.705 = 1.418x more iterations at fixed wall
clock is 0.504 doublings:

| tier | rate | equivalent |
|---|---:|---:|
| Lite (~300 it) | 2.5 | **+1.26** |
| regular (~700) | 1.8 | +0.91 |
| Pro (~1380) | 1.3 | +0.66 |
| Pro Max (~2500) | 1.3 | +0.66 |

For scale, the entire v3.5 curve is +1.17 at Pro and cost ~8% more compute. **These are conversions,
not measured strength**; the measured fact is the cost reduction, and it is exact.

`PROPOSED` **Not finished.** The re-profile still puts `sampleMoves` at ~70% of engine self time. The
remaining cost is the cover-list walk itself and the Fisher-Yates corner draw, neither of which the
three fixes touched. A second pass is justified on the same evidence that justified the first.

## Kill condition

If the baseline profile shows allocation and the listed hot spots account for less than ~10% of
per-iteration time, stop. The arm will have cost an afternoon and produced the per-iteration cost
model the v12 postmortem asked for twice, which is worth having regardless.

`ESTIMATE` The size of the win is **unknown**. The allocation profile above suggests it is material,
but the "20%" used in the framing is an illustration of the exchange rate, not a prediction. The first
deliverable is the measurement.

## Files

- `scripts/benchBitboard.ts`, `scripts/v37ReplayDiff.ts` — new
- `src/ai/bitboard/position.ts`, `playout.ts`, `ordering.ts`, `mcts.ts` — targets 1–7
- `src/ai/bitboard/search.test.ts` — unchanged; it is the gate
