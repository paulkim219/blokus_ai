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
