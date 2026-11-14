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

STAGE1_PLACEHOLDER

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
