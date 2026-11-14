# v5 — the Pentobi package, IIV1 replication, second speed pass, final-base benchmark (2026-11-14)

Overnight run on the Mac, 01:00–08:45 CST. Preregistrations: `research_paper/v6_native_and_learning_preregistered.md`,
entries "Package", "IIV1 replication" (commit `d02e16f`) and "S6 / X4" (`74911d3`). All match logs are under
`tmp/pkg/`, `tmp/iiv/`, `tmp/s6/`, `tmp/x4/` (raw `.jsonl`, `.moves.jsonl`, `.timing.jsonl` per arm).
Every match: one Blokee seat against three Pentobi 31.0 seats (book on, one thread), budget 300, four
seat rotations per seed; advantage = Blokee score − mean of the other three, averaged per seed; 95%
percentile bootstrap by seed; paired differences by seed.

## Stage A — the Pentobi package on `v5.0-s4-ultra`

### What was built (engine `18e9149`)

The elements already existed behind options; two refusals stopped them being combined. The design:

- **RAVE with prior-initialised children (no widening).** A child's value estimate is
  `Q = (W + k·v_init)/(n + k)`, with `v_init = m·sqrt(p/p_max)` and k the initial visits (3), at the root
  and now at interior nodes. RAVE blends in the edge's AMAF mean with
  `β = ñ/(ñ + n' + n'·ñ/equivalence)`, `ñ = 0.5 × AMAF weight`, and n' = n + k: the k prior pseudo-visits
  count as observations behind Q, as they already did at the root. Unvisited children therefore start at
  the prior value, moved towards their AMAF mean as AMAF samples arrive.
- **priorLog selection on the RAVE-blended value.** `score = Q_blended + 0.2·p·sqrt(N)·ln(N+1)/(n + k) + history`.
  The denominator stays real visits + k (AMAF samples move Q, not exploration). Pentobi pools all
  counts into one; we did not, because exploration 0.2 was chosen in P10 to match level 6's tree with
  this denominator. The exact cut-off still changes no choice with RAVE on (new test case).
- Rollouts over all legal moves (P1L), rank reward with quality bonus (P3B) and last-good-reply (L7)
  needed no change to combine. No setting had to change; all values are from earlier screens.
- Identity (measured): with every new option absent the engine's complete search output on 300
  positions × 4 configs (`v5.0-s4-ultra`, `v5.0-p4i-ultra`, `v5.0-p4-ultra`, `v4.2-ultra`) is
  byte-identical to the S4 pin (1,200/1,200, `tmp/pkg/identity/`). `cargo test --release` (29 with the
  new package test) and `npm run native:build && npm run native:test` pass.

### Clean cost (measured before any game; `tmp/pkg/cost/`, `p4_cost`, 150 positions, own moves 3+)

| Arm | × base ms/move |
|---|---:|
| PKG | 2.103 |
| PKG without RAVE | 1.792 |
| PKG without priorLog | 2.075 |
| PKG without all-move rollouts | 1.183 |
| PKG without rank reward | 2.208 |
| PKG without last-good-reply | 2.142 |

The all-legal-moves rollout is almost all of the cost. `PKG-ET` = PKG at `iterationScale` 16/2.1029 = 7.609.

### Tree shape (measured; `p910_probe shape`, the 47 P9/P10 positions, budget 300; `tmp/pkg/shape/arms.md`)

| Config | Simulations | Depth mean / max | Top root child share | Visits at depth 3 / 4 / 5 / 6, share of root visits |
|---|---:|---:|---:|---:|
| Pentobi level 6 (P9/P10 run) | 7,295 | 5.64 / 23 | 0.52 | 91.0% / 80.9% / 64.3% / 45.5% |
| base | 3,815 | 4.64 / 16 | 0.46 | 87.7% / 72.2% / 51.1% / 30.0% |
| PKG | 3,550 | 5.43 / 19 | 0.57 | 88.7% / 77.6% / 62.5% / 46.3% |
| PKG-ET | 1,716 | 5.27 / 18 | 0.55 | 87.5% / 75.7% / 59.8% / 43.2% |
| PKG without RAVE | 3,516 | 7.00 / 23 | 0.62 | 92.6% / 87.7% / 79.6% / 68.3% |
| PKG without priorLog | 3,671 | 4.47 / 17 | 0.50 | 84.6% / 67.2% / 46.2% / 27.4% |
| PKG without all-move rollouts | 3,577 | 5.47 / 18 | 0.55 | 89.3% / 78.6% / 63.7% / 47.2% |
| PKG without rank reward | 3,809 | 5.14 / 18 | 0.46 | 88.1% / 74.8% / 58.1% / 40.5% |
| PKG without last-good-reply | 3,580 | 5.36 / 18 | 0.55 | 88.7% / 77.3% / 62.0% / 45.6% |

The package does change the tree: it is deeper and more concentrated than the base and close to level 6's
shape (depth-5 share 62.5% against 64.3%). Reading: the depth comes from priorLog (without it the tree is
as shallow as the base), and RAVE pulls it back (without RAVE the tree is much deeper than level 6's).

## Stage C — second speed pass (S6, engine `ad66afb`)

### Profile (taken under match load, so relative shares only; `tmp/sc/sample-s4-loaded.txt`)

`sample` on `p4_cost` (one thread, `v5.0-s4-ultra`), worker thread: rollout corner scan
`Playout::sample_moves` 46%, fitted-prior scoring `PriorModel::score` 17%, `iterate` (selection,
backup inlined) 10%, `generate_moves` 6%, `Position::apply` 6%, rollout loop 3%, sorting 3%.

### Changes (all give identical output)

1. **One forbidden window.** The legality test of a placement around a corner was
   `(occ & cells) | (own & edge) != 0` on two 11×11 windows. A placement touches an own square
   orthogonally exactly when one of its cells is in the seat's edge halo (or is own, hence occupied),
   so the test is `(occ | edgeHalo[seat]) & cells != 0`: one window, one AND, and a cells-only shape
   array (half the memory read per entry). In the rollout scan and in move generation.
2. **Reach prefilter.** The free squares reachable from the corner in at most 4 orthogonal steps
   bound any legal placement there; pieces larger than that count are skipped (a dead corner is
   skipped entirely). Skipped placements are all illegal, so the same placements are found in the same
   order; nothing is stamped that would have been.
3. **No hash in rollouts.** Sampled rollouts apply moves without maintaining the Zobrist hash (nothing
   in a rollout reads it; undo restores it from the record).

Rejected or not tried because they would change results: re-ordering the corner draw or the ε-branch
(changes RNG use); scanning fewer pieces once 12 candidates are found in a different order; caching
dead corners across rollout steps (would need a different draw); moving the all-legal-moves rollout's
list maintenance to the same prefilter (identical in principle but not covered by the identity gate of
the base configs, left alone). Candidates for a separately tested experiment: a smaller rollout move
cap or a first-fit rather than first-corner scan.

### Identity (measured; `tmp/s6/identity.log`, `tmp/s6/identity/`)

- Complete search output, 300 positions × 4 configs (`v5.0-s4-ultra`, `v5.0-p4i-ultra`,
  `v5.0-p4-ultra`, `v4.2-ultra`): 1,200/1,200 byte-identical to the Stage-A pin (984 tree searches).
- Mirrors with `blokee-match` (20 seeds): 80/80 games equal to the old binary for every config.
- Self-play (6 games): shard and `games.jsonl` byte-identical for every config.
- Bridge against level 6 (2 seeds): 8/8 games move for move equal for every config.
- `tests/s6.rs`: move generation equals brute-force legality on every position of 40 random games;
  `apply_unhashed` + `undo` restores position and hash. `cargo test --release` 30 tests pass;
  `npm run native:build && npm run native:test` pass.
