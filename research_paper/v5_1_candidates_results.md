# v5.1 candidates — the package's constants, a first-place reward term, subtree reuse re-measured (2026-11-14)

Day run on the Mac, 08:30–14:30 CST. Preregistration: `research_paper/v6_native_and_learning_preregistered.md`,
entry "2026-11-14 08:45 CST, v5.1 candidates" (commit `9683198`). Base: `engine-rs/configs/v5.0-ultra.json`.
Every match: one Blokee seat against three Pentobi 31.0 level-6 seats (book on, one thread), budget 300, four
seat rotations per seed; advantage = Blokee score − mean of the other three, averaged per seed; 95%
percentile bootstrap by seed; paired differences by seed; first place = the Blokee seat among the top
scorers (shared wins count). Binary pinned in `tmp/v51/bin` (`PROVENANCE.txt`, HEAD `9a8a515`). Raw logs
under `tmp/v51/` (`.jsonl`, `.moves.jsonl`, `.timing.jsonl` per arm).

## Stage 1 — what was built: `native.reward.firstWeight` (R1, engine `9a8a515`)

With `firstWeight` f > 0 the rank reward's leading term `rank_i` (fraction of opponents beaten, ties half)
becomes `(1 − f)·rank_i + f·first_i`, `first_i` = 1/t when seat i is one of the t seats sharing the highest
final score, else 0. The rest is unchanged (`+ qualityWeight·tanh(qualitySlope·z_i) − lengthWeight·(rank_i − ½)·tanh(qualitySlope·z_len)`).
The new part still runs from 0 (sole last) to 1 (sole first), so the reward's range, the history bound and the
other constants' scale are unchanged; only the spread of the unit over places changes: the step from second
to first is `1 + 3f/(1 − f)` times a lower step (2× at f = 0.25, 4× at f = 0.5, the two screened levels).
Absent or 0: nothing is computed. Config validation: f in [0, 1], kind "rank" only. Documented in
`engine-rs/README.md` (reward section).

Identity (measured): complete search output on 300 positions × `v5.0-ultra`, `v5.0-s4-ultra`, `v5.0-p4-ultra`,
`v4.2-ultra` byte-identical to the S6 pin `tmp/s6/bin` (1,200/1,200; `tmp/v51/identity/`). `cargo test --release`
31 tests (new unit test `rank_reward_first_weight`) and `npm run native:build && npm run native:test` pass
(`tmp/v51/npm-test.log`). A one-seed smoke game with f = 0.5 ran through the bridge.

## Stage 1 — screen (measured; 400 seeds 89,000,000–89,000,399, one arm at a time, 10 threads; `tmp/v51/screen.md`)

Raw logs `tmp/v51/screen/v51s-<arm>.jsonl` (+ `.moves.jsonl`, `.timing.jsonl`); diagnostics
`tmp/v51/diag/v51d-<arm>.jsonl` (200 seeds 89,100,000–89,100,199, own base arm). Clean cost measured before
any game (08:35–08:38, quiet machine, `p4_cost` 150 positions, own moves 3+, two rounds; `tmp/v51/cost/screen-cost.md`).
`*` marks an interval excluding 0. "ms/move 3+ in-match" is wall time under match load (descriptive only).

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.0-ultra.json unchanged | 400 | -1.94 [-2.51, -1.37] | 20.2% | — | — |  | 61.5 | 0/1600 |
| R-w025 | native.rave.weight 0.5 -> 0.25 | 400 | -2.54 [-3.11, -1.96] | 17.1% | -0.59 [-1.31, +0.13] | -3.12 [-5.62, -0.56] * | 1.017 | 61.8 | 1600/1600 |
| R-w1 | native.rave.weight 0.5 -> 1.0 | 400 | -1.21 [-1.78, -0.64] | 21.3% | +0.73 [+0.01, +1.46] * | +1.12 [-1.56, +3.81] | 0.965 | 59.7 | 1600/1600 |
| R-eq30 | native.rave.equivalence 100 -> 30 | 400 | -1.93 [-2.49, -1.37] | 19.8% | +0.02 [-0.73, +0.75] | -0.38 [-3.00, +2.31] | 0.970 | 59.6 | 1600/1600 |
| R-eq300 | native.rave.equivalence 100 -> 300 | 400 | -2.13 [-2.67, -1.56] | 19.4% | -0.19 [-0.92, +0.56] | -0.75 [-3.19, +1.75] | 0.994 | 61.2 | 1599/1600 |
| R-dd0 | native.rave.distanceDecay 0.5 -> 0 (no distance weighting) | 400 | -2.14 [-2.69, -1.56] | 19.2% | -0.20 [-0.92, +0.54] | -0.94 [-3.62, +1.75] | 0.983 | 60.2 | 1600/1600 |
| R-dd1 | native.rave.distanceDecay 0.5 -> 1.0 (weight falls linearly to 0 at the simulation's end) | 400 | -2.23 [-2.80, -1.68] | 19.8% | -0.29 [-0.99, +0.45] | -0.44 [-2.94, +2.06] | 0.992 | 60.6 | 1600/1600 |
| W-q0 | native.reward.qualityWeight 0.25 -> 0 | 400 | -5.55 [-6.04, -5.08] | 17.2% | -3.61 [-4.29, -2.96] * | -2.94 [-5.50, -0.44] * | 1.006 | 64.8 | 1600/1600 |
| W-q05 | native.reward.qualityWeight 0.25 -> 0.5 | 400 | -1.55 [-2.09, -0.99] | 19.3% | +0.39 [-0.32, +1.12] | -0.88 [-3.50, +1.75] | 0.977 | 59.1 | 1599/1600 |
| W-f25 | native.reward.firstWeight 0 -> 0.25 (new, R1) | 400 | -1.64 [-2.21, -1.08] | 21.2% | +0.30 [-0.44, +1.03] | +1.00 [-1.81, +3.88] | 0.978 | 60.9 | 1600/1600 |
| W-f50 | native.reward.firstWeight 0 -> 0.5 (new, R1) | 400 | -2.18 [-2.74, -1.62] | 21.0% | -0.24 [-0.92, +0.45] | +0.81 [-1.75, +3.38] | 0.977 | 61.1 | 1599/1600 |
| S-x01 | native.selection.exploration 0.2 -> 0.1 | 400 | -3.16 [-3.68, -2.62] | 15.4% | -1.22 [-1.93, -0.51] * | -4.75 [-7.38, -2.19] * | 0.974 | 61.0 | 1600/1600 |
| S-x04 | native.selection.exploration 0.2 -> 0.4 | 400 | -1.33 [-1.91, -0.73] | 21.0% | +0.61 [-0.13, +1.35] | +0.81 [-1.94, +3.44] | 1.021 | 62.8 | 1600/1600 |
| S-def | native.selection removed (default PUCT rule; the package without priorLog) | 400 | -1.64 [-2.25, -1.04] | 19.9% | +0.30 [-0.49, +1.05] | -0.25 [-3.00, +2.44] | 0.931 | 56.9 | 1599/1600 |
| O-nolgr | native.lastGoodReply removed (off) | 400 | -2.32 [-2.87, -1.77] | 18.9% | -0.38 [-1.12, +0.38] | -1.25 [-3.75, +1.31] | 1.010 | 61.4 | 1600/1600 |
| O-iiv1 | native.candidates.interiorInitVisits 3 -> 1 | 400 | -1.45 [-2.00, -0.87] | 20.5% | +0.50 [-0.25, +1.25] | +0.31 [-2.25, +2.88] | 0.939 | 56.2 | 1600/1600 |

**Compute diagnostics (own base D-base, 200 seeds):**

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| D-base | v5.0-ultra unchanged (diagnostic block's own base) | 200 | -2.19 [-2.97, -1.43] | 19.1% | — | — |  | 60.6 | 0/800 |
| D-x2 | search.iterationScale 13.528 -> 27.056 | 200 | -0.14 [-0.91, +0.63] | 24.9% | +2.05 [+1.14, +2.96] * | +5.75 [+2.50, +9.00] * |  | 116.6 | 800/800 |
| D-x05 | search.iterationScale 13.528 -> 6.764 | 200 | -4.31 [-5.04, -3.52] | 13.5% | -2.11 [-3.02, -1.19] * | -5.62 [-8.75, -2.50] * |  | 32.2 | 800/800 |

Slope b = (Δ(D-x2) − Δ(D-x05)) / 2 = +2.083 per doubling


**Selection (preregistered rule; `tmp/v51/selection.log`, measured):** only **R-w1** (RAVE weight 1.0)
clears, +0.73 [+0.01, +1.46], at 0.965× cost, so it competes as itself; one group only, so no combination.
Confirmed: base and R-w1.

**What the screen says (reading):**
- **The compute curve has not flattened.** A doubling of iterations is worth +2.05 [+1.14, +2.96] and a
  halving −2.11 [−3.02, −1.19] (slope +2.08 per doubling, first place ±5.7 pp), the same as the ~+2 measured
  on `v5.0-p4i-ultra`. The null S6 re-timing (+18% iterations, +0.17) was within what this slope predicts
  (+0.5) at that test's resolution. Unlike every package arm, compute moves first place.
- **The quality bonus is load-bearing:** qualityWeight 0 costs −3.61 [−4.29, −2.96] (the largest effect in
  the screen); 0.5 reads +0.39 [−0.32, +1.12] (null).
- **priorLog exploration 0.1 is harmful** (−1.22 [−1.93, −0.51], first place −4.8 pp); 0.4 reads +0.61
  [−0.13, +1.35] (null, the direction is up).
- **First-place weight (R1): null at both levels.** f = 0.25 +0.30 [−0.44, +1.03], first place +1.00 pp
  [−1.81, +3.88]; f = 0.5 −0.24 [−0.92, +0.45], +0.81 pp [−1.75, +3.38]. Neither moved first place
  measurably.
- RAVE equivalence 30/300 and distance decay 0/1 are null (all within ±0.3); weight 0.25 reads −0.59
  [−1.31, +0.13] (first place −3.1 pp, interval below 0), weight 1.0 is the one clearing arm.
- **Simplifications, no measurable loss:** default selection (`S-def`, the package without priorLog) +0.30
  [−0.49, +1.05] at 0.931× cost; last-good-reply off (`O-nolgr`) −0.38 [−1.12, +0.38] at 1.010×. Both are
  recorded as clean-up candidates, not as v5.1. `interiorInitVisits` 1 reads +0.50 [−0.25, +1.25] at 0.939×
  (third null-positive reading after +0.49 on the previous base).
- Multiplicity: with 15 arms, about 0.4 arms would clear by chance under no effect; R-w1's lower bound
  (+0.01) is at the edge, which is why the confirmation matters.

## Stage 1 — confirmation (measured; 400 seeds 89,200,000–89,200,399, base and R-w1 started together, 5 threads each; `tmp/v51/confirm.md`)

Raw logs `tmp/v51/confirm/v51c-base.jsonl`, `tmp/v51/confirm/v51c-R-w1.jsonl` (+ `.moves`, `.timing`).

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.0-ultra.json unchanged | 400 | -1.63 [-2.22, -1.06] | 20.1% | — | — |  | 60.3 | 0/1600 |
| R-w1 | native.rave.weight 0.5 -> 1.0 | 400 | -1.53 [-2.14, -0.92] | 21.1% | +0.10 [-0.62, +0.88] | +1.00 [-1.56, +3.62] | 0.965 | 59.9 | 1600/1600 |

- R-w1: paired +0.10 [-0.62, +0.88] on 400 seeds; first place +1.00 pp [-1.56, +3.62]; clean cost 0.965x -> NOT ACCEPTED
VERDICT: nothing accepted
NEW BASE: (none)

**Decision (preregistered rule): nothing accepted. No `v5.1-ultra.json` was saved; `v5.0-ultra` stays the
base.** R-w1 read +0.73 on the screen and +0.10 [−0.62, +0.88] on fresh seeds. Pooled over the 800 seeds of
both blocks (descriptive, not a gate) it reads +0.42 [−0.10, +0.93], first place +1.06 pp [−0.69, +2.84]:
the screen estimate looks inflated by being the one selected out of 15 (the winner's curse). The base read
−1.94 [−2.51, −1.37] (screen block) and −1.63 [−2.22, −1.06] (confirmation block) against level 6.

**Stage 3 not run:** its condition (an accepted v5.1) was not met. Blocks 89,300,000 and 89,400,000 are
unplayed and unread.

## Seed blocks

Played: 89,000,000 (screen, 400), 89,100,000 (diagnostics, 200: 89,100,000–89,100,199), 89,200,000
(confirmation, 400). Preregistered, unplayed and unread: 89,300,000, 89,400,000 (Stage 3, conditional).
Untouched and unread: 83,100,000, 83,200,000, 84,800,000, 87,200,000, 87,300,000, 87,500,000, 88,200,000,
88,300,000.

## Candidates for a later screen (not run; reading)

- **Compute is still worth about +2 per doubling** on this base. Speed work and cheaper arms are worth
  revisiting at equal time: `S-def` (0.931×) and `O-iiv1` (0.939×) both read null-positive at equal
  iterations. At the measured slope, spending their 6–7% saving on iterations would be worth about +0.2.
  Measuring that would need about 800 seeds per arm.
- Clean-up candidates with no measurable loss: priorLog selection off (`S-def`), last-good-reply off
  (`O-nolgr`).
- Directions not ruled out: priorLog exploration above 0.2 (0.4: +0.61 [−0.13, +1.35]), quality weight
  above 0.25 (0.5: +0.39), RAVE weight 1.0 (+0.42 pooled over 800 seeds). Each is a single-arm null. A
  replication needs 800+ fresh seeds to resolve +0.4.
- The first-place term R1 did not change first-place share at either level. The code stays in as an
  option, off by default.


## Stage 2 — subtree reuse re-measured on `v5.0-ultra` (diagnostic, measured, no matches)

Method as S4/P8: `examples/p67_probe.rs reuse` (unchanged) on 48 games of `v5.0-ultra` (logged as the
`v5.0-pk-ultra` base arm of the S6 confirmation, `tmp/s6/confirm/s6c-base.moves.jsonl`, seeds from
88,400,000; every 16th game in (seed, seat) order), replaying each game with the bridge's RNG discipline and
asking, before each of the lone seat's decisions, how many visits the tree of its previous decision holds at
the position now on the board (found by hash). **662/662** searched decisions after ply 8 reproduced the
recorded move. Budget 300 × 13.528 = 4,058. `tmp/v51/reuse/reuse.md`, `reuse.csv`.

| Own moves | Decisions | Prev. iterations | Visits after own move (d1) | d2 | d3 | **At the next own turn (d4)** | **share of the 4,058 budget** | share of prev. iterations | decisions with > 0 | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4–8 | 240 | 3,025 | 1,572 | 241.5 | 37.7 | 6.1 | **0.15%** | 0.25% | 28 | 712 |
| 9–14 | 287 | 3,179 | 1,382 | 339.8 | 77.6 | 24.8 | **0.61%** | 0.80% | 114 | 939 |
| 15+ | 135 | 3,031 | 1,639 | 607.9 | 224.5 | 143.2 | **3.53%** | 5.16% | 80 | 1,352 |
| all | 662 | 3,093 | 1,504 | 358.8 | 93.1 | 42.2 | **1.04%** | 1.49% | 222 | 1,352 |

Measured: the deeper package tree carries about twice as much as the S4 tree (1.04% against 0.65% of the
budget; 42 visits against 20 at the next own turn; the line thins 1,504 → 359 → 93 → 42 against
1,052 → 205 → 40 → 20), still concentrated in the endgame (3.5% on own moves 15+) and under 1% on own moves
4–14. **It stays below the 5% line**; reuse is not worth building on this base by that criterion.

What building it would involve (reading, not built): `treeReuse` is refused natively today
(`unsupported()`), and `prepare()` clears the node vector, transposition table, history, the rank reward's
running statistics and the last-good-reply table at every search. Reuse would need (1) to keep the node arena
and table across the seat's decisions and re-root at the node found by hash for the new position (the probe
already finds it), with garbage collection or arena compaction of the unreachable part; (2) a decision on the
per-search state that is now cleared by design — the rank reward's z statistics (reused Q values were backed
up under the previous search's normalisation), RAVE/AMAF statistics, history, LGR; (3) re-initialising the
prior-seeded pseudo-visits (k = 3) and the time-allocation logic (`probeFraction`, early exit) so that
carried visits count against the budget consistently; (4) identity gates with the option off, and the bridge
and match drivers keeping one engine per seat across a game (they already reuse one engine per thread).
At 1% of the budget the expected gain is below anything a 400-seed screen can resolve (+2 per doubling
would make it about +0.03).


# Round 2 (2026-11-14 afternoon, 13:16–16:50 CST) — `v5.1-ultra` accepted

Preregistration: entry "2026-11-14 13:20 CST, v5.1 round 2" (commit `44efd90`; the entry's heading says
13:20, the commit is 13:16, before the first game at 13:16:34). Arms and rules were set by the supervising
session's brief. Engine `82977fe` (pinned `tmp/v51b/bin`) adds the bridge's `--mode two-two` and
`native.rollout.epsCap` (R2), both off by default. Identity (measured): complete search output on 300
positions × 4 configs is byte-identical to the S6 pin (`tmp/v51b/identity/`). Bridge games in `one-blokee`
and `one-pentobi` (2 seeds × 4 configs) have equal move sequences and result lines against the round-1 pin
(`tmp/v51b/identity/bridge.log`). `cargo test --release` (31) and the npm native build and test pass.

## Round 2, Stage 1 — 800-seed replication (measured; 89,500,000 and 89,600,000, 400 seeds each; `tmp/v51b/rep/rep.md`)

Clean cost was measured before the first game on a quiet machine (`p4_cost`, 150 positions, two rounds;
`tmp/v51b/rep/cost/`). IIV1 read 0.931× and COMBO 0.951×, so both are played at equal time:
`IIV1-ET` at `iterationScale` 14.529 and `COMBO-ET` at 14.224. X04 read 1.020×, inside [0.97, 1.03], so it is
played as itself at 13.528. In the check round, IIV1-ET read 0.996×, COMBO-ET 0.991× and X04 1.027×. The
"Clean cost" column below is the check round. Raw logs: `tmp/v51b/rep/b1/rep-<arm>.jsonl` and
`tmp/v51b/rep/b2/rep-<arm>.jsonl` (+ `.moves`, `.timing`); the pooled copies are in `tmp/v51b/rep/pooled/`.

### Block 89,500,000 (400 seeds)

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.0-ultra.json unchanged (iterationScale 13.528) | 400 | -2.02 [-2.59, -1.45] | 19.6% | — | — |  | 60.6 | 0/1600 |
| IIV1-ET | native.candidates.interiorInitVisits -> 1.0 at equal time: search.iterationScale 13.528 -> 14.529 (13.528 / 0.9311) | 400 | -1.56 [-2.13, -0.99] | 20.9% | +0.46 [-0.28, +1.19] | +1.31 [-1.38, +4.12] | 0.996 | 60.1 | 1599/1600 |
| X04 | native.selection.exploration -> 0.4 | 400 | -1.80 [-2.38, -1.23] | 21.0% | +0.22 [-0.50, +0.97] | +1.44 [-1.25, +4.38] | 1.027 | 62.2 | 1600/1600 |
| COMBO-ET | native.candidates.interiorInitVisits -> 1.0 + native.selection.exploration -> 0.4 + native.rave.weight -> 1.0 + native.reward.qualityWeight -> 0.5 at equal time: search.iterationScale 13.528 -> 14.224 (13.528 / 0.9511) | 400 | -0.87 [-1.46, -0.29] | 22.3% | +1.15 [+0.41, +1.87] * | +2.75 [+0.06, +5.44] * | 0.991 | 60.2 | 1600/1600 |

### Block 89,600,000 (400 seeds)

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.0-ultra.json unchanged (iterationScale 13.528) | 400 | -1.54 [-2.06, -1.01] | 21.1% | — | — |  | 60.9 | 0/1600 |
| IIV1-ET | native.candidates.interiorInitVisits -> 1.0 at equal time: search.iterationScale 13.528 -> 14.529 (13.528 / 0.9311) | 400 | -1.93 [-2.49, -1.36] | 21.2% | -0.39 [-1.12, +0.33] | +0.19 [-2.38, +2.69] | 0.996 | 60.9 | 1599/1600 |
| X04 | native.selection.exploration -> 0.4 | 400 | -2.16 [-2.70, -1.60] | 20.1% | -0.62 [-1.29, +0.09] | -1.00 [-3.50, +1.44] | 1.027 | 63.1 | 1600/1600 |
| COMBO-ET | native.candidates.interiorInitVisits -> 1.0 + native.selection.exploration -> 0.4 + native.rave.weight -> 1.0 + native.reward.qualityWeight -> 0.5 at equal time: search.iterationScale 13.528 -> 14.224 (13.528 / 0.9511) | 400 | -1.52 [-2.06, -0.96] | 18.9% | +0.02 [-0.72, +0.77] | -2.12 [-4.81, +0.44] | 0.991 | 61.6 | 1599/1600 |

### Pooled, 800 seeds

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.0-ultra.json unchanged (iterationScale 13.528) | 800 | -1.78 [-2.16, -1.38] | 20.3% | — | — |  | 60.7 | 0/3200 |
| IIV1-ET | native.candidates.interiorInitVisits -> 1.0 at equal time: search.iterationScale 13.528 -> 14.529 (13.528 / 0.9311) | 800 | -1.75 [-2.13, -1.35] | 21.1% | +0.03 [-0.49, +0.52] | +0.75 [-1.09, +2.56] | 0.996 | 60.5 | 3198/3200 |
| X04 | native.selection.exploration -> 0.4 | 800 | -1.98 [-2.37, -1.58] | 20.5% | -0.20 [-0.70, +0.30] | +0.22 [-1.62, +2.12] | 1.027 | 62.6 | 3200/3200 |
| COMBO-ET | native.candidates.interiorInitVisits -> 1.0 + native.selection.exploration -> 0.4 + native.rave.weight -> 1.0 + native.reward.qualityWeight -> 0.5 at equal time: search.iterationScale 13.528 -> 14.224 (13.528 / 0.9511) | 800 | -1.19 [-1.61, -0.79] | 20.6% | +0.58 [+0.06, +1.11] * | +0.31 [-1.53, +2.19] | 0.991 | 60.9 | 3199/3200 |

- IIV1-ET (pooled): paired +0.03 [-0.49, +0.52] on 800 seeds; first place +0.75 pp [-1.09, +2.56] -> NOT ACCEPTED
- X04 (pooled): paired -0.20 [-0.70, +0.30] on 800 seeds; first place +0.22 pp [-1.62, +2.12] -> NOT ACCEPTED
- COMBO-ET (pooled): paired +0.58 [+0.06, +1.11] on 800 seeds; first place +0.31 pp [-1.53, +2.19] -> ACCEPTED
VERDICT: ACCEPTED COMBO-ET; v5.1 = COMBO-ET
NEW BASE: COMBO-ET

**Decision (preregistered rule, on the 800 pooled seeds): `COMBO-ET` is accepted** (+0.58 [+0.06, +1.11],
first place +0.31 pp [−1.53, +2.19]). It is saved as **`engine-rs/configs/v5.1-ultra.json`**: `v5.0-ultra` with
interiorInitVisits 1, priorLog exploration 0.4, RAVE weight 1.0, reward qualityWeight 0.5, and
`iterationScale` 14.224 (equal time). IIV1-ET (+0.03) and X04 (−0.20) are nulls. The interiorInitVisits 1 reading
(+0.49 and +0.50 on two earlier blocks) did not replicate at equal time.

**Reading (what I'm unsure of):** the two blocks disagree. COMBO-ET read +1.15 [+0.41, +1.87] on 89,500,000 and
+0.02 [−0.72, +0.77] on 89,600,000, and its first-place difference went from +2.75 pp to −2.12 pp. The pooled
lower bound (+0.06) is just above 0, and first place did not move. Two of its four parts were the round-1
screen's best null-positive readings, chosen on other seeds (89,000,000), so these 800 seeds are fresh. Even
so, the effect is small and the 95% interval allows anything from about +0.1 to +1.1. The rule accepts it;
a further fresh block would show whether it holds.


## Round 2, Stage 2 — parity, two against two (measured, diagnostic; 200 seeds 89,700,000–89,700,199; `tmp/v51b/par/parity.md`)

Two `v5.0-ultra` seats against two level-6 seats in the same game. For each seed, all six seat pairs were
played (four adjacent pairs in turn order blue → green → purple → yellow, and two alternating pairs), 1,200
games in all, 10 threads, 14:43–14:52. Within the adjacent set and within the alternating set, each seat is
ours equally often, so seat-order effects cancel inside each set but not inside a single pair. The
first-place share splits a shared first place evenly; par is 50%. In the first-place column, ignore the `*`
from the formatter: it tests against 0, not against 50%. Raw log `tmp/v51b/par/par-v5.0-ultra.jsonl`
(+ `.moves`, `.timing`). No hard failures.

| Arrangements | Seeds | Games | Our mean − Pentobi mean [95% CI by seed] | First-place share of our seats (par 50%) [95% CI by seed] | Our seats among the winners (any share) |
|---|---:|---:|---:|---:|---:|
| all six | 200 | 1200 | -0.91 [-1.56, -0.28] * | +44.26% [+41.50, +46.99] * | 48.5% |
| alternating (2) | 200 | 400 | -3.91 [-4.76, -3.07] * | +36.50% [+32.33, +40.75] * | 40.8% |
| adjacent (4) | 200 | 800 | +0.58 [-0.31, +1.48] | +48.15% [+44.79, +51.50] * | 52.4% |

- adjacent blue+green: 200 games, our mean − Pentobi mean +7.92, first-place share 71.2%
- adjacent green+purple: 200 games, our mean − Pentobi mean +0.58, first-place share 39.5%
- adjacent purple+yellow: 200 games, our mean − Pentobi mean -6.03, first-place share 30.8%
- adjacent yellow+blue: 200 games, our mean − Pentobi mean -0.14, first-place share 51.1%
- alternating blue+purple: 200 games, our mean − Pentobi mean -0.01, first-place share 53.8%
- alternating green+yellow: 200 games, our mean − Pentobi mean -7.81, first-place share 19.2%

ms/move (wall, under match load): Blokee 50.2 over 43180 moves; Pentobi 67.7 over 43620 moves

**Measured:**
- Over all six arrangements, our two seats score 0.91 [0.28, 1.56] below Pentobi's two and hold 44.3% [41.5%,
  47.0%] of first places, against a 50% par.
- **Alternating and adjacent differ sharply.** Alternating: −3.91 [−4.76, −3.07], 36.5% of first places.
  Adjacent: +0.58 [−0.31, +1.48], 48.2% [44.8%, 51.5%].
- Wall ms/move under match load: Blokee 50.2, Pentobi 67.7.

**Reading:**
- On the margin, the two-against-two game is closer to parity than either lone-seat match: the lone Blokee
  seat read −1.5 to −2.1, and the lone Pentobi seat +0.26. But first-place share is still below par.
- Where our seats sit matters more than the engine gap. When each of our seats is followed by a Pentobi seat
  (alternating), we lose about 4 points. When our two seats move back to back (adjacent), we are level.
- One possible mechanism: each engine's play towards the seat that moves right after it. Our max^n search
  may block the next seat less, or be blocked by it more, than Pentobi's. This is a hypothesis only. It
  suggests the lone-seat statistic folds this neighbour interaction into our score, so it is a partly
  different measure from engine-against-engine strength.
- Individual pairs mix this with turn order and should not be read alone (for example, blue+green
  +7.9 and green+yellow −7.8).


## Round 2, Stage 3 — rollout cost at equal time (measured; base `v5.1-ultra`; 400 seeds 89,800,000–89,800,399; `tmp/v51b/roll/`)

**What the options do** (from `engine-rs/src/playout.rs`):
- `playoutMoveCap` is how many legal placements a sampled rollout move collects, from one random own corner,
  before choosing.
- `playoutCorners` is how many productive corners are scanned before stopping.
- `playoutCutoff` is the number of rollout plies after which the rollout stops and the heuristic evaluation
  scores the position instead of the final score. At 84 it never binds, so a longer cutoff would change
  nothing and was not played.
- `EPS4` is the new R2 option `native.rollout.epsCap` 4. The ε-branch (probability 0.6) is drawn first and then
  collects only 4 placements.

**Clean cost at the base's iterations** (measured 14:52–14:56, quiet machine, two rounds;
`tmp/v51b/roll/cost/screen-cost.md`):

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 150 | 60.3 | 58.9 | 1.000 | 1.000 | 1.000 |
| CAP6 | 150 | 55.7 | 55.0 | 0.924 | 0.934 | 0.929 |
| CAP24 | 150 | 60.9 | 60.1 | 1.010 | 1.022 | 1.016 |
| CUT32 | 150 | 126.9 | 124.3 | 2.105 | 2.111 | 2.108 |
| COR2 | 150 | 71.3 | 70.3 | 1.182 | 1.195 | 1.188 |
| EPS4 | 150 | 58.5 | 58.1 | 0.971 | 0.987 | 0.979 |

Every arm was re-timed to `iterationScale` 14.224 / c. In the check round (`check1-cost.md`), every arm was
inside [0.97, 1.03] except CUT32-ET at 1.032. CUT32-ET was corrected once, to 6.536, and then read 1.008
(`check2-cost.md`). Raw logs: `tmp/v51b/roll/screen/rol-<arm>.jsonl` (+ `.moves`, `.timing`).

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.1-ultra.json unchanged (iterationScale 14.224) | 400 | -0.78 [-1.40, -0.13] | 22.6% | — | — |  | 60.7 | 0/1600 |
| CAP6-ET | search.playoutMoveCap -> 6 at equal time: search.iterationScale 14.224 -> 15.308 (14.224 / 0.9292) | 400 | -1.11 [-1.68, -0.51] | 20.3% | -0.33 [-1.09, +0.43] | -2.31 [-5.06, +0.31] | 1.004 | 63.2 | 1599/1600 |
| CAP24-ET | search.playoutMoveCap -> 24 at equal time: search.iterationScale 14.224 -> 14.006 (14.224 / 1.0156) | 400 | -0.96 [-1.54, -0.38] | 21.6% | -0.18 [-0.92, +0.52] | -1.06 [-3.62, +1.50] | 1.014 | 60.7 | 1600/1600 |
| CUT32-ET | search.playoutCutoff -> 32 at equal time: search.iterationScale 14.224 -> 6.748 (14.224 / 2.1080); corrected 6.748 -> 6.536 (/ 1.0325) | 400 | -6.04 [-6.59, -5.49] | 11.5% | -5.26 [-5.98, -4.54] * | -11.12 [-13.56, -8.62] * | 1.008 | 62.3 | 1600/1600 |
| COR2-ET | search.playoutCorners -> 2 at equal time: search.iterationScale 14.224 -> 11.968 (14.224 / 1.1885) | 400 | -1.78 [-2.37, -1.15] | 20.2% | -1.00 [-1.75, -0.26] * | -2.38 [-4.94, +0.06] | 1.020 | 60.8 | 1597/1600 |
| EPS4-ET | native.rollout.epsCap -> 4.0 at equal time: search.iterationScale 14.224 -> 14.535 (14.224 / 0.9786) | 400 | -1.33 [-1.88, -0.72] | 21.4% | -0.55 [-1.31, +0.22] | -1.25 [-3.75, +1.31] | 1.008 | 61.0 | 1597/1600 |

iterationScale played: base 14.224, CAP6-ET 15.308, CAP24-ET 14.006, CUT32-ET 6.536, COR2-ET 11.968, EPS4-ET 14.535

**Decision (standing rule): no arm clears, so there was no confirmation and nothing is saved from Stage 3.**
Measured:
- The truncated rollout costs twice as much, not less (CUT32 2.11×: each truncation runs the heuristic
  evaluation). At equal time it is strongly harmful: −5.26 [−5.98, −4.54], first place −11.1 pp.
- Scanning two corners (COR2, 1.19×) loses −1.00 [−1.75, −0.26] at equal time.
- Halving the move cap saves 7% (CAP6, 0.929×), but the extra iterations do not pay for it: −0.33.
- A cap of 24 is about free and null (−0.18).
- The ε-branch cap (EPS4, 0.979×) is null to negative: −0.55 [−1.31, +0.22].

**Reading:** the current rollout settings sit at or near the best point of these trade-offs. The rollout's
cost is not in the candidate scan's length (cap 6 saves only 7%), so the remaining speed has to come from
elsewhere. The `epsCap` code stays in, off by default.

This block's base arm is `v5.1-ultra` against level 6: −0.78 [−1.40, −0.13], first place 22.6%. There is no
`v5.0-ultra` arm on this block to pair with.


## Round 2 — extra blocks on `v5.1-ultra` (measured, descriptive, no gate; `tmp/v51b/extra/extra.md`)

| Match (200 seeds each) | `v5.1-ultra` | First place | For comparison (other seeds, not paired) |
|---|---:|---:|---|
| 1 × `v5.1-ultra` vs 3 × level 7 (89,300,000; 16:04–16:50) | **−6.88 [−7.69, −6.02]** | 12.5% | `v5.0-ultra` (X4, 88,600,000): −7.85 [−8.66, −7.03], 11.3% |
| 1 × `v5.1-ultra` vs 3 × `v5.0-ultra` (`blokee-match`, 89,400,000; 15:59–16:04) | **−0.53 [−1.40, +0.40]** | 26.5% (par 25%) | — |

Raw logs: `tmp/v51b/extra/v51-l7.jsonl` (+ `.moves`, `.timing`) and `tmp/v51b/extra/v51-h2h.jsonl`. Wall
ms/move in the level-7 block: Blokee 52.0, Pentobi 600.

**Reading:** the direct match does not show `v5.1-ultra` ahead of `v5.0-ultra`. The point estimate is −0.53
and the interval spans about ±0.9, so it cannot rule out the +0.58 measured against level 6 either. That gain
was measured against Pentobi; against copies of `v5.0-ultra` it is not visible on 200 seeds. Against level 7,
`v5.1-ultra` reads about 1 point better than `v5.0-ultra` did on other seeds (not paired). Together with the
split between the two Stage-1 blocks, I'd treat v5.1 as a small, uncertain gain. It is accepted by the rule,
but a further fresh 800-seed block against level 6 (and a longer direct match) would show whether it is real.

## Round 2 — seed blocks

Played:
- 89,500,000 and 89,600,000 (Stage 1, 400 + 400)
- 89,700,000 (Stage 2, 200 seeds × 6 arrangements)
- 89,800,000 (Stage 3 screen, 400)
- 89,400,000 (head-to-head, 200)
- 89,300,000 (level 7, 200)

Preregistered and unplayed (no Stage-3 arm cleared): 89,900,000.

Untouched and unread: 83,100,000, 83,200,000, 84,800,000, 87,200,000, 87,300,000, 87,500,000, 88,200,000,
88,300,000.

# Round 3 (2026-11-14 evening, 17:05–22:30 CST) — v5.1 replication, the next seat's windfall

Preregistration: entries "2026-11-14 17:10 / 17:15 / 17:25 CST, v5.1 round 3, Stage A / B / D" (commits
`216b648`, `79a7580`, `96f64dd`). Arms and seeds were set by the supervising session's brief.

## Round 3, Stage C — move-level diagnostic (measured on existing logs, no games; `tmp/v51c/C/stageC.md`)

**Tool.** `engine-rs/examples/c_moves.rs` replays every recorded game, using the per-seat engine from
`engines` and turn order from `seatOrder`. For every placement it computes the following, against the
next, opposite and previous seat (only targets that still have a move):
- the change in the target's legal placements, absolute and as % of its count before;
- the change in its live attach points (open corners covered by at least one of its legal placements);
- the attach points the move occupies, and the ones it leaves free but dead;
- the mover's own change in legal placements, the new live attach points it creates, and how many of
  those the very next placement covers or kills.

The aggregation is `engine-rs/scripts/v51c_moves.py`. Each ± is 1.96 × the standard error of per-seed
means. Two logs were replayed: the lone-seat log `tmp/v51b/rep/pooled/rep-base.moves.jsonl`
(`v5.0-ultra` vs three level-6 seats, 800 seeds, 3,200 games) and the two-two log
`tmp/v51b/par/par-v5.0-ultra.moves.jsonl` (1,200 games, both engines in the same games). Raw rows are in
`tmp/v51c/C/lone-v50.csv` and `twotwo-v50.csv`.

**Middle game (plies 8–27): legal placements a move removes from the target**, as Δ placements per move
(Δ % of the target's count):

| Log | Role | Blokee mover | Pentobi mover, Pentobi target | Pentobi mover, Blokee target |
|---|---|---:|---:|---:|
| lone | next | **−33.8 ±0.6 (−6.0%)** → Pentobi | **−40.0 ±0.5 (−7.4%)** | −34.5 ±0.7 (−6.2%) |
| lone | opposite | −16.1 ±0.5 (−3.1%) → Pentobi | −21.0 ±0.4 (−3.6%) | −15.8 ±0.4 (−2.8%) |
| lone | previous | −29.7 ±0.6 (−5.2%) → Pentobi | −31.5 ±0.4 (−5.2%) | −23.9 ±0.6 (−4.1%) |
| two-two | next | −29.1 ±1.3 (→ Blokee), −35.6 ±1.1 (→ Pentobi) | −41.7 ±1.2 (−7.4%) | −34.1 ±1.1 (−6.1%) |

**Other measures:**
- Attach points occupied per move are the same for both engines (next seat: 0.40 Blokee vs 0.39 Pentobi;
  "killed but not occupied" is ≈ 0, because a monomino can use almost any free corner).
- Own gain per middle-game move: Blokee +49.4 ±1.1 legal placements, Pentobi +54.3 ±0.7 (+58.8 when the
  Pentobi seat follows Blokee).
- The very next placement occupies 0.13 of Blokee's new live attach points (Pentobi successor) and 0.14 of a
  Pentobi mover's (Pentobi successor). When Blokee is the successor it occupies 0.18–0.21 of its
  predecessor's.
- Late game (28+): the next-seat gap narrows. Blokee → next −5.97% vs Pentobi → Pentobi next −6.24%.

**Answer (reading):** a Pentobi seat that follows Blokee gets room, not attacks. In the middle game each
Blokee placement removes about 6 fewer of the next seat's legal placements than a Pentobi predecessor's
placement does (−6.0% against −7.4% per move, both logs). The difference is in placements cut near that
seat's frontier, not in attach points occupied, which are the same. The successor also does not gain by
hitting Blokee's new attach points (its reply occupies them no more often than a Pentobi successor's).
Blokee's moves are less disruptive towards every seat (the opposite seat also loses fewer, −16.1 vs −21.0)
and add less for itself (+49 vs +54). Blokee, as a successor, attacks its predecessor's new attach points
more than Pentobi does. So the difference is most plausibly Blokee playing less "blocking" and less
"expanding" placement-count-wise, and the next seat collects most of the slack. This is consistent with a
real effect, but correlational: Stage B is what tells real from artefact.


## Round 3, Stage A — `v5.1-ultra` replication (measured; `tmp/v51c/A/stageA.md`)

Binary: the round-2 pin `tmp/v51b/bin`. Lone seat vs three level-6 seats, 400 seeds on 90,000,000 and 400
on 90,100,000, played 17:07–17:53. Direct matches with `blokee-match`, 400 seeds on 90,200,000, played
17:53–18:12. Raw logs: `tmp/v51c/A/a1/lone-<config>.jsonl`, `tmp/v51c/A/a2/lone-<config>.jsonl`
(+ `.moves`, `.timing`), `tmp/v51c/A/h2h-fwd.jsonl`, `tmp/v51c/A/h2h-rev.jsonl`; pooled copies in
`tmp/v51c/A/pooled/`. First place "any" = among the top scorers; "split" = ties shared.

### Lone seat vs three level-6 seats

| Arm / block | Seeds | Advantage vs L6 [95% CI] | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| v5.0-ultra, a1 (90,000,000) | 400 | -1.62 [-2.17, -1.06] | 20.3% | 17.8% |
| v5.0-ultra, a2 (90,100,000) | 400 | -2.19 [-2.73, -1.62] | 19.0% | 16.4% |
| v5.0-ultra, fresh 800 | 800 | -1.90 [-2.29, -1.52] | 19.7% | 17.1% |
| v5.0-ultra, round 2 800 | 800 | -1.78 [-2.16, -1.38] | 20.3% | 17.7% |
| v5.0-ultra, all 1,600 | 1600 | -1.84 [-2.11, -1.57] | 20.0% | 17.4% |
| v5.1-ultra, a1 (90,000,000) | 400 | -1.17 [-1.73, -0.60] | 20.4% | 17.8% |
| v5.1-ultra, a2 (90,100,000) | 400 | -1.23 [-1.78, -0.67] | 20.7% | 18.1% |
| v5.1-ultra, fresh 800 | 800 | -1.20 [-1.60, -0.81] | 20.6% | 17.9% |
| v5.1-ultra, round 2 800 | 800 | -1.19 [-1.61, -0.79] | 20.6% | 17.6% |
| v5.1-ultra, all 1,600 | 1600 | -1.20 [-1.48, -0.92] | 20.6% | 17.8% |

### Paired v5.1-ultra − v5.0-ultra (same seeds)

| Sample | Seeds | Paired Δ advantage [95% CI] | Paired Δ first place (any), pp | Paired Δ first place (split), pp |
|---|---:|---:|---:|---:|
| a1 (90,000,000) | 400 | +0.44 [-0.27, +1.18] | +0.12 [-2.50, +2.75] | -0.04 [-2.41, +2.39] |
| a2 (90,100,000) | 400 | +0.96 [+0.24, +1.67] | +1.69 [-0.88, +4.25] | +1.70 [-0.58, +3.96] |
| fresh 800 | 800 | +0.70 [+0.19, +1.22] | +0.91 [-0.94, +2.75] | +0.83 [-0.86, +2.52] |
| round 2 800 | 800 | +0.58 [+0.06, +1.11] | +0.31 [-1.53, +2.19] | -0.05 [-1.70, +1.62] |
| all 1,600 | 1600 | +0.64 [+0.28, +0.99] | +0.61 [-0.69, +1.91] | +0.39 [-0.77, +1.55] |

### Direct matches (blokee-match, 400 seeds 90,200,000; advantage = lone seat − mean of the three others)

| Match | Seeds | Lone seat's advantage [95% CI] | First place (any) | First place (split), par 25% |
|---|---:|---:|---:|---:|
| one v5.1-ultra vs three v5.0-ultra | 400 | -0.51 [-1.14, +0.10] | 26.6% | 23.2% |
| one v5.0-ultra vs three v5.1-ultra | 400 | +0.06 [-0.56, +0.67] | 30.1% | 26.1% |

Combined (descriptive): per seed (fwd − rev) / 2 = -0.28 [-0.72, +0.15] on 400 seeds (positive = v5.1 better; the lone seat's advantage measured from both sides).

**Measured:**
- Against level 6 the gain replicates on fresh seeds: **+0.70 [+0.19, +1.22]** on the 800 new seeds, and
  **+0.64 [+0.28, +0.99]** pooled over 1,600 seeds (four blocks: +1.15, +0.02, +0.44, +0.96).
- First place does not move measurably: +0.83 pp [−0.86, +2.52] split on the fresh 800, and +0.39 pp
  [−0.77, +1.55] on 1,600.
- In direct play `v5.1-ultra` is not better than `v5.0-ultra`. A lone v5.1 reads −0.51 [−1.14, +0.10]
  against three v5.0. A lone v5.0 reads +0.06 [−0.56, +0.67] against three v5.1. The combined per-seed
  reading is −0.28 [−0.72, +0.15]. Round 2's 200-seed direct match read −0.53 [−1.40, +0.40].

**Reading:** v5.1 gains about +0.6 per game against Pentobi level 6 and nothing (possibly a little less)
against v5.0. Its changes (wider priorLog exploration, stronger RAVE, more quality bonus, fewer initial
visits) seem to help against Pentobi's style specifically rather than in general strength. Which
benchmark should define a version is the supervising session's call. No config was renamed or deleted.


## Round 3, Stage B — is the windfall a process artefact? (measured; `tmp/v51c/B/stageB.md`, `tmp/v51c/D/verdictB.txt`)

The bridge change (engine `dfc727e`, pinned `tmp/v51c/bin`) adds `--gtp-processes per-seat` and
`--mode pentobi-control`. It is identity-checked against the round-2 pin in `one-blokee`, `one-pentobi`
and `two-two` (`tmp/v51c/identity/bridge.log`). Played 18:12–18:31:
- B1: lone `v5.0-ultra` vs three level-6 seats on 200 seeds 90,300,000, once with the shared process and once
  with per-seat processes.
- B2: Pentobi-only control on 200 seeds 90,400,000.

Raw logs: `tmp/v51c/B/b1-shared.jsonl`, `b1-perseat.jsonl`, `b2-control.jsonl` (+ `.moves`, `.timing`).

### Score relative to the game mean, by position relative to the lone seat (bootstrap by seed)

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v51c/B/b1-shared.jsonl` | 200 | -1.85 [-2.40, -1.28] | +2.69 [+2.02, +3.37] | -0.59 [-1.27, +0.07] | -0.24 [-0.90, +0.42] |
| `tmp/v51c/B/b1-perseat.jsonl` | 200 | -0.78 [-1.40, -0.15] | +2.00 [+1.33, +2.69] | -1.20 [-1.79, -0.61] | -0.02 [-0.68, +0.65] |
| `tmp/v51c/B/b2-control.jsonl` | 200 | -0.78 [-1.29, -0.26] | +0.13 [-0.43, +0.69] | +0.86 [+0.28, +1.46] | -0.21 [-0.81, +0.40] |

ms/move by role (lone / next / opposite / previous; wall, under match load):
- `tmp/v51c/B/b1-shared.jsonl`: 50 / 72 / 48 / 47
- `tmp/v51c/B/b1-perseat.jsonl`: 49 / 76 / 79 / 78
- `tmp/v51c/B/b2-control.jsonl`: 76 / 67 / 45 / 46

Paired, Blokee's advantage per-seat − shared processes, 200 seeds: +1.42 [+0.37, +2.47]; first place (any) +4.75 [+1.00, +8.38] pp, (split) +3.56 [+0.19, +6.90] pp
- shared: 200 | -2.47 [-3.21, -1.71] | 17.5% | 15.3% |
- per-seat: 200 | -1.04 [-1.86, -0.20] | 22.2% | 18.8% |

**⚠ Benchmark issue (measured): per-seat Pentobi processes raise Blokee's advantage by +1.42 [+0.37, +2.47]
and its first-place share by +4.75 pp [+1.00, +8.38] on the same seeds** (shared −2.47, per-seat −1.04).
Pentobi's wall time per move rises from 55.8 to 77.7 ms with per-seat processes. In the shared process, the
seats that follow another Pentobi seat (opposite, previous) take 47–48 ms per move against 72 ms for the
seat after Blokee's move. That is consistent with Pentobi reusing the shared process's search tree between
its own consecutive seats. The control agrees: a level-6 seat alone in its own process scores
−0.78 [−1.29, −0.26] against three seats that share a process. **Every lone-seat benchmark so far, from
`v4.2-ultra`'s −10.68 to `v5.1-ultra`, therefore gave the three Pentobi seats an advantage worth about
1 to 1.5 points over a fair per-seat arrangement.** **[Corrected in round 4: a paired 400-seed block with the new seeding shows no
arrangement effect (per-seat − shared +0.23 [−0.57, +1.04]; identical seeds the same). This B1 reading is
attributed to noise, and earlier absolute levels stand. See "Round 4 — paired check of the Pentobi process
arrangement".]** Paired comparisons between our own arms are not biased
by this (both arms face the same arrangement), but absolute levels are.

**Verdict (the preregistered reading rule): REAL.**
- In the control, the seat after the own-process seat gets no windfall: +0.13 [−0.43, +0.69].
- With per-seat processes, the seat after Blokee still gets +2.00 [+1.33, +2.69]. Against +2.69 with the
  shared process, the drop is not "clearly smaller" by the rule.

So the next seat's windfall is a property of playing after Blokee, not of the shared process. About 0.7 of
it may be process-related (point estimates 2.69 → 2.00), but that is within noise. As preregistered,
Stage D therefore runs with per-seat processes.


## Round 3, Stage D — options aimed at the next seat's windfall (measured; `tmp/v51c/D/`)

This stage ran because Stage B returned REAL. It used per-seat Pentobi processes, because Stage B's paired
change excluded 0. Engine `9e2df31` (pinned `tmp/v51c/binD`) adds two options, both off by default, with
identity checked:
- **D1** `native.candidates.nextPressure`: a standardised next-seat pressure term added to the fitted prior.
- **D2** `native.reward.nextWeight`: the next seat's weight in the rank term.

The reason, from Stage C: Blokee removes fewer of its successor's legal placements than Pentobi does.

**Clean cost** (18:30, quiet machine; `tmp/v51c/D/cost/`):

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 150 | 59.0 | 59.3 | 1.000 | 1.000 | 1.000 |
| NP05 | 150 | 63.7 | 64.0 | 1.078 | 1.080 | 1.079 |
| NP10 | 150 | 63.4 | 63.6 | 1.074 | 1.073 | 1.074 |
| NW2 | 150 | 60.7 | 60.2 | 1.028 | 1.016 | 1.022 |
| NW3 | 150 | 58.9 | 59.6 | 0.998 | 1.005 | 1.001 |

NP05 and NP10 are above 1.03, so they are played at equal time. Check round:

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 150 | 59.3 | 59.1 | 1.000 | 1.000 | 1.000 |
| NP05-ET | 150 | 59.3 | 59.2 | 1.000 | 1.002 | 1.001 |
| NP10-ET | 150 | 59.2 | 59.7 | 0.999 | 1.011 | 1.005 |

**Screen** (400 seeds 90,500,000–90,500,399, per-seat processes, 18:32–19:41; raw logs
`tmp/v51c/D/screen/rol-<arm>.jsonl` + `.moves`, `.timing`). The role table is each seat's score minus the
game mean, by position relative to Blokee's seat:

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.0-ultra.json unchanged (iterationScale 13.528) | 400 | -1.94 [-2.49, -1.34] | 21.2% | — | — |  | 60.4 | 0/1600 |
| NP05-ET | native.candidates.nextPressure -> 0.5 at equal time: search.iterationScale 13.528 -> 12.539 (13.528 / 1.0789) | 400 | -2.51 [-3.07, -1.94] | 19.5% | -0.57 [-1.35, +0.17] | -1.75 [-4.44, +0.94] | 1.001 | 60.7 | 1600/1600 |
| NP10-ET | native.candidates.nextPressure -> 1.0 at equal time: search.iterationScale 13.528 -> 12.599 (13.528 / 1.0737) | 400 | -5.71 [-6.31, -5.15] | 14.2% | -3.78 [-4.51, -3.05] | -7.06 [-9.56, -4.62] | 1.005 | 62.6 | 1600/1600 |
| NW2 | native.reward.nextWeight -> 2.0 | 400 | -2.27 [-2.81, -1.75] | 20.0% | -0.33 [-1.05, +0.36] | -1.25 [-3.75, +1.25] | 1.022 | 60.7 | 1599/1600 |
| NW3 | native.reward.nextWeight -> 3.0 | 400 | -2.93 [-3.45, -2.40] | 18.9% | -1.00 [-1.73, -0.28] | -2.38 [-4.94, +0.25] | 1.001 | 60.9 | 1599/1600 |

iterationScale played: base 13.528, NP05-ET 12.539, NP10-ET 12.599, NW2 13.528, NW3 13.528
| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v51c/D/screen/rol-base.jsonl` | 400 | -1.45 [-1.87, -1.00] | +2.21 [+1.73, +2.70] | -0.81 [-1.27, -0.36] | +0.05 [-0.46, +0.53] |
| `tmp/v51c/D/screen/rol-NP05-ET.jsonl` | 400 | -1.88 [-2.30, -1.46] | +0.23 [-0.26, +0.70] | +0.41 [-0.07, +0.91] | +1.25 [+0.79, +1.69] |
| `tmp/v51c/D/screen/rol-NP10-ET.jsonl` | 400 | -4.29 [-4.73, -3.86] | -1.27 [-1.75, -0.80] | +3.09 [+2.62, +3.57] | +2.47 [+2.05, +2.89] |
| `tmp/v51c/D/screen/rol-NW2.jsonl` | 400 | -1.70 [-2.11, -1.31] | +0.98 [+0.54, +1.44] | -0.71 [-1.16, -0.26] | +1.43 [+0.93, +1.91] |
| `tmp/v51c/D/screen/rol-NW3.jsonl` | 400 | -2.20 [-2.59, -1.80] | -0.02 [-0.45, +0.41] | +0.40 [-0.03, +0.83] | +1.82 [+1.40, +2.25] |

**Decision (standing rule): no arm clears, so there is no confirmation; 90,600,000 is unplayed and nothing is
saved.** NP10 and NW3 are harmful: −3.78 [−4.51, −3.05] and −1.00 [−1.73, −0.28].

**Measured, what the options did to the roles:**
- Both options remove the windfall. With the base, the next seat reads +2.21 [+1.73, +2.70]. With NP05 it
  reads +0.23, with NW3 −0.02, with NP10 −1.27, and with NW2 +0.98.
- The points go to the previous and opposite seats, not to Blokee. The previous seat reads +1.25 with
  NP05, +1.82 with NW3 and +2.47 with NP10, against +0.05 with the base.
- Replaying the screen games with `c_moves` (Blokee movers, middle game) shows the mechanism of NP05.
  It cuts the next seat's legal placements by 8.1% per move against 6.2% for the base, more than Pentobi's
  7.4%. But it cuts the previous seat less (4.5% against 5.2%) and gains slightly less for itself (+47.5
  against +48.9).
- NW3 removes the windfall with almost no change in those counts (next −6.5%).

**Reading:** the next seat's windfall is real, and these options can shift it. But in this four-player game
it is a redistribution. Whatever Blokee takes from its successor is given back to its predecessor (and the
opposite seat), and Blokee's own score does not improve; it gets worse as the push gets stronger. The
windfall looks like the price of Blokee's play towards its predecessor rather than a leak Blokee can
plug for free. A change that cuts the successor's room without loosening play towards the predecessor
was not tested.

## Round 3 — what I did not get to

- Stage C on `v5.1-ultra`'s logs (only the role split was computed: next +2.58, against +2.84 for v5.0 on
  the same fresh 800 seeds; `tmp/v51c/A/roles.md`).
- Re-measuring earlier benchmarks with per-seat processes. Stage B suggests their absolute levels are
  about 1–1.5 points too pessimistic for Blokee.
- A Stage-D option that targets the next seat without giving up pressure on the previous seat.

## Round 3 — seed blocks

Played: 90,000,000; 90,100,000 (Stage A, 400 each); 90,200,000 (direct matches, 400 × 2); 90,300,000
(B1, 200 × 2); 90,400,000 (B2, 200); 90,500,000 (Stage D screen, 400).

Preregistered and unplayed: 90,600,000 (no Stage-D arm cleared).

Untouched and unread: 83,100,000; 83,200,000; 84,800,000; 87,200,000; 87,300,000; 87,500,000; 88,200,000;
88,300,000; 89,900,000.


# Round 4 (2026-11-14 night, 19:45–01:00 CST) — the per-seat benchmark, N19 (prior with mobility features)

Preregistration: entries "2026-11-14 19:55 / 20:10 CST, round 4, Stage 1 / Stage 2". Their commits are
`6225697` and `72261c2`. The Stage-2 entry's heading says 20:10, but it was committed at 19:59, before any
Stage-2 game. The base for new candidates is `v5.1-ultra`, as set by the supervising session.

## Round 4, Stage 1 — the fair benchmark, one Pentobi process per seat (measured; `tmp/v51d/S1/`)

**Seeding fix (engine `1b74f36`).** Each per-seat Pentobi process is now seeded with
`seed ^ (0x9E3779B9 · (seat + 1))`. Shared and control modes are byte-identical to their pins
(`tmp/v51d/identity/`). `ef39432` adds an optional `--pentobi-log DIR`; play was checked to be the same
with and without it.

**Clean time** (19:46–19:48, one game thread, per-seat, `v5.1-ultra` vs three level-6 seats, 5 seeds
91,950,000, 20 games; `tmp/v51d/time/`). Nothing else of ours was running; the unrelated Docker VM used
about 2.4 cores.
- Blokee: **43.8 ms/move** mean, median 29.6, 52.3 on own moves 3+.
- A per-seat level-6 Pentobi process: **71.1 ms/move** mean, median 52.1.

**Pentobi's search statistics** (the same 5 seeds replayed with logging, so the same games, 1,046 searched
Pentobi moves; `tmp/v51d/S1/stats/logs/`): **6,688 new simulations per move** (median 6,269), 6,978 root
visits, and a reused subtree of 6.2% of the tree on the 329 moves where Pentobi reported reuse. Blokee's
budget is 300 × 14.224 ≈ 4,270 iterations at most (about 3,300–3,450 on average on recorded positions; the
early exit stops some searches). **Reading:** at "equal compute" in the old sense (same nominal budget),
Blokee uses about 62% of Pentobi's wall time per move and about half its simulations. Pentobi's
simulations are cheaper (about 10 µs against 13 µs).

**Matches** (per-seat processes, 10 threads, 19:52–21:12; raw logs `tmp/v51d/S1/c{1,2}/lone-<cfg>.jsonl`,
`v42-l6.jsonl`, `rev-l6.jsonl`, `par-v51.jsonl`, each with `.moves` and `.timing`):

### Lone seat vs three level-6 seats, per-seat Pentobi processes

| Arm / block | Seeds | Advantage [95% CI] | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| v5.0-ultra `tmp/v51d/S1/c1/lone-v5.0-ultra.jsonl` | 400 | -1.64 [-2.23, -1.09] | 22.6% | 19.6% |
| v5.0-ultra `tmp/v51d/S1/c2/lone-v5.0-ultra.jsonl` | 400 | -1.93 [-2.51, -1.36] | 20.7% | 18.3% |
| v5.0-ultra `tmp/v51d/S1/pooled/lone-v5.0-ultra.jsonl` | 800 | -1.79 [-2.18, -1.39] | 21.6% | 18.9% |
| v5.1-ultra `tmp/v51d/S1/c1/lone-v5.1-ultra.jsonl` | 400 | -0.95 [-1.56, -0.37] | 21.1% | 18.4% |
| v5.1-ultra `tmp/v51d/S1/c2/lone-v5.1-ultra.jsonl` | 400 | -1.34 [-1.95, -0.71] | 20.8% | 18.3% |
| v5.1-ultra `tmp/v51d/S1/pooled/lone-v5.1-ultra.jsonl` | 800 | -1.14 [-1.58, -0.72] | 20.9% | 18.3% |

Paired v5.1 − v5.0 on 800 seeds: +0.64 [+0.08, +1.20]; first place (any) -0.69 [-2.50, +1.16] pp, (split) -0.59 [-2.20, +1.12] pp
- block c1: +0.69 [-0.04, +1.47] on 400 seeds; first place (split) -1.22 [-3.59, +1.24] pp
- block c2: +0.60 [-0.20, +1.41] on 400 seeds; first place (split) +0.04 [-2.32, +2.38] pp

### Other blocks

| Match | Seeds | Lone seat's advantage [95% CI] | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| v4.2-ultra vs 3 x L6 (91,200,000) | 200 | -8.91 [-9.75, -8.08] | 10.9% | 9.7% |
| v5.1-ultra vs 3 x L7 (91,300,000) | — | not played | | |
| one L6 vs 3 x v5.1-ultra (91,400,000; Pentobi's advantage) | 200 | +0.80 [-0.17, +1.73] | 36.1% | 32.6% |

### Role tables (score − game mean by position relative to the lone seat)

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v51d/S1/pooled/lone-v5.0-ultra.jsonl` | 800 | -1.34 [-1.64, -1.04] | +2.33 [+2.01, +2.65] | -1.38 [-1.70, -1.07] | +0.39 [+0.06, +0.71] |
| `tmp/v51d/S1/pooled/lone-v5.1-ultra.jsonl` | 800 | -0.86 [-1.18, -0.54] | +2.17 [+1.82, +2.50] | -1.64 [-1.94, -1.33] | +0.33 [-0.01, +0.66] |
| `tmp/v51d/S1/v42-l6.jsonl` | 200 | -6.68 [-7.31, -6.06] | +3.62 [+3.01, +4.23] | +2.20 [+1.62, +2.78] | +0.87 [+0.32, +1.45] |
| `tmp/v51d/S1/rev-l6.jsonl` | 200 | +0.60 [-0.13, +1.30] | -1.58 [-2.35, -0.82] | +0.55 [-0.15, +1.27] | +0.43 [-0.25, +1.15] |

**Two-two `v5.1-ultra` with level 6** (200 seeds 91,500,000, six seat pairs per seed):

| Arrangements | Seeds | Games | Our mean − Pentobi mean [95% CI by seed] | First-place share of our seats (par 50%) [95% CI by seed] | Our seats among the winners (any share) |
|---|---:|---:|---:|---:|---:|
| all six | 200 | 1200 | -0.56 [-1.24, +0.15] | +43.88% [+41.36, +46.40] * | 48.2% |
| alternating (2) | 200 | 400 | -3.68 [-4.52, -2.85] * | +37.50% [+33.38, +41.62] * | 42.0% |
| adjacent (4) | 200 | 800 | +1.00 [+0.08, +1.93] * | +47.06% [+43.96, +50.21] * | 51.2% |

- adjacent blue+green: 200 games, our mean − Pentobi mean +10.56, first-place share 73.2%
- adjacent green+purple: 200 games, our mean − Pentobi mean -0.05, first-place share 43.8%
- adjacent purple+yellow: 200 games, our mean − Pentobi mean -5.86, first-place share 26.8%
- adjacent yellow+blue: 200 games, our mean − Pentobi mean -0.65, first-place share 44.5%
- alternating blue+purple: 200 games, our mean − Pentobi mean -0.59, first-place share 49.8%
- alternating green+yellow: 200 games, our mean − Pentobi mean -6.78, first-place share 25.2%

ms/move (wall, under match load): Blokee 54.7 over 43174 moves; Pentobi 86.3 over 43753 moves

**Measured:**
- With per-seat processes, `v5.1-ultra` is still ahead of `v5.0-ultra`: **+0.64 [+0.08, +1.20]** on 800
  fresh seeds, with first place unchanged (−0.6 pp split). The levels are v5.0 −1.79 [−2.18, −1.39] and
  v5.1 −1.14 [−1.58, −0.72].
- `v4.2-ultra` reads −8.91 [−9.75, −8.08].
- A lone level-6 seat against three `v5.1-ultra` reads +0.80 [−0.17, +1.73] for Pentobi.
- Two-two: −0.56 [−1.24, +0.15], 43.9% of first places. Alternating −3.68, adjacent +1.00.
- The next seat's windfall remains (+2.33 / +2.17).
- Level 7: played later in the Stage-2 driver (see below).

**What this does to the round-3 benchmark claim (reading — I am unsure here).** The per-seat level of
`v5.0-ultra` on these 800 seeds, −1.79, is about the same as its shared-process level on other seeds
(−1.84 over 1,600). B1's paired +1.42 [+0.37, +2.47] on 200 seeds would have predicted about −0.4. These
blocks are not paired across modes, so they cannot settle it. Either B1's 200-seed estimate was high
(its interval reaches down to +0.37), or the per-seat seeding change matters (in round 3 all three
per-seat processes had the game's seed). A paired shared-vs-per-seat block with the new seeding would
settle it; I did not run it.


## Round 4 — paired check of the Pentobi process arrangement (measured; `tmp/v51d/SEED/seed.md`)

The supervising session added this block. Prereg `6543a11`; engine `6e9623b` adds `--per-seat-seed game`,
which reproduces round 3's identical per-seat seeds. Setup: `v5.1-ultra` lone vs three level-6 seats, the
same 400 seeds 92,000,000–92,000,399, three arms one after another (22:14–22:52). Raw logs:
`tmp/v51d/SEED/seed-{shared,perseat,game}.jsonl` (+ `.moves`, `.timing`).

| Arm | Seeds | Blokee advantage [95% CI] | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| shared process | 400 | -1.20 [-1.76, -0.61] | 20.6% | 18.0% |
| per-seat, seeds per seat | 400 | -0.97 [-1.57, -0.36] | 21.1% | 18.0% |
| per-seat, identical seeds (round 3) | 400 | -0.98 [-1.55, -0.38] | 21.6% | 18.4% |

- paired per-seat, seeds per seat − shared process: +0.23 [-0.57, +1.04] on 400 seeds; first place (any) +0.50 [-2.25, +3.06] pp, (split) -0.05 [-2.46, +2.23] pp
- paired per-seat, identical seeds (round 3) − shared process: +0.23 [-0.56, +0.98] on 400 seeds; first place (any) +1.00 [-1.75, +3.75] pp, (split) +0.34 [-2.19, +2.81] pp
- paired per-seat, identical seeds (round 3) − per-seat, seeds per seat: -0.00 [-0.81, +0.80] on 400 seeds; first place (any) +0.50 [-2.12, +3.00] pp, (split) +0.40 [-2.02, +2.67] pp

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v51d/SEED/seed-shared.jsonl` | 400 | -0.90 [-1.32, -0.46] | +2.73 [+2.27, +3.19] | -1.69 [-2.10, -1.29] | -0.13 [-0.56, +0.30] |
| `tmp/v51d/SEED/seed-perseat.jsonl` | 400 | -0.73 [-1.18, -0.27] | +2.33 [+1.84, +2.83] | -1.82 [-2.30, -1.35] | +0.22 [-0.25, +0.69] |
| `tmp/v51d/SEED/seed-game.jsonl` | 400 | -0.73 [-1.16, -0.29] | +2.40 [+1.93, +2.90] | -1.79 [-2.25, -1.33] | +0.12 [-0.34, +0.60] |

Pentobi ms/move by role (lone / next / opposite / previous; wall, 10 game threads):
- shared process: 48 / 71 / 47 / 47
- per-seat, seeds per seat: 48 / 76 / 79 / 77
- per-seat, identical seeds (round 3): 48 / 75 / 79 / 77

**Measured:** on the same seeds the three arrangements give the same advantage. Per-seat − shared reads
+0.23 [−0.57, +1.04], identical seeds − shared +0.23 [−0.56, +0.98], and identical − seat seeds 0.00, with
first place unchanged. Pentobi does take more time per move in its own process (76–79 ms against 47 ms
for the seats that share a process with the previous mover), which confirms the shared process reuses the
tree. But at level 6's fixed simulation budget the reuse is not worth a measurable amount of score.

**Correction to round 3 (by the preregistered reading rule):** round 3's Stage-B sentence said every
lone-seat benchmark so far was "about 1 to 1.5 points harder than a fair arrangement". **This block does
not support it.** On 400 paired seeds, per-seat processes change Blokee's advantage by +0.23 [−0.57,
+1.04], and identical seeds make no difference either. Round 3's B1 reading (+1.42 [+0.37, +2.47] on
200 seeds) is therefore attributed to noise, not to identical seeds. Earlier absolute levels stand, to
within about ±0.8. The round-3 control (a lone own-process level-6 seat −0.78 [−1.29, −0.26] against
three shared) remains unexplained; it may be noise of the same kind.

**Standard benchmark mode from round 4 on:** per-seat processes with seat-derived seeds. It is fair by
construction (no Pentobi seat sees another seat's search). On this evidence it reads the same as the
shared process, so earlier results stay comparable.

## Round 4, Stage 2 — N19: the move prior re-fitted with mobility features

**Offline** (measured; `tmp/v51d/n19/fit.log`, `ml/n19_fit_prior.py`). Data: the 29,991 level-6 decisions
the current prior was fitted on; held out are seeds ending in 4 or 9 (6,041 decisions). The 39-feature
refit reproduces the current weights exactly. Mobility columns come from `examples/n19_features.rs`; the
engine's own computation was checked equal on 347/347 moves of one decision (`examples/n19_check.rs`).
Held-out results:

| Own moves | current | exact (own gain + removed ×3) | exact without own gain | exact-sum | cheap (pressure ×3 + own corners) |
|---|---:|---:|---:|---:|---:|
| 0–2 | −1.961 | −1.945 | −1.945 | −1.946 | −1.947 |
| 3–8 | −3.718 | −3.687 | −3.704 | −3.697 | −3.696 |
| 9–14 | −3.071 | **−2.938** | −3.052 | −2.941 | −3.048 |
| 15+ | −1.451 | −1.409 | −1.431 | −1.407 | −1.436 |
| 3+ (log-lik / top-1 / top-5) | −2.918 / 0.277 / 0.579 | **−2.846 / 0.289 / 0.600** | −2.901 / 0.280 / 0.582 | −2.850 / 0.289 / 0.600 | −2.897 / 0.279 / 0.582 |

The own-gain count carries most of the gain (+0.072 nats per decision with it, +0.017 without). The cheap
approximation recovers about a third of it (+0.021).

**Clean cost** (21:12–21:16, quiet machine; `tmp/v51d/S2/cost/`):

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 150 | 62.9 | 63.0 | 1.000 | 1.000 | 1.000 |
| R-EX | 150 | 63.6 | 63.9 | 1.012 | 1.015 | 1.013 |
| R-CH | 150 | 62.8 | 62.5 | 0.999 | 0.992 | 0.996 |
| A-EX | 150 | 964.3 | 970.5 | 15.335 | 15.410 | 15.372 |

Check round, after re-timing A-EX to `iterationScale` 0.925:

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 150 | 62.4 | 63.0 | 1.000 | 1.000 | 1.000 |
| A-EX-ET | 150 | 85.0 | 84.5 | 1.363 | 1.340 | 1.352 |

A-EX-ET was corrected once to 0.684, as preregistered, and not re-checked; it is still somewhat above
equal time. **Every use at interior nodes costs about 15×**, the cheap variant included, because the
features need the opponents' move lists at every expansion. So the interior arm was played at about 5% of
the iterations. Root-only use costs nothing measurable (R-EX 1.013×, R-CH 0.996×).

**Screen** (400 seeds 91,600,000–91,600,399, per-seat processes, base `v5.1-ultra`, 21:16–22:14; the
driver was stopped by hand at 21:34 during the R-EX arm and continued by `v51d-stage2b.sh` on the same
binary and seeds; raw logs `tmp/v51d/S2/screen/rol-<arm>.jsonl`):

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.1-ultra.json unchanged (iterationScale 14.224) | 400 | -1.35 [-1.93, -0.77] | 20.3% | — | — |  | 64.8 | 0/1600 |
| R-EX | root: N19 exact model (39 features + own gain + removed from next/opposite/previous); interior: current model | 400 | -0.50 [-1.11, +0.09] | 23.0% | +0.85 [+0.16, +1.55] | +2.69 [+0.31, +5.19] | 1.013 | 61.6 | 1597/1600 |
| R-CH | root: N19 cheap model (39 + per-cell pressure on the three opponents + own corner gain); interior: current model | 400 | -0.98 [-1.58, -0.43] | 21.9% | +0.37 [-0.31, +1.06] | +1.56 [-0.75, +3.88] | 0.996 | 60.2 | 1597/1600 |
| A-EX-ET | root and interior: N19 exact model at equal time: search.iterationScale 14.224 -> 0.925 (14.224 / 15.3723); corrected 0.925 -> 0.684 (/ 1.3517) | 400 | -9.38 [-9.89, -8.85] | 6.5% | -8.03 [-8.74, -7.32] | -13.81 [-15.94, -11.75] | 1.352 | 61.1 | 1600/1600 |

iterationScale played: base 14.224, R-EX 14.224, R-CH 14.224, A-EX-ET 0.684

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v51d/S2/screen/rol-base.jsonl` | 400 | -1.01 [-1.45, -0.58] | +2.24 [+1.75, +2.71] | -1.64 [-2.08, -1.20] | +0.41 [-0.06, +0.87] |
| `tmp/v51d/S2/screen/rol-R-EX.jsonl` | 400 | -0.38 [-0.83, +0.07] | +2.23 [+1.79, +2.69] | -1.84 [-2.29, -1.40] | -0.01 [-0.45, +0.45] |
| `tmp/v51d/S2/screen/rol-R-CH.jsonl` | 400 | -0.74 [-1.18, -0.33] | +1.97 [+1.55, +2.39] | -1.81 [-2.27, -1.37] | +0.58 [+0.15, +1.00] |
| `tmp/v51d/S2/screen/rol-A-EX-ET.jsonl` | 400 | -7.03 [-7.42, -6.63] | +3.99 [+3.54, +4.44] | +1.64 [+1.21, +2.10] | +1.40 [+0.97, +1.83] |

| Arm | Δ next legal (%) | Δ opposite legal (%) | Δ previous legal (%) | own Δ legal |
|---|---:|---:|---:|---:|
| base | -32.8 (-5.83%) | -16.4 (-3.15%) | -31.1 (-5.41%) | +50.2 |
| R-EX | -33.9 (-6.01%) | -16.9 (-3.29%) | -30.8 (-5.34%) | +50.7 |
| R-CH | -34.2 (-6.09%) | -17.0 (-3.31%) | -31.3 (-5.40%) | +50.4 |
| A-EX-ET | -34.5 (-6.24%) | -15.8 (-2.95%) | -30.9 (-5.41%) | +49.7 |

**Selection (standing rule): R-EX clears, +0.85 [+0.16, +1.55], with first place +2.69 pp [+0.31, +5.19].**
It goes to confirmation on 91,700,000. R-CH reads +0.37 (null). A-EX-ET reads −8.03, the price of 5%
of the iterations.

**Reading:** the middle-game placement numbers barely move (next seat −6.01% against −5.83%; own gain
+50.7 against +50.2). So the root prior's gain, if real, does not show up as more blocking or expanding on
average. It is in which move is chosen, not in the averages Stage C measured.


**Confirmation** (400 seeds 91,700,000–91,700,399, base and R-EX started together, 5 threads each,
22:52–23:20; raw logs `tmp/v51d/S2/confirm/rolc-{base,R-EX}.jsonl`):

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.1-ultra.json unchanged (iterationScale 14.224) | 400 | -0.65 [-1.26, -0.04] | 22.8% | — | — |  | 58.6 | 0/1600 |
| R-EX | root: N19 exact model (39 features + own gain + removed from next/opposite/previous); interior: current model | 400 | -0.96 [-1.53, -0.36] | 21.4% | -0.30 [-1.06, +0.46] | -1.38 [-4.06, +1.25] | 1.013 | 60.0 | 1598/1600 |

- R-EX: paired -0.30 [-1.06, +0.46] on 400 seeds; first place -1.38 pp [-4.06, +1.25] -> NOT ACCEPTED
NEW BASE: (none)

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v51d/S2/confirm/rolc-base.jsonl` | 400 | -0.49 [-0.94, -0.03] | +1.92 [+1.47, +2.36] | -1.67 [-2.14, -1.20] | +0.24 [-0.21, +0.70] |
| `tmp/v51d/S2/confirm/rolc-R-EX.jsonl` | 400 | -0.72 [-1.15, -0.27] | +2.28 [+1.80, +2.73] | -1.63 [-2.09, -1.19] | +0.08 [-0.36, +0.52] |

**Decision (standing rule): R-EX is not accepted** (−0.30 [−1.06, +0.46]), so nothing is saved and there is
no `v5.2-cand-ultra.json`. Pooled over the screen and confirmation (800 seeds, descriptive): +0.27 [−0.23,
+0.76], first place +0.96 pp [−0.58, +2.57] (split). **Reading:** the re-fitted root prior predicts Pentobi's moves better offline (+0.07 nats per
decision, +1.2 pp top-1). In play the effect is at most small: the screen's +0.85 did not replicate. Use at
interior nodes, where a prior acts on most of the tree, is too expensive with exact mobility counts
(about 15×), and the cheap counts cost the same because they also need move lists.


## Round 4 — level 7, Stage 3, seed blocks, what I did not get to

**Level 7** (measured; per-seat processes, 200 seeds 91,300,000, 23:20–00:30; raw log `tmp/v51d/S1/v51-l7.jsonl`
+ `.moves`, `.timing`): `v5.1-ultra` vs three level-7 seats reads **−5.26 [−6.08, −4.40]**, first place 14.9%
(12.6% with ties split). Role split: own −3.95, next +3.96, opposite +0.25, previous −0.26. Earlier readings,
on other seeds, unpaired, with the shared process: `v5.1-ultra` −6.88 [−7.69, −6.02] (round 2) and
`v5.0-ultra` −7.85 [−8.66, −7.03] (X4). The full Stage-1 read-out is `tmp/v51d/S1/stage1.md`.

**Stage 3 (compute doubling) was not played.** The level-7 block ended at 00:30:11, so the ×1 / ×2 / ×0.5
blocks on 91,800,000 met the 00:30 cut-off and did not start. 91,800,000 is unplayed and unread. Round 5
Stage 1 measures the compute curve on 93,200,000 instead.

**Seed blocks played in round 4:**
- 91,000,000 and 91,100,000 (Stage 1, 400 each)
- 91,200,000 (`v4.2-ultra`), 91,300,000 (level 7), 91,400,000 (reverse), 91,500,000 (two-two)
- 91,600,000 (N19 screen) and 91,700,000 (N19 confirmation)
- 92,000,000 (arrangement check, 3 × 400)
- 91,950,000–91,950,009 (clean timing and Pentobi statistics)

Unplayed: 91,800,000. Protected and unread: 83,100,000; 83,200,000; 84,800,000; 87,200,000; 87,300,000;
87,500,000; 88,200,000; 88,300,000; 89,900,000; also 90,600,000 unplayed.

**Not done in round 4:** the compute doubling (moved to round 5), and a cheaper interior-node
approximation for the N19 features. An approximation without move generation would only re-express existing
prior features.


# Round 5 (2026-11-15 overnight, 00:30–08:45 CST) — equal wall time, iteration shapes, a tuner

Preregistrations: "2026-11-15 00:00 / 00:20 / 00:30 CST, round 5, Stage 1 / 2 / 3" (commits `e2a174b` and
`9524f8e`; both committed before 23:55, ahead of their heading times and before any of their games).
Benchmark mode throughout: per-seat Pentobi processes with seat-derived seeds. Binary `tmp/v51d/bin3`
(engine `6e9623b`).

## Round 5, Stage 1 — where we stand at equal wall time (measured; `tmp/v52/S1/`)

**Clean timing** (00:31–00:36, nothing else of ours running, one game thread, per-seat, `v5.1-ultra`; rounds
on seeds 93,950,000–004 and 93,950,005–009, 40 games, then the check on 93,950,000–004; raw logs
`tmp/v52/S1/time/*.jsonl`):

```
Blokee mean 43.12 ms/move over 365 moves; Pentobi mean 70.34 ms/move over 1093 moves; ratio 0.6131
Blokee mean 42.86 ms/move over 363 moves; Pentobi mean 70.04 ms/move over 1080 moves; ratio 0.6120
Blokee mean 42.99 ms/move over 728 moves; Pentobi mean 70.19 ms/move over 2173 moves; ratio 0.6125
Blokee mean 68.85 ms/move over 362 moves; Pentobi mean 67.70 ms/move over 1095 moves; ratio 1.0170
```

So Blokee uses **43.0 ms** per move (all its moves, opening heuristic included) against **70.2 ms** for a
per-seat level-6 process (ratio 0.61). The time-matched config **TM** has `iterationScale` **23.222** (×1.633;
`tmp/v52/S1/configs/TM.json`, unnamed, not in `engine-rs/configs`). Its check reads 68.9 against 67.7 ms
(ratio 1.017), inside ±3%.

**Matches** (10 threads, 00:36–02:07; raw logs `tmp/v52/S1/e{1,2}/lone-{base,TM}.jsonl`,
`tmp/v52/S1/curve/x{1,2,4}.jsonl`, `tmp/v52/S1/rev-TM.jsonl`, each with `.moves` and `.timing`). Round 4's
compute curve was never played, so ×2 was played here.

### Lone seat vs three level-6 seats, per-seat processes (93,000,000 + 93,100,000)

| Arm / block | Seeds | Advantage [95% CI] | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| base `tmp/v52/S1/e1/lone-base.jsonl` | 400 | -0.67 [-1.25, -0.10] | 21.9% | 18.8% |
| base `tmp/v52/S1/e2/lone-base.jsonl` | 400 | -0.74 [-1.33, -0.16] | 21.2% | 18.3% |
| base `tmp/v52/S1/pooled/lone-base.jsonl` | 800 | -0.71 [-1.11, -0.30] | 21.6% | 18.6% |
| TM `tmp/v52/S1/e1/lone-TM.jsonl` | 400 | +0.16 [-0.43, +0.77] | 24.8% | 21.1% |
| TM `tmp/v52/S1/e2/lone-TM.jsonl` | 400 | +0.46 [-0.14, +1.06] | 25.2% | 21.9% |
| TM `tmp/v52/S1/pooled/lone-TM.jsonl` | 800 | +0.31 [-0.10, +0.74] | 25.0% | 21.5% |

Paired TM − base on 800 seeds: +1.02 [+0.54, +1.48]; first place (any) +3.41 [+1.62, +5.16] pp, (split) +2.90 [+1.32, +4.50] pp

Role tables:

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v52/S1/pooled/lone-base.jsonl` | 800 | -0.53 [-0.83, -0.22] | +2.33 [+2.02, +2.66] | -1.95 [-2.26, -1.62] | +0.15 [-0.18, +0.47] |
| `tmp/v52/S1/pooled/lone-TM.jsonl` | 800 | +0.23 [-0.07, +0.56] | +2.03 [+1.70, +2.36] | -2.14 [-2.46, -1.81] | -0.12 [-0.44, +0.19] |
- base: in-match ms/move Blokee 48.7, Pentobi 77.8
- TM: in-match ms/move Blokee 77.1, Pentobi 77.6

### Compute curve (200 seeds 93,200,000)

| Multiple | Seeds | Advantage [95% CI] | First place (split) | Paired vs ×1 |
|---|---:|---:|---:|---:|
| x1 | 200 | -1.00 [-1.84, -0.19] | 18.5% | — |
| x2 | 200 | +0.59 [-0.24, +1.46] | 20.8% | +1.60 [+0.62, +2.59] |
| x4 | 200 | +1.36 [+0.50, +2.24] | 22.8% | +2.36 [+1.34, +3.41] |

Least-squares line over the multiples played: advantage = -0.87 + +1.18·log2(multiple); parity (advantage 0) at multiple 1.66

### One level-6 seat vs three time-matched seats (200 seeds 93,250,000)

| Match | Seeds | Pentobi's advantage | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| one L6 vs three TM | 200 | -0.33 [-1.25, +0.67] | 32.1% | 29.1% |
| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v52/S1/rev-TM.jsonl` | 200 | -0.25 [-0.94, +0.50] | -1.51 [-2.25, -0.84] | +1.24 [+0.63, +1.86] | +0.52 [-0.16, +1.20] |

**Measured:**
- **At equal wall time Blokee is level with Pentobi level 6.** TM reads **+0.31 [−0.10, +0.74]** against
  three level-6 seats, with first place 25.0% (21.5% with ties split). A lone level-6 seat against three TM
  seats reads −0.33 [−1.25, +0.67] for Pentobi.
- Paired TM − `v5.1-ultra` (×1.63 iterations): **+1.02 [+0.54, +1.48]**, first place **+2.9 pp [+1.3, +4.5]**
  (split).
- Compute curve on 93,200,000 (paired against ×1): ×2 **+1.60 [+0.62, +2.59]**, ×4 **+2.36 [+1.34, +3.41]**.
  Per doubling that is +1.6 for the first and +0.8 for the second. The least-squares line through the
  three levels gives +1.18 per doubling, and parity with level 6 at ×1.66 the base's iterations on these
  seeds. That is about where TM sits (×1.63).
- First place grows with compute: 18.5% → 20.8% → 22.8%.
- The next seat's windfall stays at about +2 whatever the compute.

**Reading:** "equal compute" in the old sense (same nominal budget) gave Pentobi about 1.6× Blokee's wall time
per move. At equal wall time against a per-seat process, `v5.1-ultra` is at parity with level 6, both as a
lone seat and as three seats. The returns to iterations are flattening: the second doubling is worth about
half the first.


## Round 5, Stage 2 — N20: how the iterations are spread over a seat's own moves (measured; `tmp/v52/S2/`)

The existing option `search.iterationShape` does this (a multiplier per own-move number, used once in S5), so
no engine change was needed.

**Shapes from existing logs** (`tmp/v52/shape/shapes.md`):

| Own move | Blokee iterations (p4_cost positions) | n | Blokee in-match ms (per-seat, 800 seeds) | Pentobi L6 new simulations | n |
|---:|---:|---:|---:|---:|---:|
| 0 | — | 0 | 0.0 | 568 | 28 |
| 1 | — | 0 | 0.0 | 517 | 54 |
| 2 | — | 0 | 0.0 | 614 | 60 |
| 3 | 3267 | 13 | 149.7 | 2712 | 60 |
| 4 | 3343 | 13 | 129.7 | 3765 | 60 |
| 5 | 3401 | 12 | 116.8 | 4210 | 60 |
| 6 | 3216 | 12 | 101.8 | 4843 | 60 |
| 7 | 3512 | 8 | 86.1 | 5400 | 60 |
| 8 | 3721 | 7 | 71.5 | 5816 | 60 |
| 9 | 3259 | 14 | 60.0 | 6598 | 60 |
| 10 | 3300 | 10 | 48.4 | 7084 | 60 |
| 11 | 3523 | 13 | 37.9 | 8009 | 60 |
| 12 | 3467 | 12 | 29.7 | 8660 | 60 |
| 13 | 3177 | 15 | 23.6 | 9413 | 60 |
| 14 | 3456 | 6 | 18.5 | 9678 | 57 |
| 15 | 2914 | 7 | 13.0 | 10160 | 53 |
| 16 | 2778 | 5 | 7.8 | 11372 | 48 |
| 17 | 4267 | 1 | 3.6 | 13888 | 40 |
| 18 | 3584 | 2 | 1.5 | 15981 | 29 |
| 19 | — | 0 | 0.7 | 16498 | 15 |
| 20 | — | 0 | 0.5 | 11209 | 2 |

`v5.1-ultra` runs about the same number of iterations at every own move, so its time per move falls
about tenfold over the game: rollouts get shorter. Pentobi level 6 runs about six times as many simulations
late in the game as at own move 3.

**Arms** (`engine-rs/scripts/v52_n20configs.py`): MID (a), FLAT (b), PSHAPE (c), REV (d), as in the prereg.
Each is normalised to the base's time per game on the measured in-match ms profile, then checked with
`p4_cost` (02:04–02:08, quiet machine):

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 150 | 57.7 | 57.7 | 1.000 | 1.000 | 1.000 |
| MID | 150 | 55.0 | 55.8 | 0.952 | 0.967 | 0.960 |
| REV | 150 | 57.3 | 58.4 | 0.993 | 1.011 | 1.002 |
| FLAT | 150 | 51.7 | 52.3 | 0.896 | 0.905 | 0.901 |
| PSHAPE | 150 | 55.3 | 56.3 | 0.958 | 0.975 | 0.967 |

MID, FLAT and PSHAPE were outside [0.97, 1.03], so their whole shapes were scaled by 1/ratio once (not
re-checked, as preregistered). The multipliers in the table's "Change" column are the ones before that
scaling; the configs in `tmp/v52/S2/configs/` hold the scaled ones.

**Screen** (400 seeds 93,300,000–93,300,399, per-seat, 02:08–03:17; raw logs
`tmp/v52/S2/screen/rol-<arm>.jsonl` + `.moves`, `.timing`):

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.1-ultra.json unchanged (iterationScale 14.224) | 400 | -0.88 [-1.48, -0.28] | 21.6% | — | — |  | 58.1 | 0/1600 |
| MID | (a) own moves 6-12 x1.5, 13+ x0.5, 3-5 scaled to equal time: 3:0.54, 4:0.54, 5:0.54, 6:1.50, 7:1.50, 8:1.50, 9:1.50, 10:1.50, 11:1.50, 12:1.50, 13:0.50, 14:0.50, 15:0.50, 16:0.50, 17:0.50, 18:0.50, 19:0.50, 20:0.50; whole shape (own moves 3+) scaled by 1/0.9596 after the cost check | 400 | -1.13 [-1.72, -0.54] | 21.5% | -0.24 [-0.91, +0.45] | -0.12 [-2.62, +2.31] | 0.960 | 59.8 | 1598/1600 |
| REV | (d) reverse of (a): own moves 6-12 x0.667, 13+ x2, 3-5 scaled to equal time: 3:1.19, 4:1.19, 5:1.19, 6:0.67, 7:0.67, 8:0.67, 9:0.67, 10:0.67, 11:0.67, 12:0.67, 13:2.00, 14:2.00, 15:2.00, 16:2.00, 17:2.00, 18:2.00, 19:2.00, 20:2.00 | 400 | -0.77 [-1.36, -0.16] | 22.6% | +0.11 [-0.56, +0.79] | +0.94 [-1.56, +3.38] | 1.002 | 57.7 | 1598/1600 |
| FLAT | (b) equal wall time per own move (m_k proportional to 1/ms_k, capped at x6.0), normalised: 3:0.42, 4:0.48, 5:0.54, 6:0.62, 7:0.73, 8:0.88, 9:1.05, 10:1.30, 11:1.66, 12:2.12, 13:2.66, 14:3.38, 15:4.84, 16:6.00, 17:6.00, 18:6.00, 19:6.00, 20:6.00; whole shape (own moves 3+) scaled by 1/0.9008 after the cost check | 400 | -1.52 [-2.12, -0.91] | 20.1% | -0.64 [-1.30, +0.05] | -1.50 [-4.06, +1.06] | 0.901 | 60.6 | 1599/1600 |
| PSHAPE | (c) iterations proportional to Pentobi level 6's simulations per own move (capped at x6.0), normalised: 3:0.51, 4:0.71, 5:0.79, 6:0.91, 7:1.02, 8:1.10, 9:1.25, 10:1.34, 11:1.51, 12:1.63, 13:1.78, 14:1.83, 15:1.92, 16:2.15, 17:2.62, 18:3.02, 19:3.11, 20:2.12; whole shape (own moves 3+) scaled by 1/0.9666 after the cost check | 400 | -0.76 [-1.38, -0.14] | 22.7% | +0.12 [-0.61, +0.87] | +1.06 [-1.62, +3.75] | 0.967 | 58.5 | 1596/1600 |

iterationScale played: base 14.224, MID 14.224, REV 14.224, FLAT 14.224, PSHAPE 14.224

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v52/S2/screen/rol-base.jsonl` | 400 | -0.66 [-1.11, -0.21] | +2.13 [+1.65, +2.60] | -1.67 [-2.13, -1.21] | +0.20 [-0.23, +0.65] |
| `tmp/v52/S2/screen/rol-MID.jsonl` | 400 | -0.84 [-1.29, -0.40] | +2.02 [+1.57, +2.46] | -1.65 [-2.13, -1.16] | +0.47 [+0.03, +0.91] |
| `tmp/v52/S2/screen/rol-REV.jsonl` | 400 | -0.58 [-1.02, -0.12] | +2.34 [+1.89, +2.79] | -1.81 [-2.26, -1.37] | +0.05 [-0.41, +0.51] |
| `tmp/v52/S2/screen/rol-FLAT.jsonl` | 400 | -1.14 [-1.59, -0.68] | +2.00 [+1.55, +2.45] | -1.55 [-2.03, -1.06] | +0.69 [+0.20, +1.16] |
| `tmp/v52/S2/screen/rol-PSHAPE.jsonl` | 400 | -0.57 [-1.04, -0.10] | +2.07 [+1.66, +2.49] | -1.62 [-2.08, -1.17] | +0.12 [-0.34, +0.56] |

**Decision (standing rule): no arm clears, so there is no confirmation (93,400,000 unplayed) and no
`v5.2-cand-ultra.json`.**

**Reading:** how the same time is spread over the game makes no measurable difference within ±0.7.
- Pentobi's shape reads +0.12.
- The reverse of the middle-game-heavy shape reads +0.11.
- The middle-game-heavy shape reads −0.24.
- Equal time per move (FLAT) reads −0.64 [−1.30, +0.05], the weakest. FLAT moves most of the time to
  late moves, where each iteration buys little.

The flat iteration count Blokee uses now is as good as any of these shapes.


## Round 5, Stage 3 — CEM tuner on `v5.1-ultra` (measured; `tmp/v52/S3/`)

**Run.** Stage 2 saved nothing, so the base was `v5.1-ultra`. The stage started at 03:18 with 221 minutes to
07:00, so the tuner ran: 29 generations, 03:18–06:55, about 7.5 minutes each. Each generation was 12
candidates × 25 seeds × 4 games, all on the shared Pentobi process. Training seeds were 94,000,000 + 100·g
… +24 for g = 0…28, each used once. Log `tmp/v52/S3/tune.log`; per-generation results and the CEM state in
`tmp/v52/S3/tune/state.json`; every candidate's games in `tmp/v52/S3/tune/gen-XX/`.

**Trajectory (measured).**
- The fitness of the mean candidate (each generation on new seeds) averaged −0.41 over generations 0–9,
  −0.95 over 10–19 and −0.75 over 20–28. There is no upward trend; the swings are mostly seed difficulty.
- The per-generation mean over all 12 candidates ranges from −2.2 to +0.1, also with no trend.
- σ shrank to near its floor on every dimension.

**Final point**, fixed at 06:55 before any validation game (`tmp/v52/S3/tune/final.json`):

```
{
 "generations": 29,
 "values": {
  "raveWeight": 0.6998,
  "raveEquivalence": 112.3591,
  "raveDecay": 0.5836,
  "exploration": 0.3176,
  "qualityWeight": 0.5058,
  "qualitySlope": 1.0997,
  "lengthWeight": 0.083,
  "firstWeight": 0.0311,
  "priorTemperature": 0.8891,
  "rootInitVisits": 2.5354,
  "interiorInitVisits": 1.0487,
  "historyWeight": 0.4895,
  "playoutEps": 0.5927
 }
}
```

It moved little from the start. RAVE weight 1.0 → 0.70, exploration 0.40 → 0.32, root initial visits 3 →
2.5, prior temperature 1 → 0.89, history weight 0.6 → 0.49; the rest are within about 10%.

**Clean cost** (06:55, quiet machine):

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 150 | 58.9 | 57.8 | 1.000 | 1.000 | 1.000 |
| TUNED | 150 | 58.2 | 58.1 | 0.988 | 1.005 | 0.997 |

At 0.997× it is inside [0.97, 1.03], so it was validated as itself.

**Validation** (per-seat processes, base and TUNED on 400 seeds 95,000,000 and on 400 seeds 95,100,000,
06:55–07:50; raw logs `tmp/v52/S3/val/{v1,v2}-{base,TUNED}.jsonl` + `.moves`, `.timing`; pooled copies
`all-*.jsonl`):

| Arm | Seeds | Advantage | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| base | 800 | -0.52 [-0.95, -0.08] | 22.2% | 19.5% |
| TUNED | 800 | -0.48 [-0.88, -0.08] | 21.8% | 18.5% |
- block v1: -0.22 [-0.91, +0.47] on 400 seeds; first place (split) -1.65 [-4.03, +0.69] pp
- block v2: +0.29 [-0.47, +1.02] on 400 seeds; first place (split) -0.35 [-2.99, +2.06] pp

- TUNED − base, 800 seeds: +0.03 [-0.47, +0.52]; first place (any) -0.44 [-2.38, +1.47] pp, (split) -1.00 [-2.72, +0.65] pp -> NOT ACCEPTED

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v52/S3/val/all-base.jsonl` | 800 | -0.39 [-0.71, -0.06] | +1.99 [+1.68, +2.31] | -1.94 [-2.27, -1.61] | +0.34 [+0.03, +0.65] |
| `tmp/v52/S3/val/all-TUNED.jsonl` | 800 | -0.36 [-0.66, -0.06] | +2.04 [+1.71, +2.36] | -1.95 [-2.28, -1.62] | +0.27 [-0.06, +0.60] |

**Decision (preregistered rule): not accepted** (+0.03 [−0.47, +0.52]; first place −1.0 pp split). Nothing
is saved.

**Reading:** with 25 seeds per candidate the fitness noise (about ±1.2 per candidate) is larger than any
effect these settings can have near the current point. CEM then mostly averages noise, and its mean
stayed close to where it started. This agrees with round 1's single-change screen, where the package's
constants were already near a flat optimum. A tuner on this search space would need several times more
games per candidate to resolve effects of ±0.3.

## Round 5 — seed blocks, what I did not get to, things to check

**Seed blocks played:**
- 93,950,000–93,950,009 (clean timing)
- 93,000,000 and 93,100,000 (TM vs base, 400 each)
- 93,200,000 (×1 / ×2 / ×4, 200 each)
- 93,250,000 (reverse vs TM)
- 93,300,000 (N20 screen)
- 94,000,000–94,002,824 (tuner training, generations 0–28, 25 seeds per generation at a stride of 100)
- 95,000,000 and 95,100,000 (validation)

**Preregistered and unplayed:** 93,400,000 (no N20 arm cleared); 95,200,000 and 95,300,000 (the fallback
replication was not needed). **Protected and unread:** 83,100,000; 83,200,000; 84,800,000; 87,200,000;
87,300,000; 87,500,000; 88,200,000; 88,300,000; 89,900,000; and the old N10 validation seeds
79,800,000–79,800,199. Also unplayed: 90,600,000 and 91,800,000.

**Not done:** a re-check of the time-matched config after the 800-seed block (the in-match times, 77.1 for
Blokee against 77.6 for Pentobi, agree with the clean check); per-seat training games for the tuner (I used
the shared process as allowed); a larger tuner budget per candidate.

**Worth checking:** N20's MID, FLAT and PSHAPE were each scaled once after the cost check and not
re-checked, so their final cost is about 1 ± 0.03 by construction only. TM is kept only in
`tmp/v52/S1/configs/TM.json` (not committed, since `tmp/` is ignored); its only change is `iterationScale`
23.222.


# Round 6 (2026-11-15 afternoon, 13:27–18:00 CST) — tiers at equal wall time against Pentobi's levels

Preregistration: "2026-11-15 13:40 CST, round 6" (commit `f994698`, before any game). Engine `6f63202` (pinned
`tmp/v53/bin`) adds `--mode pentobi-ladder` and `--rotations`; defaults are unchanged (checked). Driver
`engine-rs/scripts/v53-chain.sh`; read-outs `engine-rs/scripts/v53_report.py`.

## Round 6, Stage 1 — tier calibration (measured; `tmp/v53/cal/`)

**Calibration table.** Times are means per move from each seat's fifth move on (see the prereg for why).
`iterationScale` is the saved value, after one correction for nano, lite, pro and ultra.

| Level | Pentobi ms/move | Pentobi new simulations/move | Tier | `iterationScale` (saved) | our ms/move at the checked scale | our nominal iterations/move at the saved scale |
|---:|---:|---:|---|---:|---:|---:|
| 1 | 1.7 | 3 | nano | 0.383 | 2.3 (at the pre-correction scale) | 115 |
| 3 | 2.5 | 69 | lite | 0.647 | 3.0 (at the pre-correction scale) | 194 |
| 5 | 10.6 | 855 | base | 3.545 | 11.4 (at the pre-correction scale) | 1,064 |
| 7 | 902.7 | 81,654 | pro | 224.487 | 1185.2 (at the pre-correction scale) | 67,346 |
| 9 | 17069.2 | 1,745,122 | ultra | 3948.432 | 22145.6 (at the pre-correction scale) | 1,184,530 |

Configs saved: `engine-rs/configs/v5.2-{nano,lite,base,pro,ultra}.json` (`v5.1-ultra`'s settings at those
scales) and `engine-rs/configs/v5.2-l6.json` (round 5's level-6 time match, `iterationScale` 23.222).

**Full output** (one game thread, per-seat processes, 13:36–14:14; level 9 and the ultra check ran
alongside the others as a second single-threaded game; raw logs `tmp/v53/cal/L{k}.jsonl`, `check-<tier>.jsonl`,
Pentobi logs `logs-L{k}/`):

Blokee `v5.1-ultra` at iterationScale 14.224: 42.5 ms/move (own moves 4+, pooled over the level 1-7 runs)

| Level | Games | Pentobi ms/move (move 5+) | Pentobi ms/move (all) | new simulations/move | root visits | Tier | iterationScale |
|---:|---:|---:|---:|---:|---:|---|---:|
| 1 | 4 | 1.7 | 3.2 | 3 | 3 | nano | 0.565 |
| 2 | 4 | 2.0 | 3.8 | 24 | 25 |  |  |
| 3 | 4 | 2.5 | 4.7 | 69 | 70 | lite | 0.825 |
| 4 | 4 | 4.1 | 5.8 | 218 | 222 |  |  |
| 5 | 4 | 10.6 | 12.1 | 855 | 889 | base | 3.545 |
| 6 | 4 | 72.3 | 72.7 | 6496 | 6954 |  |  |
| 7 | 4 | 902.7 | 880.8 | 81654 | 88597 | pro | 302.191 |
| 8 | 2 | 3931.5 | 3969.2 | 399181 | 443978 |  |  |
| 9 | 1 | 17069.2 | 17507.1 | 1745122 | 2011301 | ultra | 5714.031 |

| Tier | Level | iterationScale (checked) | our ms/move (own 4+) | Pentobi ms/move (move 5+) | ratio | our ms (all) |
|---|---:|---:|---:|---:|---:|---:|
| nano (check) | 1 | 0.565 | 2.3 | 1.5 | 1.474 | 2.2 |
| lite (check) | 3 | 0.825 | 3.0 | 2.3 | 1.276 | 2.8 |
| base (check) | 5 | 3.545 | 11.4 | 11.8 | 0.972 | 11.1 |
| pro (check) | 7 | 302.191 | 1185.2 | 880.5 | 1.346 | 1063.0 |
| ultra (check) | 9 | 5714.031 | 22145.6 | 15302.8 | 1.447 | 20308.7 |

**Measured:**
- Pentobi's time per move grows slowly from level 1 to 5 (1.7 → 10.6 ms), then about tenfold per level:
  72 ms at level 6, 0.9 s at 7, 3.9 s at 8, 17 s at 9.
- Simulations follow the same pattern: 3, 24, 69, 218, 855, 6,500, 82,000, 399,000, 1.75M.
- **Our time is not proportional to the iterations at either end.** The proportional scale overshot by 47%
  (nano), 28% (lite), 35% (pro) and 45% (ultra); base was within 3%.
- At the low end, a fixed cost per move weighs most. From the two low checks, about 0.8 ms per move plus
  about 2.7 ms per unit of `iterationScale` (reading: root expansion with the full-move prior, and the
  position context). It does not bind: nano's corrected 115 nominal iterations should land near level 1's
  1.7 ms.
- At the high end, each iteration costs more in a bigger tree (memory and cache).

The corrected scales were not re-checked, as preregistered. Their time match is therefore an estimate.
The Stage-2 in-match times are the real check (below).

**High budgets:** one search at `iterationScale` 5,000 ran 1.0–1.4M iterations in 7–48 s, with peak memory
8.2 GB and no error (`tmp/v53/mem/`). Nothing in the engine needed changing. Memory limits ultra to about 3
concurrent games on this machine.


## Round 6, Stage 2 — each tier against its level at equal time (measured; `tmp/v53/S2/tiers.md`)

Per-seat processes, 10 threads, 14:14–15:04. Raw logs `tmp/v53/S2/<tier>-L<k>.jsonl` and
`tmp/v53/S2/rev-<tier>-L<k>.jsonl` (+ `.moves`, `.timing`). In-match times are under 10-game load. Ultra is
the tail (below).

| Match | Seeds | Our advantage [95% CI] | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| v5.2-nano vs 3 x L1 | 400 | +6.30 [+5.78, +6.83] | 52.8% | 49.3% |
| one L1 vs 3 x v5.2-nano (Pentobi's advantage) | 200 | -7.92 [-8.64, -7.21] | 7.8% | 6.4% |
| v5.2-lite vs 3 x L3 | 400 | +1.61 [+1.11, +2.14] | 37.4% | 32.7% |
| one L3 vs 3 x v5.2-lite (Pentobi's advantage) | 200 | -3.66 [-4.32, -3.08] | 14.2% | 11.5% |
| v5.2-base vs 3 x L5 | 400 | +0.33 [-0.20, +0.85] | 24.7% | 21.9% |
| one L5 vs 3 x v5.2-base (Pentobi's advantage) | 200 | -1.28 [-2.11, -0.46] | 27.8% | 24.6% |
| v5.2-pro vs 3 x L7 | 100 | -2.02 [-3.14, -0.84] | 21.2% | 18.1% |

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v53/S2/nano-L1.jsonl` | 400 | +4.72 [+4.34, +5.12] | -0.71 [-1.04, -0.36] | -2.88 [-3.23, -2.53] | -1.14 [-1.47, -0.80] |
| `tmp/v53/S2/rev-nano-L1.jsonl` | 200 | -5.94 [-6.48, -5.41] | +2.05 [+1.43, +2.67] | +3.20 [+2.63, +3.80] | +0.68 [+0.16, +1.19] |
| `tmp/v53/S2/lite-L3.jsonl` | 400 | +1.21 [+0.83, +1.60] | +0.73 [+0.45, +1.00] | -1.32 [-1.65, -0.99] | -0.62 [-0.90, -0.34] |
| `tmp/v53/S2/rev-lite-L3.jsonl` | 200 | -2.75 [-3.24, -2.31] | +0.37 [-0.26, +1.02] | +2.47 [+1.95, +3.02] | -0.09 [-0.70, +0.49] |
| `tmp/v53/S2/base-L5.jsonl` | 400 | +0.25 [-0.15, +0.64] | +2.15 [+1.76, +2.54] | -2.24 [-2.62, -1.85] | -0.17 [-0.55, +0.22] |
| `tmp/v53/S2/rev-base-L5.jsonl` | 200 | -0.96 [-1.58, -0.35] | -0.77 [-1.44, -0.10] | +1.59 [+0.97, +2.23] | +0.14 [-0.47, +0.75] |
| `tmp/v53/S2/pro-L7.jsonl` | 100 | -1.51 [-2.35, -0.63] | +4.02 [+3.03, +5.01] | -1.46 [-2.42, -0.54] | -1.05 [-1.94, -0.10] |

In-match ms/move (own/move 5+; all): 
- `tmp/v53/S2/nano-L1.jsonl`: ours 1.9 (1.8), Pentobi 1.8 (3.6)
- `tmp/v53/S2/rev-nano-L1.jsonl`: ours 1.7 (1.6), Pentobi 1.9 (3.6)
- `tmp/v53/S2/lite-L3.jsonl`: ours 3.0 (2.8), Pentobi 2.7 (5.1)
- `tmp/v53/S2/rev-lite-L3.jsonl`: ours 2.8 (2.6), Pentobi 2.8 (5.2)
- `tmp/v53/S2/base-L5.jsonl`: ours 13.8 (12.9), Pentobi 11.9 (13.4)
- `tmp/v53/S2/rev-base-L5.jsonl`: ours 13.6 (12.8), Pentobi 12.1 (13.7)
- `tmp/v53/S2/pro-L7.jsonl`: ours 823.6 (775.6), Pentobi 937.7 (935.7)

**Measured:**

| Tier vs level | Lone seat | Reverse (one Pentobi seat vs three of ours) |
|---|---|---|
| nano vs 1 | **+6.30 [+5.78, +6.83]**, first place 52.8% | −7.92 |
| lite vs 3 | **+1.61 [+1.11, +2.14]**, 37.4% | −3.66 |
| base vs 5 | **+0.33 [−0.20, +0.85]**, 24.7% (parity) | −1.28 [−2.11, −0.46] |
| pro vs 7 | **−2.02 [−3.14, −0.84]**, 21.2% (100 seeds) | not played |

Under match load our time per move is close to Pentobi's for nano (1.9 against 1.8 ms) and lite (3.0
against 2.7). It is 16% above for base (13.8 against 11.9) and 12% below for pro (824 against 938 ms). So
the corrected scales are approximate, as Stage 1 warned.

**Reading:** the further down the ladder, the larger our lead at equal time: decisive at level 1, clear at
3, level at 5, behind at 7. Pentobi's search at levels 1–3 is tiny (3–70 simulations); ours at the same
time runs about 115–200 iterations with a fitted prior. At level 7 Pentobi's 80,000 simulations outplay
our roughly 67,000 iterations. The seat after Blokee still gains at base and pro (+2.2, +4.0), but not at
nano and lite. There our seat takes most of the slack itself.


## Round 6, Stage 3 — data for a standard benchmark (measured; DRAFT read-out; `tmp/v53/S3/bench.md`)

The bridge mode `--mode pentobi-ladder --lone-level A --level B` (engine `6f63202`) plays one Pentobi seat at
level A against three at level B, each seat in its own process. Played 15:04–15:28, 200 seeds per block:
- the ladder, k = 1…5, both directions (seeds 97,000,000 + 50,000·i);
- tiers against their bracketing levels: nano vs 2, lite vs 2 and 4, base vs 4 and 6 (seeds 97,600,000 …
  97,950,000).

Raw logs `tmp/v53/S3/ladder-L<a>-vs-L<b>.jsonl` and `tmp/v53/S3/<tier>-vs-L<k>.jsonl`. The read-out
(`engine-rs/scripts/v53_report.py --bench`) is a draft: for each engine, the lone-seat advantage against three
seats of each anchor level, and the level at which the advantage would be 0 by linear interpolation between
the bracketing anchors. The 95% interval comes from bootstrapping seeds within each match.

**DRAFT read-out (design to be settled by the supervising session with Paul).**

| Engine | ms/move (own 4+) | Advantage vs anchors played (level: adv [95% CI]) | Break-even level [95% CI] |
|---|---:|---|---:|
| v5.2-nano | 1.9 | L1: +6.30 [+5.78, +6.83]; L2: +2.19 [+1.50, +2.92] | not bracketed (above all anchors) |
| v5.2-lite | 2.8 | L2: +5.22 [+4.47, +5.96]; L3: +1.61 [+1.11, +2.14]; L4: -2.33 [-3.01, -1.66] | 3.41 [3.31, 3.52] |
| v5.2-base | 13.0 | L4: +3.89 [+3.18, +4.63]; L5: +0.33 [-0.20, +0.85]; L6: -4.89 [-5.70, -4.07] | 5.06 [4.96, 5.15] |
| v5.2-pro | 823.6 | L7: -2.02 [-3.14, -0.84] | not bracketed (below all anchors) |
| Pentobi L2 |  | L1: +3.68 [+3.17, +4.24]; L3: -3.73 [-4.24, -3.22] | 1.99 [1.89, 2.09] |
| Pentobi L1 |  | L2: -4.37 [-4.95, -3.81] | not bracketed (below all anchors) |
| Pentobi L3 |  | L2: +3.83 [+3.37, +4.29]; L4: -4.20 [-4.69, -3.70] | 2.95 [2.87, 3.03] |
| Pentobi L4 |  | L3: +5.36 [+4.77, +5.95]; L5: -4.87 [-5.47, -4.28] | 4.05 [3.97, 4.13] |
| Pentobi L5 |  | L4: +5.19 [+4.54, +5.88]; L6: -6.87 [-7.63, -6.06] | 4.86 [4.78, 4.94] |
| Pentobi L6 |  | L5: +7.69 [+6.97, +8.46] | not bracketed (above all anchors) |

**Measured:**
- **The ladder is monotone and self-consistent.** Read as engines, Pentobi's levels land at their own
  numbers: L2 1.99 [1.89, 2.09], L3 2.95 [2.87, 3.03], L4 4.05 [3.97, 4.13], L5 4.86 [4.78, 4.94].
- One level is worth about +3.7 to +7.7 points for the stronger lone seat and −3.7 to −6.9 for the weaker
  one, and the gap widens up the scale.
- **Our tiers:** `v5.2-lite` sits at **level 3.41 [3.31, 3.52]** (its target is 3); `v5.2-base` at **5.06
  [4.96, 5.15]** (target 5).
- `v5.2-nano` is above both anchors played (+6.30 vs level 1, +2.19 vs level 2), so it needs a level-3
  anchor to be bracketed.
- `v5.2-pro` has only its own level (−2.02 vs 7), so it needs level 6 (and the k = 6 rung) to be read.

**Not done:** ladder rungs k = 6 (the driver plays lone 7 vs three 6 on 100 seeds if time allows; see below),
7 and 8; anchors at level 3 for nano and level 6 for pro; `v5.2-l6` against levels 5 and 7.

**Reading for the design:** a one-number score per engine works with two anchors bracketing it, and the
intervals are about ±0.1 level at 200 seeds per anchor. Interpolating linearly in level is a choice: the
points per level are not constant, so interpolating in, say, log simulations would give slightly
different numbers.


**Ladder rung 6 (added after Stage 4; measured):** lone level 7 against three level-6 seats, 100 seeds
97,500,000 (16:04–16:17; raw log `tmp/v53/S3/ladder-L7-vs-L6.jsonl`) reads **+8.22 [+7.18, +9.30]**. That is
the largest one-level step on the ladder (rungs 1–5 gave +3.7 to +7.7 for the stronger lone seat). The
reverse rung (lone 6 vs three 7) was not played. The draft read-out `tmp/v53/S3/bench.md` is regenerated
with it.

## Round 6, Stage 4 — cheap efficiency changes per tier (measured; `tmp/v53/S4/`)

Five one-change arms per tier on `v5.2-<tier>`, at equal time:
- `RW05`: RAVE weight 0.5
- `IIV3`: interiorInitVisits 3
- `T07`: prior temperature 0.7
- `X02`: priorLog exploration 0.2
- `CAP6`: rollout move cap 6

Arms outside [0.97, 1.03] in clean cost were re-timed. At the nano and lite budgets the two clean-cost
rounds disagree by up to 10%, because times are 2–3 ms per move, so re-timing at these tiers is coarse.
Screens are 400 seeds against the matched level, per-seat, 15:28–16:04. Raw logs
`tmp/v53/S4/<tier>/screen/rol-<arm>.jsonl`. (The column header says "vs L6" from the shared read-out; it is
the tier's own level.)

**nano vs level 1** (screen seeds 98,000,000; costs `tmp/v53/S4/nano/cost/`):

| Arm | Change | Seeds | Advantage vs level [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.2-nano.json unchanged (iterationScale 0.383) | 400 | +6.34 [+5.82, +6.85] | 51.7% | — | — |  | 2.1 | 0/1600 |
| RW05 | RAVE weight 1.0 -> 0.5 | 400 | +6.66 [+6.15, +7.17] | 53.8% | +0.32 [-0.36, +0.99] | +2.12 [-1.00, +5.19] | 0.990 | 2.1 | 1600/1600 |
| IIV3 | interiorInitVisits 1 -> 3 | 400 | +6.46 [+5.92, +7.00] | 52.4% | +0.12 [-0.60, +0.83] | +0.69 [-2.69, +4.12] | 1.017 | 2.2 | 1600/1600 |
| T07 | prior temperature 1 -> 0.7 (sharper prior, root and interior) | 400 | +6.86 [+6.31, +7.45] | 53.8% | +0.52 [-0.18, +1.24] | +2.12 [-1.12, +5.50] | 0.975 | 2.1 | 1600/1600 |
| X02-ET | priorLog exploration 0.4 -> 0.2 at equal time: search.iterationScale 0.383 -> 0.397 (0.383 / 0.9659); corrected 0.397 -> 0.382 (/ 1.0382) | 400 | +4.14 [+3.62, +4.66] | 44.5% | -2.20 [-2.90, -1.51] | -7.19 [-10.38, -3.94] | 1.038 | 2.1 | 1600/1600 |
| CAP6 | playoutMoveCap 12 -> 6 (cheaper rollout moves) | 400 | +5.69 [+5.16, +6.22] | 49.4% | -0.65 [-1.35, +0.06] | -2.25 [-5.38, +0.88] | 0.981 | 2.0 | 1600/1600 |

iterationScale played: base 0.383, RW05 0.383, IIV3 0.383, T07 0.383, X02-ET 0.382, CAP6 0.383

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v53/S4/nano/screen/rol-base.jsonl` | 400 | +4.76 [+4.36, +5.14] | -1.08 [-1.42, -0.74] | -2.91 [-3.28, -2.55] | -0.76 [-1.10, -0.43] |
| `tmp/v53/S4/nano/screen/rol-RW05.jsonl` | 400 | +4.99 [+4.61, +5.38] | -1.09 [-1.40, -0.78] | -3.14 [-3.49, -2.77] | -0.76 [-1.11, -0.42] |
| `tmp/v53/S4/nano/screen/rol-IIV3.jsonl` | 400 | +4.85 [+4.44, +5.25] | -0.94 [-1.25, -0.62] | -3.14 [-3.49, -2.78] | -0.77 [-1.09, -0.45] |
| `tmp/v53/S4/nano/screen/rol-T07.jsonl` | 400 | +5.15 [+4.73, +5.58] | -1.05 [-1.38, -0.73] | -3.44 [-3.80, -3.07] | -0.66 [-0.99, -0.34] |
| `tmp/v53/S4/nano/screen/rol-X02-ET.jsonl` | 400 | +3.11 [+2.71, +3.50] | -0.06 [-0.37, +0.26] | -2.34 [-2.67, -2.00] | -0.70 [-1.03, -0.37] |
| `tmp/v53/S4/nano/screen/rol-CAP6.jsonl` | 400 | +4.27 [+3.87, +4.66] | -0.55 [-0.88, -0.22] | -3.03 [-3.38, -2.67] | -0.68 [-0.99, -0.37] |

**lite vs level 3** (screen seeds 98,100,000; costs `tmp/v53/S4/lite/cost/`):

| Arm | Change | Seeds | Advantage vs level [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.2-lite.json unchanged (iterationScale 0.647) | 400 | +1.66 [+1.21, +2.12] | 35.8% | — | — |  | 3.3 | 0/1600 |
| RW05 | RAVE weight 1.0 -> 0.5 | 400 | +1.70 [+1.22, +2.20] | 36.8% | +0.04 [-0.61, +0.67] | +1.06 [-2.25, +4.38] | 0.972 | 3.3 | 1600/1600 |
| IIV3 | interiorInitVisits 1 -> 3 | 400 | +1.36 [+0.83, +1.89] | 36.4% | -0.30 [-0.99, +0.38] | +0.69 [-2.56, +3.94] | 1.028 | 3.6 | 1600/1600 |
| T07 | prior temperature 1 -> 0.7 (sharper prior, root and interior) | 400 | +0.61 [+0.13, +1.10] | 32.8% | -1.05 [-1.70, -0.40] | -3.00 [-6.25, +0.12] | 0.973 | 3.3 | 1600/1600 |
| X02-ET | priorLog exploration 0.4 -> 0.2 at equal time: search.iterationScale 0.647 -> 0.67 (0.647 / 0.9660) | 400 | +0.42 [-0.07, +0.92] | 30.1% | -1.25 [-1.87, -0.59] | -5.69 [-8.75, -2.50] | 0.982 | 3.3 | 1600/1600 |
| CAP6-ET | playoutMoveCap 12 -> 6 (cheaper rollout moves) at equal time: search.iterationScale 0.647 -> 0.681 (0.647 / 0.9505) | 400 | +1.17 [+0.68, +1.69] | 33.6% | -0.49 [-1.11, +0.12] | -2.19 [-5.06, +0.75] | 0.985 | 3.3 | 1600/1600 |

iterationScale played: base 0.647, RW05 0.647, IIV3 0.647, T07 0.647, X02-ET 0.67, CAP6-ET 0.681

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v53/S4/lite/screen/rol-base.jsonl` | 400 | +1.25 [+0.90, +1.59] | +0.85 [+0.57, +1.11] | -1.39 [-1.68, -1.09] | -0.71 [-1.00, -0.40] |
| `tmp/v53/S4/lite/screen/rol-RW05.jsonl` | 400 | +1.27 [+0.92, +1.65] | +0.54 [+0.27, +0.82] | -1.52 [-1.83, -1.19] | -0.30 [-0.60, -0.00] |
| `tmp/v53/S4/lite/screen/rol-IIV3.jsonl` | 400 | +1.02 [+0.62, +1.41] | +0.81 [+0.54, +1.07] | -0.98 [-1.31, -0.64] | -0.85 [-1.14, -0.56] |
| `tmp/v53/S4/lite/screen/rol-T07.jsonl` | 400 | +0.46 [+0.10, +0.82] | +1.15 [+0.87, +1.43] | -1.26 [-1.59, -0.95] | -0.35 [-0.64, -0.05] |
| `tmp/v53/S4/lite/screen/rol-X02-ET.jsonl` | 400 | +0.31 [-0.05, +0.69] | +1.41 [+1.15, +1.67] | -1.14 [-1.46, -0.84] | -0.58 [-0.89, -0.27] |
| `tmp/v53/S4/lite/screen/rol-CAP6-ET.jsonl` | 400 | +0.87 [+0.51, +1.27] | +1.09 [+0.82, +1.35] | -1.28 [-1.58, -0.99] | -0.69 [-0.99, -0.38] |

**base vs level 5** (screen seeds 98,200,000; costs `tmp/v53/S4/base/cost/`):

| Arm | Change | Seeds | Advantage vs level [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.2-base.json unchanged (iterationScale 3.545) | 400 | -0.14 [-0.72, +0.43] | 24.1% | — | — |  | 15.4 | 0/1600 |
| RW05 | RAVE weight 1.0 -> 0.5 | 400 | +0.64 [+0.10, +1.20] | 26.8% | +0.78 [+0.07, +1.49] | +2.69 [-0.06, +5.62] | 1.001 | 15.3 | 1600/1600 |
| IIV3-ET | interiorInitVisits 1 -> 3 at equal time: search.iterationScale 3.545 -> 3.378 (3.545 / 1.0495) | 400 | +0.15 [-0.37, +0.69] | 25.2% | +0.29 [-0.41, +1.03] | +1.12 [-1.69, +4.12] | 1.001 | 15.6 | 1600/1600 |
| T07 | prior temperature 1 -> 0.7 (sharper prior, root and interior) | 400 | -0.40 [-0.93, +0.17] | 24.1% | -0.26 [-0.96, +0.45] | +0.00 [-2.62, +2.75] | 1.002 | 15.5 | 1599/1600 |
| X02-ET | priorLog exploration 0.4 -> 0.2 at equal time: search.iterationScale 3.545 -> 3.665 (3.545 / 0.9673) | 400 | -0.64 [-1.14, -0.15] | 22.3% | -0.50 [-1.19, +0.24] | -1.75 [-4.56, +1.06] | 0.994 | 15.3 | 1600/1600 |
| CAP6-ET | playoutMoveCap 12 -> 6 (cheaper rollout moves) at equal time: search.iterationScale 3.545 -> 3.723 (3.545 / 0.9522) | 400 | +0.05 [-0.48, +0.58] | 24.6% | +0.19 [-0.48, +0.90] | +0.56 [-2.12, +3.44] | 1.002 | 15.6 | 1600/1600 |

iterationScale played: base 3.545, RW05 3.545, IIV3-ET 3.378, T07 3.545, X02-ET 3.665, CAP6-ET 3.723

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v53/S4/base/screen/rol-base.jsonl` | 400 | -0.10 [-0.54, +0.32] | +2.23 [+1.84, +2.62] | -2.11 [-2.50, -1.72] | -0.02 [-0.42, +0.39] |
| `tmp/v53/S4/base/screen/rol-RW05.jsonl` | 400 | +0.48 [+0.07, +0.90] | +1.84 [+1.46, +2.23] | -2.20 [-2.61, -1.78] | -0.12 [-0.49, +0.25] |
| `tmp/v53/S4/base/screen/rol-IIV3-ET.jsonl` | 400 | +0.12 [-0.28, +0.51] | +1.96 [+1.57, +2.37] | -1.76 [-2.17, -1.34] | -0.32 [-0.71, +0.07] |
| `tmp/v53/S4/base/screen/rol-T07.jsonl` | 400 | -0.30 [-0.70, +0.13] | +2.36 [+1.96, +2.76] | -1.93 [-2.31, -1.55] | -0.14 [-0.51, +0.25] |
| `tmp/v53/S4/base/screen/rol-X02-ET.jsonl` | 400 | -0.48 [-0.86, -0.11] | +2.03 [+1.61, +2.44] | -1.48 [-1.87, -1.07] | -0.07 [-0.46, +0.32] |
| `tmp/v53/S4/base/screen/rol-CAP6-ET.jsonl` | 400 | +0.04 [-0.36, +0.44] | +1.92 [+1.56, +2.29] | -1.93 [-2.31, -1.53] | -0.03 [-0.43, +0.35] |

**Confirmation** of base `RW05` (the only clearing arm: +0.78 [+0.07, +1.49] on the screen), 400 seeds
98,500,000 (raw logs `tmp/v53/S4/base/confirm/`):

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.2-base.json unchanged (iterationScale 3.545) | 400 | +0.12 [-0.41, +0.66] | 25.3% | — | — |  | 15.8 | 0/1600 |
| RW05 | RAVE weight 1.0 -> 0.5 | 400 | -0.06 [-0.58, +0.47] | 25.4% | -0.18 [-0.87, +0.50] | +0.06 [-2.75, +2.88] | 1.001 | 15.9 | 1599/1600 |

- RW05: paired -0.18 [-0.87, +0.50] on 400 seeds; first place +0.06 pp [-2.75, +2.88] -> NOT ACCEPTED
NEW BASE: (none)

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v53/S4/base/confirm/rolc-base.jsonl` | 400 | +0.09 [-0.31, +0.49] | +1.83 [+1.44, +2.20] | -1.75 [-2.13, -1.35] | -0.17 [-0.56, +0.21] |
| `tmp/v53/S4/base/confirm/rolc-RW05.jsonl` | 400 | -0.04 [-0.43, +0.35] | +1.74 [+1.35, +2.13] | -1.69 [-2.08, -1.29] | -0.01 [-0.40, +0.37] |

**Decision (standing rule): nothing is accepted**, so no `v5.3-cand-*` config was saved.
- Nano: nothing clears (T07 +0.52, RW05 +0.32, null).
- Lite: nothing clears. T07 −1.05 and X02 −1.25 are harmful.
- Base: RW05 cleared at +0.78 and failed confirmation at −0.18 [−0.87, +0.50].
- Lower priorLog exploration hurts at every tier: −2.20 nano, −1.25 lite, −0.50 base.

**Reading:** the `v5.1-ultra` settings carry over to small budgets about as well as the alternatives tried,
and exploration should not be lowered at small budgets.


# Round 7 (2026-11-15 evening – 2026-11-16 08:00 CST) — why we fall behind at the pro budget

Preregistration: "2026-11-15 16:55 CST, round 7" (commit `0f31eb0`). Driver `engine-rs/scripts/v54-chain.sh`.

## Round 7, B — scaling diagnosis (measured, no Pentobi games; `tmp/v54/B/`)

Setup: 150 recorded positions (own moves 3+, `tmp/d1/x1-l6a.moves.jsonl`) at the `v5.2-l6`, 4× l6 and `v5.2-pro`
budgets, plus half budgets for the change rate (`p910_probe shape`, `p4_cost` with one thread). This ran
alongside the ultra tail (3 game threads), so absolute times carry that load. Reuse uses the P8 method
(`p67_probe reuse`) on 48 recorded games: round 5's time-matched games for l6 and 4×, and round 6's
`pro-L7` games for pro. The profile is `sample` of a single-threaded `p4_cost` for 25 s. Raw files:
`shape.csv`, `cost.csv`, `reuse-*.csv` / `.md`, `sample-*.txt`.

| Budget (iterationScale) | iterations (mean) | ms/move (1 thread, under ultra load) | iterations/s | nodes | depth mean / max | chosen move's visit share | its top reply's share | best move changes, half → full budget | reuse at next own turn (share of budget; visits) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v5.2-l6 (23.222) | 5,280 | 103 | 51,021 | 5,122 | 4.14 / 16 | 0.509 | 0.371 | 18.7% | 0.843% (58.71) |
| 4× l6 (92.888) | 20,026 | 409 | 48,952 | 19,108 | 4.95 / 20 | 0.586 | 0.509 | 13.3% | 1.003% (279.36) |
| v5.2-pro (224.487) | 47,609 | 1012 | 47,042 | 44,788 | 5.60 / 20 | 0.615 | 0.562 | 14.7% | 1.325% (892.62) |

**Top of stack, `sample` 25 s, l6** (share of the samples listed):

- semaphore_wait_trap: 11387 (51.0%)
- _RNvMNtCsfG6yJ9azk97_6blokee7playoutNtB2_7Playout12sample_moves: 3534 (15.8%)
- _RNvMs_NtCsfG6yJ9azk97_6blokee6searchNtB4_9V12Search7iterate: 2736 (12.3%)
- _RNvMNtCsfG6yJ9azk97_6blokee13feature_priorNtB2_10PriorModel5score: 1950 (8.7%)
- _RNvMNtCsfG6yJ9azk97_6blokee7playoutNtB2_7Playout3run: 766 (3.4%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position14generate_moves: 586 (2.6%)
- _RINvNtNtNtNtCs3bJEMBXHbwl_4core5slice4sort8unstable9quicksort9quicksortoNvYoNtNtBa_3cmp10PartialOrd2ltECsfG6y: 311 (1.4%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position8is_legal: 283 (1.3%)
- _RNvNtCsfG6yJ9azk97_6blokee8bitboard10to_indices: 266 (1.2%)
- _RNvNtCsfG6yJ9azk97_6blokee6jsmath3exp: 135 (0.6%)
- _platform_memset: 117 (0.5%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position4undo: 116 (0.5%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position5apply: 83 (0.4%)
- _RNvNtCsfG6yJ9azk97_6blokee8ordering13sort_by_score: 64 (0.3%)

**Top of stack, `sample` 25 s, pro** (share of the samples listed):

- semaphore_wait_trap: 21505 (51.0%)
- _RNvMs_NtCsfG6yJ9azk97_6blokee6searchNtB4_9V12Search7iterate: 6786 (16.1%)
- _RNvMNtCsfG6yJ9azk97_6blokee7playoutNtB2_7Playout12sample_moves: 5750 (13.6%)
- _RNvMNtCsfG6yJ9azk97_6blokee13feature_priorNtB2_10PriorModel5score: 3605 (8.5%)
- _RNvMNtCsfG6yJ9azk97_6blokee7playoutNtB2_7Playout3run: 1101 (2.6%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position14generate_moves: 931 (2.2%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position8is_legal: 602 (1.4%)
- _RINvNtNtNtNtCs3bJEMBXHbwl_4core5slice4sort8unstable9quicksort9quicksortoNvYoNtNtBa_3cmp10PartialOrd2ltECsfG6y: 563 (1.3%)
- _RNvNtCsfG6yJ9azk97_6blokee8bitboard10to_indices: 359 (0.9%)
- _platform_memset: 238 (0.6%)
- _RNvNtCsfG6yJ9azk97_6blokee6jsmath3exp: 232 (0.5%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position5apply: 197 (0.5%)
- _RNvMNtCsfG6yJ9azk97_6blokee8positionNtB2_8Position4undo: 184 (0.4%)
- _RNvNtCsfG6yJ9azk97_6blokee8ordering13sort_by_score: 146 (0.3%)

In the profile, `semaphore_wait_trap` is the idle main thread of `p4_cost`. Among the worker's samples:

| Component | l6 | pro |
|---|---:|---:|
| `iterate` (selection, backup, RAVE updates inlined) | ≈25% | ≈33% |
| rollout move sampling (`sample_moves`) | ≈32% | ≈28% |
| prior scoring | ≈18% | ≈17% |
| move generation | ≈5% | ≈4% |
| sorting | ≈3% | ≈3% |

**Settings fixed in absolute visits** that act differently at 50× the visits:
- **priorLog exploration**: its bonus scales as √N·ln(N+1)/(n+k), so it is about 26% stronger relative to
  the visits at the pro budget than at l6.
- **RAVE weight 1.0, equivalence 100**: RAVE's share fades with real visits, but the deeper, thinly
  visited nodes keep its bias.
- **Prior pseudo-visits** (3 at the root, 1 at interior nodes): negligible at high counts.
- **Early exit**: stops at about 70–76% of the budget at every budget, so it acts the same.
- **No widening**: full expansion everywhere.
- **Per-search statistics** (rank-reward z-scores, last-good-reply table): cleared each search, independent
  of budget.

**Reading — the most likely reasons the gain flattens:**
1. **The tree stays shallow and broad for its size.** Nine times the iterations add only 1.5 plies of mean
   depth; the chosen move holds 62% of the root visits, and the best move still changes on 15% of positions
   in the second half of the search. Pentobi at level 7 runs 1.7× our iterations per move (82,000 against
   about 48,000 at equal time) and is reported deeper (round 3: 5.6 against 4.6 at level 6). Our
   exploration term growing with ln N is one candidate cause (Stage C tests it).
2. **Each iteration costs a little more in a bigger tree** (−8% iterations per second; the
   selection/backup share rises from ¼ to ⅓). That is a modest loss, not the main one.
3. **No reuse across moves for us, and little for Pentobi in per-seat mode.** Reuse would carry only 1.3%
   of the pro budget, so it is not the gap.

The rest, and probably most, is the quality of each simulation: our rollout policy and Pentobi's. These
measurements cannot separate that.


## Round 6 — ultra tail (measured, partial; `tmp/v53/S2/ultra-L9.jsonl`)

`v5.2-ultra` against three level-9 seats ran with 3 game threads from 16:17 and was stopped at 22:00 as
preregistered in round 7. It completed 45 games, which is **11 complete seeds**. Result: **−4.14 [−8.55,
+0.68]**, first place 13.6% (12.5% with ties split). Role split: own −3.11, next +2.01, opposite +2.05,
previous −0.95. In-match time per move, under load: ours 15.3 s against Pentobi's 18.9 s (moves 5+). The
corrected ultra scale therefore ran about 20% under level 9's time. Seeds 96,700,011–96,700,023 are partly
played (incomplete rotations) and should not be reused.

## Round 7, C — pro-tier screen (measured; `tmp/v54/C/`)

**Clean cost** (22:02–22:20, quiet machine, 60 positions, two rounds):

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 60 | 943.3 | 939.6 | 1.000 | 1.000 | 1.000 |
| X03 | 60 | 947.1 | 941.3 | 1.004 | 1.002 | 1.003 |
| X025 | 60 | 948.3 | 952.0 | 1.005 | 1.013 | 1.009 |
| RW05 | 60 | 947.6 | 950.7 | 1.005 | 1.012 | 1.008 |
| IIV3 | 60 | 977.3 | 977.6 | 1.036 | 1.040 | 1.038 |

IIV3 was re-timed to `iterationScale` 216.227 and not re-checked. Screen: lone `v5.2-pro` seat against three
level-7 seats, per-seat, **100 seeds 99,000,000**, 22:20–01:41. Raw logs `tmp/v54/C/screen/rol-<arm>.jsonl`.

| Arm | Change | Seeds | Advantage vs level 7 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.2-pro.json unchanged (iterationScale 224.487) | 100 | -2.82 [-4.02, -1.64] | 18.0% | — | — |  | 916.3 | 0/400 |
| X03 | priorLog exploration 0.4 -> 0.3 | 100 | -3.22 [-4.37, -2.10] | 16.0% | -0.41 [-1.70, +0.89] | -2.00 [-6.75, +2.50] | 1.003 | 934.7 | 399/400 |
| X025 | priorLog exploration 0.4 -> 0.25 | 100 | -2.27 [-3.50, -1.00] | 19.2% | +0.55 [-0.87, +1.99] | +1.25 [-3.25, +5.75] | 1.009 | 901.1 | 398/400 |
| RW05 | RAVE weight 1.0 -> 0.5 | 100 | -1.64 [-2.90, -0.32] | 21.0% | +1.18 [-0.07, +2.45] | +3.00 [-1.75, +7.75] | 1.008 | 923.2 | 398/400 |
| IIV3-ET | interiorInitVisits 1 -> 3 at equal time: search.iterationScale 224.487 -> 216.227 (224.487 / 1.0382) | 100 | -1.20 [-2.53, +0.13] | 21.8% | +1.62 [+0.19, +3.03] | +3.75 [-0.75, +8.25] |  | 895.7 | 400/400 |

iterationScale played: base 224.487, X03 224.487, X025 224.487, RW05 224.487, IIV3-ET 216.227

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v54/C/screen/rol-base.jsonl` | 100 | -2.11 [-3.01, -1.23] | +2.30 [+1.32, +3.30] | +0.01 [-0.93, +0.97] | -0.20 [-1.08, +0.69] |
| `tmp/v54/C/screen/rol-X03.jsonl` | 100 | -2.42 [-3.28, -1.57] | +3.02 [+2.10, +3.98] | +0.16 [-0.81, +1.16] | -0.76 [-1.81, +0.30] |
| `tmp/v54/C/screen/rol-X025.jsonl` | 100 | -1.70 [-2.62, -0.75] | +1.79 [+0.74, +2.84] | -0.12 [-1.10, +0.84] | +0.03 [-0.90, +0.98] |
| `tmp/v54/C/screen/rol-RW05.jsonl` | 100 | -1.23 [-2.18, -0.24] | +2.76 [+1.77, +3.86] | -0.44 [-1.38, +0.45] | -1.10 [-2.13, -0.09] |
| `tmp/v54/C/screen/rol-IIV3-ET.jsonl` | 100 | -0.90 [-1.90, +0.10] | +2.12 [+1.08, +3.10] | -0.57 [-1.62, +0.46] | -0.65 [-1.70, +0.40] |

**Confirmation** of IIV3-ET (the only clearing arm: +1.62 [+0.19, +3.03]), fresh base, **100 seeds
99,100,000**, 01:41–03:07:

| Arm | Change | Seeds | Advantage vs level 7 [95% CI] | First place | Paired Δ vs base [95% CI] | Paired Δ first place vs base, pp [95% CI] | Clean cost × base | ms/move 3+ in-match | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | engine-rs/configs/v5.2-pro.json unchanged (iterationScale 224.487) | 100 | -1.09 [-2.42, +0.25] | 20.5% | — | — |  | 896.9 | 0/400 |
| IIV3-ET | interiorInitVisits 1 -> 3 at equal time: search.iterationScale 224.487 -> 216.227 (224.487 / 1.0382) | 100 | -0.29 [-1.58, +0.98] | 23.8% | +0.79 [-0.80, +2.39] | +3.25 [-2.25, +9.00] |  | 888.1 | 400/400 |

- IIV3-ET: incomplete -> NOT ACCEPTED
NEW BASE: (none)

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v54/C/confirm/rolc-base.jsonl` | 100 | -0.82 [-1.81, +0.19] | +3.00 [+2.01, +4.05] | -1.10 [-2.09, -0.10] | -1.09 [-2.07, -0.11] |
| `tmp/v54/C/confirm/rolc-IIV3-ET.jsonl` | 100 | -0.22 [-1.18, +0.73] | +3.00 [+1.99, +4.01] | -1.73 [-2.87, -0.51] | -1.05 [-1.96, -0.15] |

**Decision: not accepted.** The confirmation reads +0.79 [−0.80, +2.39], lower bound below 0, so no
`v5.3-cand-pro.json` was saved and the l6-budget check was not run. Note: the read-out line says
"incomplete" because the shared confirmation script expects 400 seeds. By the preregistered rule (lower
bound above 0) the arm fails all the same, on its 100 complete seeds.

**Reading:**
- Lower exploration did not help at pro: 0.3 read −0.41, 0.25 read +0.55. So the ln N growth of the
  exploration term is not what holds us back.
- RAVE weight 0.5 (+1.18 [−0.07, +2.45]) and interior initial visits 3 (+1.62 screen, +0.79 confirmation)
  point the same way: less RAVE bias and more prior weight in a big tree. Neither is confirmed at 100
  seeds, where the interval half-width is about ±1.3.
- The pro base itself read −2.82 and −1.09 on the two blocks, consistent with round 6's −2.02.

## Round 7, D — benchmark fill-ins and the draft read-out (measured; `tmp/v53/S3/bench.md`)

Played 03:07–04:32, per-seat:

| Block | Seeds | Seed block |
|---|---:|---|
| nano vs level 3 | 200 | 97,960,000 |
| nano vs level 4 | 200 | 97,970,000 |
| `v5.2-l6` vs level 5 | 200 | 97,980,000 |
| pro vs level 6 | 100 | 97,995,000 |
| `v5.2-l6` vs level 7 | 100 | 97,990,000 |
| ladder: lone level 6 vs three level 7 | 100 | 97,550,000 |

Raw logs `tmp/v53/S3/*.jsonl`. DRAFT read-out (`engine-rs/scripts/v53_report.py --bench`):

**DRAFT read-out (design to be settled by the supervising session with Paul).**

| Engine | ms/move (own 4+) | Advantage vs anchors played (level: adv [95% CI]) | Break-even level [95% CI] |
|---|---:|---|---:|
| v5.2-nano | 1.9 | L1: +6.30 [+5.78, +6.83]; L2: +2.19 [+1.50, +2.92]; L3: -0.41 [-1.06, +0.23]; L4: -4.64 [-5.32, -4.00] | 2.84 [2.65, 3.04] |
| v5.2-lite | 2.8 | L2: +5.22 [+4.47, +5.96]; L3: +1.61 [+1.11, +2.14]; L4: -2.33 [-3.01, -1.66] | 3.41 [3.31, 3.52] |
| v5.2-base | 13.0 | L4: +3.89 [+3.18, +4.63]; L5: +0.33 [-0.20, +0.85]; L6: -4.89 [-5.70, -4.07] | 5.06 [4.95, 5.15] |
| v5.2-pro | 773.0 | L6: +4.10 [+2.91, +5.31]; L7: -2.02 [-3.14, -0.84] | 6.67 [6.53, 6.83] |
| v5.2-ultra | 15287.7 | L9: -4.14 [-8.55, +0.68] | not bracketed (below all anchors) |
| v5.2-l6 | 77.5 | L5: +5.02 [+4.26, +5.76]; L6: +0.31 [-0.10, +0.74]; L7: -4.28 [-5.44, -3.06] | 6.07 [5.98, 6.16] |
| Pentobi L2 |  | L1: +3.68 [+3.17, +4.24]; L3: -3.73 [-4.24, -3.22] | 1.99 [1.89, 2.09] |
| Pentobi L1 |  | L2: -4.37 [-4.95, -3.81] | not bracketed (below all anchors) |
| Pentobi L3 |  | L2: +3.83 [+3.37, +4.29]; L4: -4.20 [-4.69, -3.70] | 2.95 [2.87, 3.04] |
| Pentobi L4 |  | L3: +5.36 [+4.77, +5.95]; L5: -4.87 [-5.47, -4.28] | 4.05 [3.97, 4.13] |
| Pentobi L5 |  | L4: +5.19 [+4.54, +5.88]; L6: -6.87 [-7.63, -6.06] | 4.86 [4.77, 4.95] |
| Pentobi L6 |  | L5: +7.69 [+6.97, +8.46]; L7: -7.05 [-8.38, -5.81] | 6.04 [5.95, 6.15] |
| Pentobi L7 |  | L6: +8.22 [+7.18, +9.30] | not bracketed (above all anchors) |

**Measured:** the break-even levels (DRAFT method) are:
- `v5.2-nano` **2.84 [2.65, 3.04]** (target 1)
- `v5.2-lite` **3.41 [3.31, 3.52]** (target 3)
- `v5.2-base` **5.06 [4.95, 5.15]** (target 5)
- `v5.2-l6` **6.07 [5.98, 6.16]** (target 6)
- `v5.2-pro` **6.67 [6.53, 6.83]** (target 7)
- `v5.2-ultra`: not bracketed (−4.14 against level 9 on 11 seeds)

The Pentobi ladder reads back its own levels within 0.15 (level 6: 6.04 [5.95, 6.15]). One level is worth
more points the higher the level: +3.7 at 1→2, +8.2 at 6→7.

**Reading:** at equal time our score rises with compute more slowly than Pentobi's. We are about two levels
above Pentobi at its fastest setting, level with it from level 5 to 6, and a third of a level below at 7.


## Round 7, Stage E — IIV3 settled at the pro budget, IIV3 + RAVE 0.5 screened (measured; `tmp/v54/E/`)

Prereg `36fbda0`. Lone seat vs three level-7 seats, per-seat processes, the same **100 seeds 99,300,000** for
each arm, one arm after another (05:40–07:50). Raw logs `tmp/v54/E/games/e-{base,IIV3-ET,COMBO-ET}.jsonl`
(+ `.moves`, `.timing`).

**COMBO cost** (one round in each order, 60 positions, quiet, 05:38–05:40):

| Arm | positions (own moves 3+) | ms/move round 1 | ms/move round 2 | × base round 1 | × base round 2 | × base (mean) |
|---|---:|---:|---:|---:|---:|---:|
| base | 60 | 889.8 | 914.6 | 1.000 | 1.000 | 1.000 |
| COMBO | 60 | 913.4 | 930.7 | 1.027 | 1.018 | 1.022 |

So COMBO-ET ran at `iterationScale` 224.487 / 1.0221 = **219.633**, from the measured round (the
product-of-ratios fallback was not needed).

| Arm | Seeds | Advantage vs three level-7 seats | First place (any) | First place (split) |
|---|---:|---:|---:|---:|
| base | 100 | -0.92 [-2.24, +0.39] | 21.8% | 19.6% |
| IIV3-ET | 100 | -1.46 [-2.75, -0.14] | 17.8% | 15.5% |
| COMBO-ET | 100 | -1.09 [-2.29, +0.10] | 19.2% | 17.4% |

- IIV3-ET − base, 100 seeds: -0.54 [-2.21, +1.07]; first place (any) -4.00 [-8.25, +0.25] pp, (split) -4.17 [-8.42, -0.04] pp -> NOT ACCEPTED (second confirmation rule)
- COMBO-ET − base, 100 seeds: -0.17 [-1.64, +1.32]; first place (any) -2.50 [-6.75, +1.75] pp, (split) -2.25 [-6.38, +1.88] pp -> does not clear (screen only)

- DESCRIPTIVE, not the decision: IIV3-ET − base pooled over 300 seeds (99,000,000 + 99,100,000 + 99,300,000): +0.62 [-0.29, +1.49]; first place (split) +0.64 [-1.97, +3.18] pp

| Log | Seeds | Lone seat | Next | Opposite | Previous |
|---|---:|---:|---:|---:|---:|
| `tmp/v54/E/games/e-base.jsonl` | 100 | -0.69 [-1.68, +0.29] | +2.72 [+1.80, +3.64] | -0.59 [-1.62, +0.37] | -1.44 [-2.35, -0.54] |
| `tmp/v54/E/games/e-IIV3-ET.jsonl` | 100 | -1.09 [-2.06, -0.10] | +2.83 [+1.73, +3.92] | -0.92 [-1.95, +0.08] | -0.82 [-1.97, +0.33] |
| `tmp/v54/E/games/e-COMBO-ET.jsonl` | 100 | -0.82 [-1.72, +0.07] | +2.79 [+1.74, +3.83] | -0.76 [-1.80, +0.26] | -1.21 [-2.28, -0.13] |

**Decisions (preregistered):**
- **IIV3-ET is not accepted.** On these fresh seeds it reads −0.54 [−2.21, +1.07], and first place is down
  4.2 pp [−8.4, −0.04] with ties split.
- Descriptive, not the decision: pooled over its three 100-seed blocks (300 seeds) it reads +0.62
  [−0.29, +1.49].
- **COMBO-ET does not clear** (−0.17 [−1.64, +1.32]).
- No `v5.3-cand-pro.json`; the level-6 check was not run.

**Reading:** IIV3's screen reading (+1.62) shrank to +0.79 and then −0.54. Its pooled +0.6 is
indistinguishable from 0. Raising the prior's pseudo-visits does not close the pro-tier gap.
