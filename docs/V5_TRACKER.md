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

- **Named 2026-11-14 (Paul): `v5.0-ultra` = `engine-rs/configs/v5.0-ultra.json`**, a byte-for-byte
  copy of `v5.0-pk-ultra.json` (interior expansion + RAVE + priorLog selection + rank reward +
  last-good-reply, sampled rollouts, equal time; engine `ad66afb` or later). The next clear
  improvement over it, by the acceptance rule, is **v5.1**. New candidates are measured against
  `v5.0-ultra`.

- **Named 2026-11-16 (Paul): the round-6 tier configs are the v5.2 models.** Each is `v5.1-ultra`'s settings at equal
  wall time with one Pentobi level (round 6 calibration, engine `6f63202`):

  | Name | Config | `iterationScale` | Time-matched to |
  |---|---|---:|---|
  | `v5.2-nano` | `engine-rs/configs/v5.2-nano.json` | 0.383 | Pentobi level 1 (1.7 ms/move) |
  | `v5.2-lite` | `engine-rs/configs/v5.2-lite.json` | 0.647 | level 3 (2.5 ms) |
  | `v5.2` (base tier, no suffix) | `engine-rs/configs/v5.2.json` (was `v5.2-base.json`) | 3.545 | level 5 (10.6 ms) |
  | `v5.2-turbo` (turbo, Pentobi level 6) | `engine-rs/configs/v5.2-turbo.json` (was `v5.2-l6.json`) | 23.222 | level 6 (72 ms) |
  | `v5.2-pro` | `engine-rs/configs/v5.2-pro.json` | 224.487 | level 7 (903 ms) |
  | `v5.2-ultra` | `engine-rs/configs/v5.2-ultra.json` | 3948.432 | level 9 (17,069 ms) |

  (When this entry was first written, `v5.2-l6.json` was kept as a reference config, not a tier; see the next entry.) The benchmark is accepted as designed
  (`docs/BENCHMARK.md`): Pentobi levels 1–9 are fixed anchors, and an engine's score is the level at which its
  lone-seat advantage crosses zero, interpolated linearly, with ms/move as the second axis. New candidates are
  measured against the v5.2 config of their tier. The next clear improvement is **v5.3**.

- **Named 2026-11-16 (Paul): the level-6 reference becomes a tier, turbo (Pentobi level 6).** Paul: "The level-6
  reference can be the turbo version of the base model, so like v5.3-turbo as a naming". `v5.2-l6.json` →
  `engine-rs/configs/v5.2-turbo.json` (unchanged content). The v5.2 family is nano, lite, v5.2, turbo, pro, ultra.
  Raw logs keep their old `l6` file names; the read-outs map them.

- **Named 2026-11-16 (Paul): v5.3.** Paul: "Let's do that and name it v5.3". Round 8's interior cap W1A
  (`native.candidates.interiorCap` = floor(4 + 1·√N) at interior nodes, equal time), confirmed at two tiers on
  800 fresh seeds each (N21, N22):

  | Name | Config | `iterationScale` | Time-matched to | v5.3 − v5.2 (confirmation) | Benchmark |
  |---|---|---:|---|---|---:|
  | `v5.3` (base tier) | `engine-rs/configs/v5.3.json` (byte copy of `v5.3-cand.json`) | 3.776 | level 5 | +0.71 [+0.21, +1.22] | 5.16 [5.08, 5.24] |
  | `v5.3-turbo` | `engine-rs/configs/v5.3-turbo.json` (byte copy of `v5.3-cand-turbo.json`) | 25.091 | level 6 | +0.71 [+0.15, +1.28] | 6.15 [6.08, 6.23] |

  The cap was not tried at nano, lite or ultra and was unresolved at pro (+0.18 [−1.38, +1.68], 100 seeds), so
  those tiers stay at their v5.2 configs: the current best family is `v5.2-nano`, `v5.2-lite`, `v5.3`,
  `v5.3-turbo`, `v5.2-pro`, `v5.2-ultra`. Each later tier gains the v5.3 name only when the cap (or something
  else) is confirmed there. New candidates are measured against these; the next clear improvement is v5.4.
  The `-cand` files stay as the configs the round-8 logs were recorded under.

- **Named 2026-11-17 (Paul): v5.3-nano and v5.3-lite.** Paul chose a cap shape per tier ("Option 1 sounds
  good"): at nano and lite v5.3 uses round 9's narrow cap W1C, floor(2 + 0.5·√N), which beat v5.3's W1A shape
  there on the same seeds (N23). Base and turbo keep W1A.

  | Name | Config | Cap | `iterationScale` | Time-matched to | v5.3 − v5.2 (confirmation) | Benchmark |
  |---|---|---|---:|---|---|---:|
  | `v5.3-nano` | `engine-rs/configs/v5.3-nano.json` (byte copy of `v5.3-cand-nano.json`) | W1C (2, 0.5) | 0.363 | level 1 | +0.94 [+0.42, +1.47] | 3.01 [2.84, 3.15] |
  | `v5.3-lite` | `engine-rs/configs/v5.3-lite.json` (byte copy of `v5.3-cand-lite.json`) | W1C (2, 0.5) | 0.647 | level 3 | +1.10 [+0.62, +1.57] | 3.53 [3.44, 3.64] |

  The current best family is `v5.3-nano`, `v5.3-lite`, `v5.3`, `v5.3-turbo`, `v5.2-pro`, `v5.2-ultra`. Pro
  (W1D-ET cleared a 300-seed screen, N24) goes to a fresh-seed confirmation in round 10.

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

**`v5.1-ultra` (accepted 2026-11-14 14:43 by the preregistered round-2 rule; `engine-rs/configs/v5.1-ultra.json`):**

`v5.0-ultra` with interiorInitVisits 1, priorLog exploration 0.4, RAVE weight 1.0 and reward qualityWeight 0.5,
at equal time (`iterationScale` 14.224 = 13.528 / 0.9511). `research_paper/v5_1_candidates_results.md`, round 2.

| Match | Result | First place |
|---|---|---:|
| paired vs `v5.0-ultra`, 800 seeds (89,500,000 + 89,600,000) | **+0.58 [+0.06, +1.11]** (blocks +1.15 / +0.02) | paired +0.31 pp [−1.53, +2.19] |
| 1 × `v5.1-ultra` vs 3 × level 6, 800 seeds (same) | −1.19 [−1.61, −0.79] (`v5.0-ultra` −1.78 [−2.16, −1.38]) | 20.6% (20.3%) |
| same, 400 seeds 89,800,000 (round-2 Stage-3 base arm) | −0.78 [−1.40, −0.13] | 22.6% |
| 1 × `v5.1-ultra` vs 3 × `v5.0-ultra` (`blokee-match`, 200 seeds, 89,400,000) | −0.53 [−1.40, +0.40] | 26.5% |
| 1 × `v5.1-ultra` vs 3 × level 7 (200 seeds, 89,300,000) | −6.88 [−7.69, −6.02] (`v5.0-ultra` X4: −7.85, other seeds) | 12.5% |
| 2 × `v5.0-ultra` + 2 × level 6, all six seat pairs (200 seeds, 89,700,000; parity diagnostic) | ours − Pentobi's −0.91 [−1.56, −0.28]; alternating −3.91, adjacent +0.58 | our share 44.3% (par 50%) |

Caveat (reading): the two 400-seed blocks disagree (+1.15 / +0.02), and the direct match against `v5.0-ultra` reads −0.53. Round 3 replicated the gain against level 6 (+0.70 on 800 fresh seeds; +0.64 [+0.28, +0.99] over 1,600) but not in direct play (−0.51 / +0.06 on 400 seeds each way). **Benchmark note (round 3 B, corrected in round 4):** round 3 read +1.42 [+0.37, +2.47] for per-seat Pentobi processes over the shared one on 200 seeds. A paired 400-seed check in round 4 with per-seat seeding found +0.23 [−0.57, +1.04] (identical seeds also +0.23), so the arrangement makes no measurable difference and earlier levels stand. The standard benchmark mode from round 4 on is per-seat processes with seat-derived seeds.

**`v5.0-ultra` (named 2026-11-14; `engine-rs/configs/v5.0-ultra.json`, identical to `v5.0-pk-ultra.json`, the id the matches below were logged under):**

`v5.0-s4-ultra` + RAVE (weight 0.5, equivalence 100, decay 0.5, all nodes) + priorLog selection
(exploration 0.2) + rank reward with quality bonus (P3B) + last-good-reply (L7), sampled rollouts, at
equal time (`iterationScale` 13.528 = 16 / 1.1827). `research_paper/v5_package_results.md`.

| Match | Result | First place |
|---|---|---:|
| 1 × `v5.0-pk-ultra` vs 3 × Pentobi level 6 (400 seeds, 88,800,000) | **−1.50 [−2.08, −0.93]**; paired vs `v5.0-s4-ultra` **+1.89 [+1.15, +2.65]** | 20.0% (paired +0.25 pp [−2.50, +3.00]) |
| same, 400 seeds 88,400,000 (S6 base arm) | −2.06 [−2.60, −1.52] | 19.2% |
| 1 × `v5.0-pk-ultra` vs 3 × level 7 (X4, 200 seeds, 88,600,000) | −7.85 [−8.66, −7.03] | 11.3% |
| 1 × `v5.0-pk-ultra` vs 3 × level 5 (X4, 200 seeds, 88,500,000) | +2.82 [+2.02, +3.62] | 35.4% |
| 1 × level 6 vs 3 × `v5.0-pk-ultra` (X4, 200 seeds, 88,700,000) | +0.26 [−0.67, +1.21] for Pentobi | 32.5% |

Since S6 (engine `ad66afb`) the same config plays identically about 15% faster (clean 0.845×); spending
that on 18% more iterations (S6T) was null. Also accepted, not the base: `v5.0-pkg-et-ultra` (full
package incl. all-move rollouts at equal time, +1.31 [+0.61, +2.02] on 88,100,000). Previous line:

**Previous v5.0 line (2026-11-13, after S4; `engine-rs/configs/v5.0-s4-ultra.json`):**

`v5.0-p4i-ultra` with `iterationScale` 16 (from 10.383) on the S4 binary (engine `7a1f3ad` and later),
which searches identically and 1.52× faster: 0.995× the clean ms/move of `v5.0-p4i-ultra` on the old
binary, i.e. the same time per move. `research_paper/v5_speed_and_prior_refit_results.md`.

| Match | Result | First place |
|---|---|---:|
| 1 × `v5.0-s4-ultra` vs 3 × Pentobi level 6 (400 seeds, 87,000,000) | **−3.31 [−3.92, −2.71]**; paired vs `v5.0-p4i-ultra` on the same seeds and binary **+1.30 [+0.62, +2.00]** | 18.5% (paired +1.00 pp [−1.31, +3.38]) |

(On an older binary the config plays the same moves about 1.5× slower.) Previous line, for reference:

**Previous v5.0 line (2026-11-13, after P4 at interior nodes; `engine-rs/configs/v5.0-p4i-ultra.json`):**

`v5.0-p4-ultra` + every legal move, fitted prior, value initialisation and no widening at interior
nodes too, at equal time (`iterationScale` 10.383, 1.01× the clean ms/move of `v5.0-p4-ultra`).
`research_paper/v5_p9_p10_selection_results.md`.

| Match | Result | First place |
|---|---|---:|
| 1 × `v5.0-p4i-ultra` vs 3 × Pentobi level 6 (400 seeds, 85,400,000) | **−4.12 [−4.68, −3.56]**; paired vs `v5.0-p4-ultra` on the same seeds **+0.88 [+0.18, +1.56]** | 18.6% (paired +1.81 pp [−0.56, +4.19]) |
| same mechanism at equal iterations (`iterationScale` 16, 1.54× time), same seeds | −3.13 [−3.67, −2.60]; paired +1.86 [+1.20, +2.54] | 20.3% (paired +3.56 pp [+1.31, +5.88]) |
| 1 × `v5.0-p4i-ultra` vs 3 × `v5.0-p4-ultra` (200 seeds, 85,800,000) | +1.56 [0.92, 2.25] | 35.6% |
| 1 × `v5.0-p4i-ultra` vs 3 × Pentobi level 5 (X3, 200 seeds, 86,000,000) | +0.75 [−0.02, +1.48]; paired vs `v5.0-p4-ultra` **+1.52 [+0.54, +2.46]** | 31.0% (paired +4.38 pp [+0.38, +8.25]) |
| 1 × `v5.0-p4i-ultra` vs 3 × Pentobi level 7 (X3, 200 seeds, 86,100,000) | −9.72 [−10.54, −8.87]; paired vs `v5.0-p4-ultra` +0.28 [−0.79, +1.32] | 10.0% (paired −0.50 pp [−3.12, +2.00]) |
| 1 × Pentobi level 6 vs 3 × `v5.0-p4i-ultra` (X3, 200 seeds, 86,200,000) | +3.66 [+2.91, +4.43] for Pentobi (X2's +5.86 was on other seeds) | 41.5% |
| 1 × `v5.0-p4i-ultra` vs 3 × Pentobi level 6, compute (X3, 200 seeds, 86,300,000): as saved / `iterationScale` 16 / 32 | −4.39 / −3.64 / **−1.62 [−2.42, −0.82]**; paired 16 − saved +0.75 [−0.23, +1.68], 32 − saved **+2.77 [+1.69, +3.84]**, 32 − 16 **+2.02 [+1.04, +3.04]** | 17.2% / 18.1% / 25.0% |

X3 ms/move (in-match, own moves 3+, arms run one at a time): Blokee as saved 72.9, at 16 106.4
(1.46×), at 32 202.1 (2.77×); Pentobi level 5 ≈9, level 6 ≈60, level 7 ≈650. Unlike the old config,
extra time now pays (`research_paper/v5_x3_p4i_benchmark_results.md`). Previous line, for reference:

**Previous v5.0 line (2026-11-13, after port P4/P5; `engine-rs/configs/v5.0-p4-ultra.json`):**

| Match | Result | First place |
|---|---|---:|
| 1 × `v5.0-p4-ultra` vs 3 × Pentobi level 6 (200 seeds) | **−4.93 [−5.74, −4.14]** | 16.2% |
| 1 × Pentobi level 6 vs 3 × `v5.0-p4-ultra` (100 seeds) | +5.86 [4.89, 6.90] for Pentobi (unchanged from `v4.2-ultra`) | 48.3% |
| 1 × `v5.0-p4-ultra` vs 3 × Pentobi level 5 (100 seeds) | −0.32 [−1.51, +0.84] | 26.5% |
| 1 × `v5.0-p4-ultra` vs 3 × Pentobi level 7 (200 seeds) | −10.90 [−11.88, −9.94] | 8.3% |
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
| P1 | **Rollout move choice over all legal moves.** P(move) ∝ 5^(piece squares) × 10⁶ per "local" square covered; local = corners opened by the opponents' last moves and their neighbours, counted double if also an own corner. `libpentobi_mcts/State.cpp` (`init_gamma`, `check_move`), `PlayoutFeatures.h`, `LocalPoints.h` | One random own corner, ≤12 placements, uniform random 60% of the time, else size/centre + table | **Tested** 2026-11-13: null, not added (`native.rollout`, built and kept behind the option) | Screen on the P4/P5 base, 100 seeds from 83,000,000, paired Δ vs base: size only −0.30 [−1.85, +1.29]; size + fitted local response −0.09 [−1.38, +1.29]; steep local −0.48 [−2.02, +0.96]. Weights fitted by us on level-6 decisions (`ml/p13_fit_rollout.py`). Costs 1.36–1.77× ms/move (clean run). `research_paper/v5_p1_p3_rollout_results.md` |
| P2 | **Incremental legal-move lists in rollouts** (`State.cpp` `update_moves`). The enabler that makes P1 affordable | Moves re-sampled per ply | **Built** 2026-11-13 (`engine-rs/src/move_lists.rs`; used only by `native.rollout` "all") | Equality gate: 1,118,389 list comparisons over 7,000 random games, all equal to a from-scratch generation. Base lists at the root + packed entries cut the all-moves rollout from ~3× to 1.4–1.8× base |
| P3 | **Rank reward plus quality bonus.** Result = fraction of opponents beaten, ties shared (`libpentobi_base/ScoreUtil.h`); + 0.3·sigmoid of the score's z-score, − a game-length term (`State.cpp` `get_quality_bonus`) | 65% sigmoid of margin over the best opponent, 35% rank (`rankBlend` 0.35, shifted by lead) | **Tested** 2026-11-13: null, not added (`native.reward`, kept behind the option) | Screen, paired Δ vs base: quality weight 0.1 −0.49 [−1.97, +1.07]; 0.25 +0.44 [−0.92, +1.87]; with P1 (fitted local) +0.06 [−1.50, +1.59]. 0.89–0.93× ms/move. Re-test of P3B (P6/P7 run, fresh seeds): screen 400 seeds from 84,000,000 **+0.86 [+0.13, +1.58]** (cleared), confirmation 400 seeds from 84,400,000 **+0.48 [−0.27, +1.23]: not confirmed**, 0.88× ms/move. Descriptive pool of all 900 seeds +0.65 [+0.19, +1.14] (includes the selecting screen; not a decision). **First place falls** (descriptive, not preregistered): paired first-place share −2.75 pp [−7.0, +1.5] (100 seeds, 83M), −1.50 [−3.81, +0.75] (400, screen), −3.50 [−5.81, −1.31] (400, confirmation), pooled 900 seeds **−2.53 [−4.03, −1.03]**: more margin, fewer wins. `research_paper/v5_p6_p7_rave_results.md`. Earlier, vs itself: `rankBlend` 0 / 0.7 / 1.0 showed no clear overall gain (v7 screen) |
| P4 | **Expand every legal move; children start with a value and 3 visits.** Value = parent value × sqrt(gamma / max gamma) (`PriorKnowledge.h` `gen_children`, `SearchParamConst.h` `child_min_count`) | Shortlist 40 (root) / 24, progressive widening, prior only steers exploration | **Added** 2026-11-13 at the root (with P5; `v5.0-p4-ultra.json`); **at interior nodes added** 2026-11-13 (`native.candidates.interiorFull` / `interiorNoWidening` / `interiorInitVisits`; config `engine-rs/configs/v5.0-p4i-ultra.json`, equal time) | **Interior nodes** (P9/P10 run, `research_paper/v5_p9_p10_selection_results.md`): screen 400 seeds from 85,000,000 +1.51 [+0.81, +2.24]; confirmation 400 fresh seeds from 85,400,000 **+1.86 [+1.20, +2.54]** at equal iterations (1.54× clean cost, first place +3.56 pp [+1.31, +5.88]) and **+0.88 [+0.18, +1.56]** at equal time (iterationScale 10.383, first place +1.81 pp [−0.56, +4.19]): accepted, the equal-time config is the new base. Direct vs `v5.0-p4-ultra` +1.56 [0.92, 2.25], first 35.6%. Mean tree depth 3.5 → 4.6 (4.4 at equal time). Before: interior nodes had at most a fitted ordering of the 24-move shortlist (`interiorScorer` fitted). **Root:** Confirmation vs Pentobi level 6, 200 fresh seeds: **+5.32 [+4.30, +6.31]** over `v4.2-ultra` (−4.93 against −10.25), 0.93× ms/move. Directly vs `v4.2-ultra`: +2.13 [1.55, 2.75]. Full expansion with the *old* ordering as prior: +1.06 [−0.33, +2.50] (screen). `research_paper/v5_p4_p5_candidate_generation_results.md` |
| P5 | **Feature-based move priors**: covers an opponent corner or its neighbour, adjacency to own/other pieces, new own corners by number of free neighbours, piece size, local response (`PriorKnowledge.cpp` `compute_features`); weights trainable by softmax (`learn_tool/`) | Hand ordering score through a softmax at temperature 6 | **Added** 2026-11-13 (with P4). Our own 39 features and weights, fitted on Pentobi level 6's moves in 800 games (`ml/p4_fit_prior.py`, `ml/v5-prior-weights.json`); nothing copied from Pentobi | Carries most of the gain: the prior alone in the old 40-move tree +4.29 [+2.88, +5.81] (screen). Held-out, moves 3–8: Pentobi's move in the top 40 86.5% (old shortlist 54.9%). Not confirmed as better: the prior at interior nodes, 10 initial visits, root widening kept |
| P6 | **RAVE** with distance weighting, weight 0.7, child max 2,000, parent max 50,000 (`Search.cpp`, `SearchParamConst.h`) | Placement-level AMAF per tree edge, kept apart and blended with β = ñ/(ñ + n + n·ñ/equivalence) (`native.rave`, built and kept behind the option) | **Rejected** 2026-11-13 at the tested settings | Screen on the P4/P5 base, 400 seeds from 84,000,000, paired Δ vs base: weak (AMAF weight 0.05) −0.34 [−1.05, +0.36]; strong (0.5) **−1.10 [−1.81, −0.37]**; strong, root only −0.26 [−0.99, +0.45]; strong + P7 −0.48 [−1.20, +0.23]; strong + all-legal-moves rollout +0.12 [−0.60, +0.85] at 1.91×. Equivalence 100, distance decay 0.5 throughout. 1.03–1.05× ms/move alone. Earlier piece-level RAVE in the old tree: +0.49 at equivalence 10, −0.39 at 50. `research_paper/v5_p6_p7_rave_results.md` |
| P7 | **Last-good-reply table** (`libboardgame_mcts/LastGoodReply.h`) | LGR-1 with forgetting, tried first in rollouts (`native.lastGoodReply`, built and kept behind the option); progressive history unchanged | **Tested** 2026-11-13: null, not added | Screen, 400 seeds: −0.43 [−1.14, +0.28]; with strong RAVE −0.48 [−1.20, +0.23]. Supplies 9–19% of rollout moves; 0.96× ms/move |
| P8 | **Subtree reuse between moves** (`SearchBase.h` `m_reuse_subtree`) | Fresh tree every move (`treeReuse` unsupported natively) | **Parked** 2026-11-13 (diagnostic only, not built); re-measured 2026-11-13 on `v5.0-p4i-ultra` and 2026-11-14 on `v5.0-ultra`: still parked | **Re-measure on `v5.0-ultra` (2026-11-14)** (48 S6-confirmation level-6 games, 662 decisions, all reproduced): the deeper package tree holds 42 visits at the next own turn, **1.04% of the 4,058 budget** (0.15% on own moves 4–8, 0.61% on 9–14, 3.5% on 15+), about twice the S4 tree's share; still below 5% (`research_paper/v5_1_candidates_results.md`). **Re-measure on the interior-expansion tree** (48 X3 level-6 games of `v5.0-p4i-ultra`, 674 decisions, all reproduced): at the next own turn the previous tree holds 20 visits on average, **0.65% of the 3,115 budget** (0.08% on own moves 4–8, 0.09% on 9–14, 2.7% on 15+); the line now thins 1,050 → 205 → 40 → 20. Below the 5% line (`research_paper/v5_speed_and_prior_refit_results.md`). Before, on the old tree: 48 base games, 630 decisions (all reproduced): the previous tree holds on average 11 visits at the position the engine faces next, **0.23% of the 4,800 budget** (0.00% on moves 4–8, 1.3% on 15+); the line thins from ~1,540 visits after the own move to ~170 and ~26 after the first two replies. Under the preregistered 5% line, not worth building on this base (`examples/p67_probe.rs`) |
| P9 | **Opening rules**: for the first 12 pieces on the board only moves that minimise distance to the centre (`PriorKnowledge.cpp`); an opening book (`opening_books/book_classic.blksgf`); only larger pieces considered early in rollouts (`State.cpp` `get_is_piece_considered`) | Heuristic move for each seat's first three moves; no book | **Rejected** 2026-11-13 (centre rule and large-piece rule built behind `native.opening`; no book) | Screen, 400 seeds from 85,000,000, paired vs base: centre rule on own moves 0–2 with the opening searched (`P9A`) **−1.90 [−2.75, −1.05]**; searching the opening alone (`O0`, control) **−1.50 [−2.33, −0.67]**; rollouts 5-square pieces only below 31 pieces on the board (`P9B`) −0.39 [−1.06, +0.29], first place −2.12 pp. Numbers from level 6's own moves (slack 0 on own moves 0–2; 31 pieces). With the opening shortcut on the centre rule cannot act. `research_paper/v5_p9_p10_selection_results.md`. Earlier: Blokee's own book covered plies 1–2 only and was not matched (`selfplay-results/v36-opening-book-findings.md`) |
| P10 | **Selection rule**: value + prior × 0.4·sqrt(N)·log(N+1) / child count, with a cut-off that skips hopeless children (`SearchBase.h` `select_child`) | PUCT, `cPuct` 1.6, plus history term | **Rejected** 2026-11-13 at the tested settings (`native.selection` rule `priorLog`, built and kept behind the option) | Exploration c·p·sqrt(N)·ln(N+1)/(n+k) with an exact cut-off (a speed device: it changes no choice). Screen, 400 seeds from 85,000,000: c 0.2 **−0.77 [−1.48, −0.06]** (first place −2.56 pp), c 0.1 **−1.49 [−2.24, −0.78]** (−4.94 pp); with interior P4 +0.50 [−0.28, +1.28], and −1.02 [−1.67, −0.36] against interior P4 alone. It concentrates the root and, with interior P4, gives a Pentobi-like depth (6.1 vs level 6's 5.6), but loses strength. c chosen to match level 6's tree shape. Earlier, S2, PUCT kept: `cPuct` 0.8 +0.11 [−1.40, +1.53]; `cPuct` 3.2 −2.10 [−3.53, −0.64] |
| P11 | **Simulation budget grows through the game**: × 0.7·exp(0.1·i) for a seat's i-th move, cut to 20–30% on moves 0–2 (`Player.cpp`) | `iterationShape` exists (v3.5); flat in `v4.2-ultra` apart from the opening shortcut | **Tested** 2026-11-13 (config-only, S2): null, not added | Rising curve ∝ exp(0.1·i) on the P4/P5 base: −0.31 [−1.70, +1.06], with about 11% more iterations on searched moves |
| P12 | **The elements together** (Pentobi's design is one system: prior-initialised children, RAVE values, a selection rule for them, rollouts and reward matched) | Each port tested alone: RAVE, LGR, P1, P3, priorLog null or harmful | **Added** 2026-11-14 without the all-move rollout (`v5.0-pk-ultra`, equal time); full package at equal time also accepted (`v5.0-pkg-et-ultra`) | `research_paper/v5_package_results.md`. Screen on `v5.0-s4-ultra`, 400 seeds 88,000,000: PKG +3.00 [+2.25, +3.76] at 2.10× cost, PKG-ET +0.80 [+0.05, +1.54], PKG-noROLL +2.41 [+1.71, +3.14] at 1.18×. Inside the package (Δ vs PKG): without RAVE −2.40 [−3.09, −1.70], without rank reward −1.80 [−2.50, −1.04], without priorLog −0.23, without LGR −0.19, without all-move rollout −0.59. Confirmation 88,100,000: PKG +2.80 / PKG-ET **+1.31 [+0.61, +2.02]**; PKG-noLGR +3.67 / -ET +1.28 [+0.58, +2.01]: both accepted. Amendment, 88,800,000: PKG-noROLL +1.64 [+0.89, +2.37], PKG-noROLL-ET **+1.89 [+1.15, +2.65]**: accepted, new base. First place did not move at equal time in any arm (+0.25 to +0.94 pp, all spanning 0). Tree: depth 4.64 → 5.43 (level 6 5.64) |

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
| N10 | **Re-fit the weights against Pentobi** with a noisy-optimisation tuner (CLOP or Bayesian optimisation; the repo's CEM tuner is the starting point): evaluation, ordering, `cPuct`, widening, reward blend | Every weight here was fitted against Blokee's own ancestors, and D1 shows the ordering leans the wrong way. AlphaGo gained about 94 and 103 Elo from Bayesian optimisation of search hyperparameters, landing far from the hand-tuned values. A 400-game block against level 6 takes 5 minutes | **Tuner built** 2026-11-13 (`engine-rs/scripts/n10_tune.py`, CEM, resumable; state in `tmp/n10/`); shake-down generations only, not validated | Starts from `v5.0-p4-ultra`. Liveness pass: the 12 evaluation weights (`phases.*`) and `evalScale` are **dead** in this search (every rollout reaches the end of the game, so the evaluation is never called), which leaves 15 live dimensions: 8 ordering weights, `cPuct`, `priorTemp`, `historyWeight`, `wideningGrowth`, `playoutEps`, `rankBlend`, `playoutTableBlend`. No trend after 7 generations of 840 games (10 seeds per candidate is too noisy). Validation seeds 79,800,000–199 unread. Earlier, vs itself: fitting eval weights by CEM was worth +4.5 |
| N11 | **Learn the move-feature weights from strong games** (Coulom's minorisation–maximisation "Elo ratings of move patterns"; then simulation balancing for the rollout weights) using Pentobi level 7–9 or high-budget v5 games as data | Pentobi's own weights come from a similar softmax fit; training on stronger games or balancing for value accuracy could beat them. Pairs with P5 and P1 | **Tested** 2026-11-13: null, not added (move prior re-fitted on level 7; rollout balancing not run) | 125,729 level-7 decisions (2,240 games, 360 seeds). Offline, held-out level 7, own moves 3+: current −3.131 nats/decision, level-7 fit −3.105, pooled −3.105, pooled with per-move bands −3.088 (top-40 0.898 → 0.901); train = held-out, so capacity-limited. Screen on `v5.0-s4-ultra`, 400 seeds from 87,100,000: L7 +0.26 [−0.48, +0.98], pooled +0.26 [−0.48, +0.99], pooled-fine +0.31 [−0.41, +1.04] (first place +0.25 / +1.31 / +1.25 pp, all spanning 0): none clears, no confirmation. Weights kept in `ml/n11-prior-weights-*.json`. `research_paper/v5_speed_and_prior_refit_results.md`. Earlier here: imitation-trained rollout policy lost to the hand one (26.8% vs 34.6% top-1, weight 0 selected); balancing was never run |
| N12 | **Multi-threaded search** (root or tree parallelism with virtual loss) | Free strength at equal wall time on a multi-core machine: each doubling of simulations is worth about +1.3. Pentobi can do this too (`--threads`), so it is an edge only where we use more cores | Proposed | |
| N13 | **Pondering**: keep searching during the three opponents' turns | In live play a seat thinks once per four turns. Needs subtree reuse (P8) | Proposed (after P8) | |
| N14 | **Spend the budget where the search is unsure**: more iterations on a seat's moves 3–8 | D1: the search reproduces its own move only 39–50% of the time there, and that is where the positional damage starts | **Tested** 2026-11-14 (config-only, S5): null | ×1.5 on own moves 3–8, ×0.6423 on 9+ on `v5.0-s4-ultra`: −0.27 [−0.90, +0.38], using 1.23× the Blokee time per game (the nominal equal-total shape was not equal in time). Earlier: the v3.5 iteration curve was worth +1.00 [0.43, 1.58] vs flat |
| N15 | **Stop rollouts early when the outcome is decided** (all remaining seats sealed → exact packer; score bounds) | Cheaper late-game simulations, so more of them | Proposed (with N3) | |
| N16 | **First-place term in the rank reward** (`native.reward.firstWeight`, R1) | The package's gains came as score margin, not first places | **Tested** 2026-11-14: null, not added (option kept, off by default) | On `v5.0-ultra`, 400 seeds from 89,000,000: f = 0.25 +0.30 [−0.44, +1.03], first place +1.00 pp [−1.81, +3.88]; f = 0.5 −0.24 [−0.92, +0.45], +0.81 pp. `research_paper/v5_1_candidates_results.md` |
| N17 | **Rollout cost trade-offs at equal time** (`playoutMoveCap` 6/24, `playoutCutoff` 32, `playoutCorners` 2, new `native.rollout.epsCap` 4) | Compute is worth +2.1 per doubling, so cheaper rollouts could pay | **Tested** 2026-11-14 on `v5.1-ultra`: none clears, nothing added (`epsCap` kept, off) | 400 seeds 89,800,000, all re-timed to equal time: cap 6 −0.33, cap 24 −0.18, epsCap 4 −0.55 (null); corners 2 −1.00 [−1.75, −0.26]; cutoff 32 −5.26 (costs 2.1×, as the truncation runs the heuristic evaluation). `research_paper/v5_1_candidates_results.md` |
| N18 | **Next-seat pressure** (`native.candidates.nextPressure`, `native.reward.nextWeight`) | The seat after Blokee scores about +2.7 above the game mean in every lone-seat log; Blokee cuts its successor's room less than Pentobi does | **Tested** 2026-11-14 (per-seat processes): none clears, nothing added (options kept, off) | 400 seeds 90,500,000: nextPressure 0.5 (equal time) −0.57, 1.0 −3.78; nextWeight 2 −0.33, 3 −1.00. The windfall shrinks from +2.2 to about 0, but the previous seat gains instead. `research_paper/v5_1_candidates_results.md` |
| N19 | **Move prior re-fitted with mobility features** (own gain in legal placements, placements removed from each opponent; `native.candidates.model` extra features, `interiorModel`) | Stage C (round 3): Blokee's middle-game moves remove fewer placements and gain fewer than Pentobi's | **Tested** 2026-11-14 on `v5.1-ultra` (per-seat processes): not added (options kept, off) | Offline held-out (level-6 decisions): log-lik −2.918 → −2.846, top-1 0.277 → 0.289, top-5 0.579 → 0.600 (mostly from the own-gain count). Root-only exact (1.01×): screen +0.85 [+0.16, +1.55] on 91,600,000, confirmation −0.30 [−1.06, +0.46] on 91,700,000 → not accepted (800 pooled +0.27). Cheap root variant +0.37 (null). Interior use costs ≈15× (move lists at every expansion): −8.03 at equal time. `research_paper/v5_1_candidates_results.md` |
| N20 | **Iteration spread over a seat's own moves** (`search.iterationShape`, existing option) | Blokee runs flat iterations per move (its time per move falls about tenfold over a game); Pentobi level 6 runs about 6× more simulations late than early | **Tested** 2026-11-15 on `v5.1-ultra` (per-seat): null, nothing added | Equal time per game, 400 seeds 93,300,000: middle-heavy −0.24, its reverse +0.11, Pentobi's shape +0.12, equal time per move −0.64 [−1.30, +0.05]. `research_paper/v5_1_candidates_results.md` |

Already tried and closed in the old tree, listed so they are not re-proposed by accident: implicit
max^n backups (null at α 0.10 and 0.20, v4 report §9.4), a learned leaf value *replacing* rollouts
(−4.5 to −16), value-of-computation control and root racing (v3.7). Any of these may be reopened
under a new v5 base, with a note here saying why.

| N21 | **Speed with play unchanged at large budgets** (round 8 Lead 1) | Iterations per ms appeared to fall from about 100 (base) to 69 (ultra); 8 GB per ultra search | **Tested** 2026-11-16: no speed candidate | Clean, one thread, same positions: iterations/s −9% from turbo to pro, −21% to ultra (not −31%); 3.5–4.0 KB per iteration (not 8). `select` is 27% (pro) / 37% (ultra) of the time, as per-edge arithmetic. S8a (edge-cached child values, identical play): 0.97× at pro, 1.015× at ultra, +18% memory, reverted. Nothing exact reaches 10%; no re-calibration. `research_paper/v5_1_candidates_results.md`, round 8 |
| N22 | **Interior cap** (`native.candidates.interiorCap`, W1): at interior nodes only the first `floor(init + growth·√N)` children by prior are considered; nothing forced open | Round 7 B: the tree stays shallow and broad; RAVE pulls low-prior moves in | **Candidate** 2026-11-16 (W1A, (4, 1), at equal time): accepted at base and turbo, not at pro | Screens vs v5.2 (800 seeds base/turbo, 100 pro): W1A-ET +0.72 / +0.86 / +0.18; W1D (16, 4) +0.59 / +0.84 / +0.66; W1C (2, 0.5) −0.02 / −0.32 / −0.68. Confirmations, 800 fresh seeds: base +0.71 [+0.22, +1.19] (first place +2.69 pp), turbo +0.71 [+0.13, +1.26] (+2.00 pp). At equal iterations (D8): +0.86 / +0.56, so the gain is the cap itself. Benchmark: base 5.06 → 5.16 [5.08, 5.24], turbo 6.07 → 6.15 [6.08, 6.23]. Saved `v5.3-cand.json`, `v5.3-cand-turbo.json`. `research_paper/v5_1_candidates_results.md`, round 8 |
| N23 | **Interior cap at nano and lite** (`native.candidates.interiorCap`, shapes W1A (4, 1), W1C (2, 0.5), W1D (16, 4)) | Round 8 accepted W1A at base and turbo; nano and lite were never tried | **Candidate** 2026-11-17: W1C accepted at nano and at lite; W1A also accepted at lite, not at nano | Screens, 800 seeds (nano vs L1 101,100,000; lite vs L3 101,200,000): nano W1A +0.68, W1C-ET +0.98, W1D +0.50; lite W1A +0.74, W1C +1.23, W1D +0.84 (all clear). Confirmations, 800 fresh seeds: nano W1C-ET +0.94 [+0.42, +1.47] (first place +3.47 pp), lite W1C +1.10 [+0.62, +1.57] (+2.97 pp); W1A on the same seeds nano +0.36 [−0.17, +0.87], lite +0.53 [+0.09, +0.96]. Benchmark: nano 2.84 → 3.01 [2.84, 3.15], lite 3.41 → 3.53 [3.44, 3.64]. Saved `v5.3-cand-nano.json` (0.363), `v5.3-cand-lite.json` (0.647), `v5.3-cand-lite-w1a.json` (0.647). `research_paper/v5_1_candidates_results.md`, round 9 |
| N24 | **Interior cap at pro** (W1A-ET, W1D-ET at equal time) | Round 8's 100-seed pro screen was unresolved | **Testing** 2026-11-17: W1D-ET clears a 300-seed screen; confirmation pending | vs L7, 300 seeds 101,500,000: W1A-ET +0.46 [−0.42, +1.35], W1D-ET +1.16 [+0.41, +1.91] (first place +1.58 pp [−1.00, +4.25]). Pooled with round 8 (400 seeds, descriptive): W1A-ET +0.39, W1D-ET +1.03 [+0.36, +1.68]. `research_paper/v5_1_candidates_results.md`, round 9 |

## C. Supporting work

| ID | Item | Status | Result |
|---|---|---|---|
| D1 | **Game anatomy** of the 800 level-6 games, with Pentobi level 7 as a judge of 2,876 positions (`engine-rs/examples/d1_anatomy.rs`, `engine-rs/scripts/d1_report.py`) | **Done** | See "D1 findings" below; full tables in `tmp/d1-results.md` |
| S1 | **Config-only screen against Pentobi level 6**: single-knob variants of `v4.2-ultra`, 100 seeds from 79,300,000, each paired with the base on the same seeds. Exploratory: a filter for what to build and confirm, not evidence (`engine-rs/scripts/s1-screen.sh`) | **Done** 2026-11-13: nothing confirmed (`research_paper/v5_s1_config_screen_results.md`) | Confirmation on 200 fresh seeds: `W96` +0.97 [−0.06, +2.04], `W400open` +1.11 [−0.07, +2.30]; both superseded by P4/P5. base −9.88 [−10.98, −8.78]. Paired Δ vs base, screen only (selection-biased, 11 arms): `W96` (root shortlist 40→96) **+2.03 [+0.45, +3.49]**; `W400open` (shortlist 400, all open at once) **+1.81 [+0.38, +3.30]**; `C0` (no centre pull in ordering) **−3.22 [−4.71, −1.75]**; `O0` (search from move 1) −1.55 [−3.41, +0.34]; `E30` −1.28 [−2.74, +0.20]; `N96` +0.89, `R0` +0.93, `W400` +0.60, `B4` +0.57 (at 1.92× cost), `A140` +0.17, `R100` −0.42, all with CIs spanning 0. Notes in `tmp/s1-results.md` on arms that do more than their label says |
| S2 | **Config-only screen on the P4/P5 base** (`v5.0-p4-ultra`): six single-change arms, 100 seeds from 82,000,000 (`engine-rs/scripts/s2-screen.sh`) | **Done** 2026-11-13: no arm cleared, no confirmation | base −6.03 [−7.08, −4.96]. Paired Δ: `cPuct` 0.8 +0.11; `cPuct` 3.2 **−2.10 [−3.53, −0.64]**; search from move 1 +0.40; `initVisits` 1 +0.95; rising budget curve (P11, config-only form) −0.31; `nodeShortlist` 96 +1.38 [−0.04, +2.86], then **+0.30 [−0.71, +1.35]** on its own 200-seed test (S3): dropped. `research_paper/v5_s2_config_screen_results.md` |
| S4 | **Speed of the interior-expansion search, identical output** (profile-guided: static scorer prefix, packed-key sort, static shift masks, bounded selection over untouched edges, reach-only endgame gate, first rollout corner by n-th bit; engine `7a1f3ad`) | **Added** 2026-11-13; re-timed base **`v5.0-s4-ultra`** accepted | Profile before: rollout 43%, interior-node initialisation 41% (prior scoring 21%, sort 7%, column masks 6%, move generation 5%), selection 9%. Identity for `v5.0-p4i-ultra`, `v5.0-p4-ultra`, `v4.2-ultra`: 900/900 complete search outputs byte-identical, mirrors 0.00 with 80/80 games equal to the old binary, self-play bytes identical, bridge 8/8. Clean ms/move: `v5.0-p4i-ultra` 68.2 → 44.8 (**0.658×**), `v5.0-p4-ultra` 0.852×, `v4.2-ultra` 0.857×. Re-timed: `iterationScale` 16 = 0.995× the old time; confirmation 400 seeds from 87,000,000 vs `v5.0-p4i-ultra` **+1.30 [+0.62, +2.00]**, first place +1.00 pp [−1.31, +3.38]. `research_paper/v5_speed_and_prior_refit_results.md` |
| S5 | **Config-only screen on `v5.0-s4-ultra`** (interior expansion changed the regime): `interiorInitVisits` 1 / 6, prior temperature 0.7 / 1.4, `cPuct` 0.8, budget shape ×1.5 on own moves 3–8 (N14), `rankBlend` 0.7; 400 seeds from 87,400,000 (`engine-rs/scripts/screen-chain.sh`) | **Done** 2026-11-14: no arm cleared, no confirmation | Paired Δ vs base: IIV1 +0.49 [−0.20, +1.20]; IIV6 −0.65 [−1.37, +0.08]; T07 **−1.82 [−2.50, −1.15]** (first place −5.69 pp); T14 +0.27 [−0.44, +1.00]; C08 −0.57 [−1.25, +0.13] (first place **−4.75 pp [−7.31, −2.12]**); SHAPE −0.27 [−0.90, +0.38] at 1.23× Blokee time per game; RB07 −0.48 [−1.21, +0.23] (first place −2.31 pp). base −2.92. `research_paper/v5_speed_and_prior_refit_results.md` |
| S6 | **Second speed pass, identical output** (one forbidden window in the corner scans, reach prefilter, no hash in sampled rollouts; engine `ad66afb`) | **Added** (code); re-timed config **not accepted** | Identity: 1,200/1,200 dumps, mirrors 80/80, self-play bytes, bridge 8/8 for `v5.0-s4-ultra`, `v5.0-p4i-ultra`, `v5.0-p4-ultra`, `v4.2-ultra`; 300/300 on `v5.0-pk-ultra`. Clean ms/move on `v5.0-pk-ultra` 0.845×. Re-timed S6T (`iterationScale` 16.013) vs `v5.0-pk-ultra`, 400 seeds 88,400,000: +0.17 [−0.48, +0.83], first place +0.25 pp: null; ~18% more iterations bought nothing measurable |
| X4 | Benchmark of `v5.0-pk-ultra` (descriptive): level 7, level 5, reverse, 200 seeds each | **Done** 2026-11-14 | Level 7 −7.85 [−8.66, −7.03] (X3 `v5.0-p4i-ultra` −9.72, other seeds); level 5 +2.82 [+2.02, +3.62] (X3 +0.75); reverse, Pentobi level 6 +0.26 [−0.67, +1.21] (X3 +3.66) |
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
- 2026-11-13 07:36 — Mac overnight run ended. Also done since the entry above: S1 confirmation (nothing confirmed), S2 screen on the P4/P5 base (no arm cleared), S3 (`nodeShortlist` 96: +0.30 [−0.71, +1.35], dropped), X2 (level with level 5; −10.90 [−11.88, −9.94] against level 7 on 200 seeds; a second doubling of iterations adds nothing measurable), the N10 tuner (7 shake-down generations, not validated), PC results merged. Next port: rollout policy and reward (P1–P3). All Mac commits are local, not pushed.
- 2026-11-13 — P1–P3 (rollout over all legal moves with incremental lists, rank reward + quality bonus) built behind `native.rollout` / `native.reward` (identity gates pass: parity 8/8, 0.00 mirror, self-play bytes and bridge games equal) and screened against level 6 on 100 seeds from 83,000,000 (prereg `feedc0a`). Six arms, none clears: best P3B +0.44 [−0.92, +1.87]; P1 arms −0.48 to −0.09 at 1.36–1.77× cost. No confirmation; `v5.0-p4-ultra` stays the base. Seeds 83,100,000 and 83,200,000 unread. The Mac was entering system sleep during the first two arms (strength unaffected, in-match timing unusable); later runs use `caffeinate -w`. `research_paper/v5_p1_p3_rollout_results.md`.
- 2026-11-13 — P6/P7 (RAVE, last-good-reply) built behind `native.rave` / `native.lastGoodReply` (identity gates pass: parity 8/8, 0.00 mirror, self-play bytes and bridge games equal) and screened with a P3B re-test against level 6 on 400 seeds from 84,000,000 (prereg `e89cb9b`). Only P3B cleared (+0.86 [+0.13, +1.58]); its confirmation on 400 fresh seeds from 84,400,000 gave +0.48 [−0.27, +1.23]: not accepted. Strong RAVE at every node is harmful (−1.10 [−1.81, −0.37]); every other RAVE and LGR arm null. P8 diagnostic: reuse would carry 0.23% of the budget, parked. `v5.0-p4-ultra` stays the base; seeds 84,800,000–199 unread. `research_paper/v5_p6_p7_rave_results.md`.
- 2026-11-13 — P9/P10 (selection rule `priorLog`, P4 at interior nodes, opening centre rule, large pieces early in rollouts) built behind `native.selection` / `native.candidates` interior keys / `native.opening` (identity gates pass: parity 8/8, 0.00 mirror, self-play bytes and bridge games equal; code `484cc18`, prereg `d6927e9`). Tree-shape diagnostic first: base mean in-tree depth 3.5 (max 7) vs Pentobi level 6 5.6 (max 23); busy interior nodes give their top child 17% vs 69%. Screen, 400 seeds from 85,000,000: only interior P4 cleared (+1.51); confirmed on 85,400,000 at equal iterations +1.86 [+1.20, +2.54] and at equal time +0.88 [+0.18, +1.56]. **New base `v5.0-p4i-ultra`** (the equal-time config); +1.56 [0.92, 2.25] directly vs `v5.0-p4-ultra`. priorLog harmful (−0.77, −1.49), the opening rules harmful or null. Deeper is not better by itself: priorLog on top of interior P4 is deeper still and −1.02 against it. Seeds 85,900,000–001 used for liveness; 83,100,000, 83,200,000, 84,800,000 still unread. `research_paper/v5_p9_p10_selection_results.md`.
- 2026-11-13 20:44 — X3 benchmark of `v5.0-p4i-ultra` (descriptive, no gate; prereg `8a90a5d`; pinned binary byte-identical to the P9/P10 pin, 12/12 + 12/12 identity games equal). Level 5: +0.75 [−0.02, +1.48], paired vs `v5.0-p4-ultra` +1.52 [+0.54, +2.46]. Level 7: −9.72 [−10.54, −8.87], paired +0.28 [−0.79, +1.32] (null). Reverse: Pentobi level 6 +3.66 [+2.91, +4.43] against three copies (X2's +5.86 on other seeds). Compute vs level 6: as saved −4.39, `iterationScale` 16 −3.64, 32 −1.62 [−2.42, −0.82]; 32 − 16 paired +2.02 [+1.04, +3.04], so extra time now pays (2.77× ms for +2.77). Seeds 86,000,000 / 86,100,000 / 86,200,000 / 86,300,000 (200 each) and 86,900,000–002 (identity) used; 83,100,000, 83,200,000, 84,800,000 still unread. `research_paper/v5_x3_p4i_benchmark_results.md`.
- 2026-11-13 22:25 — S4: the interior-expansion search made 1.52× faster with identical output (engine `7a1f3ad`; identity: 900/900 search dumps, mirrors, self-play bytes and bridge games equal for `v5.0-p4i-ultra`, `v5.0-p4-ultra`, `v4.2-ultra`; clean ms/move 0.658× / 0.852× / 0.857×). Prereg `459993f`. Re-timed base (`iterationScale` 16, 0.995× the old clean time) confirmed on 400 seeds from 87,000,000: **+1.30 [+0.62, +2.00]** vs `v5.0-p4i-ultra`, first place +1.00 pp [−1.31, +3.38]; −3.31 [−3.92, −2.71] against level 6. **New base `v5.0-s4-ultra`.** P8 re-measured on `v5.0-p4i-ultra`: reuse would carry 0.65% of the budget (2.7% on own moves 15+), still under 5%, parked. `research_paper/v5_speed_and_prior_refit_results.md`.
- 2026-11-13 23:10 — N11 (prior re-fit on level 7; prereg `ff3ff1a`): offline gains small (0.026 nats/decision for a level-7 fit, 0.043 with per-move bands; the level-6 prior already transfers). Screen on `v5.0-s4-ultra`, 400 seeds from 87,100,000: L7 +0.26 [−0.48, +0.98], pooled +0.26 [−0.48, +0.99], pooled-fine +0.31 [−0.41, +1.04]; none clears, no confirmation, no level-7 benchmark (87,200,000 and 87,300,000 unused, unread). Null. S5 (config screen on `v5.0-s4-ultra`, 400 seeds from 87,400,000) started automatically after it.
- 2026-11-14 00:39 — S5 (config-only screen on `v5.0-s4-ultra`, prereg `ff3ff1a`), 400 seeds from 87,400,000: no arm clears; prior temperature 0.7 harmful (−1.82 [−2.50, −1.15]), `cPuct` 0.8 loses first place (−4.75 pp), `interiorInitVisits` 1 best point estimate (+0.49 [−0.20, +1.20]); budget shape (N14) −0.27 at 1.23× time. No confirmation (87,500,000 unused, unread). `v5.0-s4-ultra` stays the base.
- 2026-11-14 04:20 — Package (P12; prereg `d02e16f`, engine `18e9149`): RAVE with value-initialised interior children and priorLog on the RAVE-blended value made configurable (identity 1,200/1,200). Screen on `v5.0-s4-ultra`, 400 seeds from 88,000,000: PKG +3.00 [+2.25, +3.76] at 2.10× cost, PKG-ET +0.80 [+0.05, +1.54], PKG-noROLL +2.41 [+1.71, +3.14] at 1.18×; RAVE and the rank reward carry the package (−2.40 and −1.80 when removed), priorLog and LGR read as nothing inside it. Confirmation of PKG and PKG-noLGR (with equal-time arms) on 88,100,000 running; amendment (`5322069`) adds PKG-noROLL on 88,800,000 and drops Stage B (IIV1, 88,200,000/88,300,000 unplayed). S6 speed pass built (`ad66afb`, identical output, ~19% faster under load); clean re-timing and X4 run after on the final base.
- 2026-11-14 05:30 — P12 confirmation, 88,100,000 (prereg `d02e16f`): PKG +2.80 / PKG-ET +1.31 [+0.61, +2.02]; PKG-noLGR +3.67 / -ET +1.28 [+0.58, +2.01]; both accepted at equal time, saved `v5.0-pkg-et-ultra`. Stage B (IIV1) dropped by the supervising session's amendment (`5322069`); 88,200,000 and 88,300,000 unplayed.
- 2026-11-14 05:50 — Amendment confirmation PKG-noROLL, 88,800,000: equal iterations +1.64 [+0.89, +2.37], equal time +1.89 [+1.15, +2.65]; accepted. **New base `v5.0-pk-ultra`.**
- 2026-11-14 06:12 — S6 (prereg `74911d3`): clean 0.845× on `v5.0-pk-ultra`; re-timed S6T vs base on 88,400,000 +0.17 [−0.48, +0.83]: not accepted; the code stays as a pure speed-up.
- 2026-11-14 07:06 — X4 of `v5.0-pk-ultra`: level 7 −7.85, level 5 +2.82, reverse (Pentobi level 6 vs three of ours) +0.26 [−0.67, +1.21]. Unread and unplayed: 83,100,000, 83,200,000, 84,800,000, 87,200,000, 87,300,000, 87,500,000, 88,200,000, 88,300,000.
- 2026-11-14 08:35 — Paul names the current base **`v5.0-ultra`** (`engine-rs/configs/v5.0-ultra.json`, a copy of `v5.0-pk-ultra.json`); the next accepted improvement will be v5.1.
- 2026-11-14 12:12 — v5.1 candidates (prereg `9683198`; engine `9a8a515` adds `native.reward.firstWeight`, identical output when off). Screen of 15 one-change arms on `v5.0-ultra`, 400 seeds from 89,000,000 (base −1.94): only RAVE weight 1.0 cleared (+0.73 [+0.01, +1.46]). Its confirmation on 89,200,000 read +0.10 [−0.62, +0.88]: **not accepted, no v5.1**. Measured: quality weight 0 −3.61 (the quality bonus is load-bearing), priorLog exploration 0.1 −1.22. First-place weight 0.25/0.5, RAVE equivalence 30/300, decay 0/1, quality 0.5, exploration 0.4 and IIV1 were null. Compute diagnostic (89,100,000, 200 seeds): ×2 iterations +2.05 [+1.14, +2.96], ×0.5 −2.11, about **+2.1 per doubling**, so the curve has not flattened. Clean-up candidates with no measurable loss: default selection (+0.30, 0.93× cost), LGR off (−0.38). P8 re-measured on `v5.0-ultra`: 1.04% of the budget, still parked. Stage 3 not run. 89,300,000 and 89,400,000 are unplayed. `research_paper/v5_1_candidates_results.md`.
- 2026-11-14 16:50 — v5.1 round 2 (prereg `44efd90`; engine `82977fe` adds the bridge's `--mode two-two` and `native.rollout.epsCap`, identical when off). Stage 1, the 800-seed replication on 89,500,000 + 89,600,000: COMBO-ET (interiorInitVisits 1 + exploration 0.4 + RAVE weight 1.0 + quality 0.5, equal time at `iterationScale` 14.224) **+0.58 [+0.06, +1.11]** (blocks +1.15 / +0.02; first place +0.31 pp). **Accepted: `v5.1-ultra`**. IIV1-ET +0.03 and X04 −0.20 were null. Stage 2 parity (two of ours + two level-6 seats, six pairs, 200 seeds 89,700,000): −0.91 [−1.56, −0.28], 44.3% of first places; alternating −3.91, adjacent +0.58. Stage 3 rollout cost at equal time (base `v5.1-ultra`, 89,800,000): no arm clears (cutoff 32 −5.26, corners 2 −1.00, others null), no confirmation, 89,900,000 unplayed. Extra blocks: `v5.1-ultra` vs 3 × level 7 −6.88 [−7.69, −6.02]; vs 3 × `v5.0-ultra` −0.53 [−1.40, +0.40]. `research_paper/v5_1_candidates_results.md`.
- 2026-11-14 19:45 — Round 3 (prereg `216b648`, `79a7580`, `96f64dd`). **A:** `v5.1-ultra` replicates against level 6 on fresh seeds, +0.70 [+0.19, +1.22] on 90,000,000 + 90,100,000 and +0.64 [+0.28, +0.99] over 1,600 seeds; first place +0.4 pp (null). It is not better in direct play: lone v5.1 vs three v5.0 −0.51 [−1.14, +0.10], lone v5.0 vs three v5.1 +0.06 (90,200,000). **B:** giving each Pentobi seat its own `pentobi-gtp` process (engine `dfc727e`, `--gtp-processes per-seat`) raises Blokee's advantage by **+1.42 [+0.37, +2.47]** (first place +4.8 pp; 90,300,000). The shared process lets Pentobi reuse its tree between consecutive own seats, so every lone-seat benchmark so far was about 1–1.5 points harder than a fair arrangement. The next seat's windfall is real (control 90,400,000: +0.13 after an own-process Pentobi seat; per-seat: +2.00 after Blokee). **C:** in the middle game Blokee removes 33.8 of its successor's legal placements per move against Pentobi's 40.0. **D:** `nextPressure` (0.5, 1.0) and `nextWeight` (2, 3) remove the windfall but move it to the previous seat; no arm clears (NP10 −3.78, NW3 −1.00); 90,600,000 unplayed. `research_paper/v5_1_candidates_results.md`.
- 2026-11-14 23:25 — Round 4 (prereg `6225697`, `72261c2`, `6543a11`). Per-seat Pentobi processes, each seeded from the game seed and its seat (`1b74f36`), are the standard benchmark from now on. **Fair benchmark:** `v5.0-ultra` −1.79, `v5.1-ultra` −1.14 vs level 6 (800 seeds 91,000,000 + 91,100,000; paired +0.64 [+0.08, +1.20], first place −0.6 pp); `v4.2-ultra` −8.91; one level-6 seat vs three `v5.1-ultra` +0.80 for Pentobi; two-two −0.56. Clean time, one thread: Blokee 43.8 ms/move, a per-seat level-6 process 71.1 ms/move, ≈6,700 Pentobi simulations per move. **Paired arrangement check** (92,000,000): per-seat − shared +0.23 [−0.57, +1.04], identical seeds the same, so round 3's +1.42 was noise and earlier levels stand. **N19:** offline gain, but in play the root-only arm was not confirmed (screen +0.85, confirmation −0.30); nothing saved.
- 2026-11-15 00:30 — Round 4 end: `v5.1-ultra` vs three level-7 seats (per-seat, 200 seeds 91,300,000) −5.26 [−6.08, −4.40], first place 14.9%. The compute-doubling blocks met the 00:30 cut-off and were not played; 91,800,000 is unplayed.
- 2026-11-15 03:20 — Round 5 (prereg `e2a174b`, `9524f8e`). **Equal wall time:** clean, one thread, per-seat, Blokee 43.0 ms/move against level 6's 70.2. `v5.1-ultra` at `iterationScale` 23.222 (×1.63, time-matched, kept only in `tmp/v52/S1/configs/TM.json`) reads +0.31 [−0.10, +0.74] against three level-6 seats (first place 25.0%) and −0.33 for a lone level-6 seat against three of it. That is parity. Paired against `v5.1-ultra` it is +1.02 [+0.54, +1.48] (93,000,000 + 93,100,000). Compute curve (93,200,000): ×2 +1.60, ×4 +2.36 paired, so returns are flattening. **N20** iteration shapes: all null. Tuner running.
- 2026-11-15 07:50 — Round 5 Stage 3: CEM tuner on `v5.1-ultra`, 13 cost-neutral settings, 29 generations (94,000,000+, shared process). No fitness trend; the final point is close to the start. Validated per-seat on 800 seeds 95,000,000 + 95,100,000: +0.03 [−0.47, +0.52], not accepted, nothing saved. `v5.1-ultra` remains the base.
- 2026-11-15 16:20 — Round 6 (prereg `f994698`, `f5d8cc7`). Paul's tier scheme at equal wall time: `engine-rs/configs/v5.2-{nano,lite,base,pro,ultra}.json` = `v5.1-ultra`'s settings calibrated to Pentobi levels 1/3/5/7/9 (`iterationScale` 0.383 / 0.647 / 3.545 / 224.487 / 3948.432), and `v5.2-l6.json` (23.222, the level-6 time match). Pentobi ms/move by level: 1.7, 2.0, 2.5, 4.1, 10.6, 72, 903, 3,932, 17,069. Each tier vs its level: nano +6.30, lite +1.61, base +0.33 (parity), pro −2.02 (100 seeds); reverse matches agree. Draft benchmark: the Pentobi ladder is monotone (levels read back as 1.99 / 2.95 / 4.05 / 4.86); lite breaks even at level 3.41, base at 5.06; lone level 7 beats three level 6 by +8.22. Stage 4 (five cheap arms per tier for nano/lite/base): nothing accepted. Ultra vs level 9 started 16:17 (3 threads, about 8 GB per search).
- 2026-11-16 04:35 — Round 7 (prereg `0f31eb0`). Scaling diagnosis (no games): from the l6 to the pro budget, 9× iterations add only 1.5 plies of mean depth; iterations per second fall 8%; subtree reuse would carry 1.3% of the pro budget (not built). Pro-tier screen vs level 7 (100 seeds 99,000,000): exploration 0.3 −0.41, 0.25 +0.55, RAVE weight 0.5 +1.18 [−0.07, +2.45], interiorInitVisits 3 (equal time) +1.62 [+0.19, +3.03]. Its confirmation (99,100,000) read +0.79 [−0.80, +2.39]: not accepted. `v5.2-ultra` vs level 9, stopped at 22:00 after 11 complete seeds: −4.14 [−8.55, +0.68]. Draft benchmark break-even levels: nano 2.84, lite 3.41, base 5.06, `v5.2-l6` 6.07, pro 6.67; the Pentobi ladder reads back its own levels within 0.15.
- 2026-11-16 07:50 — Round 7 Stage E (prereg `36fbda0`), vs three level-7 seats on 100 seeds 99,300,000. IIV3-ET −0.54 [−2.21, +1.07], first place −4.2 pp: not accepted. Pooled over 300 seeds (descriptive) +0.62 [−0.29, +1.49]. IIV3 + RAVE weight 0.5 at equal time (cost 1.022, `iterationScale` 219.633): −0.17 [−1.64, +1.32], does not clear. No pro candidate.
- 2026-11-16 10:20 — Paul names the round-6 tier configs the **v5.2** models: `v5.2-nano`, `v5.2-lite`, `v5.2` (base tier; `engine-rs/configs/v5.2.json`, renamed from `v5.2-base.json`), `v5.2-pro`, `v5.2-ultra`; `v5.2-l6` stays a reference. The benchmark is accepted as designed (`docs/BENCHMARK.md`, runner `engine-rs/scripts/bench.sh`, read-out `v53_report.py --bench`, no longer a draft); regenerated from the raw logs, identical to round 7's numbers. Next accepted improvement: v5.3.
- 2026-11-16 18:40 — Round 8 (prereg `a041060`/`7797cdb`, amendment `0b1087b`; engine `f2c01ee`, binary `tmp/v55/bin-w1`). **N21:** the speed fall-off is −9% (pro) / −21% (ultra) on the same positions, and memory is 3.5–4.0 KB per iteration. The one exact change tried (S8a) gave no speed, so there is no speed candidate. **N22, the interior cap W1A (4 + √N children by prior at interior nodes), at equal time:** accepted at the base tier (+0.71 [+0.22, +1.19], first place +2.69 pp) and at turbo (+0.71 [+0.13, +1.26], +2.00 pp) on 800 fresh seeds each. At pro it did not clear (+0.18 [−1.34, +1.63], 100 seeds), and nano, lite and ultra were not played. Saved `engine-rs/configs/v5.3-cand.json` (`iterationScale` 3.776) and `v5.3-cand-turbo.json` (25.091), a v5.3 candidate for Paul to name. Benchmark: base 5.16 [5.08, 5.24] (v5.2 5.06), turbo 6.15 [6.08, 6.23] (v5.2 6.07). The l6 reference is renamed turbo (Paul). Played: 100,000,000–100,000,007; 100,100,000, 100,200,000, 100,400,000, 100,500,000 (800 each); 100,300,000 (100); 100,740,000, 100,760,000, 100,850,000 (200); 100,870,000 (100). Unplayed: 100,600,000, 100,960,000.
- 2026-11-17 03:30 — Round 9 (prereg `8388381`/`9ba3e82`, amendments `9b3abd4`/`7f8f9a9`, `c93038d`/`a91ac4a`; binary `tmp/v56/bin` = round 8's `bin-w1`). **N23:** the interior cap carries to nano and lite. The narrowest shape W1C is best and confirmed on 800 fresh seeds: nano +0.94 [+0.42, +1.47], lite +1.10 [+0.62, +1.57]. W1A is confirmed at lite (+0.53 [+0.09, +0.96]), not at nano (+0.36 [−0.17, +0.87]). Saved `v5.3-cand-nano.json`, `v5.3-cand-lite.json`, `v5.3-cand-lite-w1a.json` for Paul to name. Benchmark nano 3.01, lite 3.53. **N24:** pro vs L7, 300 seeds: W1D-ET +1.16 [+0.41, +1.91] clears, W1A-ET +0.46; the pro confirmation is for a later round. Played 101,100,000, 101,200,000, 101,300,000, 101,400,000 (800 each); 101,500,000 (300); 101,620,000, 101,630,000, 101,640,000, 101,720,000, 101,740,000 (200 each).
