# High-budget round (2026-11-17/18 CST) — results

Plan of record: `research_paper/v5_high_budget_plan.md` (copied unchanged, commit `2e53ecc`). Branch `v5-high-budget` from `v6-native-engine-e4` at `d5b6771`, worktree `/Users/paulkim/Blokee-hb`. Raw output: `/Users/paulkim/Blokee/tmp/hb/` (untracked). Local commits only.

**Machine.** Round 10 (pid 28488, `tmp/v57/`) uses all 14 cores until about 06:00–06:30. Until it exits this round runs no match and no timing or cost measurement. It runs builds, tests, identity checks, offline log analysis and single-threaded probes under `nice -n 20`. Each is logged with start and end times in `tmp/hb/cpu-log.txt`. Clean timing happens only in the quiet slot after pid 28488 exits (at most 45 minutes, ending with `touch tmp/hb/QUIET_DONE`, at 07:00 at the latest).

**Seeds.** No game is played tonight. Round 10's block 102,000,000–102,000,799 and its reserved blocks (102,160,000; 102,180,000) are not used for selection or analysis. Development positions come from completed earlier games only (rounds 6–9 logs listed per experiment).

---

## §3 Lazy interior child allocation — preregistration (2026-11-17 21:06 CST, commit `95cedaf`; fixed before any identity, memory or speed figure is read)

*Time stamp corrected: the heading first said 21:10; the commit is 21:06:07.*

**Mechanism.** Option `native.candidates.interiorCap.lazy` (bool, absent = false = today's eager layout; engine `engine-rs/src/search.rs`). It takes effect only with an interior cap. An interior node keeps its full prior-sorted `moves` and `priors`. It holds `children`, `child_visits` and the AMAF pairs only for edges [0, d), where d is the largest window `select` has opened at that node. When the window grows, the arrays grow (capacity ×1.5, never past the move count). AMAF credit for an edge at or beyond d goes to a sparse pending list, sorted by edge, as (sum, weight) pairs built from the same additions in the same order. The pair moves into the dense slot unchanged when the window reaches its edge. Interior AMAF updates find a move's edge by binary search in a per-node edge permutation sorted by move id (2 bytes per edge). Eager mode scans every edge instead; both give the same credits. The root stays eager. Refused with `native.net`, whose depth-1 policy re-sorts a root child's moves.

**Why identity should be exact.** Selection reads only edges below the window, and their children, visits and AMAF pairs are the eager values bit for bit. Each placement occurs at most once in a simulation, so each slot gets at most one addition per simulation, with the same weight expression in the same order. Edges beyond the window are never read until the window opens. Update order, transpositions and tie-breaking are untouched.

**Identity gates (all must hold; any failure is reported and lazy is not used):**
1. *Option absent = round-9 binary.* The new build against `tmp/v56/bin`:
   - `s4_identity`, 180 positions (`tmp/d1/x1-l6a.moves.jsonl`) × v5.2-nano, v5.2-lite, v5.2, v5.2-turbo, v5.3-nano, v5.3-lite, v5.3, v5.3-turbo: byte-identical output;
   - `blokee-match` v5.3-turbo vs v5.2-turbo, 2 seeds × 4 rotations from 80,900,000, one thread: identical result lines (moves via scores, plies, winners);
   - `v55_speed` digests at pro (`pro-base`, `pro-W1D-ET`) on the probe positions below: all equal.
2. *Lazy = eager at fixed iterations with the same cap:*
   - `tests/lazy.rs`: 45 searches (3 caps × 3 RAVE settings × 5 positions, about 1,000 iterations): ranked root (move, visits, value bits) and tree shape equal, lazy tree bytes lower;
   - `s4_identity` 180 positions × v5.3-{nano,lite,base,turbo} eager vs `-lazy`: identical lines;
   - `v55_speed` digests at pro (`pro-W1D-ET` vs `pro-W1D-ET-lazy`) and at ultra (`ultra-W1D` vs `ultra-W1D-lazy`): all equal.

**Memory (load-insensitive, run while round 10 plays, one thread, `nice -n 20`).** `v55_speed` on `tmp/d1/x1-l6a.moves.jsonl` (round 8's set: 150 positions, own moves 3+). Pro searches every 3rd position (50). Ultra searches every 30th (5), because a search there takes about 21 s quiet and 8 GB. Reported per arm: tree heap bytes per iteration, the largest tree, and peak RSS from `/usr/bin/time -l`. The arms are `pro-W1D-ET` vs `pro-W1D-ET-lazy`, and `ultra-W1D` (v5.2-ultra plus cap {16, 4}, not re-timed, probe only) vs `ultra-W1D-lazy`.

**Speed (quiet slot only).** `p4_cost`, one thread, pro, 60 positions of `tmp/d1/x1-l6a.moves.jsonl`. Order: an unscored warm-up search by `pro-W1D-ET`, then the two arms, in two rounds with the order reversed (round 9's warm-up procedure). The figure is the mean ms ratio lazy / eager. If time allows: `v55_speed` at ultra on the 5 positions, both arms in turn.

**What the outcome decides (fixed now).** No match is played on it tonight.
- Identity passes and lazy is at most 0.97× eager's clean ms at pro: the saving can buy iterations. A later screen would play `W1D-ET-lazy` with `iterationScale` / cost against the W1D-ET or v5.2-pro control (whichever round 10 leaves as control). That screen is preregistered below, not run.
- Identity passes and the cost lies in 0.97–1.03: lazy plays the same games in the same time. It is a memory option only, usable for ultra benchmark capacity, with no strength claim.
- Identity passes and the cost is above 1.03: memory option only, with the slowdown stated.
- Identity fails: the reason is documented precisely, decision agreement is measured against a 1%-more-iterations noise reference (round 9 probe style), and lazy is not used.

---

## §1 Will a remaining piece still fit after the opponents reply? — development probe preregistration (2026-11-17 21:15 CST, this commit's time; fixed before the probe runs)

**Question (plan §1).** On held-out development positions, do fit counts after sampled opponent replies (c) carry information about stranding and final margin beyond the current search (a) and immediate fit counts (b)? And would they change enough decisions to matter? A match arm is built only if this gate passes.

**Positions** (`engine-rs/scripts/hb_positions.py`, `tmp/hb/s1/positions.jsonl`). 480 positions, at most one per game, drawn from completed pro games against three L7 seats:
- round 9 pro screen, seeds 101,500,000–101,500,299, all three arms (`tmp/v56/pro/screen/rol-{base,W1A-ET,W1D-ET}.moves.jsonl`);
- round 6 pro baseline (`tmp/v53/S2/pro-L7.moves.jsonl`).

The position is the lone Blokee seat's decision at own turn k, with k uniform in 9–16. The draw is stratified 4 lone seats × {win, loss} × 60, where win means the lone score is above the mean of the other three, using `random.Random(20261117)`. **Halves by seed parity:** even seeds train (247 positions), odd seeds test (233). No round-10 seed is used; the script asserts this.

**Probe** (`engine-rs/examples/hb_strand_probe.rs`, one thread, `nice -n 20`, shared CPU):
- **(a) the current search.** `pro-base` (= v5.2-pro, the promotion control) at its full budget (300 × 224.487 iterations, RNG seeded as `p4_cost` seeds it). Its 8 most-visited root moves are the candidates, with their visits.
- **(b) immediate fits.** After the candidate, for each piece left in the mover's hand: the mover's open corners that some legal placement of that piece covers, merged into regions. Open corners within one square of each other (king move) form one region, so orientations through the same corner count once.
- **(c) fits after replies.** The same counts after each of K = 16 sampled reply sequences. The next three seats in turn order each play a move drawn from the fitted interior prior (softmax, temperature 1). A seat with no move passes, and the sequence stops at the mover's next decision. Reply sample k uses the same seed for all 8 candidates.
- **Outcome.** R = 12 forced-move continuations per candidate. All four seats are played by `engine-rs/configs/v5.3-nano.json` at budget 300 to the end of the game. Continuation r uses the same seed for all 8 candidates (common random numbers). Recorded: final scores and the mover's unplayed pieces.
- **Budget, chosen for the shared CPU:** nano continuations (about 109 iterations per move), K = 16, R = 12. If the probe has not finished by 04:30, the analysis uses the positions completed by then; the file order is a random shuffle. The count is reported.

**Variables per candidate** (i over the mover's pieces in hand after the candidate, s_i = size):
- Y = mean over the R continuations of (mover's final score − mean of the other three);
- A = ln(visits + 1);
- B0 = Σ s_i·[b-regions_i = 0]; B1 = Σ s_i·[b-regions_i = 1];
- C0 = Σ s_i·mean_k [c-regions_i,k = 0]; CL = Σ s_i·mean_k [b-regions_i ≥ 1 and c-regions_i,k = 0] (the replies destroyed the last fit).

Every variable is centred within its position (minus the mean over that position's candidates). The plan's size and completion-bonus sensitivity enters through the size weights. Per piece, the stranding target is the fraction of continuations that end with the piece unplayed.

**Gate (all three must hold; fitted on train, judged on test):**
- **G1-margin:** OLS of centred Y on A, B0, B1 (M_ab) versus A, B0, B1, C0, CL (M_abc). Measure: test-half per-position Δ squared error (M_ab − M_abc, summed over the position's candidates). Pass if the 95% bootstrap interval of the mean (2,000 resamples of test positions) has a lower bound > 0.
- **G1-strand:** per (candidate, piece in hand) rows, linear-probability OLS of the stranded fraction on size, one-hot b-regions (0, 1, 2, 3+) and own turn (M_b), versus M_b plus the mean c-zero indicator and the mean lost-last-fit indicator (M_bc). Measure: test-half per-position Δ Brier. Pass if the bootstrap lower bound > 0.
- **G2-decisions:** on the test half, the candidate with the highest prediction under M_abc versus under M_ab.
  - Flip rate f, the share of positions where they differ, must be ≥ 5%.
  - Gain per test position: Y(M_abc choice) − Y(M_ab choice), 0 where they agree. Its mean's bootstrap 95% lower bound must be > 0.

Descriptive only: held-out R² of M_a, M_ab and M_abc; the same fits with the halves swapped; flips and gain against the search's own top move (most visits); stranding by piece shape.

**What follows (fixed now).** If all three hold, the match arm is built and its screen preregistered here (300 seeds vs L7 from 103,000,000, not played tonight). Otherwise the result is written up as not passing the gate, and no arm is built.

---

## §2 Position-dependent interior width — probe preregistration (2026-11-17 21:15 CST, this commit's time; fixed before the probe runs)

**Probe** (`engine-rs/examples/hb_prior_probe.rs`, one thread, `nice -n 20`). The input is every Pentobi L7 decision (passes skipped) in the same four development files as §1 (round 9 pro screen, three arms; round 6 pro baseline). At each decision the fitted interior prior is built exactly as an `interiorFull` interior node builds it, using `pro-base`'s model: every legal move, the model's logits with the last three placements, sorted, then softmax at temperature 1. Recorded:
- the effective number of moves n_eff = 1/Σp²;
- the rank of L7's actual move (1 = top) and its prior;
- the legal-move count;
- *board contact*, meaning an opponent piece lies in the mover's edge or corner halo;
- *move contact*, meaning the actual move's halo touches an opponent piece;
- the mover's open corners.

**Main set:** decisions where the mover has placed at least 3 pieces. **Cramped:** legal-move count in the bottom quartile of its own-move band (3–5, 6–9, 10–13, 14+ pieces placed), with the quartiles taken over the main set. **Halves:** even seeds train, odd seeds test.

**Reported:**
- n_eff quantiles by band;
- rank quantiles;
- miss rate (rank > window) for W1A floor(4 + √N) and W1D floor(16 + 4√N) at N ∈ {1, 4, 16, 64, 256, 1024}, split by board contact, move contact and cramped;
- W1D's miss rate at N = 16 and 64 by n_eff tercile (does the miss rate rise when the prior is diffuse?).

**Two-width bins, fixed rule.**
- *Split:* at the train-half median of n_eff (main set).
- *Windows:* diffuse nodes (n_eff above the median) get floor(f_d·(16 + 4√N)); concentrated nodes get floor((2 − f_d)·(16 + 4√N)). Because the split is a median, the mean eligible width stays about W1D's at each N.
- *Choice of f_d:* from {1.25, 1.5, 1.75}, the one with the lowest train-half miss rate averaged over N ∈ {16, 64, 256}.
- *Held-out read:* test-half miss rate, adaptive minus W1D, averaged over the same N. 95% bootstrap interval by seed (2,000 resamples).
- *Mean width:* the realised mean window on the test half at each N, adaptive versus W1D.
- *Reading:* the probe is "supportive" if the held-out difference has an upper bound < 0. Either way the screen below is preregistered and not run. The probe measures only the miss side; the depth cost of wider windows is what a match measures.

---

# Results

## §3 Lazy interior allocation — identity and memory (measured; `tmp/hb/identity/`, binary `tmp/hb/bin` = `95cedaf`)

All runs are one thread at `nice -n 20` while round 10 played. That does not affect the identity or memory figures. The ms figures below are not timing results.

**Identity: every gate passes, exactly.**

| Gate | Check | Result |
|---|---|---|
| 1 option absent = round-9 binary `tmp/v56/bin` | `s4_identity` 180 positions × 8 configs (v5.2/v5.3 nano, lite, base, turbo), 1,440 searches | byte-identical |
| | `blokee-match` v5.3-turbo vs v5.2-turbo, 80,900,000–80,900,001 × 4 rotations, one thread | 8/8 games: same scores, winners and search counts; only `challengerSeconds` differs |
| | `v55_speed` pro, 50 positions: `pro-base` and `pro-W1D-ET` | 50/50 and 50/50 digests equal (ranked root moves, visits, value bits), same iterations |
| 2 lazy = eager, same cap, fixed iterations | `tests/lazy.rs`: 3 caps × 3 RAVE settings × 5 positions, ~1,000 iterations | 45/45 equal (ranked root and tree shape); lazy tree smaller each time; 611 pending AMAF pairs moved into dense slots, so the pending path ran |
| | `s4_identity` 180 positions, v5.3-{nano,lite,base,turbo} eager vs `-lazy` (W1C/W1A caps) | byte-identical |
| | `blokee-match` with `v5.3-turbo-lazy` as challenger | 8/8 games identical to eager |
| | `v55_speed` pro `pro-W1D-ET` vs `-lazy`, 50 positions (mean 49,820 iterations) | 50/50 digests equal |
| | `v55_speed` ultra `ultra-W1D` vs `-lazy`, 5 positions (mean 690,547 iterations) | 5/5 digests equal |

No "decisions differ" measurement is needed: the two layouts give the same search, bit for bit.

**Re-check on the final engine** (`47647a0`, which adds the §2 `adaptive` option; binary `tmp/hb/bin2`, output `tmp/hb/identity2/`, 21:36–21:48):
- `s4_identity`: old = new = lazy, all 1,440 lines byte-identical;
- `blokee-match`: the same 8 games, only `challengerSeconds` differs;
- `v55_speed` pro digests: old = new 50/50 (`pro-base`), 50/50 (`pro-W1D-ET`); eager = lazy 50/50;
- `cargo test --release`: 36 tests pass. These include `adaptive_width_identity_points`: adaptive with both factors 1 = plain cap on 5 searches, and adaptive lazy = adaptive eager.
- Descriptive, §2 arm on the same 50 pro positions: `pro-W1D-AD` has the same mean tree depth as W1D-ET (5.83 vs 5.83). Its best move matches W1D-ET's in 38/50 positions. Its memory is 4,652 bytes per iteration, eager layout.

**Memory** (`tree_memory` heap bytes; peak RSS from `/usr/bin/time -l`; same positions and iterations for both layouts):

| Tier / config | Positions | Tree bytes per iteration, eager → lazy | Largest tree, eager → lazy | Peak RSS, eager → lazy |
|---|---:|---:|---:|---:|
| pro, `pro-W1D-ET` | 50 | 4,613 → 2,773 (−40%) | 0.59 → 0.30 GB (−50%) | 0.90 → 0.52 GB (−42%) |
| ultra, v5.2-ultra + cap {16, 4} | 5 | 4,859 → 2,619 (−46%) | 5.36 → 2.69 GB (−50%) | 5.39 → 2.91 GB (−46%) |

For scale, v5.2-ultra without a cap had a largest tree of 8.35 GB and peak RSS of 10.8 GB on round 8's 15 positions. The cap alone does not change memory per iteration (eager 4.6–4.9 KB). The lazy layout halves it.

**Speed (clean, quiet slot 05:24:48–05:43:15 CST 2026-11-18; `tmp/hb/quiet/`).** Round 10's chain exited at 05:20:13, and the slot opened at 1-minute load 2.94 with no Pentobi or match process left. The Docker VM and two macOS storage processes used about 1.5 cores throughout, as in round 8. Method: `p4_cost`, one thread, binary `tmp/hb/bin2`. Rounds 1 and 2 have reversed order. Pro and turbo have an unscored eager warm-up search per position first (round 9's procedure); ultra has none. Read-out: `engine-rs/scripts/hb_cost_report.py`.

| Tier | Positions | Eager ms | Lazy ms | Lazy / eager, round 1 · round 2 | Mean | Same iterations, same move |
|---|---:|---:|---:|---:|---:|---|
| pro (`pro-W1D-ET`) | 60 | 895.6 · 904.9 | 933.7 · 940.9 | 1.0425 · 1.0397 | **1.041** | yes, 60/60 |
| turbo (`v5.3-turbo`, W1A cap) | 150 | 93.0 · 92.6 | 97.7 · 96.5 | 1.0499 · 1.0425 | **1.046** | yes, 150/150 |
| ultra (`ultra-W1D`) | 5 | 18,385 · 17,814 | 18,728 · 18,456 | 1.0187 · 1.0361 | **1.027** | yes, 5/5 |

**Decision (preregistered rule):** the pro cost is 1.041, above 1.03. **Lazy is a memory option only. It is about 4% slower at pro and turbo, and about 3% at ultra (5 positions, so a noisy figure). There is no screen P3,** and block 103,200,000 stays unused. The option stays off by default.

**Reading (mine):**
- The extra time is probably in the AMAF update. Each credited move now costs a binary search with an indirect key (`moves[by_move[k]]`) instead of a stamp check in a linear scan. Each credit to an edge outside the window costs a sorted `Vec::insert`. The memory saved does not buy speed back, because `select` already scans only the window.
- A cheaper layout would probably remove the gap: (move, edge) pairs stored together for the search, and pending pairs in an unsorted buffer merged when the window opens. That was not tried tonight because it would need clean timing again.
- At ultra the case is capacity, not speed. Lazy halves the tree. Round 6 found that memory limits ultra to about 3 concurrent games, so lazy could roughly double ultra benchmark throughput, at a cost of about 3% of time per move. That cost would have to be matched in calibration (`iterationScale` / 1.03).

## §1 Fits after replies — development probe (measured; `tmp/hb/s1/`)

`hb_strand_probe` ran 21:13–21:33, one thread at nice 20, on all 480 positions with K = 16 reply samples and R = 12 nano continuations per candidate. Four positions have fewer than two candidates (a forced or single-move root). They hold no decision and are left out, which leaves 476: train 244, test 232, 3,724 candidates. Read-out: `engine-rs/scripts/hb_s1_report.py` → `tmp/hb/s1/report.md`.

| Gate (fit on train, judged on test) | Measure | Result | Pass? |
|---|---|---:|---|
| G1-margin | per-position Δ squared error, M_ab − M_abc | +0.46 [+0.10, +0.98] | yes |
| G1-strand | per-position Δ Brier, M_b − M_bc | +0.357 [+0.228, +0.504] | yes |
| G2-decisions | flip rate M_abc vs M_ab (needs ≥ 5%) | **2.6%** | **no** |
| | mean gain per test position | +0.08 [+0.02, +0.16] points | (would pass) |

**Gate: not passed (G2 flip rate).** Per the prereg, no match arm is built and no screen is preregistered. Seed block 103,000,000 stays unused.

Descriptive:
- Held-out R² of within-position margin: M_a (search visits only) 0.099, M_ab 0.092, M_abc 0.101. Immediate counts (b) add nothing over the search. (c) adds about 0.01.
- **Halves swapped:** G1-margin +0.04 [−0.42, +0.55] (not significant); G1-strand +0.21 [+0.13, +0.29]; flip rate 5.7%; gain +0.05 [−0.05, +0.16]. The margin signal of (c) is not robust across halves. The stranding signal is.
- Coefficients (main fit): C0 −0.066 and CL −0.024 points per exposed square, with B0 falling from −0.095 to −0.043 once (c) is in. So (c) mostly re-expresses (b) with a better horizon.
- Against the search's own top move, M_abc picks another candidate in 6.0% of test positions, gain +0.10 [+0.03, +0.18] points per position. Swapped: 7.4%, +0.04 [−0.05, +0.13].
- In the continuations, the pieces most often left unplayed when still in hand at own turns 9–16 are I4 (54%), O4 (50%), I3 (45%), I5 (42%), U5 (41%) and V5 (39%). After the replies, the "no fit" rate is far below the end-of-game stranding rate (I3 7% vs 45%). Most stranding happens later than the next three replies.

**Reading (mine):** the reply-aware count predicts stranding. Its information about the margin is small (ΔR² ≈ 0.01) and unstable across halves. Blended with the search, it would change about 3–6% of decisions, each worth a fraction of a point in nano continuations. That is below the bar the plan set for revisiting a feature family that has failed twice. The late-square deficit is real, but a three-reply horizon sees little of it: most stranding happens after that. If this line is revisited, the information would have to come from deeper continuations (more like a rollout feature), not from a fit count after one reply cycle.

## §2 Position-dependent width — probe (measured; `tmp/hb/s2/`)

`hb_prior_probe` ran 21:30, one thread, 7 s. It covered all 218,633 Pentobi L7 decisions in the four development files; the main set (own ≥ 3) is 182,633 decisions over 400 seeds. Read-out: `engine-rs/scripts/hb_s2_report.py` → `tmp/hb/s2/report.md`.

**n_eff and the rank of L7's move** (main set):

| Pieces placed | Decisions | Legal moves (median) | n_eff p10 / p50 / p90 | Rank of L7's move p50 / p90 / p95 | Rank 1 |
|---|---:|---:|---:|---:|---:|
| 3–5 | 36,000 | 533 | 7.8 / 18.5 / 34.4 | 9 / 72 / 115 | 14.0% |
| 6–9 | 47,989 | 283 | 7.0 / 22.0 / 50.8 | 11 / 74 / 110 | 12.1% |
| 10–13 | 47,520 | 71 | 3.5 / 11.6 / 33.6 | 6 / 32 / 48 | 18.7% |
| 14+ | 51,124 | 12 | 1.2 / 3.7 / 9.2 | 2 / 8 / 12 | 48.9% |

**Miss rate** (L7's move outside the window at N visits):

| Subset | Decisions | W1A N=16 (8) | W1A N=64 (12) | W1D N=1 (20) | W1D N=16 (32) | W1D N=64 (48) | W1D N=256 (80) |
|---|---:|---:|---:|---:|---:|---:|---:|
| all | 182,633 | 0.382 | 0.302 | 0.210 | 0.138 | 0.089 | 0.044 |
| move touches an opponent | 155,487 | 0.322 | 0.242 | 0.154 | 0.090 | 0.052 | 0.021 |
| move touches no opponent | 27,146 | 0.722 | 0.644 | 0.529 | 0.409 | 0.303 | 0.171 |
| cramped (bottom quartile of legal moves) | 47,171 | 0.266 | 0.201 | 0.129 | 0.079 | 0.047 | 0.019 |
| not cramped | 135,462 | 0.422 | 0.337 | 0.238 | 0.158 | 0.103 | 0.052 |
| n_eff low tercile (≤ 6.8) | 60,878 | 0.135 | 0.086 | — | 0.022 | 0.013 | — |
| n_eff middle tercile | 60,877 | 0.403 | 0.305 | — | 0.123 | 0.074 | — |
| n_eff high tercile (> 18.5) | 60,878 | 0.607 | 0.515 | — | 0.268 | 0.180 | — |

"Board contact", meaning any opponent piece in the mover's halo, holds in 97.5% of main-set decisions, so it does not separate positions. The useful split is *move contact*. L7's quiet, non-contact moves fall outside the window 2–8× as often as its contact moves; the ratio grows with the window.

**Two-width bins (preregistered rule).** Split at the train-half median n_eff = 11.7338. Train miss rate, mean over N = 16, 64, 256: W1D 0.0893; f_d = 1.25: 0.0779; 1.5: 0.0784; 1.75: 0.1071. **Chosen: f_d = 1.25.** Diffuse nodes get floor(1.25·(16 + 4√N)) and concentrated nodes floor(0.75·(16 + 4√N)).
- **Held-out** (test half, 91,168 decisions, 200 seeds): miss rate 0.0908 → 0.0794, difference **−0.0114 [−0.0120, −0.0108]**. **Supportive.**
- Mean window on the test half equals W1D's within 0.3 at every N (e.g. 31.9 vs 32 at N = 16).
- The gain is at diffuse nodes. In cramped positions the narrower window costs +0.001 to +0.003 at N = 1–4, and saves −0.002 to −0.005 from N = 16 on.

**Reading (mine):**
- The prior's own concentration is a strong signal of where W1D's window is too narrow: at N = 16, misses run 2% at concentrated nodes against 27% at diffuse nodes.
- Shifting width from concentrated to diffuse nodes at equal mean width cuts misses by about an eighth.
- n_eff tracks the legal-move count closely (median legal 15 vs 334 between the extreme terciles). The rule is largely "wider where there are more moves".
- The probe cannot see the depth cost: a wider window at diffuse nodes means shallower lines there. Only the match decides.
- Game positions stand in for tree nodes, and L7's move stands in for "the necessary reply".
- **Tree diagnostics for the arm** (descriptive; one thread, nice 20; `tmp/hb/s2/shape/shape.csv`, `tmp/hb/identity2/`):
  - On 50 pro positions W1D-AD changes the best move in 12/50 positions vs W1D-ET. The noise reference, W1D-ET with 1% more iterations, changes it in 0/50.
  - The tree is otherwise the same: `p910_probe shape` on 50 positions gives mean depth 5.98 vs 5.98. The share of simulations reaching the mover's next turn (depth 4) is 0.871 vs 0.872, and depth 8 is 0.227 vs 0.226.
  - So the arm changes which replies are searched, not how deep.
- The miss rate for non-contact moves stays high under every window. That is a prior-model issue (quiet L7 moves score low), not a width issue.

---

# Preregistered next screens (not run tonight)

## Screen P2: adaptive interior width at pro (preregistration 2026-11-17 21:45 CST, this commit's time; fixed before its cost is measured or any game is played)

*Resolved 2026-11-18 05:45 (facts that the rule below branches on; no rule change):*
- Round 10 accepted W1D-ET. `tmp/v57/pro/confirm.md` reads `NEW BASE: W1D-ET`, with paired +1.00 [+0.46, +1.55] and first place +3.78 pp [+2.06, +5.59] on 800 seeds. **So the control is W1D-ET, and P2 has two arms.**
- The chain's log printed "R10 BENCH not run (nothing accepted)", which contradicts its confirm file. That is for round 10 to sort out.
- **Clean cost of W1D-AD vs W1D-ET:** 0.9733 and 0.9694 in the two rounds, mean **0.971**. That is inside 0.97–1.03, so W1D-AD plays at `iterationScale` 239.172 (`tmp/hb/quiet/ad-r*.csv`).
  - The ratio includes early exits: W1D-AD averages 49,604 iterations per search against 51,662.
  - The same 60 positions give a different best move than W1D-ET in 25/60.

- **Candidate `W1D-AD`** = `tmp/hb/configs/pro-W1D-AD.json`. That is W1D-ET with `interiorCap.adaptive` {split 11.7338, diffuse 1.25, concentrated 0.75}, taken from the §2 rule above. Engine `47647a0` or later; the option-absent identity is re-checked on that build (`tmp/hb/identity2/`).
- **Control:**
  - If round 10 accepted W1D-ET: W1D-ET is the control, and the screen has two arms.
  - If not: v5.2-pro stays the promotion control and W1D-ET is played as a diagnostic third arm. That is the plan's rule.
- **Equal time:**
  - Clean cost of W1D-AD vs W1D-ET comes from `p4_cost`: one thread, 60 positions of `tmp/d1/x1-l6a.moves.jsonl`, an unscored W1D-ET warm-up search, two rounds in reverse order. It runs tonight's quiet slot if time allows (`tmp/hb/quiet/ad-r*.csv`), else before the screen.
  - If the ratio is outside 0.97–1.03, W1D-AD plays with `iterationScale` 239.172 / ratio (`W1D-AD-ET`). Otherwise it plays at 239.172.
  - If v5.2-pro is the control, W1D-ET keeps its round-8 timing (cost 0.9386).
- **Match:** as rounds 9 and 10. `blokee-pentobi --mode one-blokee --gtp-processes per-seat --level 7 --budget 300`, book on, Pentobi 31.0, 12 game threads, four rotations per seed. **300 fresh seeds 103,100,000–103,100,299**, in three 100-seed chunks with the arm order rotating per chunk. Resumable chunks with `.done` markers, merged by explicit file names.
- **Rule (the standard):** cleared if the paired-by-seed 95% bootstrap Δ advantage (candidate − control) has a lower bound > 0 *and* the upper bound of the paired first-place Δ is ≥ 0, at equal clean time.
  - A cleared screen goes to a confirmation on 800 fresh seeds 103,300,000–103,300,799, under its own preregistration.
  - Descriptive only: mean tree depth and the share of simulations that reach the mover's next turn (`v55_speed`/`tree_shape`), and W1D-AD vs W1D-ET same-best on the probe positions.
- **Cost estimate:** round 9's pro block took 6.2 h for 3 arms × 300 seeds, about 2.1 h per arm. So about **4.2 Mac hours** with two arms, or **6.2 h** with three.

*Setup as run (recorded 2026-11-18 13:38 CST, commit `52f5d2b`, before the first P2 game; no rule changed. Time stamp corrected: the line first said 13:45; the commit is 13:38:05 and the chain started 13:38:13):*
- **Directory** `tmp/hb/p2/`. `configs/base.json` = byte copy of `tmp/v57/pro/configs/W1D-ET.json` (SHA-256 `81b25794…7a9`). `cmp` shows it is byte-identical to `v6-native-engine-e4:engine-rs/configs/v5.3-pro.json`, so **the control is `v5.3-pro`**. `configs/W1D-AD.json` = byte copy of `tmp/hb/configs/pro-W1D-AD.json` (`4f6e6d03…5a6a2`). By `jq -S` diff it differs from the control only by `interiorCap.adaptive` {split 11.7338, diffuse 1.25, concentrated 0.75}; both play `iterationScale` 239.172 (cost 0.971 is inside the band).
- `PLAYED` = `W1D-AD`; `COSTS` = {W1D-AD: 0.971}; `manifest.json` states both arms.
- **Binary** `tmp/hb/bin2` (engine `47647a0`; `blokee-pentobi` SHA-256 `02fa5c14…c5c1`, as in its `PROVENANCE.txt`). `engine-rs/src` and `engine-rs/examples` are unchanged from `47647a0` to `282d52d`.
- **Driver** `engine-rs/scripts/hb-p2-chain.sh` as committed, run from this worktree under `caffeinate -i -s -m -w <pid>`, `BIN=tmp/hb/bin2`, 12 game threads. Chunk k (0–2) = 100 seeds from 103,100,000 + 100k; arm order base, W1D-AD in chunk 0, then rotated.
- **Machine at start:** on AC (100%), no other match or probe running. The Docker VM and macOS storage processes use about 1.5 cores, as in earlier rounds. Nothing else CPU-heavy runs until P2 ends; round 11's preregistration is written meanwhile (text only).
- **Read-out:** `screen.md` from the driver (`v51b_report.py --roll-screen`). The rule is applied by hand from its table: paired lower bound > 0 and first-place upper bound ≥ 0.
- **Noted after launch:** the chain was started from a zsh background job, so it and its Pentobi children run at nice 5 (zsh `BG_NICE`). Both arms run so, and nothing else competes beyond the usual ~1.5 background cores, so pairing and equal time are unaffected. The ultra runs below are launched through bash at nice 0.

## Screen P2 — results (measured; `tmp/hb/p2/screen.md`; played 2026-11-18 13:38:13–17:58:14 CST)

All six chunk-arms are complete: 1,200 games per arm, all 300 seeds 103,100,000–103,100,299 paired. W1D-AD's games differ from the control's in 1,197 of 1,200. The Mac stayed on AC throughout; no sleep, pause or replay.

| Arm | Seeds | Advantage vs L7 [95% CI] | First place (any) | Paired Δ vs control [95% CI] | Paired Δ first place, pp [95% CI] | ms/move 3+ in-match |
|---|---:|---:|---:|---:|---:|---:|
| control `v5.3-pro` (W1D-ET, 239.172) | 300 | −1.22 [−1.95, −0.44] | 21.7% | — | — | 1137.5 |
| W1D-AD (adaptive width, 239.172) | 300 | −1.36 [−2.03, −0.69] | 19.7% | **−0.14 [−0.96, +0.66]** | −2.00 [−4.92, +0.92] | 1102.0 |

**Decision (preregistered rule): W1D-AD does not clear.** The paired lower bound is −0.96, not above 0. No confirmation is preregistered; block 103,300,000 stays unused. **This is a null:** the interval allows anything from about −1 to +0.7 points.

Descriptive:
- Per chunk, paired Δ advantage: −0.71 / +0.29 / −0.00; first place −1.50 / −1.00 / −3.50 pp. No chunk is clearly positive.
- First place with ties split: 18.6% → 17.0%.
- In-match time W1D-AD / control = 1102.0 / 1137.5 = 0.969, the same direction as its clean cost (0.971). The arm was, if anything, slightly under time.
- Score relative to the game mean by turn-order position (lone / next / opposite / previous): control −0.91 / +2.73 / −0.56 / −1.25; W1D-AD −1.02 / +2.73 / −0.99 / −0.72.
- The control's −1.22 here is lower than its round-10 −0.66 on other seeds; both intervals overlap.
- The P2 chain ran at nice 5 (zsh background job, see the setup note); both arms alike.

**Reading (mine):** the §2 probe found that shifting window width toward diffuse nodes cuts L7-move misses by about an eighth at equal mean width, and the tree diagnostics showed the arm changes which replies are searched (best move differs in 12/50 positions) without changing depth. In games, that did not buy strength at pro: the point estimate is slightly negative and first place leans down. Either L7's move is a poor proxy for the reply the search needs, or the narrower window at concentrated nodes costs as much as the wider diffuse window gains. I would not pursue adaptive width further at pro without a different signal than prior concentration.

## Screen P1: reply-aware fit feature

Not preregistered: the §1 gate did not pass. Block 103,000,000 stays unused.

## §3 lazy allocation: what the speed result will decide (rule fixed in the §3 prereg)

The read is lazy/eager clean ms at pro, from the quiet slot.
- **At most 0.97:** screen **P3**. `W1D-ET-lazy-ET` (W1D-ET + lazy, `iterationScale` 239.172 / ratio) against the round-10 control. Same match setup as P2, **300 fresh seeds 103,200,000–103,200,299**, standard rule. About 4.2 Mac hours.
- **Otherwise:** no screen. Lazy is a memory option that plays the same games.
- **Separately (proposal, not preregistered):** the round-8 notes give about 4 h per 24 L9 seeds per arm with three simultaneous games. Round 6 found that memory limits ultra to about 3 concurrent games on this machine (peak about 8–11 GB per search). Lazy halves ultra's tree and peak RSS on the probe positions. With per-seat Pentobi a game keeps about one core busy, so on 48 GB about twice as many ultra games could run at once. Whether that holds at matched throughput needs a short pilot.

---

# Round 11 — ultra: measure first (preregistration 2026-11-18 CST, this commit's time; fixed before any round-11 probe, cost run or game)

**Read so far:** this file; rounds 6–10 of `v6-native-engine-e4:research_paper/v5_1_candidates_results.md`; `docs/BENCHMARK.md` and `docs/V5_TRACKER.md` on that branch. No game on seeds 104,000,000+ exists (`grep` of `research_paper/`, `docs/`, `engine-rs/scripts/`; `tmp/v58/` is new). Round 11 starts only after screen P2's chain has exited. Raw output: `tmp/v58/`.

**What is known about ultra.** `v5.2-ultra` (`engine-rs/configs/v5.2-ultra.json`, `iterationScale` 3948.432, byte-identical to the e4 branch) scored −4.14 [−8.55, +0.68] vs three L9 seats on 11 seeds, at about 15.3 s/move against Pentobi's 18.9 s/move under 3-game load. L8 has never been played, so ultra has no benchmark score. The interior cap has never been tried at ultra. The best cap window has widened with budget: W1C (2, 0.5) at nano and lite, W1A (4, 1) at base and turbo, W1D (16, 4) at pro.

**Purpose.** Measure: tree shape, clean cost, memory, safe concurrency, and the time and variance of ultra games vs L8. **No acceptance decision is taken in this round.** It stops after the pilot; Paul chooses the screen's sample size from the projections.

**Binary:** `tmp/hb/bin2` (engine `47647a0`), the binary P2 runs. No engine change.

## Arms

Each cap arm is `v5.2-ultra` plus `native.candidates.interiorCap` {init, growth, exponent 0.5, **lazy true**}. Configs are written by a script into `tmp/v58/configs/`; each is checked by `jq -S` diff against `v5.2-ultra.json` to differ only by that block (and, for -ET or the noise reference, `iterationScale`).

| Name | Change |
|---|---|
| `U` | `v5.2-ultra` unchanged (control) |
| `U-1pct` | `iterationScale` 3948.432 × 1.01 = 3987.916 (noise reference, probe only) |
| `U16-4` | cap (16, 4) = W1D, pro's accepted shape |
| `U16-8` | cap (16, 8) |
| `U32-8` | cap (32, 8) |
| `U64-16` | cap (64, 16) |

**Deviation from the brief, fixed now:** the brief asks for `lazy: true` in every arm, the control included. `lazy` is a sub-option of `interiorCap` (`config.rs`), and `v5.2-ultra` has no cap, so the control cannot be lazy. A non-binding cap would not help: a window that covers every move opens every edge at once, so nothing is saved, and the capped path also switches off `fast_select`. **The control therefore keeps its eager, uncapped memory** (round 8: largest tree 8.35 GB, peak RSS 10.8 GB), and that, not the cap arm, sets the pilot's concurrency limit for the control. The cap arms are lazy. Lazy plays bit-identically to eager with the same cap (§3), so it changes no game; its extra time (about 2.7% at ultra, §3) is inside each cap arm's measured clean cost, so it is matched by the -ET rule below. Lazy in a future ultra config would shift that tier's time match to L9 by its cost; `v5.2-ultra` itself is unchanged.

## Step A — no-game probe (tree shape)

- `v55_speed`, one thread per process, budget 300, positions `tmp/d1/x1-l6a.moves.jsonl` (150 positions, every 5th = **30 positions**; round 8's 15 ultra positions are every 10th and so a subset).
- All six arms, run as parallel single-threaded processes (results are deterministic: same RNG seed per position, fixed budget; ms from this step is not used). Peak RSS of each process from `/usr/bin/time -l`.
- Reported per arm: mean depth, mean max depth, same best move as `U` (of 30), mean iterations, tree bytes per iteration, largest tree, peak RSS.

**Shape chosen for the pilot (fixed rule).** Among the four cap arms:
1. *Binding:* an arm counts only if its same-best count is at least 3 positions below `U-1pct`'s (otherwise the cap does not change the search beyond noise).
2. *Memory:* peak RSS ≤ 6 GB (lazy).
3. *Choice:* the arm whose mean-depth gain over `U` is closest to **+0.39 plies**, W1D's gain over v5.2 at pro on round 8's 50-position probe (5.39 → 5.78). That is: the ultra shape that changes the tree about as much as pro's accepted shape changed pro's. Gains within 0.05 of each other count as a tie, broken toward the wider arm (larger init, then larger growth), following the widening trend.
4. If no arm passes 1–2, the pilot is played with `U16-4` and that is reported.

This rule is a heuristic extrapolation, not strength evidence. The probe cannot measure strength; only games can.

## Step B — clean cost (quiet machine)

- Only after Step A's processes have exited, with no match, probe or build running, and 1-minute load < 3. Logged in `tmp/v58/cpu-log.txt`.
- `p4_cost`, one thread, **30 positions** of `tmp/d1/x1-l6a.moves.jsonl`, round 9's warm-up procedure: round 1 = `U` (unscored warm-up), `U`, chosen arm; round 2 = `U` (warm-up), chosen arm, `U`. Read-out `hb_cost_report.py` (ratio of mean ms, mean of the two rounds).
- **If the ratio is outside 0.97–1.03,** the arm plays re-timed: `iterationScale` 3948.432 / ratio (name suffix `-ET`, not re-checked, as rounds 8–10). Otherwise it plays at 3948.432.

## Step C — memory and concurrency

- **Baseline B:** after P2 exits and with no game running, B = wired + anonymous + compressor-occupied memory from `vm_stat` (the memory the rest of the machine holds: the Docker VM, apps).
- **Pentobi:** one unscored game per level, `blokee-pentobi --mode pentobi-ladder --lone-level 1 --level 8` (then `--level 9`), 1 seed, `--rotations 1`, seed **104,900,000** (memory measurement only, never scored), RSS of each `pentobi-gtp` sampled every 5 s with `ps`. The L9 game is stopped after 8 minutes if not finished. P8, P9 = largest per-process RSS seen.
- **Blokee per game:** R_arm = the arm's peak RSS in Step A (an engine keeps its tree capacity across a game's searches, so a game's peak is about its largest search).
- **Rule:** C_arm = min(12, floor((48 − 8 − B) / (R_arm + 3·P8))) games at once (48 GB machine, at least 8 GB left free; 12 = the CPU limit used in every round, ~1 core per game). Each arm is played with its own C_arm. During the pilot, free memory, compressor and swap are logged every 60 s (`tmp/v58/pilot/mem.log`).
- Per-arm concurrency means in-match ms/move are measured under different loads; they are descriptive. The equal-time standard is the clean cost (Step B).

## Step D — pilot vs three L8 seats

- **Arms:** `U` and the arm chosen in Step A (re-timed if Step B says so).
- **Match:** `blokee-pentobi --mode one-blokee --gtp-processes per-seat --level 8 --budget 300`, book on, Pentobi 31.0, four rotations per seed. **12 seeds, 104,000,000–104,000,011**, in two 6-seed chunks (104,000,000 and 104,000,006); chunk 0 plays `U` then the cap arm, chunk 1 the reverse. Resumable chunk-arms with `.done` markers (24 result lines each), merged by explicit file names. Driver `engine-rs/scripts/v58-pilot.sh`, under `caffeinate -i -s -m -w <pid>`, launched through bash (nice 0).
- **Reported (descriptive only; no acceptance decision):**
  - in-match ms/move (own moves 5+ and 3+) for Blokee and Pentobi in each arm, and the Blokee / Pentobi ratio;
  - each arm's lone-seat advantage vs L8 with its 95% seed-bootstrap interval, and first place;
  - the paired Δ (cap − `U`) with its interval, and the **per-seed SD of the paired Δ**;
  - wall time per game and games per hour per arm at its concurrency;
  - **projected Mac hours** for a two-arm screen of 50 / 100 / 200 / 400 / 800 paired seeds vs L8; for an L9 block (scaled by the measured Pentobi time ratio L9/L8 and L9 memory); for **an L7 block of 50 seeds (fresh block 104,600,000)** for one arm; and the 95% half-width of the paired Δ that each sample size would give at the pilot SD.

## Opponent for the ultra screen and confirmation (Paul's rule, 2026-11-18, fixed now)

- **The opponent is L8 if `v5.2-ultra`'s pilot advantage vs three L8 seats is below 0 (point estimate), and L9 otherwise.**
- The rule reads only the control arm's own level against Pentobi, never the paired Δ or the cap arm, so it cannot steer the acceptance test of any candidate.
- If the opponent is L8, the ultra benchmark bracket needs an anchor where the engine is above zero, most likely L7, which is cheap: an L7 block of 50 seeds from **104,600,000** is in the projections.

## What follows

Nothing beyond the pilot is played in round 11. The ultra screen (fresh seeds from 104,100,000), its confirmation (104,300,000) and an L9 anchor (104,500,000) get their own preregistration once Paul has chosen the sample size. The acceptance rule stays the standard one: paired-by-seed 95% bootstrap Δ lower bound > 0 and first-place Δ upper bound ≥ 0, at equal clean time.

**Seed blocks:** 104,000,000–104,000,011 (pilot); 104,900,000 (memory measurement, unscored). Reserved, unplayed: 104,100,000 (screen), 104,300,000 (confirmation), 104,500,000 (L9 anchor), 104,600,000 (L7 anchor).

## Round 11 — Step A probe and Step C memory (measured; `tmp/v58/probe/probe.md`, `tmp/v58/mem/`)

**Step A** (`v58-probe.sh`, 18:10–18:33, two waves of three single-threaded `v55_speed` processes, 30 positions; ms is under 3-process load and not a timing figure):

| Arm | Mean depth | Δ depth vs U | Mean max depth | Same best as U (of 30) | Iterations | Tree bytes / iteration | Largest tree | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| U (`v5.2-ultra`, eager, uncapped) | 7.66 | — | 15.2 | — | 834,533 | 3,904 | 9.37 GB | 9.86 GB |
| U-1pct (noise reference) | 7.67 | +0.01 | 15.2 | 30 | 842,583 | 3,894 | 9.41 GB | 10.30 GB |
| U16-4 (W1D) | 8.23 | +0.57 | 16.5 | 18 | 788,816 | 2,514 | 3.77 GB | 3.73 GB |
| U16-8 | 7.94 | +0.28 | 15.9 | 21 | 870,128 | 2,492 | 5.28 GB | 5.61 GB |
| U32-8 | 8.07 | +0.41 | 15.9 | 19 | 836,247 | 2,608 | 4.86 GB | 5.01 GB |
| U64-16 | 7.78 | +0.12 | 15.3 | 20 | 830,764 | 2,828 | 4.77 GB | 4.85 GB |

- The noise reference keeps the best move in 30/30 positions; every cap shape changes it in 9–12 of 30. All four bind, and all are under 6 GB.
- **Chosen by the preregistered rule: `U32-8`** (depth gain +0.41, closest to +0.39; no other shape within 0.05).
- Depth is not monotone in the window here: (16, 8) deepens less than (32, 8). The windows differ in where they bind (init vs √N growth), and 30 positions is a small sample.
- The cap arms use about a third less tree memory per iteration (lazy layout) and half the peak RSS of the uncapped control.

**Step C** (`v58-mem.sh`, 17:59–18:11):
- Baseline with no game running (17:59:36, a minute after P2 exited): wired 3.09 + anonymous 17.03 + compressor 0.00 = **B = 20.12 GB**; swap used 2.7 GB of 4 GB (already in use before round 11). A later reading during the cost wait (18:33) showed anonymous 11.3 GB, so the baseline fluctuates with the Docker VM and apps. The preregistered rule uses the 17:59 snapshot, the larger one.
- Pentobi per-process RSS (allocated at start, flat over the game): **L8 0.61 GB, L9 2.03 GB.** The L8 game finished (3.0 min, Pentobi 2.56 s/move mean over 70 moves); the L9 game was stopped at 8 minutes as preregistered.
- *Deviation:* stopping the L9 game left one `pentobi-gtp` process orphaned (pid 5408, 2.0 GB, about one core). It ran on until 18:12, overlapping the first two minutes of Step A's first wave. Step A's outputs are deterministic and its ms is not used, so nothing is affected. It was killed by hand.

**Concurrency by the preregistered rule** (48 − 8 − B = 19.88 GB available):
- `U`: per game 9.86 + 3 × 0.61 = 11.69 GB → **C = 1**.
- `U32-8`: per game 5.01 + 1.83 = 6.84 GB → **C = 2**.
- At L9 (P9 = 2.03 GB): `U` 15.95 GB → C = 1; `U32-8` 11.10 GB → C = 1.
- This machine, with its usual load of apps and the Docker VM (about 20 GB), fits **one uncapped ultra game at a time**. Round 6's "about 3" ran without this 8 GB margin.

### Amendment 1 (2026-11-18, this commit's time; before any pilot game and before the cost result is read)

- **Both arms of a pilot chunk play at the same time**, as two `blokee-pentobi` processes with one game thread each (`U` 1 + `U32-8` 1). Together they need 11.69 + 6.84 = 18.53 GB, inside the 19.88 GB budget. That is the largest total the rule allows: `U32-8` at 2 alongside `U` would need 25.4 GB.
- Why: run one after the other at C = 1 and C = 2, the pilot would take about 11 hours and might not finish before the 08:00 hand-back. Run side by side, it takes about 7 hours, and both arms see the same machine load, which makes their in-match times more comparable.
- Chunk 1 starts when both arms have finished chunk 0. The arm order within a chunk no longer applies.
- Nothing else changes: seeds, arms, the read-outs, and no acceptance decision.

## Round 11 — Step B clean cost (measured; `tmp/v58/cost/`, 18:41–19:35)

`v58-cost.sh`: `p4_cost`, one thread, 30 positions, round 9's warm-up procedure, two rounds in reverse order. The script's quiet gate (no match or probe, 1-minute load < 3) opened at 18:41 (load 2.70). The Docker VM and two macOS storage processes used about 2.5 cores throughout, a little more than the ~1.5 in earlier rounds; this hits both arms alike within each position.

| Round | U ms | U32-8 ms | Ratio | Iterations U / U32-8 | Same move as U |
|---|---:|---:|---:|---:|---:|
| 1 (U warm-up, U, U32-8) | 17,897 | 17,741 | 0.9913 | 814,550 / 799,868 | 15/30 |
| 2 (U warm-up, U32-8, U) | 17,812 | 17,810 | 0.9999 | 814,550 / 799,868 | 15/30 |

**Cost of `U32-8` (lazy included) = 0.996 × `v5.2-ultra`: inside 0.97–1.03, so it plays at `iterationScale` 3948.432** (no -ET). The cap's saving in `select` about cancels lazy's ~3% cost. Early exits give U32-8 about 2% fewer iterations at the same time. A clean ultra search on this machine takes about 17.8 s, against Pentobi L9's 17.1 s/move (round 6 calibration).

**Pilot launched 19:35:17** (`tmp/v58/pilot/`, `v58-pilot.sh` as amended, pid in `chain.pid`, under caffeinate, nice 0). This commit follows the launch by a few minutes; the cost result only fixes the iteration scale, by the preregistered rule.

## Round 11 — Step D pilot vs three L8 seats (measured; `tmp/v58/pilot/report.md`, `screen.md`; 2026-11-18 19:35 – 2026-11-19 01:39)

12 seeds 104,000,000–104,000,011 × 4 rotations, both arms complete (48 games each), the two arms side by side with one game thread each (amendment 1). On AC throughout; no sleep or pause. Swap stayed at 2.6–2.7 GB (no growth). Anonymous memory peaked at 27.3 GB with both games running (idle about 11–15 GB), so the games used about 12–16 GB at peak against the rule's 18.5 GB estimate.

| Arm | Advantage vs L8 [95% CI] | First place | Blokee ms/move, own moves 5+ | Pentobi L8 ms/move, moves 5+ | Blokee / Pentobi | Seconds per game (Blokee + Pentobi) | Wall time, 48 games |
|---|---:|---:|---:|---:|---:|---:|---:|
| `U` (`v5.2-ultra`) | **+1.08 [−3.01, +5.72]** | 22.9% | 13,387 | 4,058 | 3.30 | 454 (235 + 219) | 6.06 h |
| `U32-8` | +2.71 [−0.53, +5.81] | 31.2% | 12,916 | 4,026 | 3.21 | 442 (225 + 217) | 5.89 h |

- Paired Δ (U32-8 − U): +1.62 [−2.77, +6.00]; first place +8.3 pp [−12.5, +29.2]. **Descriptive only; 12 seeds decide nothing.**
- **Per-seed SD of the paired Δ: 7.87** (U's own advantage 8.00, U32-8's 5.99). That is close to pro's (about 7 at L7). The 95% half-width of a paired Δ is therefore about ±2.2 at 50 seeds, ±1.5 at 100, ±1.1 at 200, ±0.77 at 400 and ±0.55 at 800.
- Time: under two-game load, ultra searched 13.4 s/move at own moves 5+ (14.3 s at 3+). That is 3.3× L8's 4.1 s and about 0.78× L9's 17.1 s (round 6 calibration). Round 6's in-match ratio against L9 was 15.3 / 18.9 = 0.81. The clean single-search time is 17.8 s (Step B), on positions from own move 3 on.
- **First L8 anchor for ultra:** `v5.2-ultra` +1.08 [−3.01, +5.72] on 12 seeds. With round 6's L9 −4.14 [−8.55, +0.68] on 11 seeds, the point estimates put ultra's break-even level between 8 and 9 (linear: about 8.2), but both intervals span zero, so it is not bracketed with confidence.
- Throughput: 12 seeds per arm in 6.06 h side by side, i.e. **about 2.0 seeds per hour for both arms vs L8**. At L9, Pentobi's time per move scales by 4.34 (17,069 / 3,932 ms, round 6), so a game takes about 235 + 950 = 1,185 s. That gives **about 0.76 seeds per hour** side by side.

**Paul's opponent rule:** `v5.2-ultra`'s pilot advantage vs L8 is +1.08, not below 0, so **the ultra screen opponent is L9.** The rule reads only the control's level. The L7 anchor block is not needed for bracketing (L8 is already above zero on the point estimate) and is not run.

**Projected Mac hours** (both arms side by side, one game each, steady state from the pilot's game times):

| Block | Seeds | Hours (wall) | Days | Paired Δ 95% half-width at SD 7.87 |
|---|---:|---:|---:|---:|
| L8 screen | 50 | 25 | 1.1 | ±2.18 |
| L8 screen | 100 | 50 | 2.1 | ±1.54 |
| L8 screen | 200 | 101 | 4.2 | ±1.09 |
| L8 screen | 400 | 202 | 8.4 | ±0.77 |
| L8 screen | 800 | 404 | 16.8 | ±0.55 |
| L9 screen (the rule's choice) | 24 | 32 | 1.3 | ±3.15 |
| L9 screen | 48 | 63 | 2.6 | ±2.23 |
| L9 screen | 100 | 132 | 5.5 | ±1.54 |
| L9 screen | 200 | 263 | 11 | ±1.09 |
| L9 screen | 400 | 527 | 22 | ±0.77 |
| L9 screen | 800 | 1,053 | 44 | ±0.55 |
| L7 anchor, one arm (not needed under the rule) | 50 | 16 | 0.7 | — |

The L9 rows assume the SD measured at L8. The L9 hours assume Pentobi L9's calibrated time and the same one-game-per-arm concurrency.

### Amendment 2 — the ultra screen (2026-11-19, this commit's time; fixed after the pilot and before any screen game)

On Paul's instruction (relayed 22:50 CST):
- **Arms:** `U32-8` (v5.2-ultra + interiorCap (32, 8), lazy, `iterationScale` 3948.432, clean cost 0.996) vs `U` (`v5.2-ultra`, byte copy). As preregistered, the control cannot be lazy: `lazy` is a sub-option of `interiorCap`, and the control has no cap. Both configs are the pilot's files, copied to `tmp/v58/screen/configs/`.
- **Opponent: three Pentobi L9 seats** (Paul's rule, above).
- **Seeds:** fresh, from 104,100,000, in 6-seed chunks played in order (chunk k = 104,100,000 + 6k). Both arms of a chunk are played side by side as in amendment 1 (one game thread each). Driver `engine-rs/scripts/v58-screen.sh`, `LEVEL=9`, under caffeinate. Hard ceiling 134 chunks (804 seeds).
- **Memory at L9.** The Step C rule would allow one L9 game at a time (U 15.95 + U32-8 11.10 = 27.05 GB against 19.88 GB available). Paul asked for side by side. The pilot measured 12–16 GB for two L8 games, against 18.5 GB by the rule. Adding six L9 Pentobi processes (+8.5 GB over L8) gives an expected peak of about 36 GB anonymous plus 3 GB wired on a 51.5 GB machine, leaving about 12 GB. **Mechanical guard:** if swap use is more than 1 GB above its level at the chain's start at any chunk boundary, the chain plays the two arms one after the other from then on, and logs it. Memory is logged every 5 minutes (`tmp/v58/screen/mem.log`).
- **Acceptance rule:** the standard one. `U32-8` clears if the paired-by-seed 95% bootstrap Δ advantage has a lower bound > 0 and the paired first-place Δ has an upper bound ≥ 0, at equal clean time (0.996, inside the band). Complete seeds only.
- **When it is read:** only once, at the sample size N Paul chooses (a multiple of 6), with `engine-rs/scripts/v58-screen-read.sh N`, which merges chunks 0 … N/6 − 1 only. **If Paul names no N before it is reached, the read is at N = 48 seeds** (8 chunks, about 63 h, ±2.2). No chunk is looked at before then: the chain prints only progress lines, and nobody reads `tmp/v58/screen/chunks/*.jsonl` until the read. Seeds played beyond the chosen N are not part of this screen.
- **Stopping:** `touch /Users/paulkim/Blokee/tmp/v58/screen/STOP` stops the chain at the next chunk boundary, after both arms finish the chunk in progress. Killing it mid-chunk loses only that chunk; the chain is resumable.
- A cleared screen would go to a confirmation on fresh seeds from 104,300,000, under its own preregistration. Paul names versions.
