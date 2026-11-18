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

**Memory** (`tree_memory` heap bytes; peak RSS from `/usr/bin/time -l`; same positions and iterations for both layouts):

| Tier / config | Positions | Tree bytes per iteration, eager → lazy | Largest tree, eager → lazy | Peak RSS, eager → lazy |
|---|---:|---:|---:|---:|
| pro, `pro-W1D-ET` | 50 | 4,613 → 2,773 (−40%) | 0.59 → 0.30 GB (−50%) | 0.90 → 0.52 GB (−42%) |
| ultra, v5.2-ultra + cap {16, 4} | 5 | 4,859 → 2,619 (−46%) | 5.36 → 2.69 GB (−50%) | 5.39 → 2.91 GB (−46%) |

For scale, v5.2-ultra without a cap had a largest tree of 8.35 GB and peak RSS of 10.8 GB on round 8's 15 positions. The cap alone does not change memory per iteration (eager 4.6–4.9 KB). The lazy layout halves it.

**Speed:** quiet slot, below.

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
- The miss rate for non-contact moves stays high under every window. That is a prior-model issue (quiet L7 moves score low), not a width issue.

---

# Preregistered next screens (not run tonight)

## Screen P2: adaptive interior width at pro (preregistration 2026-11-17 21:45 CST, this commit's time; fixed before its cost is measured or any game is played)

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

## Screen P1: reply-aware fit feature

Not preregistered: the §1 gate did not pass. Block 103,000,000 stays unused.

## §3 lazy allocation: what the speed result will decide (rule fixed in the §3 prereg)

The read is lazy/eager clean ms at pro, from the quiet slot.
- **At most 0.97:** screen **P3**. `W1D-ET-lazy-ET` (W1D-ET + lazy, `iterationScale` 239.172 / ratio) against the round-10 control. Same match setup as P2, **300 fresh seeds 103,200,000–103,200,299**, standard rule. About 4.2 Mac hours.
- **Otherwise:** no screen. Lazy is a memory option that plays the same games.
- **Separately (proposal, not preregistered):** the round-8 notes give about 4 h per 24 L9 seeds per arm with three simultaneous games. Round 6 found that memory limits ultra to about 3 concurrent games on this machine (peak about 8–11 GB per search). Lazy halves ultra's tree and peak RSS on the probe positions. With per-seat Pentobi a game keeps about one core busy, so on 48 GB about twice as many ultra games could run at once. Whether that holds at matched throughput needs a short pilot.
