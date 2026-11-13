# v5 tracker — what was proposed, what was tested, what was added

Started 2026-11-12. **v5** is the engine line built by porting Pentobi's search ideas into Blokee,
then adding ideas Pentobi does not have. (The earlier "v5 Oracle" opponent-modelling experiments
keep their files and ids; they are not this line. The bare id `v5` is an August ablation in
`src/ai/versions/v1.ts`, so configs here always carry the minor version.)

## Versioning (decided by Paul, 2026-11-12)

- **v5.0** is the initial model: `v4.2-ultra` with the Pentobi elements (section A) ported in.
- **v5.1, v5.2, …**: each of our own additions (section B) that shows a statistically significant
  gain over the current v5.x becomes the next minor version, measured against the version it
  replaces.
- Ports are still built and measured one at a time, so each one's effect is known, but they are
  named together as v5.0. Default, to be confirmed by Paul: a port that measures clearly harmful
  in this engine is left out of v5.0 and recorded here as Rejected.
- Experimental configs before a version is named use ids like `v5.0-p4`; the tier suffix
  (`-ultra`) follows the existing convention.

This file is the ledger. Update the row and add a dated line to the log whenever an item changes
status. Full write-ups stay in `research_paper/`; gates are fixed in a dated preregistration entry
before each run.

## Rules

- One mechanism per experiment, on top of the current base. No bundles inside an experiment.
- Every candidate is measured twice at budget 300:
  - against the current base (starting with `v4.2-ultra`), seat-rotated, with `blokee-match`;
  - against three Pentobi level-6 seats, with `blokee-pentobi` (`docs/E6_RUNBOOK.md`).
- Report ms/move next to every result. Level 6 is the equal-compute opponent; a gain that costs
  wall time is priced at the measured exchange rate (about +1.3 points per doubling).
- The identity point of every new option must be byte-identical to the base (parity tests and a
  0.00 mirror).

**Status:** Proposed → Building → Testing → **Added** / **Rejected** / Parked.

## Baseline (2026-11-12, Pentobi 31.0, opening book on, one thread)

| Match | Result | First place |
|---|---|---:|
| 1 × `v4.2-ultra` vs 3 × Pentobi level 6 (100 seeds) | **−10.68 [−11.96, −9.41]** | 8.8% |
| 1 × Pentobi level 6 vs 3 × `v4.2-ultra` (same seeds) | +5.56 [4.59, 6.59] for Pentobi | 49.5% |
| 1 × `v4.2-ultra` vs 3 × Pentobi level 5 (40 seeds) | −2.50 [−4.01, −1.06] | 23.1% |
| 1 × `v4.2-ultra` vs 3 × Pentobi level 7 (40 seeds) | −15.66 [−17.18, −14.10] | 3.1% |
| 1 × `v4.2-ultra` vs 3 × Pentobi level 9 (16 games, stopped; descriptive) | −25.10 [−32.50, −17.71] | 0% |

**Current v5.0 line (2026-11-13, after port P4/P5; `engine-rs/configs/v5.0-p4-ultra.json`):**

| Match | Result | First place |
|---|---|---:|
| 1 × `v5.0-p4-ultra` vs 3 × Pentobi level 6 (200 seeds) | **−4.93 [−5.74, −4.14]** | 16.2% |
| 1 × Pentobi level 6 vs 3 × `v5.0-p4-ultra` (100 seeds) | +5.86 [4.89, 6.90] for Pentobi (unchanged from `v4.2-ultra`) | 48.3% |
| 1 × `v5.0-p4-ultra` vs 3 × Pentobi level 5 (100 seeds) | −0.32 [−1.51, +0.84] | 26.5% |
| 1 × `v5.0-p4-ultra` vs 3 × Pentobi level 7 (40 seeds) | −10.32 [−12.95, −7.87] | 8.8% |
| same vs level 6 at 2× / 4× iterations (100 seeds) | −4.78 / −4.67 (budget 300 on those seeds: −6.03) | 15.3% / 17.5% |
| 1 × `v5.0-p4-ultra` vs 3 × `v4.2-ultra` (200 seeds) | +2.13 [1.55, 2.75] | 38.1% |

Level with level 5, about 5 points behind level 6, and extra compute stops helping after one
doubling (`research_paper/v5_x2_p4_benchmark_results.md`).

Compute per move, measured:

| Engine | Simulations per move | ms/move |
|---|---|---:|
| `v4.2-ultra` | 4,800 iterations (none on a seat's first three moves) | ≈62 |
| Pentobi level 5 | ≈560 new (≈970 at the root with the reused subtree) | ≈9 |
| Pentobi level 6 | ≈3,900 new (≈7,100 at the root) | ≈54 |
| Pentobi level 7 | ≈52,000 new (≈98,500 at the root) | ≈590 |
| Pentobi level 9 | base 1,745,221, scaled up through the game | ≈9,900 |

Reading: at equal compute Pentobi is about 11 points stronger, and Blokee at 4,800 iterations is
slightly weaker than Pentobi at about 560 simulations. The gap is quality per simulation.

## A. Ports from Pentobi

Source paths are under `~/src/pentobi` (tag `v31.0`).

| ID | Mechanism in Pentobi | Blokee today | Status | Result |
|---|---|---|---|---|
| P1 | **Rollout move choice over all legal moves.** P(move) ∝ 5^(piece squares) × 10⁶ per "local" square covered; local = corners opened by the opponents' last moves and their neighbours, counted double if also an own corner. `libpentobi_mcts/State.cpp` (`init_gamma`, `check_move`), `PlayoutFeatures.h`, `LocalPoints.h` | One random own corner, ≤12 placements, uniform random 60% of the time, else size/centre + table | Proposed (**next port**, with P2 and P3) | D1: no move-level evidence either way. X2: with P4/P5 in, a second doubling of iterations adds +0.11 [−1.19, +1.33], so the gap is in what each simulation returns |
| P2 | **Incremental legal-move lists in rollouts** (`State.cpp` `update_moves`). The enabler that makes P1 affordable | Moves re-sampled per ply | Proposed (with P1) | |
| P3 | **Rank reward plus quality bonus.** Result = fraction of opponents beaten, ties shared (`libpentobi_base/ScoreUtil.h`); + 0.3·sigmoid of the score's z-score, − a game-length term (`State.cpp` `get_quality_bonus`) | 65% sigmoid of margin over the best opponent, 35% rank (`rankBlend` 0.35, shifted by lead) | Proposed | Earlier, vs itself: `rankBlend` 0 / 0.7 / 1.0 showed no clear overall gain (v7 screen) |
| P4 | **Expand every legal move; children start with a value and 3 visits.** Value = parent value × sqrt(gamma / max gamma) (`PriorKnowledge.h` `gen_children`, `SearchParamConst.h` `child_min_count`) | Shortlist 40 (root) / 24, progressive widening, prior only steers exploration | **Added** 2026-11-13 (with P5; config `engine-rs/configs/v5.0-p4-ultra.json`) | Confirmation vs Pentobi level 6, 200 fresh seeds: **+5.32 [+4.30, +6.31]** over `v4.2-ultra` (−4.93 against −10.25), 0.93× ms/move. Directly vs `v4.2-ultra`: +2.13 [1.55, 2.75]. Full expansion with the *old* ordering as prior: +1.06 [−0.33, +2.50] (screen). `research_paper/v5_p4_p5_candidate_generation_results.md` |
| P5 | **Feature-based move priors**: covers an opponent corner or its neighbour, adjacency to own/other pieces, new own corners by number of free neighbours, piece size, local response (`PriorKnowledge.cpp` `compute_features`); weights trainable by softmax (`learn_tool/`) | Hand ordering score through a softmax at temperature 6 | **Added** 2026-11-13 (with P4). Our own 39 features and weights, fitted on Pentobi level 6's moves in 800 games (`ml/p4_fit_prior.py`, `ml/v5-prior-weights.json`); nothing copied from Pentobi | Carries most of the gain: the prior alone in the old 40-move tree +4.29 [+2.88, +5.81] (screen). Held-out, moves 3–8: Pentobi's move in the top 40 86.5% (old shortlist 54.9%). Not confirmed as better: the prior at interior nodes, 10 initial visits, root widening kept |
| P6 | **RAVE** with distance weighting, weight 0.7, child max 2,000, parent max 50,000 (`Search.cpp`, `SearchParamConst.h`) | None | Proposed | Earlier piece-level RAVE in the old tree: +0.49 at equivalence 10, −0.39 at 50; neither advanced (v4 report §9.6) |
| P7 | **Last-good-reply table** (`libboardgame_mcts/LastGoodReply.h`) | Progressive history only (`historyWeight` 0.6) | Proposed | |
| P8 | **Subtree reuse between moves** (`SearchBase.h` `m_reuse_subtree`) | Fresh tree every move (`treeReuse` unsupported natively) | Proposed | |
| P9 | **Opening rules**: for the first 12 pieces on the board only moves that minimise distance to the centre (`PriorKnowledge.cpp`); an opening book (`opening_books/book_classic.blksgf`); only larger pieces considered early in rollouts (`State.cpp` `get_is_piece_considered`) | Heuristic move for each seat's first three moves; no book | Proposed | Earlier: Blokee's own book covered plies 1–2 only and was not matched (`selfplay-results/v36-opening-book-findings.md`) |
| P10 | **Selection rule**: value + prior × 0.4·sqrt(N)·log(N+1) / child count, with a cut-off that skips hopeless children (`SearchBase.h` `select_child`) | PUCT, `cPuct` 1.6, plus history term | Proposed (the selection formula itself is not ported) | S2, on the P4/P5 base, PUCT kept: `cPuct` 0.8 +0.11 [−1.40, +1.53]; `cPuct` 3.2 −2.10 [−3.53, −0.64] |
| P11 | **Simulation budget grows through the game**: × 0.7·exp(0.1·i) for a seat's i-th move, cut to 20–30% on moves 0–2 (`Player.cpp`) | `iterationShape` exists (v3.5); flat in `v4.2-ultra` apart from the opening shortcut | **Tested** 2026-11-13 (config-only, S2): null, not added | Rising curve ∝ exp(0.1·i) on the P4/P5 base: −0.31 [−1.70, +1.06], with about 11% more iterations on searched moves |

## B. Ideas Pentobi does not have

| ID | Idea | Why it could beat Pentobi | Status | Result |
|---|---|---|---|---|
| N1 | **Network policy as the tree prior** (root and interior nodes) | Pentobi's prior is linear over hand features; the ResNet picks the search's move about 48% of the time. Most useful once P4 makes the prior seed child values | Tested in the old tree (E6); to be re-tested on the P4/P5 base, where the prior seeds child values | In the old tree, root prior only: +0.18/+0.24 (E3a), +0.39 [0.14, 0.65] (E4), +0.88 [0.50, 1.27] (E5 net, E6 control). Depth-1 policy on top: +0.35 [−0.19, +0.89], not significant |
| N2 | **Network value blended with rollouts** (virtual visits; AlphaGo-style mix) | Pentobi has no value function. Offline, the net predicts final margin better than the 4,800-iteration search's own root value (R² 0.448 vs 0.413) | Tested in the old tree (E6): not significant | V64 +0.12 [−0.43, +0.67], V512 +0.27 [−0.25, +0.82] over the root-prior control |
| N3 | **Exact endgame**: sealed-region packer in the tree plus a multi-player MCTS-Solver | Pentobi does not solve Classic endgames | Packer exists; solver Proposed | Packer alone, old tree: +0.01 |
| N4 | **Better rollout statistics**: N-gram selection (NST), playout policy adaptation | Reported stronger than simpler reply tables in general game playing | Proposed (after P1, P7) | |
| N5 | **Win-probability objective** from the net's P(first) head | Targets winning directly instead of rank or margin | Proposed (head is in the E5 net) | |
| N6 | **Seat-aware play** | Turn order is worth several points (2nd seat wins 33.5%, 4th 14.7% in a `v4.2-ultra` mirror); Pentobi plays every seat alike | H1 passed; H2 not confirmed | H1 blue `agg140` +3.65 pp [0.60, 6.67]; H2 yellow `flat` −1.14 pp [−3.38, 1.10]. Not in the engine yet |
| N7 | **Re-test the opponent model**: plain max^n vs the paranoid-when-leading switch | Nijssen & Winands found max^n best inside MCTS | Proposed | Earlier: the switch measured +0.52 [−0.21, 1.31] |
| N8 | **Distil a strong slow teacher** (Pentobi level 7–9, or v5 at a high budget) into the net | A fast model that keeps most of the teacher's strength | Proposed (after the first ports) | |
| N9 | **Network-only player** (no search) as the speed baseline | Sets the bar that N8 has to beat | Proposed | |
| N10 | **Re-fit the weights against Pentobi** with a noisy-optimisation tuner (CLOP or Bayesian optimisation; the repo's CEM tuner is the starting point): evaluation, ordering, `cPuct`, widening, reward blend | Every weight here was fitted against Blokee's own ancestors, and D1 shows the ordering leans the wrong way. AlphaGo gained about 94 and 103 Elo from Bayesian optimisation of search hyperparameters, landing far from the hand-tuned values. A 400-game block against level 6 takes 5 minutes | Proposed | Earlier, vs itself: fitting eval weights by CEM was worth +4.5 |
| N11 | **Learn the move-feature weights from strong games** (Coulom's minorisation–maximisation "Elo ratings of move patterns"; then simulation balancing for the rollout weights) using Pentobi level 7–9 or high-budget v5 games as data | Pentobi's own weights come from a similar softmax fit; training on stronger games or balancing for value accuracy could beat them. Pairs with P5 and P1 | Proposed (after P5) | Earlier here: imitation-trained rollout policy lost to the hand one (26.8% vs 34.6% top-1, weight 0 selected); balancing was never run |
| N12 | **Multi-threaded search** (root or tree parallelism with virtual loss) | Free strength at equal wall time on a multi-core machine: each doubling of simulations is worth about +1.3. Pentobi can do this too (`--threads`), so it is an edge only where we use more cores | Proposed | |
| N13 | **Pondering**: keep searching during the three opponents' turns | In live play a seat thinks once per four turns. Needs subtree reuse (P8) | Proposed (after P8) | |
| N14 | **Spend the budget where the search is unsure**: more iterations on a seat's moves 3–8 | D1: the search reproduces its own move only 39–50% of the time there, and that is where the positional damage starts | Proposed (with P11) | Earlier: the v3.5 iteration curve was worth +1.00 [0.43, 1.58] vs flat |
| N15 | **Stop rollouts early when the outcome is decided** (all remaining seats sealed → exact packer; score bounds) | Cheaper late-game simulations, so more of them | Proposed (with N3) | |

Already tried and closed in the old tree, listed so they are not re-proposed by accident: implicit
max^n backups (null at α 0.10 and 0.20, v4 report §9.4), a learned leaf value *replacing* rollouts
(−4.5 to −16), value-of-computation control and root racing (v3.7). Any of these may be reopened
under a new v5 base, with a note here saying why.

## C. Supporting work

| ID | Item | Status | Result |
|---|---|---|---|
| D1 | **Game anatomy** of the 800 level-6 games, with Pentobi level 7 as a judge of 2,876 positions (`engine-rs/examples/d1_anatomy.rs`, `engine-rs/scripts/d1_report.py`) | **Done** | See "D1 findings" below; full tables in `tmp/d1-results.md` |
| S1 | **Config-only screen against Pentobi level 6**: single-knob variants of `v4.2-ultra`, 100 seeds from 79,300,000, each paired with the base on the same seeds. Exploratory: a filter for what to build and confirm, not evidence (`engine-rs/scripts/s1-screen.sh`) | **Done** 2026-11-13: nothing confirmed (`research_paper/v5_s1_config_screen_results.md`) | Confirmation on 200 fresh seeds: `W96` +0.97 [−0.06, +2.04], `W400open` +1.11 [−0.07, +2.30]; both superseded by P4/P5. base −9.88 [−10.98, −8.78]. Paired Δ vs base, screen only (selection-biased, 11 arms): `W96` (root shortlist 40→96) **+2.03 [+0.45, +3.49]**; `W400open` (shortlist 400, all open at once) **+1.81 [+0.38, +3.30]**; `C0` (no centre pull in ordering) **−3.22 [−4.71, −1.75]**; `O0` (search from move 1) −1.55 [−3.41, +0.34]; `E30` −1.28 [−2.74, +0.20]; `N96` +0.89, `R0` +0.93, `W400` +0.60, `B4` +0.57 (at 1.92× cost), `A140` +0.17, `R100` −0.42, all with CIs spanning 0. Notes in `tmp/s1-results.md` on arms that do more than their label says |
| S2 | **Config-only screen on the P4/P5 base** (`v5.0-p4-ultra`): six single-change arms, 100 seeds from 82,000,000 (`engine-rs/scripts/s2-screen.sh`) | **Done** 2026-11-13: no arm cleared, no confirmation | base −6.03 [−7.08, −4.96]. Paired Δ: `cPuct` 0.8 +0.11; `cPuct` 3.2 **−2.10 [−3.53, −0.64]**; search from move 1 +0.40; `initVisits` 1 +0.95; rising budget curve (P11, config-only form) −0.31; `nodeShortlist` 96 +1.38 [−0.04, +2.86], then **+0.30 [−0.71, +1.35]** on its own 200-seed test (S3): dropped. `research_paper/v5_s2_config_screen_results.md` |
| X2 | Benchmark of the P4/P5 config: ladder, reverse match, compute scaling (`engine-rs/scripts/x2-run.sh`) | **Done** 2026-11-13 | Table under "Baseline"; `research_paper/v5_x2_p4_benchmark_results.md` |
| X1 | Pentobi bridge and benchmark (`blokee-pentobi`, validity gate 20/20) | **Added** | Mac level 6: −10.68 [−11.96, −9.41]. PC, 100 seeds from 79,400,000: base −9.99 [−11.05, −8.85], 82 ms/move; `ei-gen6` −9.58 [−10.75, −8.43], 93 ms/move. Paired Δ +0.41 [−1.00, +1.75], not an advance |
| E5 | Model v2 (`resnet2-b8w96`, utility heads) | **Done** (offline only) | Mac: test KL 0.336, top-1 48.4%, margin R² 0.406. PC 36k games: `resnet2-b8w96` selected (val loss 7.171, 19.2k pos/s). `b12w128` 7.172 / 8.0k, `b16w160` 7.172 / 3.2k |
| E6 | Net inside the old search (root prior, depth-1 policy, root-child value); screen vs `v4.2-ultra`, 400 seeds (`ml/torch/e6_screen.sh`) | **P0 confirmed on the PC** (passes the +0.50 gate: the v2 root prior is a promotion candidate over `v4.2-ultra`). Other channels screened on the Mac 2026-11-13: none advances | Mac screen P0 +0.88 [0.50, 1.27]. PC confirmation (800 seeds from 77,100,000): **+0.83 [0.56, 1.09]**, first place 31.8%, 136 ms/move, 1.0 eval/move. Passes the +0.50 gate. Mac screen of the other channels, vs `v4.2-ultra`, 400 seeds: P0 (root prior only) +0.88 [0.50, 1.27]; P1 (depth-1 policy) +1.24; V64 +1.00; V512 +1.15; PV (both) +1.28 [0.90, 1.65]. Paired vs P0: P1 +0.35 [−0.19, +0.89], V64 +0.12 [−0.43, +0.67], V512 +0.27 [−0.25, +0.82], PV +0.40 [−0.13, +0.92]. All point estimates positive, none clears 0, and PV costs 149 ms/move against 81. No confirmation run. The net cannot yet be combined with the P4/P5 root (more than 64 candidates) |

## E. v6 — candidate structures (not started)

v5 keeps today's structure: a rollout tree search with hand features, optionally helped by a
network. v6 would move the strength into a learned model. Three candidates, to be chosen after v5:

| ID | Structure | What changes from v5 | Main risk |
|---|---|---|---|
| V6-A | **Distilled, searchless (or nearly) model.** A network trained on the action-values of a strong slow teacher (v5 at a high budget, Pentobi level 8–9); plays from one forward pass, or a 16–64-simulation Gumbel search on top | No rollouts at play time. Action-value head over all legal moves, not a 40-move shortlist. Self-play records must store every root child's value, not only visits | Data scale: the chess result used 15 billion labelled positions and a 270M-parameter transformer. Earlier leaf-replacement attempts here failed on small data |
| V6-B | **Network-guided search trained by self-play** (AlphaZero / Gumbel AlphaZero with a max^n value vector), started from the distilled V6-A model instead of from scratch | The network supplies both prior and value at every node; rollouts go | Compute: a from-scratch Blokus Duo AlphaZero plateaued around Pentobi level 4 after 700k games |
| V6-C | **CPU-incremental network (NNUE-style) inside the tree** | Value (and a cheap policy) updated incrementally per move, so it runs in the browser at hundreds of thousands of evaluations per second with no GPU | Engineering and feature design; unproven for four-player Blokus |

Also noted, not planned: best-first minimax with a learned value and no policy (Descent/Athénan),
which is strong in two-player games and has no multi-player version.

## D1 findings (2026-11-12, descriptive)

- **Where the gap opens.** Squares are level through round 9. Territory (the engine's own estimate)
  is already −3.0 at round 4 and −7.0 at round 9; legal moves go negative from round 5. The points
  are lost in rounds 10–21 as smaller pieces and lost turns: Blokee seats are stuck before round
  15 in 16.8% of cases against 1.6%, and place all 21 pieces in 1.0% against 10.5%.
- **Candidate generation (P4/P5) is the strongest signal.** On own moves 3–8 the move Pentobi
  level 7 would play is in Blokee's 40-move root shortlist only 42–45% of the time (67% on moves
  9–11, ≥95% from move 12). The earlier internal audit found the shortlist lost the "oracle" move
  1.2% of the time, but its oracle was Blokee's own deeper search, which shares the shortlist.
- **Blokee's choices lean the way its hand ordering leans.** Where it differs from level 7 (moves
  3–15) its move is a bigger piece, 1.26 cells closer to the centre, with more own corners and
  more opponent corners covered. Pentobi plays the long pentominoes first (Z5, V5, N5, L5 at mean
  move 2.9–3.9); Blokee opens W5, F5, X5 and plays the long ones at 6.2–7.2.
- **Local response (P1) is not supported at move level.** In the same positions level 7 answers
  locally exactly as often as Blokee (0.250 vs 0.249). Whether local-aware *rollouts* give better
  values is untested; that is still the P1 question.
- **Opening (P9).** Blokee's heuristic first three moves never match level 7 and cost −4.6
  territory at round 2, but reach and territory are level again by round 3. The lasting deficit
  starts at the first searched moves.
- **Search noise.** Re-searching Blokee's own positions with another random seed reproduces the
  move it played 39% of the time on moves 3–5 and 50% on moves 6–8.
- **Company matters.** A Blokee seat scores 6.16 [5.19, 7.11] worse among Pentobis than among
  Blokees; a Pentobi seat barely changes (−1.04 [−2.08, 0.00]).
- Agreement with level 7 overall: Blokee 0.24, Pentobi level 6 0.56.

Consequence: the first v5 port is **P4/P5 (candidate generation and priors)**, not P1.

## Log

- 2026-11-12 — Pentobi 31.0 built; bridge validated (20/20 replays, legal-move sets equal at every
  ply). Level 9 pilot stopped at Paul's request; benchmark moved to level 6 (prereg addendum
  `a141e6f`). Levels 5, 6 and 7 scored (baseline table); 1,120 games, no rules disagreements.
  `v4.2-ultra` does not beat Pentobi level 6 under the preregistered rule. v5 defined as the
  Pentobi-port line. Tracker created. Full results draft: `tmp/x1-results.md` (to be merged into
  `research_paper/v6_native_and_learning_results.md`).
- 2026-11-12 — E5 finished: `resnet2-b8w96` test KL 0.336, top-1 48.4%, margin R² 0.406 (old
  ResNet 0.338 / 48.1% / 0.397); best checkpoint at step 6,000 of 15,000. E6 screen started.
- 2026-11-12 — D1 done (findings above). First port retargeted from P1 to P4/P5. S1 config-only
  screen against Pentobi level 6 defined and started.
- 2026-11-12 15:22 — All matches paused at Paul's request. E6 screen: control arm complete, P1
  half done. S1: base complete, `W96` at 69 of 100 seeds, 11 arms not started. Both drivers resume
  by rerunning their commands (they skip completed work). S1 liveness check: `MAXN` plays the same
  games as base against Pentobi level 6, because Blokee almost never leads by 8.
- 2026-11-12 — Added N10–N15 and the v6 candidate structures (section E) from a literature pass.
- 2026-11-12 — Versioning rule set: v5.0 = all Pentobi ports; v5.1+ = one significant addition each.
- 2026-11-12 — Screens resumed (S1 without the no-op `MAXN` arm). PC runs preregistered and written into `docs/E6_RUNBOOK.md`.
- 2026-11-13 — E6-P0 confirmation on the PC passes: root prior only, Mac `resnet2-b8w96-g18500-s0`,
  800 seeds from 77,100,000, **+0.83 [0.56, 1.09]** versus `v4.2-ultra`, first place 31.8%, 136 ms/move,
  1.0 network evaluation per move. This makes the v2 root prior a promotion candidate. It says
  nothing about the depth-1 or value channels, which are still unplayed.
- 2026-11-13 — E5 PC arms finished. Validation losses 7.171 / 7.172 / 7.172 for `b8w96` / `b12w128` /
  `b16w160`, at 19.2k / 8.0k / 3.2k positions per second. `resnet2-b8w96-g36k-s0` is selected: lowest
  validation loss, and at least twice as fast as either larger arm. It does not replace the Mac
  checkpoint in E6-P0. Fuel: the margin head still adds about +0.075 R² over the search value on
  the mean target, the same on all three arms.
- 2026-11-13 — v7 seat confirmation finished on the PC (1,600 seeds from 75,000,000). H1 passes:
  `agg140` from blue, Δ win share +3.65 pp [0.60, 6.67]. H2 does not: `flat` from yellow, −1.14 pp
  [−3.38, 1.10]. Write-up: `research_paper/v7_seat_strategy_results.md`. Root-seat dispatch and the
  promotion match are not started.
- 2026-11-13 — PC Pentobi level 6, exploratory, 100 seeds from 79,400,000. Validity gate passed (20/20).
  `v4.2-ultra` −9.99 [−11.05, −8.85], first place 7.8%, 82 ms/move against Pentobi at 60 ms/move.
  `ei-gen6` −9.58 [−10.75, −8.43], first place 7.5%, 93 ms/move. Seed-paired difference
  +0.41 [−1.00, +1.75], so the E4 network does not advance against level 6.
- 2026-11-13 — Overnight on the Mac. **P4/P5 accepted as the first v5.0 port**: +5.32 [+4.30, +6.31]
  against Pentobi level 6 on 200 fresh seeds (−4.93 against −10.25) at 0.93× cost; +2.13
  [1.55, 2.75] against `v4.2-ultra` directly. Gap to level 6 roughly halved; still losing.
  E6 screen finished: no arm beats the root-prior control. S1 screen finished: `W96` and
  `W400open` cleared it and went to confirmation. Both implementation agents were stopped by a
  usage limit from about 01:10 to 04:40, so N10 (tuning) lost its window: tuner being built, real
  run deferred. S2 (config screen on the P4/P5 base) preregistered and started.
