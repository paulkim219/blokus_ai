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
