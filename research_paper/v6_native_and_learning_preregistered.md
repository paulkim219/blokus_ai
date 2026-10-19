# v6 — native engine, scaled self-play data, and learned priors: preregistration

Written 2026-10-18, before any of the measurements below were taken. Results go in
`v6_native_and_learning_results.md`; this file is not edited after the runs start, except to append
the dated addendum section at the end.

## Why

The v4 and v5 programmes ended with the same diagnosis from two directions. Every learned component
was trained on a few hundred games (`v4_learning_programme.md`: ~393 independent outcomes; the v5
transformer arm had 96 sequences), its labels came from a noisy, truncated teacher (top-12 of
~40 root children; the oracle's move fell outside the top 12 in 46.3% of positions), and its
3×3 trunk could not see past a 7×7 window. None of those is a model-size problem. All of them are
cheaper to fix with a faster engine, which is why E0 comes first.

## E0 — native engine (completed before this document; recorded for the record)

`engine-rs/` ports the bitboard engine's play path to Rust. The gate was exactness, not speed:

- `cargo test --release` matches TS fixtures from `scripts/dumpGoldens.ts` bit-for-bit: placement
  table and Zobrist keys, RNG stream, legal moves, territory, E_i in all three phases, move
  ordering with Δsplit, the greedy ranker, playouts (including the RNG state after each), full
  searches (ranked root, visits, values, RNG state after), and five whole seeded games.
- Cross-engine matches: 40/40 (`v4.1-ultra` vs `v3.5`, 30 base iterations) and 8/8 (`v4.1-ultra`
  mirror, 300) games identical in every score; the native mirror prints exactly 0.00.
- Two V8 behaviours had to be reproduced, not assumed: `Math.exp` is fdlibm *with FMA contraction
  of the polynomial* (Node 25, arm64), and `Math.pow` is the platform libm. Probed on 250k values.

Speed is a measurement, not a gate: per-iteration cost on fixed positions fell from 145 / 125 / 94 µs
(TS) to 24.6 / 22.0 / 17.2 µs (opening / midgame / late); a `v4.1-ultra` mirror match at 300 base
iterations took 34 s of CPU against 191 s.

## Settle fix — `v4.1-ultra-settlefix` vs `v4.1-ultra`

Found while porting: `V12Search.iterate` replays a node's cached settle only while the node is
uninitialised, so on later visits a move generated for `node.turn` is applied with `position.turn`
pointing at a seat that was settled out. Instrumented on four `v4.1-ultra` self-play games this is
1.8%, 5.6%, 6.2% and 3.0% of tree descents. `search.replaySettle: true` re-applies the cache on
every descent; `false` (every existing version) is byte-identical.

- Match: 200 seeds × 4 seats, base 300 iterations, seeds 71,234,567–71,234,766 (outside the tuner's
  `g·100,000 + i` lattice and outside every training seed below), native engine.
- **Pass** if the 95% CI lower bound is above 0. A pass is a candidate only: promotion additionally
  requires a fresh, disjoint 200-seed block with the same verdict.
- A null is informative too: it would mean the corrupted tail of the tree is too rarely selected to
  matter at this budget.

## E1 — is the learned policy data-limited?

- Data: 20,000 native `v4.1-ultra` self-play games at base 300 (4,800 iterations per searched
  move), seeds 61,000,000–61,019,999, opening sampling as in the match harness (first 8 plies from
  the top 3). Each record keeps every root child with its visit count (up to 40), not a top-12.
- Split by game: games 19,000–19,999 test, 18,500–18,999 validation (checkpoint selection only),
  training on games 0…N−1.
- Arm: `conv-small` (v4.5-class: three 3×3 conv layers at width 16, footprint-pooled policy),
  20,000 steps at N = 1,000, 5,000 and 18,500; `resnet` (8 global-pooling residual blocks, width 96)
  at N = 5,000 and 18,500 with 8,000 steps.
- Metric: test policy KL(visits ‖ model) and top-1 agreement on search decisions.
- **Reading, fixed in advance:** if KL at N = 18,500 is not clearly below KL at N = 1,000 for
  `conv-small` (less than a 0.02 nat improvement), the v4 ceiling was the inputs or the trunk, not
  the data, and scaling data alone is closed. If it improves and keeps improving to 18,500, the
  v4 programme was data-starved.

## E2 — does global attention help at matched compute?

- Same data and split. Arms at roughly equal GPU time (~45–50 min each on the M4 Pro):
  `resnet` 8,000 steps, `vit-patch` (2×2 patches, d 192, 6 layers) 6,000 steps, `vit-cell`
  (400 cell tokens, d 128, 6 layers) 3,000 steps; all at N = 18,500.
- Metrics: test policy KL, top-1/top-5, value R² of the mover's final margin, ownership accuracy,
  and forward throughput (positions/s, batch 512, on the GPU).
- **Selection:** the arm with the lowest test policy KL, unless another arm is within 0.01 nats and
  at least 2× faster, in which case the faster arm. That arm goes to E3a.

## E3a — learned root prior inside the incumbent search

- Challenger: `v4.1-ultra` with the selected E2 network blended into the root PUCT prior
  (`native.prior`, same semantics as TS `netPrior`/`netPriorBlend`), served by `ml/torch/serve.py`.
  Blends 0.25 and 0.5 at temperature 1.0, no pseudo-visits.
- Champion: `v4.1-ultra`. Base 300 iterations; the challenger's network call is extra wall-clock
  that is reported, not charged against its iteration budget (the prior is one batched call per
  move, against 4,800 iterations).
- Screen: 100 seeds per blend, seeds 72,345,678 onward. **Pass** if mean ≥ +0.50 with the CI lower
  bound above 0. A passing blend then gets a fresh 200-seed confirmation on disjoint seeds.
- History says to expect a null: the v4.x root-prior channel measured +0.12 to +0.20 at best, and
  deleting the prior entirely cost only −0.12. A pass here would mean the old prior was limited by
  its training, not by how much the root prior can matter.

## What is explicitly not claimed

- Nothing here is measured against humans. All teachers and opponents are engines.
- A better offline KL is not a strength result; the repo has already seen offline gains of 4.8 pp
  pair accuracy turn into −0.27 online. Only matches count.

## Addendum

(Dated entries only, below this line.)

- **2026-10-18, settle fix screen read; confirmation fixed before it runs.** The screen block
  (seeds 71,234,567–71,234,766) measured +0.29 [0.17, 0.43]. The confirmation block is seeds
  71,334,567–71,334,766 with the same configs, budget and gate (95% CI lower bound above 0).
- **2026-10-18, settle fix confirmed.** Confirmation block measured +0.27 [0.14, 0.42]; both blocks
  pass, so `v4.1-ultra-settlefix` meets the promotion rule. E3a still uses `v4.1-ultra` as written
  above, so its result stays comparable to this preregistration.
- **2026-10-18, E3a read; E4 gate fixed before it runs.** E3a: blend 0.25 +0.18 [−0.56, 0.95],
  blend 0.5 +0.24 [−0.53, 1.03]; both null. `v4.1-ultra-settlefix` is promoted as `v4.2-ultra`.
  E4 (`ml/torch/expert_iteration.sh`, runbook `docs/E4_RUNBOOK.md`) starts from
  `resnet-g18500-s0.pt` with `v4.2-ultra` as the search. It runs 8 generations × 2,000 games at
  base 300, with 4,000 steps per generation, a replay window of 3, the 20k corpus as base data, and
  blend 0.5 at temperature 1. Generation gates use 50 seeds and keep a challenger if its mean is
  above 0; they decide the path, not the result. **E4 result:** the final network as a served
  prior of `v4.2-ultra` against plain `v4.2-ultra`, 200 seeds from 74,000,000. **Pass** if the mean
  is ≥ +0.50 with the CI lower bound above 0, then a confirmation on 200 fresh seeds from
  74,100,000 with the same verdict. If no generation is accepted, the reading is that the root
  prior channel does not respond to self-improvement at this scale, and the next experiment is
  E3b.
- **2026-10-18, E4 read; powered confirmation fixed before it runs.**
  - The E4 final measured +0.83 [0.30, 1.37], and its confirmation measured +0.41 [−0.11, 0.94].
    Under the rule above, E4 is **not confirmed**, and that verdict stands whatever happens below.
  - Why a second confirmation: at 200 seeds the minimum detectable effect (80% power) is about
    0.95, so neither 200-seed block could reliably detect the +0.50 effect the gate requires.
  - The test: the same served `ei-gen6` (`final.json`, blend 0.5, temperature 1) against plain
    `v4.2-ultra`, budget 300, on **800 seeds from 74,200,000** (74,200,000–74,200,799). This block
    is disjoint from every earlier block, and the expected minimum detectable effect is about 0.48.
    It is read on its own; it is not pooled with the earlier blocks.
  - **Pass** if the mean is ≥ +0.50 and the CI lower bound is above 0. A pass makes `ei-gen6` as
    a served prior a promotion candidate, recorded as "passed screen, failed the underpowered
    confirmation, passed the powered one".
  - If the mean is above 0 but the gate is not met, the reading is that expert iteration helps
    below the bar this programme set, and E3b is next.
  - If the mean is at or below 0, the +0.83 screen was noise.
