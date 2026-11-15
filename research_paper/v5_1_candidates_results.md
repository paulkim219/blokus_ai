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
1 to 1.5 points over a fair per-seat arrangement.** Paired comparisons between our own arms are not biased
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
