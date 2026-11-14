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

### Screen (measured; 400 seeds 88,000,000–88,000,399, one arm at a time, 10 threads; `tmp/pkg/screen.md`)

Raw logs `tmp/pkg/screen/pkgs-<arm>.jsonl` (+ `.moves.jsonl`, `.timing.jsonl`). Paired differences by seed,
95% percentile bootstrap; first place in percentage points. Clean cost from the table above.

| Arm | Advantage vs L6 | First place | Paired Δ vs base | Paired Δ first place vs base | Paired Δ vs PKG | Paired Δ first place vs PKG | Clean cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| base (`v5.0-s4-ultra`) | −3.85 [−4.42, −3.28] | 18.6% | — | — | −3.00 [−3.76, −2.26] | −4.56 [−7.19, −1.94] | 1.00 |
| PKG | −0.84 [−1.43, −0.26] | 23.2% | **+3.00 [+2.25, +3.76]** | **+4.56 [+2.00, +7.19]** | — | — | 2.10 |
| PKG-ET (equal time) | −3.05 [−3.60, −2.48] | 18.9% | **+0.80 [+0.05, +1.54]** | +0.31 [−2.12, +2.81] | −2.21 [−2.83, −1.53] | −4.25 [−6.69, −1.75] | ≈1 |
| PKG without RAVE | −3.24 [−3.75, −2.74] | 15.8% | +0.61 [−0.06, +1.29] | −2.88 [−5.19, −0.44] | **−2.40 [−3.09, −1.70]** | −7.44 [−9.88, −4.94] | 1.79 |
| PKG without priorLog | −1.07 [−1.62, −0.55] | 21.9% | **+2.77 [+2.03, +3.51]** | +3.31 [+0.81, +5.94] | −0.23 [−0.93, +0.47] | −1.25 [−3.75, +1.38] | 2.07 |
| PKG without all-move rollouts | −1.43 [−2.03, −0.83] | 20.4% | **+2.41 [+1.71, +3.14]** | +1.75 [−0.75, +4.19] | −0.59 [−1.33, +0.13] | −2.81 [−5.38, −0.31] | 1.18 |
| PKG without rank reward | −2.64 [−3.26, −2.02] | 22.6% | **+1.20 [+0.51, +1.95]** | +3.94 [+1.38, +6.62] | **−1.80 [−2.50, −1.04]** | −0.62 [−3.31, +2.19] | 2.21 |
| PKG without last-good-reply | −1.04 [−1.61, −0.47] | 22.4% | **+2.81 [+2.13, +3.52]** | +3.75 [+1.44, +6.12] | −0.19 [−0.92, +0.51] | −0.81 [−3.44, +1.88] | 2.14 |

**What each element contributes inside the package** (the "paired Δ vs PKG" column; reading, on the
screening seeds): the two elements that matter are **RAVE** (removing it costs −2.40 [−3.09, −1.70] and
−7.4 pp of first place) and the **rank reward** (−1.80 [−2.50, −1.04]). Both were null or harmful when
tested alone on the older bases (RAVE weight 0.5 at all nodes −1.10; P3B +0.65 pooled but −2.5 pp first
place). priorLog (−0.23) and last-good-reply (−0.19) read as nothing inside the package; the all-move
rollout −0.59 [−1.33, +0.13] for 1.8× of the time. So the package works as a system in the sense that
RAVE and the rank reward, useless alone, carry it once combined with the prior-initialised full tree.
Caveat: leave-one-out differences are on the same seeds that select.

**Selection (preregistered rule, `tmp/pkg/selection.log`):** every arm except PKG without RAVE clears;
the two largest point estimates, PKG (+3.00) and PKG without last-good-reply (+2.81), go to the
confirmation on 88,100,000, each with its equal-time version (both cost above 1.25×): base, PKG,
PKG-ET, PKG-noLGR, PKG-noLGR-ET, started together at 04:02, 2 threads each.

### Confirmation of the preregistered selection (measured; 400 seeds 88,100,000–88,100,399, five arms started together, 2 threads each; `tmp/pkg/confirm.md`, raw `tmp/pkg/confirm/pkgc-*.jsonl`)

| Arm | Advantage vs L6 | First place | Paired Δ vs base | Paired Δ first place vs base |
|---|---:|---:|---:|---:|
| base (`v5.0-s4-ultra`) | −3.60 [−4.18, −3.03] | 18.5% | — | — |
| PKG (2.10×) | −0.80 [−1.46, −0.19] | 22.8% | +2.80 [+2.06, +3.53] | +4.31 [+1.88, +6.69] |
| PKG-ET (`iterationScale` 7.609) | −2.30 [−2.86, −1.73] | 19.4% | **+1.31 [+0.61, +2.02]** | +0.94 [−1.50, +3.38] |
| PKG-noLGR (2.14×) | +0.07 [−0.54, +0.70] | 25.7% | +3.67 [+2.93, +4.44] | +7.19 [+4.50, +9.88] |
| PKG-noLGR-ET (`iterationScale` 7.469) | −2.33 [−2.89, −1.77] | 19.0% | **+1.28 [+0.58, +2.01]** | +0.50 [−2.00, +2.94] |

Decision (preregistered rule): PKG and PKG-noLGR both hold at equal iterations and at equal time, so
both are **accepted**; the saved configs are the equal-time ones, and PKG-ET (larger point estimate)
was the rule's new base, saved as `engine-rs/configs/v5.0-pkg-et-ultra.json`. (PKG-noLGR at equal
iterations reads +0.87 [+0.12, +1.65] against PKG on these seeds, against +0.19 on the screen seeds;
descriptive only.) The PKG-noLGR-ET config was not saved
under its own name (the rule saves one); it is `tmp/pkg/configs/PKG-noLGR-ET.json`.

### PKG-noROLL confirmation (amendment; measured; 400 seeds 88,800,000–88,800,399, three arms together, 3 threads each; `tmp/pkg/confirm2.md`, raw `tmp/pkg/confirm2/pkgr-*.jsonl`)

| Arm | Advantage vs L6 | First place | Paired Δ vs base | Paired Δ first place vs base | Clean cost |
|---|---:|---:|---:|---:|---:|
| base (`v5.0-s4-ultra`) | −3.39 [−3.93, −2.84] | 19.8% | — | — | 1.00 |
| PKG-noROLL (`iterationScale` 16) | −1.75 [−2.33, −1.19] | 19.8% | **+1.64 [+0.89, +2.37]** | +0.06 [−2.50, +2.50] | 1.18 |
| PKG-noROLL-ET (`iterationScale` 13.528) | −1.50 [−2.08, −0.93] | 20.0% | **+1.89 [+1.15, +2.65]** | +0.25 [−2.50, +3.00] | ≈1 |

Decision (amendment rule): PKG-noROLL-ET holds → **accepted**, saved as
`engine-rs/configs/v5.0-pk-ultra.json` = `v5.0-s4-ultra` + RAVE (R6S) + priorLog 0.2 + rank reward (P3B)
+ last-good-reply (L7), `iterationScale` 13.528, sampled rollouts.

### Final base (rule fixed in the amendment)

`v5.0-pk-ultra` (PKG-noROLL-ET accepted). It is preferred to the also-accepted `v5.0-pkg-et-ultra` by
the amendment's rule, not by a head-to-head comparison (the two were never played against each other
or on the same seeds).

**First place did not move at equal time in any package arm** (measured): PKG-ET +0.31 / +0.94 pp,
PKG-noLGR-ET +0.50 pp, PKG-noROLL-ET +0.25 pp, every interval spanning 0. The equal-time gain is in
margin, not in wins (reading: consistent with the rank reward's earlier pattern of more margin, fewer
wins, here cancelled by the stronger search). At equal iterations the package arms did gain first place.

**Amendment (supervising Claude session, not Paul, 04:04; prereg `5322069`, `91bdeab`):** the rule ranked by point estimate and left
out PKG without all-move rollouts, which keeps most of the gain at 1.18× cost. It is confirmed
separately on 88,800,000 (base, equal iterations, equal time at `iterationScale` 13.528); final-base
rule fixed in the amendment. Stage B was dropped (below).

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

## Stage B — IIV1 replication: preregistered, not played

Preregistered (`d02e16f`): `interiorInitVisits` 1 against the base after Stage A on 88,200,000 and
88,300,000 (800 seeds). Dropped for tonight by the supervising session's change of plan at 04:04 (time went to the
PKG-noROLL confirmation); the master driver was stopped before reaching it. Blocks 88,200,000 and
88,300,000 are unplayed and unread.

## Stage C — S6 results

- Identity on the final base `v5.0-pk-ultra` through the Stage-A pin and the S6 binary: 300 searches
  byte-identical (`tmp/s6/identity/base-*.txt`).
- **Clean cost** (measured on a quiet machine, 05:50, `p4_cost` 150 positions, 2 threads, two alternating
  rounds; `tmp/s6/cost/`): new / old ms/move on `v5.0-pk-ultra` = **0.8448** (−15.5%), past the 10% line.
- Re-timed `S6T`: `iterationScale` 13.528 → 16.013; check S6T (new binary) / base (old binary) = 0.971,
  inside [0.97, 1.03], no correction.
- **Confirmation** (400 seeds 88,400,000–88,400,399, base and S6T together on the S6 binary;
  `tmp/s6/confirm.md`, raw `tmp/s6/confirm/s6c-*.jsonl`): base (`v5.0-pk-ultra`) −2.06 [−2.60, −1.52],
  first place 19.2%; S6T −1.89 [−2.39, −1.38], 19.5%; paired **+0.17 [−0.48, +0.83]**, first place
  +0.25 pp [−2.06, +2.62]. **Not accepted**; nothing saved.
- The S6 code change stays in as a pure speed-up (identical output) at the old `iterationScale`:
  `v5.0-pk-ultra` plays the same moves about 15% faster. Reading of the null re-timing: about 18% more
  iterations (16.013/13.528) bought nothing measurable on this base, below what the ~+2 per doubling
  measured on `v5.0-p4i-ultra` would predict (+0.5 for 18%), which this test could not have resolved
  anyway (interval half-width ±0.65).

## Stage D — X4 benchmark of `v5.0-pk-ultra` (measured, descriptive, no gate; S6 binary; `tmp/x4/`)

| Match (200 seeds each) | `v5.0-pk-ultra` (X4) | First place | `v5.0-p4i-ultra` (X3, other seeds, not paired) |
|---|---:|---:|---:|
| 1 × Blokee vs 3 × level 7 (88,600,000) | **−7.85 [−8.66, −7.03]** | 11.3% | −9.72 [−10.54, −8.87], 10.0% |
| 1 × Blokee vs 3 × level 5 (88,500,000) | **+2.82 [+2.02, +3.62]** | 35.4% | +0.75 [−0.02, +1.48], 31.0% |
| 1 × level 6 vs 3 × Blokee, Pentobi's advantage (88,700,000) | **+0.26 [−0.67, +1.21]** | 32.5% (Pentobi) | +3.66 [+2.91, +4.43], 41.5% |

Raw logs `tmp/x4/x4-l7.jsonl`, `x4-l5.jsonl`, `x4-rev.jsonl` (+ `.moves`, `.timing`). Reading: the new
base now clearly beats level 5, is about 2 points closer to level 7 than `v5.0-p4i-ultra` was, and a lone
level-6 seat no longer gains measurably against three copies of it. Against three level-6 seats it read
−1.50 / −2.06 on two blocks (88,800,000 equal-time arm; 88,400,000 base arm).

## Seed blocks

Played: 88,000,000 (screen), 88,100,000 (confirmation), 88,800,000 (PKG-noROLL confirmation),
88,400,000 (S6), 88,600,000, 88,500,000, 88,700,000 (X4). Preregistered and unplayed (Stage B dropped):
88,200,000, 88,300,000. Untouched and unread: 83,100,000, 83,200,000, 84,800,000, 87,200,000,
87,300,000, 87,500,000.

## Candidates for a later screen (not run)

- The package without the all-move rollout and also without priorLog and/or without last-good-reply
  (inside the package −0.23 [−0.93, +0.47] and −0.19 [−0.92, +0.51] on the screen; a smaller package may
  do as well).
- RAVE weight and equivalence, never tuned on this tree (RAVE is the element that carries the package).
- From S6, changes that alter results and need their own test: a smaller rollout move cap, a different
  corner scan in rollouts.
