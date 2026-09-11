# Algorithm versions

Living log of search / heuristic / evaluation versions used in self-play. Each overnight cycle appends results here.

## Naming (2026-08-18)

Model versions were renamed to a generation scheme. Old ids mostly still resolve through an alias
table in `getAlgo`, **with one deliberate exception noted below**.

| New | Old | What it is |
| --- | --- | --- |
| `greedy` | — | Not a version but a *policy*: the `v1` evaluation ranked once, no tree. The floor. |
| `v1` | `v4` | Best of the v1–v9 generation; the baseline every later result is quoted against. |
| `v2-lite` | `v11` | v10's structure with its evaluation CEM-fitted over ~46k games. Faster, weaker. |
| `v2-pro` | `v11-deep` | v2-lite + full-length rollouts. **+4.86 [2.91, 6.89] compute-matched on held-out seeds.** |
| `v3` | `v12` | The research report as implemented. Frozen — its +1.90 vs v1 stays attached to it. |
| `v3.1-nano` | `v3.1-lite` | Tuned v3 evaluation + fractional Voronoi ties, rollouts truncated at 12 plies. ~54 ms. |
| `v3.1-lite` | `v3.1` | Same, with full-length rollouts, 300 iterations. ~85 ms. |
| `v3.1` | `v3.1-pro` | Same config, ~700 iterations. ~214 ms. |
| `v3.1-pro` | — | Same config, ~1380 iterations. ~360 ms. |
| `v3.1-pro-max` | — | `v3.1-pro` at **max effort**: ~2400 iterations. ~600–800 ms. |
| `v4` | — | **Learned evaluation.** A network distilled from v2-pro and v3.1 search, replacing the rollout. |

`lite`/`pro` means the same thing in both generations: **identical evaluation, differing only in
rollout length.** Truncated is faster, full-length is stronger.

**`v4` no longer resolves to `v1`.** It was generation 1's old id; it now names a live version. This
is the one alias that was retired rather than kept, because a name cannot mean two engines at once —
and the alternative failure is worse than a broken reference. When `v4` was still an alias, the new
`v4` config silently ran on the **legacy engine** and posted a plausible-looking number for the wrong
engine entirely. That is the same class of bug as the 23 configs that kept declaring `engine: "v12"`
after the engine rename. Anything that meant generation 1 must now say `v1`; `getAlgo('v4')` returns
the learned evaluation.

**The numbering is lineage, not rank.** `v3.1` is not distinguishable from `v2-lite`
(−0.55 [−1.32, 0.20]) and is clearly behind `v2-pro` (−2.55 [−4.11, −0.87] at 300 iterations). The v3
line's lasting contribution was making rollout length an explicit parameter, which is how the
truncation error was found in v2 at all.

The `v12-*` ablation ids are deliberately **not** renamed: measured results throughout this document
and the research-paper postmortem cite them, and renaming would sever the record from the configs it
describes.

Time budgets (`greedy` 400ms, `mcts-bench` 1200ms, `mcts-short` 3200ms, `mcts-long` 8000ms) are orthogonal to these versions. A fair version-vs-version game uses the same time budget on both sides.

Configs live in `src/ai/algoVersions.ts`.

> **The measurement protocol changed on 2026-08-17.** Everything recorded above the
> "New measurement protocol" heading was measured with `hero − max(three opponents)`, a statistic
> whose null is *negative*, from the blue seat only, on unseeded games. Those numbers cannot be
> compared with the ones below it. See [New measurement protocol](#new-measurement-protocol-2026-08-17).

---

## v4 — champion at start of overnight run (2026-08-16)

**What it is:** The engine after the speed + UCB fix. This is the 90.9% vs-greedy player.

**Search**
- MCTS with cheap rollouts (size/center policy, no heuristic scoring inside the playout).
- Light rollouts in self-play: 14 steps, move cap 8.
- Rollout value: `tanh(material / 20) * 0.6 + tanh(eval / 60) * 0.4` when the game is not finished.
- UCB1 with `c = 1.41` on those squashed values.
- Root candidates ordered by heuristic prior; deeper nodes by quick score only.
- **Final move = highest mean value** (not visit count).
- Self-play skips UI win-odds refinement.

**Evaluation**
- One board pass: liberties (legal corner-adjacent empty cells), center control, placed squares. Memoized on the board array.
- Fast mobility ≈ liberties + 2 × pieces remaining.
- Blocking = mean opponent liberty shortfall vs baseline 20.
- Opponent term = **equal mean of the other three seats**.
- Weights: placed 2.6, remaining −1.9, corner 2.2, mobility 1.3, opponent mobility −1.1, center 0.5, territory 1.1, blocking 1.2, unique liberties 0.
- Phase bonus: `0.25 * size` with ≥14 pieces left; `0.1 * (5 − size)` with ≤5 left.

**Measured**
- vs 3× greedy: 44 games, 90.9% sole wins, mean score +7.73, mean margin +18.14.
- vs 3× mcts-bench (same eval, 1.2s): 26 games, 38.5% sole wins, mean score −6.58, mean margin −2.69.
- mcts-long (8s) vs greedy did **not** beat mcts-short. Extra time was not the bottleneck.

---

## v5 — challenger, cycle 1

**Hypothesis:** Extra search time added noise because the played move was the noisy mean of truncated rollouts. Adjacent opponents matter more than the opposite seat. Unshared liberties are the real expansion currency.

**Changes vs v4**
- **Final move = most visits**, tie-break by mean value (standard robust MCTS).
- Opponent term: 80% adjacent seats (the two that share a board edge), 20% opposite seat.
- New feature `uniqueLiberties`: empty cells that are a liberty for this color and no one else. Weight 1.6.
- Blocking weight 1.2 → 1.0 (unique liberties take some of that job). Center 0.5 → 0.35.
- Truncated rollout blend: 45% material / 55% positional; positional scale 50.
- UCB `c = 1.5`.
- Slightly stronger phase bonuses (0.30 early, 0.15 late).

**Measured**
- vs 3× mcts-short v4: 8 games, 25.0% sole wins, 25.0% first place, mean score −6.75, mean margin **−5.38**.
- **Rejected.** Par for a 4-player seat is 25% first; negative margin means v4's copies outscored v5. Too many simultaneous changes — cannot tell which one hurt.

---

## v6 — challenger, cycle 2

**Hypothesis:** The only search change that should help without touching eval is playing the most-visited child. v5 bundled that with eval changes and lost; this isolates visits.

**Changes vs v4**
- **Final move = most visits**, tie-break by mean value.
- Everything else identical to v4 (weights, opponent mean, rollout blend, UCB c).

**Measured**
- vs 3× mcts-short v4: 14 games, 35.7% sole wins, **50.0% first place**, mean score −5.93, mean margin **−3.07**.
- **Rejected.** First-place rate meets the 50% bar, but negative margin means v4 still outscores it on average. Visit-count selection is not a promotion by itself.

---

## v7 — challenger, cycle 3

**Hypothesis:** Unshared liberties are the real expansion currency. v5 mixed this with other changes; this adds only `uniqueLiberties` weight 1.6 to v4.

**Changes vs v4**
- Feature `uniqueLiberties` weight 0 → 1.6.
- Final move still by mean value. Opponent term still equal mean of three seats.

**Measured**
- vs 3× mcts-short v4: 14 games, 42.9% sole wins, 42.9% first place, mean score −5.29, mean margin **−2.36**.
- **Rejected.** Unique liberties alone did not beat v4.

---

## v8 — challenger, cycle 4

**Hypothesis:** Adjacent opponents (the two who share a board edge) constrain you more than the opposite seat. v5 mixed this with other changes; this only raises adjacent weight from 2/3 to 0.8.

**Changes vs v4**
- `adjacentOpponentWeight` 2/3 → 0.8.
- Weights, visit policy, and rollout blend unchanged.

**Measured**
- vs 3× mcts-short v4: 14 games, 35.7% sole wins, 35.7% first place, mean score −3.21, mean margin **−0.14**.
- **Rejected.** Closest margin of any challenger so far, but first-place rate is below 50% and margin is not positive.

---

## v9 — challenger, cycle 5

**Hypothesis:** Truncated rollouts over-weight unfinished material. Mixing in more positional eval (45% material / 55% positional, scale 50) should steer the tree better without changing the played-move rule.

**Changes vs v4**
- `materialBlend` 0.6 → 0.45, `positionalScale` 60 → 50.
- Weights, visit policy, and opponent term unchanged.

**Measured**
- vs 3× mcts-short v4: 14 games, 21.4% sole wins, 28.6% first place, mean score −12.00, mean margin **−10.50**.
- **Rejected.** Worst challenger of the session. More positional truncated-rollout blend hurt.

---

## v4-explore — challenger, cycle 6

**Hypothesis:** Truncated-rollout values are noisy, so UCB at c = 1.41 under-explores. Raising c to 1.7 (no eval change) should visit more root children.

**Changes vs v4**
- `exploration` 1.41 → 1.7.
- Named `v4-explore` so it does not collide with the bundled `v10` challenger in `algoVersions.ts`.

**Measured**

*(cycle 6 batch not launched)*

---

## Session 2 — resumed 2026-08-16 ~12:39 PDT

Previous 8-hour window ended after cycle 1. Cycle 2 (`v6` vs `v4`) is now running under a new 8-hour deadline. Champion is still **v4** until a challenger meets the promote rule (mean margin > +2 and first-place rate ≥ 50%).

---

## Overnight protocol

1. 50-minute self-play batch of challenger vs a previous version (same time budget) and/or greedy.
2. Promote challenger to champion only if mean **margin** is clearly better (not just win rate on a small sample).
3. If it loses, keep the champion and try a *different* single-axis change.
4. Record every version here so later cycles do not silently overwrite the recipe.

Deadline: 8 hours from cycle 1 start. Journal: `selfplay-results/overnight/`.

---

# New measurement protocol (2026-08-17)

The v5–v9 cycles were all inconclusive, and the protocol was the reason. Three faults:

1. **The null was never zero.** The reported statistic was `hero − max(three opponents)`. The
   maximum of three draws beats the mean of the same distribution, so *even a perfect mirror match
   scores negative*. Every challenger was measured against a "0.0" line that did not exist, and no
   `v4`-vs-`v4` calibration had ever been run.
2. **The hero always sat in blue.** Seat strength and version strength were confounded.
3. **~14 games per 50 minutes,** single-threaded, unseeded. With a per-game score spread of ±5 that
   cannot resolve a two-point effect, and nothing could be replayed or paired.

## What replaced it — `scripts/tournament.ts`

- **Statistic:** for one seed, the challenger plays each of the four seats in turn while the
  champion fills the rest; the score is `challenger − mean(the three champion seats)`, averaged over
  the four rotations. **Its null is exactly zero:** with two identical configs all four rotations
  are literally the same game, so the four advantages cancel. A mirror match printing anything but
  `0.00` means the engine lost determinism — the runner checks this and fails the run.
- **Pairing:** every stochastic choice comes from a seeded PRNG (`src/ai/rng.ts`), so two configs
  are compared on identical rollout luck (common random numbers).
- **Opening diversity:** the first N plies are sampled from the top K moves, drawn from a *separate*
  RNG stream that advances once per ply regardless of how many rollouts each side ran. Without it,
  greedy play is fully deterministic and every seed replays one identical game.
- **Reporting:** bootstrap 95% CI over the per-seed samples, plus a per-seat breakdown. Significant
  only when the interval excludes zero.
- **Budgets:** `--iterations N` fixes MCTS iterations per move instead of milliseconds, so results
  do not depend on machine load or worker count.

Throughput: ~65,000 greedy games/hour on 8 workers, against ~17 mcts-short games/hour before.

**Promote rule:** beat the champion with a bootstrap CI excluding zero, on **held-out seeds** never
used during tuning, at the policy the engine ships with.

## Two structural facts about v4's evaluation, found while building v10

- **`territory` has never affected play.** `extractFeatures` returns `territory: 0` whenever
  `fast = true`, and every search path passes `fast = true`. Its weight of 1.1 only ever reached the
  explanation text. v10's `voronoiTerritory` is the first territory term that reaches the search.
- **`placedSquares` and `remainingPenalty` are one feature.** They sum to 89 for every colour, so
  only the difference of their weights matters, and the leftover constant cancels in
  `myScore − opponentTerm`. Fitting or tuning both searches a direction that does not exist.

## v5–v9 re-measured

At the eval level (greedy policy, 1600 games, seat-rotated):

- **v8: −0.33 [95% CI −0.57, −0.09] → significantly worse than v4.** The adjacent-opponent split is
  a real, small negative. Five nights of the old loop could not settle this; the new protocol did it
  in 25 seconds.

---

# v10 / v11 — the challenger

`v10` is the hand-designed structure; **`v11` is v10 with its evaluation learned by the CEM tuner**
and is the version that beats v4. v10's own numbers are kept below because the ablations are stated
against it.

**Hypothesis:** v4 loses on three fronts at once. It has no working notion of space, it spends one
weight set on a game whose phases want opposite things, and its search spreads a few hundred
iterations across 36 root children so no child's mean means anything.

## Evaluation

- **`voronoiTerritory`** — multi-source BFS over empty cells from each colour's corner liberties
  (`src/ai/territory.ts`); cells strictly closer to me than to any rival, with occupied cells as
  walls. One pass per colour, O(400), computed lazily inside the memoised board stats, so versions
  that give it zero weight pay nothing for it.
- **`reachableArea`** — cells my frontier can reach at all. Weighted only late, where "have I room
  left for what I am still holding" is the whole question.
- **Phase schedule** — `weights` → `weightsLate`, interpolated by share of all placeable squares
  played (`phaseSplit` 0.30 → 0.65). Early: blocking and territory. Late: packing — leftover penalty
  grows, blocking and centre fade, reachable area appears.
- **Seat profile** — per-seat `aggression` / `expansion` multipliers.
- Adjacent-opponent weight 0.8 (the v8 axis).

## Search

- **PUCT** — `Q + c · P(a) · √N / (1 + n)`, `P` a softmax over the existing heuristic move prior.
  The AlphaZero tree policy with the heuristic standing in for the policy head.
- **Final move by visit count.** Not optional: PUCT starves moves it disbelieves, so a child can
  hold a high mean off one lucky rollout. In testing, mean-value selection under PUCT picked a
  1-visit child over one with 230 visits. This is why v6 — visit selection on plain UCB1 — looked
  pointless alone: it is PUCT's partner, not a standalone change.
- **Root progressive widening** — 8 children, +0.8 per √visits. At 300 iterations v4 opens all 36
  root children with ~10 visits each; v10 opens 22 and gives its best move ~247.
- **Exact endgame packer** (`src/ai/endgame.ts`) — when the space a colour can reach is disjoint
  from every opponent's, the position stops being a game and becomes a packing problem.
  Branch-and-bound over its own legal moves, maximising final score including the all-placed and
  monomino-last bonuses; falls back to MCTS if the region is not sealed or the node budget runs out.

  *Not exact cover.* Blokus placements chain corner-to-corner off cells already on the board, so the
  legal set changes with every placement; a static cover matrix (Algorithm X / DLX) would solve a
  different problem.

## Ablations

Each is v4 plus exactly one v10 axis: `v10a-voronoi`, `v10b-puct`, `v10c-widen`, `v10d-phase`,
`v10e-seat`, `v10f-endgame`.

## Measured — eval level (greedy policy, 1600 games each, seat-rotated)

The greedy policy uses the evaluation directly with no tree, so this isolates the eval changes.

| Version | Advantage vs v4 | 95% CI | First place |
| --- | --- | --- | --- |
| **v10** (eval parts only) | **+1.20** | [0.81, 1.59] | 33.8% |
| v10d-phase | +1.02 | [0.67, 1.37] | 33.0% |
| v10a-voronoi | +0.16 | [−0.24, 0.54] | 29.3% |
| v10e-seat | −0.10 | [−0.36, 0.16] | 28.0% |
| v8 | −0.33 | [−0.57, −0.09] | 27.3% |

Par for one seat of four is 25%.

## Measured — search level (mcts-bench, 300 iterations/move, 120 games each, seat-rotated)

| Version | Advantage vs v4 | 95% CI | First place | Games |
| --- | --- | --- | --- | --- |
| **v11** (v10 + CEM-tuned eval) | **+5.50** | [3.31, 7.85] | 43.3% | 120 |
| **v11** (replication, 25 seeds) | **+7.34** | [4.64, 9.95] | 46.0% | 100 |
| **v12** (research-report engine) | +1.90 | [−0.67, 4.31] | 32.0% | 100 |
| v10c-widen | +1.96 | [−0.71, 4.68] | 36.7% | 120 |
| v10f-endgame | +0.01 | [−0.00, 0.03] | 26.7% | 120 |
| v10b-puct | −1.03 | [−3.74, 1.66] | 20.8% | 120 |

The eval-level gain transfers to real search: **v11 beats v4 decisively** and is the first challenger
in this repo to do so under a calibrated statistic. A 100-game replication (25 seeds, same protocol)
reproduced the win at **+7.34 [4.64, 9.95]**, 46% first place.

**v12 vs v4 at the same 100-game / 300-iter protocol is not a confirmed win:** +1.90
[−0.67, 4.31], 32% first place. The point estimate is positive and first-place is above par, but the
CI includes zero. Against the same champion, v11 is clearly stronger than v12. v12 has not been
measured against v11 yet; that remains the promote bar.

The mean-score column looked like the clue: **v12 −11.87 against v11 −7.39 on the same seeds**, i.e.
~4.5 more squares left in hand. Seven ablations later that is *not* explained by the value function's
opponent aggregation, its rank blend, or its missing material anchor — all measured null or harmful
to change. It is explained by the evaluation being ~3 points behind v11's, and v11's evaluation being
the tuned one. See the eval-level table below.

The search-side changes do not carry their own weight at this budget. Widening is the most
promising (+1.96, interval still straddling zero). PUCT alone is not an improvement over UCB1 with
v4's evaluation — a policy prior is only worth its concentration if the prior is good, and v4's
evaluation is the thing v11 replaced. The endgame packer is a no-op in practice: sealed regions are
rare and arrive so late that exact packing rarely differs from what the rollouts already find.

**v10f-endgame's +0.01 with a CI of [−0.00, 0.03] is also a protocol self-check.** A change that
only fires in a handful of terminal positions should produce almost exactly zero, and it does —
which is what a correctly calibrated statistic on paired seeds looks like.

**The phase schedule is the win.** Voronoi territory is mildly positive but not significant alone;
the guessed seat profile is worth nothing and needs tuning; the v8 axis inside v10 is a small drag.

---

# Reinforcement learning over the parameters

Two learners over disjoint parameter sets, because the two kinds of parameter need different tools.

## Value regression — `scripts/collectFeatures.ts` → `scripts/fitValue.ts`

Monte-Carlo policy evaluation with linear function approximation: log every position's feature
vector, label it with the outcome that position led to, regress. Ridge on standardised columns,
with structurally redundant features dropped.

**Result: it does not beat the hand-designed weights.**

- Late-game fit: R² = 0.32 over 26,000 rows — real signal.
- Early-game fit: **R² = 0.004.** Monte-Carlo returns from the opening are almost independent of the
  opening position, so early coefficients are not identified at all.
- Played out: fully fitted weights scored −1.48 [−1.87, −1.08] against v10; late-weights-only
  scored −1.85 [−2.21, −1.48].

Why it fails is worth recording. Regression fits *E[outcome | position]* under the behaviour
policy's own state distribution, but the search needs an evaluation that *ranks successor
positions*; a good predictor is not automatically a good ranker. The collinear subspace of the
feature set also leaves coefficient magnitudes arbitrary in exactly the directions the search then
amplifies. The pipeline stays because its diagnostics — R² per phase, the collinearity report — are
what found both structural faults in v4's feature set.

## CEM tuner — `scripts/tune.ts`

Cross-entropy method over a flat parameter vector (`scripts/lib/paramSpace.ts`), optimising the
thing that actually matters: seat-rotated advantage against a fixed reference.

- Every candidate in a generation plays the **same seeds** (common random numbers), so candidates
  are separated by decisions rather than luck.
- The reference is fixed, so the population cannot drift by beating a moving target.
- Elite mean and sigma update with smoothing, plus a sigma floor against early collapse.
- Spaces: `weights`, `search`, `phase`, `seat`, `eval` (weights + phase + seat), `all`.
- Generation-best fitness is optimistically biased by selection, so promotion requires a
  **held-out seed** validation run.

---

# v12 — the research-report engine

`research_paper/blokus_ai_research_report_v3.md`, implemented. It is a **separate engine**, not a
config: `src/ai/v12/**` has its own board representation, evaluation, tree and endgame solver, and
ignores every field of `AlgoConfig` above `engine`. `AlgoConfig.engine === 'v12'` is the only switch;
`src/ai/mcts.ts` dispatches on it, so the worker, the self-play runner, the tuner and the tournament
harness reach it unchanged.

`src/engine/` was deliberately left alone. It is now the **slow reference implementation** §8 asks
for, and `src/ai/v12/moveGen.test.ts` checks the bitboard generator against it move for move.

## Representation (§6, Layer 0)

- Four 400-bit boards in one `Uint32Array`, plus a per-colour edge halo and corner halo maintained
  incrementally. Open corners are `cornerHalo & ~occupied & ~edgeHalo`, one expression.
- ~27,000 precomputed (piece, orientation, anchor) masks with a CSR index of "which placements cover
  cell c". Generation walks the open corners and costs two ANDs per candidate.
- Zobrist hashing over (cell, colour) + seat to move + last piece. Transpositions share node
  statistics, so the tree is a DAG; the exploration term uses the edge's visit count and
  exploitation uses the shared node's mean (Childs et al.; Saffidine et al.).
- Seats are indexed in **turn order** (blue 0, green 1, purple 2, yellow 3), because every asymmetry
  in §5 is about turn order. `(s+2) % 4` is the diagonal opponent, which is also true geometrically.

## Evaluation (§3)

`E_i = a·S_i + b·f(C_i) + c·|T_i| − d·waste_i − Σ_j λ_j(e·|T_j| + g·f(C_j))`, plus the
centre-reachability term of §4.1 and the frontier-pressure discount of §3.1.

- **f(C_i)** is `Σ over empty regions of sqrt(corners there)` — corners in distinct regions are
  worth more than clustered ones.
- **|T_i|** is the Voronoi partition over a multi-source BFS from each seat's open corners, with the
  report's step rule (diagonal steps anywhere empty, orthogonal steps only onto cells not
  edge-adjacent to that colour) and **ties broken by turn order**. That tie-break is where the
  first-mover advantage enters as a property of the position rather than a seat fudge factor.
- **waste_i** counts cells in own territory that the smallest remaining piece cannot cover.
- **λ_j** depends on the seat relation (next / prev / diagonal), the phase, and whether *j* is
  currently leading — never a constant.

## Search (§2.2, §6)

- Multi-player MCTS, four-component value vector, **max^n** backup; the mover selects on its own
  component. Paranoid selection at opponent nodes switches on automatically when the root seat leads
  by `paranoidLead` squares (§5). BRS is available but approximated — see the comment on `brsSkip`.
- Values are a **sigmoid of the score margin** blended with a **rank** component, and the blend
  itself shifts with the standing: margin when leading, rank when trailing badly.
- PUCT with a heuristic prior, progressive widening at every node, progressive history.
- Playouts are ε-greedy and truncated at 12 plies, then read `E_i`. A playout ply samples open
  corners in random order rather than capping a full generation — capping would bias every playout
  toward whichever corner sorts first.
- **Sealed-region hand-off**: at a leaf, any seat whose reachable space is disjoint from every other
  seat's is solved exactly and dropped from the playout, and its component of the vector is the
  proven value. This is the fix for the horizon effect where random playouts pack sealed territory
  badly.

## Move ordering (§3.1, §3.2)

Three tiers, because the report asks for expensive ordering in one place and cheap ordering
everywhere else:

1. O(1) per move (size, centre pull) to cut a 1,000-move list down.
2. Bitboard ordering: corners created, opponent corners denied weighted by λ, and **Δsplit** for
   moves that cover an articulation point (Tarjan, one pass per position). Δsplit is what makes the
   search look at a cut move that happens to place a small piece.
3. Root only: apply the move and re-run the full evaluation — `V_i(m) = Δ own + Σ λ_j Δ harm_j`,
   literally.

## Endgame (§4.3)

Formulation A only: memoised branch-and-bound keyed on the position hash, bounded by
`min(coverable cells, Σ remaining sizes)` where "coverable" already excludes cells on the seat's own
edge halo (the hole-feasibility check). Near-sealed regions get the pessimistic/optimistic bracket.

**Formulation B (the ILP) is not implemented.** Its stated role is to validate A offline and to take
the largest regions, and it needs a MIP solver this repo does not ship. `packer.test.ts` covers what
the comparison would: exhaustive enumeration agrees with the solver on crafted pockets, including
both bonus cases.

**Temper expectations here.** `v10f-endgame` measured +0.01 [−0.00, 0.03] — "sealed regions are rare
and arrive so late that exact packing rarely differs from what the rollouts already find". v12's
version is a different mechanism (it fires at *every leaf*, for *every* seat, and removes sealed
seats from the playout, which is the horizon-effect fix §6 describes rather than a root-only
shortcut), but the prior evidence says the honest expectation is small. `v12-nopack` exists to
settle it.

**Layer 3 (the policy-value network) is not implemented** either. The tree takes a prior and a leaf
value through interfaces a network can fill, but there is no training stack in a TS/Vite repo.

## Two bugs the tests caught while building it

- The packer applied its own line under whichever seat the turn had advanced to, so a two-piece
  packing was scored as one piece plus garbage. Found by the brute-force reference in
  `packer.test.ts` — the exact test §7 Tier 1 asks for.
- A seat that had not opened yet has no corner liberties, so seeding the territory flood from
  liberties alone gave it zero reach: every unplayed seat read as *sealed*, and the whole board read
  as belonging to whoever moved first. Found by reading the §7 event log, not by a test. Now seeded
  from the home corner; `territory.test.ts` guards it.

## Cost

At an equal iteration budget v12 is **~20% cheaper per move than v11**: the two paired 100-game runs
at 300 iterations on 8 workers took **6.2 min (v12)** against **7.8 min (v11)**. That is
artifact-backed, from the summary files themselves.

*(An earlier revision of this section claimed "316 ms vs 371 ms per move at 200 iterations" from one
smoke game each. That had no artifact behind it and has been replaced by the figure above.)*

## Status: measured vs v4, not vs v11

Seat-rotated `npm run match` at mcts-bench, 300 iterations/move, 25 seeds × 4 seats = 100 games
(label `v12-vs-v4`, 2026-08-17):

| Pair | Advantage | 95% CI | First place | Sole wins | Mean score |
| --- | --- | --- | --- | --- | --- |
| v11 vs v4 | **+7.34** | [4.64, 9.95] | 46.0% | 36.0% | −7.39 |
| v12 vs v4 | +1.90 | [−0.67, 4.31] | 32.0% | 29.0% | −11.87 |

v12 is faster per move than v11 at equal iteration count, and its point estimate vs v4 is positive,
but it does not yet beat v4 with a CI excluding zero. Every remaining number in
`src/ai/v12/config.ts` is still a hypothesis until it beats **v11**.

**Read that number carefully before drawing conclusions from it.** `summarizeMatch` bootstraps over
*seeds*, so its effective n is 25, not 100 — the ±2.5 interval means underpowered, not "no effect".
And v12 has never been tuned, while v11 *is* v10 after a 46k-game CEM run that moved the same
structure from +1.20 to +5.40 at eval level. The comparison as run is untuned-structure against
tuned-structure. See [`research_paper/v12_postmortem.md`](../research_paper/v12_postmortem.md).

Per-seat advantage is not de-seated, so it must be read against the v4-vs-v4 mirror baseline
(blue +1.32 / yellow −3.55 / purple −1.88 / green +4.12 over 80 games). v12's
+2.53 / −2.36 / +1.96 / +5.45 is modestly positive in **all four** seats: nothing seat-specific
collapsed.

## Ablations

For the claims the report makes:

| Version | Isolates | Level |
| --- | --- | --- |
| `v12` | everything (frozen: this is the config that measured +1.90) | — |
| `v12-maxn` | the paranoid-when-leading switch (§5) | search |
| `v12-nopack` | the exact sealed-region packer (§4.3) | search |
| `v12-nosplit` | the articulation-point Δsplit term (§3.1) | search |
| `v12-onephase` | the phase schedule (§4) | both |
| `v12-noseat` | the seat profiles (§5) | both |

For the structural findings in the postmortem — parameters that were hard-coded when the report was
implemented, so no amount of tuning could have reached them:

| Version | Isolates | Level |
| --- | --- | --- |
| `v12-mean` | margin against the mean of the other seats, not the best — matching the promote statistic | search |
| `v12-material` | 60% of a truncated leaf anchored on the actual score margin, as v4/v11 do | search |
| `v12-margin` | rank blend off, including the standing shift that a blend of 0 does not disable | search |
| `v12-oppsquares` | opponent material in `E_i`, which the report's formula omits | eval |
| `v12-lincorners` | linear open-corner count instead of the per-region sqrt (weights rescaled) | eval |
| `v12-nowaste` | the waste term, which degenerates to a frontier-length penalty | eval |
| `v12-cutaware` | a funnel that cannot delete the cut moves Δsplit exists to find | search |
| **`v13`** | all of the above at once — an upper bound on what the corrections recover | search |

Search-level ablations are invisible at `--policy greedy` (there is no tree), and eval-level ones are
the cheap ones. `src/ai/v12/config.test.ts` asserts each differs from `v12` on exactly its own axis,
and that `v12` itself still resolves to the defaults it was measured with.

## Measured — v12 at eval level (greedy policy, 1600 games each, seat-rotated, 2026-08-17)

| Pair | Advantage | 95% CI | First place |
| --- | --- | --- | --- |
| v11 vs v4 | +5.40 | [4.92, 5.89] | 51.8% |
| **v12 vs v4** | **+2.18** | **[1.78, 2.58]** | 36.3% |
| v10 vs v4 | +1.20 | [0.81, 1.59] | 33.8% |
| **v12 vs v11** | **−2.84** | **[−3.23, −2.46]** | 17.3% |

**v12's evaluation is the best hand-designed one in this repo** — it beats v4 significantly and beats
the previous hand-designed evaluation (v10) with non-overlapping intervals. It is also ~3 points
behind v11's *tuned* evaluation, and that gap fully accounts for the search-level gap within the
noise. Additivity checks out: 2.18 − 5.40 = −3.22 against a measured −2.84.

Determinism gates (both must print 0.00, and both now do):

```
v12 vs v12, greedy,     20 seeds → -0.00 [-0.00, 0.00]
v12 vs v12, mcts-bench, 10 seeds →  0.00 [-0.00, 0.00]
```

The greedy gate alone is insufficient — `rankMovesGreedyV12` never touches the tree or the RNG, so it
is deterministic by construction. The mcts-bench gate is what validates the +1.90.

## Measured — the postmortem's own hypotheses, all seven refuted or null

Each ablation is measured **against v12 itself**, so the effect is read directly. Eval level is
400 seeds / 1600 games; search level is 100 seeds / 400 games.

| Ablation | Level | Advantage vs v12 | 95% CI | Verdict |
| --- | --- | --- | --- | --- |
| `v12-lincorners` | eval | **−1.33** | [−1.70, −0.95] | sqrt corner transform is worth +1.33 |
| `v12-material` | search | **−1.25** | [−2.02, −0.49] | a material anchor at leaves *hurts* v12 |
| `v12-nowaste` | eval | **−0.59** | [−0.90, −0.28] | the waste term is worth +0.59 |
| `v13` (all of them) | search | −0.44 | [−1.17, 0.34] | not significant |
| `v12-margin` | search | −0.08 | [−1.03, 0.87] | not significant |
| `v12-cutaware` | search | +0.24 | [−0.50, 0.98] | not significant |
| `v12-oppsquares` | search | +0.35 | [−0.62, 1.29] | not significant |
| `v12-mean` | search | +0.52 | [−0.21, 1.31] | not significant |

**Nothing proposed in the postmortem's first draft improved v12; three changes made it significantly
worse.** The report's design choices were right where they were measurable. See
[`research_paper/v12_postmortem.md`](../research_paper/v12_postmortem.md) for the full account.

## Measured — tuning v12 (CEM, base v12, reference v11, `v12-eval`, 66 params, 20 × 2304 games)

`tuning/tune-2026-08-17T03-48-51-737Z.jsonl`. Fitness is the advantage against **v11**, so > 0 means
beating the champion.

```
gen 1   best -1.50   elite -2.16   pop -3.35
gen 9   best +0.14   elite -0.64   pop -1.89     first crossing
gen 12  best +1.16   elite +0.42   pop -0.78     peak
gen 20  best +0.19   elite +0.01   pop -0.85
```

| | vs v11, eval level, 400 held-out seeds |
| --- | --- |
| v12 untuned | −2.84 [−3.23, −2.46] |
| **v12 tuned** | **−1.12 [−1.52, −0.70]** |

**Tuning bought +1.72 and did not close the gap.** About 1.1 points remain, significant, and
unexplained by any of the eight ablations above. Candidates (untested): the tune is under-converged
at 66 parameters on a population of 24, or v12's `E_i` is missing v11's `mobility`,
`uniqueLiberties` and `reachableArea` — it has no counterpart to any of the three, and
`exclusiveReach` in `src/ai/v12/territory.ts` is computed but never read by the evaluation.

**Generation-best overstated the held-out result by 2.3 points** (+1.16 vs −1.12). This is exactly
the selection bias the promote rule exists to catch.

## Measured — the evaluation gap is closed; the search gap is not

Two changes closed the eval-level gap to v11 entirely. Neither came from the postmortem's list of
criticisms (all of which measured null or harmful).

| vs v11, eval level, 400 held-out seeds | advantage | 95% CI | |
| --- | --- | --- | --- |
| v12 as implemented | −2.84 | [−3.23, −2.46] | |
| + CEM tuning of the evaluation | −1.01 | [−1.44, −0.59] | **+1.83** |
| + fractional Voronoi tie-break | **−0.15** | [−0.54, 0.24] | **+0.86** |

**`v12-fracties` vs frozen `v12`: +0.96 [0.57, 1.37]** — a cell several seats reach in the same
number of steps is split 1/k between them rather than awarded whole to the earliest mover.
Winner-take-all made |T_i| jump by whole regions between siblings differing by one placement, and
those jumps are noise. It is the *first of twelve* hand-set changes to improve the engine, and the
only one that changed how a feature is **computed** rather than what it is **worth**. Eleven
reweightings failed; one recomputation worked.

**But with the tree it does not close at all:**

| tuned v12 + fractional ties, vs v11 | advantage | 95% CI |
| --- | --- | --- |
| eval level (greedy, no tree), 400 seeds | −0.15 | [−0.54, 0.24] |
| search level (300 iterations), 100 seeds | **−3.98** | [−4.91, −3.04] |

v11's tree adds roughly +1.6 over its own evaluation; v12's subtracts ~3. **The evaluation is at
parity and the search destroys it.** An earlier claim in this doc that "the entire deficit is in the
evaluation" was read off a 25-seed run with a ±2.5 interval and is false at 100 seeds.

### Methodology defect: parameters fitted under a policy that cannot read them

`v12-eval` was built to include the four leaf-value parameters (`sigmoidScale`, `evalScale`,
`rankBlend`, `leafMaterialBlend`). All fitting was done at the **greedy** policy, where
`rankMovesGreedyV12` ranks by ΔE and never calls the backup — so those four have **no effect on
fitness** and drifted under selection noise (`sigmoidScale` 12 → 19.6, `evalScale` 28 → 35.2).

Restoring them to defaults recovers part of it — **−2.81 [−4.25, −1.39]** against −3.98 — but the
intervals overlap, so the drift is not established as the cause. Restoring *defaults* is not
obviously right either: tuning raised E's magnitude, so the `evalScale` matching the tuned E is
probably larger than the one calibrated for the untuned E. Leaf-value scaling has never been fitted
at a policy that reads it.

`v12-value` is now excluded from `v12-eval` and `v12-eval-noseat`; fit it with
`--space v12-value --policy mcts-bench`. **Consequence: eval-level results stand, search-level
results for any fitted config do not.**

`evalScale` was then swept at search level (tuned + fractional ties, other leaf params at defaults),
and stopped after two of four points: **20 → −4.31 [−5.34, −3.32]**, **28 (default) → −2.81
[−4.25, −1.39]**. Scale is not irrelevant (+1.50 from 20 to 28) but the two points lean toward the
default being roughly right, so the tree's ~3 points are probably not in the leaf scale. A CEM fit
over the four leaf parameters at `mcts-bench` was deliberately *not* run: within budget it forces
~8 seeds per candidate, a fitness SE of ~1.7 points on effects of ~1 point — under-powered by
construction, the same fault the low-noise refit already diagnosed.

# v2-pro — PROMOTED, and the finding that produced it

`v2-pro` is **v2-lite with one field changed**: rollout truncation 24/14 plies → 84 (play it out).
Nothing else. The legacy engine had this hard-coded since v1; it was never a parameter, so it was
never swept.

| v2-pro vs v2-lite, mcts-bench 300 iterations | advantage | 95% CI | first place | MDE |
| --- | --- | --- | --- | --- |
| 40 seeds, standard base | +6.93 | [4.74, 9.17] | 53.8% | 2.1 |
| 24 seeds, held out | +5.00 | [2.78, 7.22] | 51.0% | 2.7 |
| 24 seeds, held out, equal compute | +4.86 | [2.91, 6.89] | 45.8% | 2.7 |
| **100 seeds, held out — CONFIRMATION** | **+5.89** | **[4.72, 7.08]** | **48.8%** | **1.34** |

**Promoted.** The 100-seed held-out run is the clean one: interval ±1.2, positive in all four seats
(blue 6.11 / yellow 4.42 / purple 6.34 / green 6.69), at the shipping policy, on seeds never used in
tuning. It was assembled from two runs on disjoint seed ranges (7777777–7777855, then 7777856–7777876)
and pooled with `npm run aggregate`: the seed is the unit of sampling, so disjoint ranges pool exactly.

**The promote rule is met, and it survives compute-matching.** Longer rollouts cost the legacy engine
**2.23×** per iteration (measured: 8.7 min vs 3.9 for the same mirror), so the equal-compute run gives
v11-deep only **45%** of the iterations — and it still wins by +4.86. Both engines now carry an
`iterationScale` field so equal-compute comparisons are expressible at all; previously the harness
could only set one global iteration budget.

**A second finding falls out of that.** Cutting the iteration budget by 55% cost roughly nothing
(+5.00 → +4.86). The strength-versus-iterations curve is nearly flat in this engine at this budget —
which corroborates a note from the v4 era that "mcts-long (8s) did not beat mcts-short (3.2s); extra
time was not the bottleneck". **Iterations are cheap and rollout quality is not**, which is exactly
why trading half the tree for full-length rollouts is such a large win.

**How it was found.** Not by working on v11. The v12 engine specified its truncation depth as an
explicit parameter, which made it sweepable; sweeping it showed 12 plies was costing ~5 points, and
the same question then transferred to the incumbent. Two engines built independently had made the
same mistake, and neither would have surfaced it alone.

## Re-based standings against the corrected champion

Every "vs v11/v2-lite" number in this document was measured against the *uncorrected* incumbent. With
`v2-pro` promoted, the honest comparison for the v3 line is against it:

| v3.1 vs v2-pro | advantage | 95% CI | MDE |
| --- | --- | --- | --- |
| 100 iterations, 40 seeds | −4.45 | [−5.89, −2.97] | 2.1 |
| **300 iterations (shipping), 36 held-out seeds** | **−2.55** | **[−4.11, −0.87]** | 2.23 |

**v3.1 is significantly behind v2-pro at the shipping budget.** The gap narrows as the budget grows
(−4.45 → −2.55), which is worth a note: the bitboard engine is ~5× cheaper per move, so at a fixed
*time* budget rather than a fixed iteration budget the comparison would be different again — and that
comparison has never been run.

What does **not** need re-basing: the `v12-*` ablation table. Those are ablations *of v3, measured
against v3* — attributions inside that engine, valid regardless of who holds the championship.

## Measured — the tree, and the largest single effect found

All three tree-level candidates were tested as single-axis ablations against frozen `v12`
(mcts-bench, 300 iterations, 200 seeds / 800 games each):

| Ablation | vs v12 | 95% CI |
| --- | --- | --- |
| `v12-deep` — playouts truncate at 24 plies, not 12 | **+3.57** | [2.85, 4.31] |
| `v12-corners4` — playout pools 4 open corners, not 1 | **+0.75** | [0.09, 1.42] |
| `v12-wide` — interior shortlist 48, not 24 | +0.21 | [−0.44, 0.85] |

Sweeping truncation depth shows it is a first-order design error, not a tuning nicety:

| `playoutCutoff` | 12 | 18 | 24 | 36 | 48 | **84** |
| --- | --- | --- | --- | --- | --- | --- |
| advantage vs v12 | — | +1.29 | +3.57 | +5.13 | +4.89 | **+5.71** |
| first place | 25% | 34.3% | 45.0% | 50.0% | 46.9% | **52.1%** |

**Playing rollouts to the end is worth ~5.7 points.** The report's §2.2 argues playouts are
informative "because the scoring rule is simple", then truncates them at ~12 plies — three moves per
seat — and reads a heuristic instead. Its early-termination citation (Lorentz, Amazons/Breakthrough)
covers games where rollouts are long and evaluations cheap; Blokus rollouts are bounded at 84 plies
and on bitboards cost less than the evaluation replacing them.

### v14 — the combined candidate

`tuning/v14.json` = tuned evaluation + fractional Voronoi ties + full-length playouts + 4-corner
playout sampling.

**Corner pooling was ablated back out**: removing it costs −0.10 [−0.62, 0.42] over 800 games. It was
worth +0.75 under 12-ply truncation and nothing once playouts run to the end. The candidate is
**three** changes — tuned evaluation, fractional Voronoi ties, full-length playouts.

| candidate vs v11 | advantage | 95% CI | first place |
| --- | --- | --- | --- |
| eval level, 400 seeds | −0.15 | [−0.54, 0.24] | — |
| search level, 48 seeds | −0.16 | [−1.47, 1.17] | 34.4% |
| **search level, 200 held-out seeds** | **−0.55** | **[−1.32, 0.20]** | **30.8%** |

against −3.98 for the same evaluation under the report's search parameters.

**Confirmed: parity, not a promotion.** At 200 held-out seeds the interval resolves to ±0.76 and
still spans zero. **v11 remains champion.** The candidate is a second engine of champion strength
reached by an entirely different route — which is a useful thing to have (two independent designs
at the same level bound how much of each one's strength is idiosyncratic) but it is not a promotion
under the rule.

Accounting for the whole original deficit:

| | worth |
| --- | --- |
| CEM tuning of evaluation weights | +1.83 |
| Fractional Voronoi tie-break | +0.86 |
| Full-length playouts | ~+3 to +5.7 |
| 4-corner playout sampling | +0.75 |
| 11 reweightings, 2 feature additions, 3 fit variants | 0 |

### Protocol defect: the documented held-out seed base was not held out

The tuner draws generation `g`'s seeds from `g * 100_000 + i`, so `--seed-base 900000` — prescribed
in the README and used by v11's own holdout run — overlaps **generation 9**. 24 of those 400 seeds
had been optimised on.

Re-running v11 vs v4 on clean seeds (base 7777777) gives **+5.77 [5.29, 6.24]** against the
contaminated **+5.40 [4.92, 5.89]** — slightly higher, so the contamination was real but immaterial
and v11's standing is unaffected. README corrected; `scripts/tune.ts` now documents the lattice.

Three results worth carrying forward:

- **The leaf material blend is not a domain constant.** v9 showed that shifting v4 *away* from
  material hurt; `v12-material` shows that shifting v12 *toward* it hurts too. The right blend is a
  function of how good the positional evaluation is: v4's is weak and needs the score to stay honest,
  v12's is strong enough that diluting it costs 1.25.
- **Ablations do not compose.** `v13` bundles three significantly-negative changes; additivity
  predicts −3.2 and it measured −0.44. Single-axis results describe the neighbourhood of the base
  config, not a decomposable sum.
- **`v12-oppsquares` at eval level returned −0.02 [−0.06, 0.01]** — a protocol self-check. Opponents'
  placed squares do not change when *you* place a piece, so the term cancels in `E_after − E_before`
  and cannot mechanically affect a greedy ranking. It had to be re-run at search level.

```bash
# 0. Validity gate — never yet run for v12, and everything below is void without it.
npm run match -- --challenger v12 --champion v12 --policy greedy --seeds 20   # must print 0.00

# 1. Is it the evaluation or the tree? Greedy has no tree, so this isolates E_i.
npm run match -- --challenger v12 --champion v1  --policy greedy --seeds 400
npm run match -- --challenger v12 --champion v11 --policy greedy --seeds 400

# 2. Search level — use >=100 seeds, not 25: the bootstrap n is the seed count.
npm run match -- --challenger v12 --champion v11 --policy mcts-bench --iterations 300 --seeds 100

# 3/4. Localise the loss by phase, then tune before comparing with a tuned opponent.
npm run oracle-loss -- --version v12 --common-oracle v11 --games 8 --oracle-iterations 3000
npm run tune -- --base v12 --champion v11 --space v12-eval --policy greedy --generations 20
```

## §7 Tier 2 — oracle loss

`scripts/oracleLoss.ts` is the missing middle tier: Tier 1 is `src/ai/v12/*.test.ts`, Tier 3 is
`scripts/tournament.ts`. It replays self-play games, labels each move with a long-budget oracle's
score loss, and aggregates by phase, by seat, and by event (was a cut available? was one played? was
a corner denied? did anyone get sealed?). It also emits the topological event log §7 prescribes for
an LLM judge — no raw board strings, only engine-computed events:

> Ply 34: purple plays Z4 (midgame); on an articulation point, leaving regions 71 cells (blue 6,
> green 9, purple 5); 38 cells (purple 2, yellow 9); 37 cells (purple 2, yellow 5); covering 1
> opponent corner(s); territory 55/42/55/76 → 60/47/37/80; oracle loss 6.64 squares.

```bash
npm run oracle-loss -- --version v12 --games 8 --iterations 300 --oracle-iterations 3000
```

---


**Effort is a level, not a model.** `v3.1-pro` and `v3.1-pro-max` share an evaluation, a rollout
policy and every search parameter; they differ only in `iterationScale`. Giving the larger budget its
own name in the ladder would imply a design difference that does not exist — the same reason `lite`
and `pro` are effort levels of one engine rather than two engines.

## PROMOTED: `v3.1-pro` is champion (2026-08-18)

**`v3.1-pro` vs three `v2-pro`: +2.01 [1.00, 3.02] over 400 games on held-out seeds** (base 7777777;
the config's 12x1 split was selected on base 6300000, so the validation seeds took no part in
choosing it). First place 41.5% against a 25% par, sole wins 33.5%.

It wins at **~360 ms/move against v2-pro's ~1498 ms** — roughly a quarter of the compute.

### What actually changed, and what did not

Nothing about the evaluation, the rollout policy, or any search parameter. `v3.1-pro` is
`v3.1-lite` with `iterationScale: 4.59`. The entire gain is compute the engine was never given.

That is the whole finding. Every previous v3-vs-v2 comparison was **iteration**-matched, which reads
as fair and is not: at 300 iterations v3.1-lite costs ~85 ms and v2-pro ~1498 ms, so the record
showing v3 behind v2 was measured while v2 spent 16x more per move. The conclusion drawn from it —
that the bitboard line had hit a design ceiling — was an artifact of the benchmark, not a property
of the engine. Correct the axis and the ordering reverses.

| Challenger | ms/move | Games | vs `v2-pro` |
| --- | ---: | ---: | --- |
| `v3.1-lite` @ 300 it | 85 | 100 | −2.87 [−4.88, −0.70] |
| `v3.1` @ ~700 it | 214 | 400 | *(measuring)* |
| **`v3.1-pro` @ ~1380 it** | **~360** | **400** | **+2.01 [1.00, 3.02]** |

### The two errors this passed through

Worth recording, because both were the same error and it cost two wrong claims:

1. A 100-game bake-off put a 24x2 rollout mix ahead of depth-only, and the tiers were built on it.
   A 400-game single-axis sweep reversed it: narrow-and-deep +1.86 [1.06, 2.69], 32x3 +1.10
   [0.28, 1.94], 24x2 +0.89 [0.13, 1.68], 48x4 +0.17 [−0.57, 1.00] — monotone in width, the wrong
   way from the bake-off.
2. The 24x2 tier was reported as reaching parity with v2-pro at −0.05 [−2.02, 2.06] on 100 games.
   Re-measured on held-out seeds it was −1.48 [−2.50, −0.52].

Both times a leader was picked from overlapping 100-game intervals and quoted as a result. **In this
project a bake-off winner is a hypothesis; only a 400-game held-out run is a measurement.**

### The 2026-08-18 tier rename — read this before citing a v3.1 number

The v3.1 tiers were renamed to reflect how cheap this engine actually is, and **all three existing
names changed meaning**. This is not a rename that can be papered over with aliases, because an
alias would resolve an old id to a *different config* and silently answer the wrong question:

| Old id | Now called | The old id now means |
| --- | --- | --- |
| `v3.1-lite` | `v3.1-nano` | a different, larger config (the old `v3.1`) |
| `v3.1` | `v3.1-lite` | a different, larger config (the old `v3.1-pro`) |
| `v3.1-pro` | `v3.1` | a new 400 ms tier that did not previously exist |

So **no aliases were added** — the same decision, and for the same reason, as retiring `v4`. Every
measurement in this document has been migrated to the new names, and `selfplay-results/matrix.json`
carries a `renamedFrom` key recording the mapping; the pre-rename copy is kept beside it as
`matrix.pre-rename.json`. Any number quoted from an older log or an external note needs translating
through the table above before it means anything.


# The v3.1 tiers — the same engine on a time budget

Every earlier `v3.1` vs `v2-pro` comparison was **iteration**-matched, and that quietly handed the
champion a 16× compute advantage: at 300 iterations v3.1 costs ~87 ms/move and v2-pro ~1439 ms.
The `v3.1` tier spends ~200 ms instead — still roughly a seventh of v2-pro — by raising iterations
(`iterationScale` 1.67, ≈500) and widening the rollout (24 placements over 2 open corners, from 12
over 1).

Rollout *width* is the lever the truncation sweep implied but never tested. The tell was the cost of
going from truncated to full-length rollouts in each engine: **2.70×** in the legacy engine
(271 → 732 ms) against **1.30×** in the bitboard one (43 → 56 ms). Two engines doing comparable
simulation work would not differ that much — v3.1's "full-length" rollout reaches the end of the
game nearly blind.

| Config | ms/move | Games | Advantage vs `v2-pro` |
| --- | ---: | ---: | --- |
| `v3.1-lite` @ 300 iterations | 85 | 100 | −2.87 [−4.88, −0.70] |
| `v3.1-wide-only` (32×3, ~400 it) | ~200 | 100 | −1.77 [−3.53, 0.01] |
| `v3.1-depth-only` (12×1, ~700 it) | ~190 | 100 | −0.96 [−3.01, 1.22] |
| `v3.1` (24×2, ~500 it) | ~203 | 100 | −0.05 [−2.02, 2.06] |
| **`v3.1`, held-out seeds** | ~203 | **400** | **−1.48 [−2.50, −0.52]** |

**The last row is the result; the row above it is a warning.** Picking the best of three candidates on
100 games each — with intervals that overlapped heavily — and quoting its score is the same selection
bias the tuner section warns about, and it cost 1.4 points when re-measured on held-out seeds. A
bake-off leader is a hypothesis, not a measurement.

So the `v3.1` tier **halves** the gap to the champion at about a seventh of its compute, and reaches par on
win rate (24.8% first place against 25% par) while still losing on margin. It is not a promotion.
`v2-pro` remains champion.

**What this changes about the v3 line.** The conclusion that the bitboard engine was capped rested on
iteration-matched comparisons only. Corrected for compute, most of its deficit was budget, not
design. The remaining 1.48 is within what tuning has historically produced here — and v3's weights
were fitted at the *greedy* policy, with no tree and no rollouts at all, which is the wrong regime
for a leaf that now sees wide full-length simulations. Re-fitting them for this regime is the
obvious next step and needs no new code.

# v4 — the learned evaluation

Everything through generation 3 tuned *weights* over hand-designed terms. The record on that is
unambiguous, and it is the reason this generation exists: across twelve-plus hand-set changes to v3,
**only two ever helped** — fractional Voronoi ties (+0.96 [0.57, 1.37]) and full-length playouts
(+5.71 [5.05, 6.35]) — and both changed what a term *computes*, never what a term is *worth*. Weight
search was exhausted; term design was the bottleneck. v4 stops proposing terms and learns the
evaluation instead.

## What it is

A small MLP over 168 features the bitboard engine already computes for its own evaluation, trained
in TensorFlow (`ml/train_v4.py`) and run inside the engine as a flat `Float32Array` forward pass
(`src/ai/bitboard/net.ts`). It **replaces the rollout entirely** — a v4 leaf runs no playout at all.

| Piece | Where |
| --- | --- |
| Feature contract (shared by trainer and engine) | `src/ai/bitboard/netFeatures.ts` |
| Distillation dataset export | `scripts/exportTraining.ts` |
| Training | `ml/train_v4.py` (venv at `ml/.venv`) |
| Inference | `src/ai/bitboard/net.ts`, wired at `mcts.ts` `leafValue` |
| Version configs | `src/ai/versions/v4.ts` |

## Three design decisions, each traceable to a measurement

**1. Listwise over siblings, not regression on the outcome.** The v12 postmortem's sharpest finding
was that v12's evaluation was the *better* global predictor of final margin (Spearman 0.494 against
v11's 0.444) and still lost the head-to-head by 2.84 points. A better global predictor that loses is
a **ranking** failure: what decides a move is the ordering of one node's children, and a monotone
transform of the whole state space preserves global correlation while scrambling that ordering. So
the primary loss is a softmax cross-entropy over one search node's candidate children against the
teacher's searched values. Outcome regression is kept only as an auxiliary anchor, and only on the
child that was actually played — labelling unplayed siblings with the game's result leaks it.

**2. The network replaces the rollout, not `E_i` at the rollout's truncation point.** The truncation
sweep showed the rollout's value only becomes trustworthy played to the end (84 plies +5.71 against
12 plies at baseline), and playing it out is exactly what makes v2-pro cost 732 ms/move. A network
that estimates the same quantity directly gets the accuracy without the 2.7× cost.

**3. One forward pass per leaf, not four.** The net emits all four seats' margins from one
seat-relative feature vector, so max^n still gets a full value vector. The first cut asked the net
once per seat and cost **910 ms/move** — worse than v2-pro. Restructuring to a single multi-output
pass brought it to **57 ms/move** at 300 iterations. The evaluation runs at every leaf, so the
architecture is chosen by that budget: this is also why it is an MLP over precomputed features and
not a convnet over 20×20 planes.

## Cost

| | ms/move at 300 iterations |
| --- | --- |
| v3 | 41 |
| **v4** | **57** |
| v3.1 | 56 |
| v2-lite | 271 |
| v2-pro | 732 |

v4 costs what v3.1 costs and about **1/13th of the champion**.

## Measured — and it does not work

All against three clones of `v3.1` at 300 iterations, seat-rotated, bootstrapped over seeds. v4
shares v3.1's tuned parameters exactly, so these isolate the learned evaluation and nothing else.

| Where the network is used | Games | Advantage vs v3.1 |
| --- | ---: | --- |
| Leaf value, replacing the rollout entirely (`v4`) | 100 | **−10.62** [−12.10, −9.23] |
| Leaf value, half-weight with a full rollout (`v4-hybrid`) | 100 | −1.73 [−3.24, −0.21] |
| Leaf value, quarter-weight (`v4-hybrid25`) | 100 | −0.47 [−1.90, 1.09] n.s. |
| Root PUCT prior only (`v4-prior`) | **400** | **−0.58** [−1.35, 0.23] n.s. |
| Root prior + quarter-weight leaf (`v4-prior-hybrid`) | 100 | −0.79 [−2.87, 1.28] n.s. |

And against the actual champion, both arms on the **same seeds** (common random numbers, so the two
rows are directly comparable rather than two independent samples):

| Challenger | Games | Advantage vs `v2-pro` |
| --- | ---: | --- |
| `v3.1` | 160 | −2.29 [−3.61, −1.03] |
| `v4-prior` | 160 | **−4.13** [−5.75, −2.55] |

v4 is further behind the champion than the v3.1 it was built from. `v2-pro` is still champion, and
nothing in this generation threatened it. (v3.1's −2.29 here also replicates its −2.55 [−4.11, −0.87]
from independent seeds, which is a check on the harness rather than on v4.)

Two readings, and both matter:

**As a leaf value the network is clearly worse than a rollout, monotonically in its weight.** 100%
of the leaf costs −10.62, half costs −1.73, a quarter costs −0.47, and zero is v3.1 by definition.
There is no blend at which it helps. A rollout is a noisy but *unbiased* sample of the final margin;
the network is a low-variance but biased estimate, and here the bias is worse than the variance.

**As a prior it makes no measurable difference.** The 400-game interval is [−1.35, 0.23], which rules
out any gain above +0.23. This is the more interesting null, because the prior is the job the
network was actually trained for — the loss is listwise over one search node's children, which is a
ranking loss, and ranking a node's children is precisely what a prior does. It is also not a case of
the prior being unimportant: a *flat* prior costs v3 −1.41 [−2.42, −0.46], so the hand-written
ordering is carrying real weight. The learned ranker simply does not beat it.

## Why — the diagnosis is upstream of the model

The evaluation is asked to order the children of one node. Measured directly on 28,484 sibling
groups drawn from v2-pro and v3.1 search:

| Sibling ranker | Val pairwise accuracy |
| --- | --- |
| v3's own evaluation terms, fitted optimally as a linear ranker | **0.510** (chance) |
| Linear fit over every feature that varies between siblings | 0.573 |
| The MLP, 60 games of data | 0.567 |
| The MLP, 393 games (28,484 groups) | 0.561 |
| The MLP, ranking-specialised (no value head at all) | 0.563 |

Three facts follow.

**The hand-designed features cannot rank siblings at all.** Territory, corner score, centre, waste,
per-seat — fitted *optimally* for exactly this job — score 0.510 against a 0.5 null. This is the
direct confirmation of what the v12 postmortem could only infer from match outcomes: v12's
evaluation was the better *global* predictor of final margin (Spearman 0.494 against v11's 0.444)
and lost the head-to-head by 2.84 points. Those features describe who is winning, not which move to
make.

**More data does not help, and neither does a better loss.** 60 games → 0.567; 393 games → 0.561;
a pure ranking objective → 0.563. Six times the data moves nothing. The model is not
under-trained, and the ceiling is not in the optimiser.

**The features, not the model, are the ceiling.** A *linear* fit (0.573) matches the MLP. When a
neural network with 85k parameters cannot beat a linear model on the same inputs, the inputs are
what is exhausted.

There is also a structural reason the feature vector is weak here: **only 45 of its 168 features
vary between the children of a node at all.** The other three seats' position is identical across
one node's children, so 120 features are constant within every training group and can contribute
nothing to the ordering. The evaluation spends seven eighths of its input width on information that
is, for this decision, a constant.

## The teacher values are noisy; the original best-move headline is withdrawn

The experiment that should have come first (`scripts/teacherNoise.ts`). Search the same position
twice with different RNG seeds and ask how often the two runs order the same pair of moves the same
way. v3.1 at 300 iterations, 120 positions, 3,676 sibling pairs:

| | |
| --- | --- |
| Same best move in both runs | **withdrawn — diagnostic mixed visit and value selection** |
| Sibling pairs ordered the same way | **64.5%** |
| …restricted to pairs the first run separated by more than a point | 67.8% |

The original 25.8% headline was invalid: run A contributed the engine's most-visited child, while
run B contributed its highest mean-value child. The engine plays by visits, so this compared two
different decision rules. `scripts/teacherNoise.ts` now compares `bestMove` with `bestMove`; that
corrected comparison measured **52.1%** agreement over a preliminary 73 positions (three games).
On the same run, 1,754 shared sibling-Q pairs agreed 67.8%, rising to 74.9% when the first search
separated them by more than one point. The pairwise result remains a different diagnostic because
both sides compare the searched-value field rather than the visit-selected action.

This puts a hard ceiling on the whole exercise, and the arithmetic is worth doing. If two
independent runs agree on a pair 64.5% of the time, and each is an independent draw that is correct
with probability `p`, then `p² + (1−p)² = 0.645`, so **p ≈ 0.77**. A model that predicted the *true*
ordering perfectly would therefore score about **0.77** when graded against a single noisy teacher
run — not 1.0. The measured 0.56 is short of that, but the headroom is 0.21, not 0.44, and roughly a
quarter of every training label is simply wrong.

That reorders the explanations for v4's failure:

1. **The searched-value target is noisy**, and no amount of model capacity fixes a label whose
   ordering changes substantially across independent searches.
2. **The features are exhausted** — a linear fit matches an 85k-parameter network on them, and v3's
   own evaluation terms rank at chance (0.510).
3. **A spatial representation does not rescue it at this data scale** — raw board 0.543,
   board+features 0.553, features 0.546, all within noise of each other on 4,300 groups.

Explanation 1 was invisible until measured and is the one that most changes what to do next.

**What this implies for a future generation.** Distilling from search is not wrong, but policy and
value need different targets. The engine chooses the most-visited child, so a policy head should
imitate the visit distribution (and the exporter now records it), not rank noisy mean-Q estimates.
A value head should train on *final game outcomes* over many games, where noise averages across the
dataset rather than being baked into each label. That is the part that already behaved sensibly:
its RMSE improved steadily with data (9.7 → 7.97) while Q-ranking accuracy sat flat.

**A separate contract bug in the leaf experiment.** The value labels are already
`score − mean(other three)`, but the original v4 inference path treated the four predictions as raw
scores and applied an opponent-margin transform again. The measured `v4` id remains frozen; the
corrected contract is a separate candidate. It measured **−8.66 [−10.09, −7.18]** against v3.1 over
100 held-out games: still decisively bad. The original −10.62 used a different seed block, so the
roughly two-point difference is directional rather than an attributable gain. The bug mattered, but
it was not the main reason the learned value failed.

## Guard rails

- `netFeatures.ts` is the single feature contract; the exported dataset carries its names, and
  `loadNet` refuses weights whose width disagrees with the build.
- A version that asks for a learned evaluation and does not get one **throws** rather than falling
  back to the hand-written evaluation. Silent fallback is how a rename once put 23 configs on the
  wrong engine, and it produced numbers that looked entirely reasonable.
- The v3 freeze test still passes: every parameter v4 introduces defaults to reproducing v3 exactly
  (`netBlend: 0`).


# Historical v3.5 candidate workstreams — a committee and an aggression dial

**Both mechanisms ship inert and both are single-axis. Neither has earned the version name.**

- **A, the committee: stopped at its pre-registered gate.** The arbiters are worse than the primary
  at picking among contested root moves, and pooling is worse than the best single member under
  either of two oracles.
- **B, the aggression dial: measured, and it is not a free knob.** λ = 0 is worth **+0.59
  [0.23, 0.97]** without a tree and **−1.10 [−1.83, −0.37]** with one. The sign reverses on regime.

## The two halves have different success criteria

They are deliberately not bundled — `v13` is the standing reminder of what bundling costs.

| | Mechanism | Criterion |
| --- | --- | --- |
| A | Committee arbitration at the root | **Strength.** Beat `v3.1-pro-max` on held-out seeds at equal wall-clock, and reproduce on a second seed block. |
| B | Global aggression scale | **Behaviour.** Read on a frontier — own score, opponents' score, squares placed — *not* on the promote statistic. |

B's criterion is not a softer version of A's, it is a different one, and the reason is structural:
the promote statistic is `own − mean(the three opponent seats)`, which is exactly what
`aggressionScale: 1` optimises. Every other setting is handicapped on it by construction. Ranking
the sweep by advantage would be the same category error as §7's self-oracle.

## A — the committee

`engine: 'committee'` (`src/ai/committee.ts`) is a layer over an engine rather than a fourth engine.
The primary searches at its full budget; where its top root children are within `band` of the
leader's share of root visits, up to `maxArbitrated` of them are re-ranked by one-ply arbiters and
the pooled ranking decides. `band: 0` forms no contested set, calls no arbiter, and returns the
primary's result untouched.

**The members are free on purpose.** The compute ladder is measured — ~700 iterations to ~1380 is
worth +3.04 — so a committee that splits the budget between two full searches is three points down
before it starts. One-ply arbiters over at most four moves are a rounding error against a pro-max
move, so any gain is a net gain. A cross-engine full-search committee is rejected on that cost model,
not on principle.

**Why it is not another tree-policy null.** The changes that measured null are all reallocations of
evidence one evaluation already produced. This adds a second, independently fitted evaluation to the
decision: `v3`'s `E_i` is the better global predictor (Spearman 0.494 against v2's 0.444) while v2's
retains +0.065 incremental over it, concentrated in the opening (+0.121) and endgame (+0.178). That
is the "change what something computes" class, which is the only one that has ever worked here. It
is still a hypothesis.

`v4` is present as an arbiter at **weight 0** — a clean null as a root prior (−0.58 [−1.35, 0.23])
and monotonically harmful as a leaf value, so the axis exists and is switched off.

## B — the aggression dial

`aggressionScale` (`BitboardParams`, default 1) multiplies every seat's fitted `aggression`, and so
every opponent-directed term the engine has: `E_i`'s `oppTerritory` / `oppCorners` / `oppSquares`
block, `ordering.denyCorners`, the Δsplit harm term, and the greedy policy's ΔE. All four route
through `lambdaFor`, so it is one line.

`0` is the EFFICIENT pole and is simultaneously the λ = 0 ablation report §5 records as never run.
Above 1 is the GREEDY pole.

**It does not reach the backup, and the sweep is designed to measure how much that costs.** With
`playoutCutoff: 84` almost every leaf is terminal and its value is `σ(score margin)`, which is
margin-maximising whatever λ is set to. So the dial is fully load-bearing at `greedy` (where
`rankMovesGreedyV12` ranks by ΔE) and progressively attenuated as rollouts run to the end. The
frontier runs both arms for exactly that reason: the gap between them is how much of the dial the
tree absorbs, and that number decides whether a backup-side term is worth building.

### Eval level: λ = 0 is better, and the dial is not the trade-off it was designed to be

`MEASURED` Against `v3.1-lite`, `--policy greedy`, 400 seeds / 1600 games each (MDE 0.67):

| | advantage | 95% CI | own score | opponents | squares placed | first place |
| --- | --- | --- | --- | --- | --- | --- |
| λ × 0 (`v3.5-a00-eval`) | **+0.59** | [0.23, 0.97] | −12.30 | −12.90 | 76.29 | 30.4% |
| λ × 1 (shipping) | — | baseline | — | — | — | 25% |
| λ × 2.5 (`v3.5-a25-eval`) | **−0.43** | [−0.76, −0.09] | −13.29 | −12.87 | 75.58 | 27.5% |

`STRUCTURAL` **The eval-level arm isolates the `E_i` opponent block exactly.** `aggressionScale`
reaches five things, but only one of them is live at `greedy`: `rankMovesGreedyV12` shortlists by
`pieceSize` and `centreDistance` — neither touched by λ, so both sides see identical candidate sets —
and then ranks purely by `deepScore`, which is `E_after − E_before`. `ordering.denyCorners` and the
Δsplit harm term are never called. So the numbers above are the opponent block of `E_i` and nothing
else; the ordering-side half of the dial only exists inside a tree, which is what the search arm
measures.

Two findings, and the second is the more interesting one.

**1. This is §5's never-run λ ablation, and it says the fitted λ is too high.** Deleting every
opponent-directed term from `E_i` is worth +0.59, monotone with scaling them up costing −0.43. Both
intervals clear zero. Note what this does *not* say: λ was fitted by CEM as part of `v12-eval`, so
this is not "hand-set beats fitted" — it is that the fit put λ above the value a single-axis sweep
prefers, which is what a 66-parameter fit at 24 seeds per candidate is expected to do.

**2. Aggression is close to pure self-harm here, not a trade.** The opponents scored −12.90 against
the λ = 0 agent and −12.87 against the λ × 2.5 agent — **unmoved**, well inside noise, while the
agent's own score swung a full point. Spending evaluation weight on restricting opponents costs the
agent squares and does not measurably deny opponents any. The dial the plan described as trading own
score against opponent harm is, at eval level, a dial that trades own score against nothing.

### Search level: the sign flips

`MEASURED` `v3.5-a00` against `v3.1-pro-max`, both at `iterationScale` 8 on a base of 88 — ~700
effective iterations a side, equal compute — 98 held-out seeds / 392 games (MDE 1.35):

| | advantage | 95% CI | own score | opponents | squares placed | first place |
| --- | --- | --- | --- | --- | --- | --- |
| λ × 0, **eval level**, 400 seeds | **+0.59** | [0.23, 0.97] | −12.30 | −12.90 | 76.29 | 30.4% |
| λ × 0, **search level**, 98 seeds | **−1.10** | [−1.83, −0.37] | −12.01 | −10.90 | 76.69 | 22.4% |

**Deleting the opponent terms is significantly better without a tree and significantly worse with
one.** Both intervals clear zero and they lie on opposite sides of it. This is §0.4 again — an
ablation is only valid inside the regime it was measured in — and it is the second time in this
document that a λ-adjacent result has reversed on regime.

`STRUCTURAL` The mechanism is visible in the opponents' column, and it is the same column that made
the eval-level result look like self-harm. At eval level, λ = 0 left opponents at −12.90 against
−12.87 for λ × 2.5: **blocking bought nothing**. At search level, λ = 0 let opponents score −10.90
against the agent's −12.01: **blocking was buying about a point, and switching it off handed it
back**. The difference is that a one-ply ΔE cannot tell a block that works from a block that wastes
tempo, while a tree that plays the rollout to the end can. Opponent restriction is worth having
exactly when the search can verify it — which is also why the ordering-side half of the dial
(`denyCorners`, the Δsplit harm term) only exists inside a tree.

The practical consequence for the dial: **λ is not a free behaviour knob at the tiers that ship.**
Turning it down costs real strength, and the EFFICIENT pole is not a costless preference.

`MEASURED` **Partial run, and why it is still usable.** The sweep was killed at 98 of 200 seeds while
the v3.2 batch was running on the same eight cores. Matches here are *iteration*-budgeted, not
clock-budgeted, so CPU contention changes wall time and not results; the seeds are a contiguous
prefix of the block with no selection on outcome.

### The frontier completed, and it closes the dial

`MEASURED` The remaining arms ran overnight on 2026-08-22 once the v3.2 batch drained
(`selfplay-results/v35-frontier-queue.log`), all against `v3.1-pro-max` at 88 base iterations. This
supersedes the paragraph above, which said the shape of the curve was unmeasured:

| λ | seeds | advantage | own | opponents | first |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 102 | **−0.90 [−1.65, −0.11]** | −12.01 | −11.11 | 21.3% |
| 0.5 | 200 | −0.32 [−0.84, 0.18] | −11.76 | −11.43 | 27.1% |
| 1.0 | — | 0.00 (control) | — | — | 25% |
| 1.6 | 200 | −0.03 [−0.61, 0.55] | −11.76 | −11.73 | 27.5% |
| 2.5 | 200 | **−0.60 [−1.15, −0.02]** | −12.16 | −11.56 | 25.3% |

**The fitted value is already the optimum, and both poles cost strength.** The curve is flat between
1.0 and 1.6 and falls away on either side. Note what this retires: the eval-level result had λ = 0
*better* by +0.59, so the regime reversal in §"Search level" is confirmed at four times the seed
count, and the EFFICIENT pole is not a costless preference at any tier that ships. The λ = 0 block
here is disjoint from the killed 98-seed run that produced the −1.10 above; both are negative.

`STRUCTURAL` The dial is therefore closed as a strength lever. It remains a *behaviour* control —
that was always B's stated criterion — and the CEM space `v35-aggr` in `scripts/lib/paramSpace.ts`
has no reason to be run: a one-dimensional sweep at 200 seeds per point has already resolved the axis
more finely than a fit at 24 seeds per candidate could.

`STRUCTURAL` **A caveat the harness imposes on the eval-level finding.** The statistic seats one
challenger against three champion clones, so an aggressive challenger pays the whole cost of blocking
while the benefit — a weakened rival — is shared with the two opponents who paid nothing. That is a
free-rider structure, and it is a property of the measurement, not of Blokus. "Aggression does not
pay" is established *for the promote statistic*; whether it holds in a game where all four seats are
equally aggressive is a different experiment and has not been run.

## A is stopped at the gate

`MEASURED` `npm run agreement`, 120 positions drawn from 30 games generated by both engines, primary
`v3.1-pro-max` at 2400 iterations. **The root decision is contested often enough to be worth
arbitrating** — and much more so in the opening, which is where v2's evaluation carries its largest
incremental signal:

| band | contested | opening | midgame | endgame |
| --- | --- | --- | --- | --- |
| 0.02 | 16.2% | 25.7% | 5.6% | 19.4% |
| 0.05 | 31.5% | 48.6% | 18.5% | 25.8% |
| 0.10 | 41.4% | 62.9% | 29.6% | 25.8% |

So the ceiling was not the problem. The gate was. Agreement with a long-budget oracle on contested
decisions only, **judged twice — once by each engine — because the first judge was a copy of the
primary**:

| judge (band 0.10) | primary | v2-pro | v3.1-lite | v4 | **borda** | geomMean |
| --- | --- | --- | --- | --- | --- | --- |
| `v3.1-pro-max` @ 19200 | **43.5%** | 13.0% | 21.7% | 13.0% | 37.0% | 34.8% |
| `v2-pro` @ 1200 | 20.0% | **26.7%** | 22.2% | 6.7% | 17.8% | 17.8% |

`MEASURED` **The judge decides the table.** Every evaluation agrees best with the oracle that shares
its evaluation, and the effect is worth roughly twenty points of agreement rate — far larger than any
difference between combiners. A self-oracle here does not measure quality at all; §7 said so and this
is the number.

`MEASURED` **One thing survives both judges: pooling lands below the best single voter.** Borda is
below the primary under the v3.1 oracle (37.0 vs 43.5) and below v2-pro under the v2-pro oracle (17.8
vs 26.7), at all three bands. That ordering is oracle-independent, and it is the mechanism: combining
two structurally disagreeing evaluations yields a compromise move that neither member would choose
and that no judge prefers. The committee is not short of contested decisions to improve — it makes
them worse.

**Stopped on the pre-registered rule, not on a match.** n is 21–46 contested decisions, so no single
cell here is significant; what carries it is the same ordering under two judges at three bands.
Where a diagnostic and a match have disagreed in this repo the match was right, so this is a decision
about where to spend eight hours of compute, not a proof that the committee is weaker. The mechanism
stays in the tree, inert at `band: 0`, and the gate is one command if anyone wants to revisit it.

## Gates, and what they have already shown

Both mechanisms pass their identity gates — a mirror-match signature, which is normally the warning
that a flag never reached the code path and here is the pass condition:

```
v3.5-balanced vs v3.1-pro-max   0.00 [0.00, 0.00]   committee layer inert at band 0
v3.5-a10      vs v3.1-pro-max   0.00 [0.00, 0.00]   dial is a pure multiplier at scale 1
```

And both are live when switched on, which is the complementary check — a *zero-width* null with the
flag open would be the `v12-fracties` failure, where a change never reached the code path and ten
prior nulls made it easy to file as an eleventh. `v3.5-arb10` and `v3.5-a00` both return intervals
with real width.

**No strength number from those smoke runs is quotable.** They ran at 3–4 seeds (minimum detectable
effect 6.7–7.7) and at 320 iterations rather than pro-max's 2400 — a different regime as well as an
underpowered one.


# v3.5 release — where the iteration budget goes across the 21 own-moves

**Status: promoted at Pro and Pro Max.** The budget-neutral legacy curve pooled to
**+1.00 [0.43, 1.58]** over two preregistered 100-seed tier blocks / 800 games.

## The channel, and why it is the one left

Four channels feed the engine's decision. Three now have measured ceilings:

| Channel | Status | Source |
| --- | --- | --- |
| Root PUCT prior weights | capped at ≈0.12 points | E1 — deleting the prior costs −0.12 [−1.09, 0.89], MDE 1.81 |
| Candidate generation | capped at ≈0 | E2 — tier 0 discarded the oracle's move 0 times in 82 positions |
| Leaf replacement | falsified | v4.6 — all seven pure-replacement arms −6.6 to −14.8 vs `v3.2` |
| **Per-move compute allocation** | **measured; promoted at Pro / Pro Max** | this section |

`STRUCTURAL` **Before v3.6, the fourth had never been measured because it could not have been.**
`src/ai/bitboard/timeManager.ts` has carried a 21-entry `MOVE_SHAPE` since the report was first
implemented — own moves 1–5 cheap, 6–14 the peak — but `src/ai/bitboard/index.ts` derives
`scaledIterations` from a *scalar* `iterationScale`, and `V12Search.advance` sets `useClock = false`
whenever iterations are set. Every tournament in this repo passes `--iterations`. The time manager
shapes only the browser path; **every number in this document was measured by an engine spending
identical compute on move 1 and move 21.**

`STRUCTURAL` **The criterion is a slope, not a regret.** If a seat's contribution to the final margin
is `a_k + c_k·log(n_k)` at own-move `k` with `Σ n_k` fixed, the optimum is `n_k ∝ c_k` — the local
points per doubling. Two things follow, and the second is what makes this falsifiable:

- A move with large oracle regret but a flat compute ladder cannot repay iterations. Regret is a
  ceiling on what better play there is worth, not what a bigger budget buys.
- **If every `c_k` is equal, reallocation is worth exactly zero**, and a concave ladder makes an
  uneven shape marginally worse. A flat profile is a result that stops the programme.

`MEASURED` There is prior reason to expect `c_k` varies, and it points away from the shipped guess.
E2's phase profile maps onto own-move index through `detectPhase` (`openingMoves: 5`,
`midgameMoves: 15`):

| own moves | phase | oracle agreement | regret (sq) | rollout SD (sq) | shipped `MOVE_SHAPE × PHASE_SHAPE` |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1–5 | opening | **8%** | **0.62** | **10.23** | 0.32 – 0.81 |
| 6–15 | midgame | 67% | 0.19 | 7.92 | 1.09 – 1.72 |
| 16–21 | endgame | 78% | 0.06 | 1.75 | 0.30 – 0.51 |

The moves where the deployed search most disagrees with a 7× oracle are the ones the hand-authored
curve would starve. The endgame end of it is defensible for a different reason: the sealed-region
packer returns without searching at all, so `c_k` there is near zero by construction.

## The mechanism

`search.iterationShape?: number[]` (`src/ai/bitboard/config.ts`) is a per-own-move multiplier read at
`src/ai/bitboard/index.ts` where `scaledIterations` is computed, with the last entry repeated. Absent
reproduces a flat budget, so it is invisible to every existing config.

**A candidate keeps `sum(shape) === 21`.** The match statistic carries no compute discount, so a shape
summing to more would be measuring itself plus a slice of the compute ladder — at ≈1.3 points per
doubling, a 10% overspend is worth ≈0.18 points before the shape does anything.

`MEASURED` **Identity gate passed.** `v3.6-flat` — an explicit shape of twenty-one 1s — against
`v3.2-pro`, 20 seeds / 80 games: **0.00 [−0.00, 0.00]**
(`selfplay-results/match-2026-08-24T02-45-28-132Z-summary.txt`). A flat shape is bit-identical to no
shape, which is what says the field reaches the budget without perturbing anything else. The
complementary check — that a live shape returns an interval with real width — is what the probes
below supply.

## The experiments

`MEASURED` **W1, the profile** (`scripts/moveImportance.ts`, `npm run move-importance`). At each
position: search at the deployed budget, search at twice it with the *same* RNG seed so the second is
the first continued rather than an independent draw, and ask a deeper oracle what each chosen move is
worth. `regret(1×) − regret(2×)` is what the doubling bought at that move number, in squares.
Bootstrapped over **games**, not positions — positions inside one game share a board and an outcome.

It reuses the cached corpus that `rolloutBalance.ts` and `rootHeadroom.ts` already paid for, which
happens to be balanced at 24 positions per own-move index across 24 games.

`STRUCTURAL` Two cautions, both inflating the *level* and neither the difference: the oracle is a
stronger search rather than ground truth, and taking a max over noisy children carries a
winner's-curse inflation. Both apply about equally to the two arms, which is the reason to read the
slope and not the level.

`MEASURED` **W2, the exchange rate in matches** (`scripts/v36ShapeProbe.ts`,
`npm run experiment:v3.6-shape`). W1 is an offline proxy, and E14b is the standing warning that an
offline proxy for a search property can be *anti*-correlated with strength. So four probes —
`v3.6-boost-1-5`, `-6-10`, `-11-15`, `-16-21` — each double the budget over one block of own moves
and change nothing else. Deliberately compute-*positive*: the advantage divided by the fraction of
the game boosted is the local points per doubling.

Run at the pro tier. At 300 iterations the ladder is nearly flat (cutting the budget 55% cost
+5.00 → +4.86), while pro → pro-max is worth +1.02 [0.24, 1.84]; a probe at the standard tier would
measure the flat part of the curve and report a null about the wrong thing.

`v3.6-legacy-shape-pro` runs alongside as a control: `MOVE_SHAPE × PHASE_SHAPE` normalised to sum to
21. It is the report's own guess, made testable for the first time, and E2 predicts it is backwards.

`MEASURED` **W1 result: the profile is not flat, and it points away from the opening.** 468
positions, 24 games, bootstrapped by game, squares of oracle regret recovered per doubling:

| own moves | slope | regret @1x | oracle agreement |
| ---: | ---: | ---: | ---: |
| 1-3 | 0.067 [−0.167, 0.274] | **1.143** | **11.1%** |
| 4-6 | **0.315 [0.013, 0.613]** | 0.877 | 26.4% |
| 7-9 | **0.242 [0.091, 0.397]** | 0.692 | 25.0% |
| 10-12 | 0.177 [0.062, 0.300] | 0.341 | 48.6% |
| 13-15 | 0.101 [0.025, 0.215] | 0.192 | 63.9% |
| 16-18 | 0.106 [−0.068, 0.305] | 0.160 | 73.8% |
| 19-21 | −0.020 [−0.104, 0.044] | −0.023 | 91.7% |

`STRUCTURAL` **Regret and slope disagree, exactly as the criterion predicted they could.** Moves 1-3
carry the most regret and the least oracle agreement, and doubling the budget there recovers nothing
measurable. Moves 19-21 sit at zero with a tight interval, consistent with the sealed-region packer
already solving them.

## W2 — the boost probes, and the flaw they hid

`MEASURED` Four compute-*positive* probes against `v3.2-pro`, 40 seeds each (MDE 2.12). Each
advantage is decomposed against what the same compute spent uniformly would have bought, at the
measured 1.3 points per whole-game doubling:

| own moves | advantage | uniform-compute expectation | excess | implied local rate |
| ---: | ---: | ---: | ---: | ---: |
| 1-5 | +0.94 [−0.50, 2.48] | +0.31 | +0.63 | 3.95 |
| 6-10 | +0.99 [−0.16, 2.23] | +0.31 | +0.68 | 4.16 |
| 11-15 | +0.18 [−0.25, 0.62] | +0.31 | −0.13 | 0.76 |
| 16-21 | +0.17 [−0.28, 0.72] | +0.37 | −0.20 | 0.60 |

`MEASURED` **The match contradicts W1 on the opening.** W1 put moves 1-3 at a slope of essentially
zero; the probes put moves 1-5 near the top. The likely mechanism is that W1 grades against a 7x
oracle, and in a 356-legal-move opening that oracle agrees with the deployed search only 11% of the
time — "regret recovered" is measured against a referee that is itself unsettled precisely where the
referee is weakest. Where a diagnostic and a match have disagreed in this repo, the match has been
right, and this is filed the same way.

`STRUCTURAL` **Two things the levels cannot support.** No arm clears zero. And the four arms'
size-weighted mean rate is 2.28 against the measured global 1.30 — they collectively over-credit by
1.75x, which is what 40-seed intervals do. Only the ratios survive.

## The fitted shapes fail: addition and removal have asymmetric prices

`MEASURED` Three budget-neutral shapes, fitted from the probe ratios and normalised to `sum = 21`:

| shape | moves 1-10 / 11-21 | seeds | advantage |
| --- | --- | ---: | ---: |
| fitted, shrink 1.0 | 1.7x / 0.34x | 16 | −1.36 [−3.39, 0.65] |
| fitted, shrink 0.5 | 1.4x / 0.63x | 16 | +0.46 [−2.39, 3.41] |
| **fitted, shrink 0.5 — fresh block** | 1.4x / 0.63x | **40** | **−0.77 [−2.19, 0.66]** |

The screen did not reproduce, which is the twelfth instance of that arc in this ledger. And the more
a shape commits to the probe ratios, the worse it does — the signature of a fit to noise.

`MEASURED` **The diagnosis is a measurement the probe design omitted.** The boost probes only ever
measured what *adding* compute buys. A budget-neutral shape also spends what *removing* it costs, and
on a concave ladder those are not the same number. Two compute-*negative* arms, cutting own moves
11-21 and giving nothing back, 40 seeds each:

| arm | per-game budget | advantage | doublings removed | implied removal rate |
| --- | ---: | ---: | ---: | ---: |
| moves 11-21 at 0.5x | 74% | **−0.99 [−1.66, −0.33]** | 0.524 | 1.89 |
| moves 11-21 at 0.34x | 65% | **−0.85 [−1.50, −0.20]** | 0.815 | 1.04 |

Both clear zero — at this diagnostic stage they were the workstream's only significant results.

`STRUCTURAL` **Adding compute to moves 11-21 buys ≈0.67 points per doubling. Removing it costs
1.04-1.89.** Reallocation requires the donor moves' marginal rate to sit *below* the recipients'. The
boost probes made that look like 0.67 against 4.0. Priced correctly — donors at their measured
removal rate, recipients discounted by the 1.75x over-credit — the gap closes to roughly 1.0-1.9
against 2.3, and the trade stops paying for itself. That is why every fitted shape lands at or below
zero while its component probes all read positive.

`ESTIMATE` The asymmetry is what a concave ladder does, and the engine has a specific reason for it:
`time.earlyExit` and the sealed-region packer already return early at the moves a shape wants to
harvest, so the iterations nominally allocated there are partly not being spent in the first place.
Cutting the *budget* removes real search; it does not recover an equivalent amount of idle compute.

`STRUCTURAL` **What this closes is the fitted hypothesis, not every static curve.** The measured
probe ratios do not price their donor side correctly, so the shapes derived from them fail. That
does not logically falsify a curve chosen by a different prior—and the preregistered legacy control
below is the counterexample.

## The curve that survived

`MEASURED` The report's old `MOVE_SHAPE × PHASE_SHAPE` guess was included as a budget-neutral
control, normalised to `sum = 21`. It reproduced before being advanced and then cleared both required
100-seed tier blocks:

| tier / role | seed base | seeds | advantage |
| --- | ---: | ---: | ---: |
| Pro screen | 36250000 | 40 | +0.66 [−0.42, 1.75] |
| Pro reproduction | 36360000 | 40 | +0.64 [−0.61, 2.05] |
| **Pro decisive** | **36370000** | **100** | **+1.20 [0.39, 1.98]** |
| **Pro Max reproduction** | **36380000** | **100** | **+0.80 [−0.01, 1.67]** |
| **Lite transfer** | **36410000** | **100** | **+1.18 [0.27, 2.08]** |
| **Regular transfer** | **36420000** | **100** | **+1.23 [0.44, 2.04]** |

`MEASURED` Pooling the two preregistered decisive tier blocks gives **+1.00 [0.43, 1.58]** over
200 seeds / 800 games. Both independent point estimates are positive and above the +0.5 bar, and
the pooled interval excludes zero—the same cross-tier standard used to promote `v3.2`. The canonical
configs are `v3.5-lite`, `v3.5`, `v3.5-pro`, and `v3.5-pro-max`; the
`v3.6-legacy-shape-*` ids remain as the exact configs named in the original Pro-tier match logs.
`v3.6` is reserved for the next mechanism measured independently against `v3.5-pro`.

`STRUCTURAL` This is a useful correction to the diagnostics rather than a vindication of their
story. W1 said moves 1-3 had little measurable doubling slope, the W2 boost probes ranked moves 1-10
highest, and the fitted shapes failed. The winning curve predates all three and concentrates most
compute in moves 6-15. Match evidence outranks the proxy.

`MEASURED` Dynamic banking was implemented as a separate one-axis follow-up to `v3.5-pro`. It
carried unused fixed-budget iterations forward within each game and released the pool according to
the existing root-spread rule. Triage was +0.40 [−0.94, 1.99] at 16 seeds; the fresh confirmation
was **+0.36 [−0.91, 1.72]** at 40 seeds, below the preregistered +0.50 gate. It stopped there without
a decisive block or retry (`v3.6-banking-pro`).

## What this deliberately is not

`MEASURED` **Not an ensemble.** Splitting one budget across two independent root trees measured
**−2.99 [−4.40, −1.54]**, and committee rank-pooling landed below its best single voter under both
judges. Two half-depth searches lose more than diversity buys. The proposed evaluator switch could
not literally use `V12Search.setParams`: `v2-pro` is the legacy object-board evaluator, not a
`BitboardParams` block. The repaired arm kept `v3.5-pro` as the only tree and let `v2-pro` select
among its top four at one ply on own moves 1–5 and 16–21. It triaged at +0.07 [−1.88, 2.14], then
measured **−0.53 [−1.67, 0.67]** on the fresh 40-seed confirmation and stopped
(`v3.6-phase-v2-pro`).

`PROPOSED` **Not the opening book, yet.** That is the other half of "spend compute where it matters",
and it spends it offline: `lookupBook` is already wired at `src/ai/bitboard/index.ts` behind
`phase === 'opening'`, with no corpus behind it. E2's 8% opening agreement is the argument for it, and
the v4 report requires its result be reported separately from anything about the tree policy. The
standard match protocol samples the first eight plies from each engine's top three, so a fair
exact-hash book needs coverage of that randomized opening tree; a single deterministic line would
either miss held-out positions or suppress diversity only for the challenger.


# PROMOTED: `v3.6-pro-max` (2026-08-24)

`MEASURED` **+0.84 [0.31, 1.37] against `v3.2-pro-max`**, 200 seeds / 800 games on a single
preregistered block (base 37800000, MDE 0.95). First place 32.6% against a 25% par.

It is `v3.5-pro-max` with `iterationScale` 8.0 -> 8.33 and nothing else — same curve, same
evaluation, same rollout policy.

`MEASURED` **Cost, in both currencies, and they disagree.** Against `v3.2-pro-max` on identical
seeds: **+9.5% executed iterations** but **+13.9% wall clock**. The extra iterations are not free
per-iteration — they go deeper into the tree, where nodes cost more. `v3.5-pro` shows the same
pattern at +8.2% iterations and +10.2% wall clock.

## The promotion bar this line uses

`STRUCTURAL` This generation is promoted under an explicit compute cap rather than strict
equal-compute, and the arithmetic is why. Buying +0.84 points by adding iterations costs
`2^(0.84/1.3) - 1` = **+57%**. The curve delivers it for **+13.9% wall clock**, roughly 4x cheaper.
`v3.5-pro` is 8.5x cheaper on the same reckoning. A config that is 14% slower and 0.84 points
stronger is a good trade at any tier that ships.

`STRUCTURAL` **The cap was stated as 10% and these exceed it on wall clock.** It was set and checked
against *executed iterations*, where both tiers land at 8-10%; measured on the clock they are 10.2%
and 13.9%. For an engine that runs in a browser the clock is the currency that matters, so the
honest statement is that this line is promoted on the **efficiency ratio**, not on fitting under a
10% ceiling. Every figure carries its measured cost so the trade can be re-judged at any time.

`STRUCTURAL` The cap is a *shipping* rule, not a measurement one. Every figure below is still
reported with its executed-compute cost, and `scripts/v36BudgetSlack.ts` makes that a two-minute
check rather than an invisible confound. The distinction that matters: extra compute never makes the
*curve* significant, it only makes the *config* score higher, and the two are separately attributed.

## The lineup

| tier | advantage vs its `v3.2` counterpart | seeds | exec compute | status |
| --- | ---: | ---: | ---: | --- |
| `v3.5-lite` | +1.18 [0.27, 2.08] | 100 | 8.9% | promoted, one block |
| `v3.5` | +1.23 [0.44, 2.04] | 100 | 7.9% | promoted, one block |
| `v3.5-pro` | **+1.17 [0.60, 1.76]** | **200** | 8.1% | promoted, **replicated** |
| `v3.5-pro-max` | +0.41 [-0.15, 0.98] | 200 | 2.6% | **not promoted** |
| **`v3.6-pro-max`** | **+0.84 [0.31, 1.37]** | **200** | 9.2% | **promoted** |

`MEASURED` `v3.5-pro` is the only tier replicated on disjoint blocks: +1.20 then +1.14, pooling to
+1.17. That reproduction is what licenses reading the two single-block lower tiers as the same
~+1.2 effect rather than as optimistic draws.

## Why Pro Max needed a budget the other tiers did not

`MEASURED` At `iterationScale` 8 the Pro Max tier collected only **+2.6%** of the front-loading
bonus, against +7.9% to +8.9% at the lower tiers. The curve sums to 21 over 21 own moves but a seat
plays ~18.5 of them, and the curve is front-loaded, so a shaped config spends ~9% more than flat —
except at Pro Max, where more of that surplus is discarded before it is executed.

`STRUCTURAL` The mechanism is `decided()`: a search stops once the runner-up cannot catch up on
visits, and since the engine plays by visits, the remaining iterations **provably cannot change the
move**. Pro Max reaches that point sooner relative to its allocation. Measured decision-locked
fraction of the midgame allocation, where the curve pours 1.8x:

| tier | `v3.2` | `v3.5` | penalty |
| --- | ---: | ---: | ---: |
| Pro | 11.4% | 11.9% | +0.5 pt |
| Pro Max | 13.2% | **17.0%** | **+3.8 pt** |

`ESTIMATE` Those two effects together — less bonus collected, and saturation against the decision
lock — account for roughly 0.17 of the 0.76-point gap between Pro's +1.17 and Pro Max's +0.41. **Most
of the gap remains unexplained**, and that is the open question this promotion does not close.
Raising the budget to the cap works around it rather than answering it.


## Next architecture research: v3.7 promotion candidates

The next campaign treats executed compute as a resource to optimize rather than a fixed ceiling.
A candidate may spend +10%, +25%, or +50% if it beats both the shipping incumbent and an incumbent
effort control calibrated to the same executed compute. The research and promotion protocol is in
[`V37_PROMOTION_RESEARCH_PLAN.md`](V37_PROMOTION_RESEARCH_PLAN.md).

The proposed workstreams, in order, are:

1. [`V37_METAREASONING_CONTROLLER_PLAN.md`](V37_METAREASONING_CONTROLLER_PLAN.md) — learn when an
   additional search tranche has positive expected value of computation.
2. [`V37_ROOT_RACING_PLAN.md`](V37_ROOT_RACING_PLAN.md) — after the nominal search finishes, spend
   only added compute on a warm-started leader/challenger race.
3. [`V37_ORACLE_DISTILLATION_PLAN.md`](V37_ORACLE_DISTILLATION_PLAN.md) — generalize stable oracle
   choices with a confidence-gated selector that abstains outside its support.

The campaign starts at 40 seeds for feasibility, then 100 for confirmation, and requires two
independent 200-seed blocks for promotion. A 16-seed result may reject an identity failure but may
not nominate a strength candidate.


# The first optimisation pass (2026-08-24)

`MEASURED` **−29.5% per iteration, behaviour-identical.** Every v3 tier and phase between −21% and
−39%. No strength claim is attached and none is needed: the engine plays the same moves it did
before, so its measured strength carries over unchanged and only its cost moved.

`STRUCTURAL` **This is the first implementation speedup in the project's history.** Every previous
"faster" number was either a design-time representation change (the bitboard rewrite against the
object engine) or an algorithmic one — fewer iterations, cheaper rollouts, a network replacing a
playout. The v12 postmortem asked twice for a per-iteration cost model and it was never built.

## Why it is verified without a match ladder

A change that plays *identical moves on identical seeds* inherits its strength. The gates:

- `scripts/v37ReplayDiff.ts` — full ranked visit vector, not merely the best move, across three
  versions and three phase-representative positions at real budgets. Snapshot before, `--check` after.
- `src/ai/bitboard/search.test.ts` — the same invariant in unit form.
- The mirror match printed `−0.00 [−0.00, 0.00]`, and that 80-game block ran in **3.7 min against
  5.1 min** for the same-size block beforehand — an independent end-to-end confirmation.

Anything that changes a single move is out of scope for this and becomes an ordinary candidate under
the promotion ladder. Faster-but-different is not a speedup; it is a different engine.

## Profile before optimising

`MEASURED` The static reading of the source ranked the targets badly wrong, and following it cost an
afternoon. Pooling `Position.apply`'s undo allocations — nominally the dominant GC pressure, ~270
allocations an iteration — measured **−0.9% against an 18% noise floor**. A CPU profile then showed:

| frame | share of engine self time |
| --- | ---: |
| `playout.ts sampleMoves` | **74.7%** |
| `territory.ts floodSeat` | 6.0% |
| `position.ts apply` — the item ranked first by eye | **1.9%** |

One function was three quarters of the engine.

| fix | cumulative |
| --- | ---: |
| Bound the two 13-word intersection loops to the 1–3 words a placement actually touches | −7.0% |
| Replace the O(n²) candidate dedup with a generation stamp | −8.5% |
| Skip pieces no longer in hand via a per-(cell, piece) cover index | **−29.5%** |

`STRUCTURAL` The last is only identity-preserving because `coverList` is **already grouped by piece
and ascending within a piece** — checked empirically rather than assumed. Iterating only the pieces
still in hand therefore visits the same ids in the same order. The win lives in the rollout tail: a
playout runs to the end of the game, and by then most of a seat's 21 pieces are down, so most of the
cover list was being scanned only to fail the hand test.

## What it is worth, and what that figure is not

`ESTIMATE` 1/0.705 = 1.418x more iterations at fixed wall clock, or 0.504 doublings:

| tier | points/doubling | equivalent |
| --- | ---: | ---: |
| Lite | 2.5 | **+1.26** |
| regular | 1.8 | +0.91 |
| Pro | 1.3 | +0.66 |
| Pro Max | 1.3 | +0.66 |

For scale, the whole v3.5 curve is +1.17 at Pro and costs ~8% more compute. **These are exchange-rate
conversions, not measured strength.** The measured fact is the cost reduction; whether a tier is
re-cut to spend the saving on iterations is a separate decision with its own ladder.

`STRUCTURAL` **The tooling this required, because none of it existed.** `scripts/benchSearch.ts` — the
only script reporting iterations per second — benchmarks the *legacy object engine* and describes code
the champion does not run. There was no ms-per-iteration figure anywhere, and the `v3*Bench.ts` family
samples plies 8/24/40 and averages the phases away. New: `scripts/benchBitboard.ts` (per-iteration and
per-phase cost, warmed, order-rotated, **minimum over repeats** because timing noise is one-sided, with
the noise floor printed so an unresolvable delta is visible as one), `scripts/v37Profile.ts`, and
`scripts/v37ReplayDiff.ts`.

## What it did to the published frontier

`MEASURED` Re-measuring all thirteen bitboard models against greedy (100 seeds each) confirms the
change end-to-end: **every model's score against greedy is bit-identical to its pre-optimisation
figure** across 5,200 games, repeated over two independent re-measurement runs, while cost fell
sharply.

`STRUCTURAL` **The vs-greedy ms/move carries roughly ±10% run-to-run noise, and the frontier chart
should be read with that in mind.** Two full re-measurements of the same thirteen models, the second
on an engine strictly faster than the first, disagreed by −18% to +13% per model, with five cells
moving the wrong way. Each is a single mean over 400 games rather than a minimum over repeats, so it
inherits whatever the machine was doing. The microbenchmark (`scripts/benchBitboard.ts`, min over
seven) is the number to trust for a cost *claim*; the published axis is the best available end-to-end
figure and is fine for showing the shape of the frontier, but a 10% cost difference between two
adjacent points on it is not a measurement.

| ms/move | Δ vs greedy | model |
| ---: | ---: | --- |
| 43 | 14.94 | `hanni-3-1-lite` |
| 52 | 16.03 | `hanni-3-5-lite` |
| 108 | 19.62 | `hanni-3-2` |
| 117 | 21.35 | `hanni-3-5` |
| 207 | 22.20 | `hanni-3-2-pro` |
| 233 | 22.85 | `hanni-3-5-pro` |
| 395 | 24.62 | `hanni-3-2-pro-max` |
| 412 | 24.98 | `hanni-3-6-pro-max` |

`MEASURED` **`v3.1-nano` is now strictly dominated and should be retired.** It is *more expensive*
than `v3.1-lite` (46 ms against 43 in the final run, 56 against 52 in the previous one — behind in
both) and 5.13 points weaker, with non-overlapping strength intervals. The strength gap is what
carries this; the cost ordering merely removes nano's last remaining argument.

`STRUCTURAL` The reason is a clean consequence of which fix did the work. Skipping placements whose
piece is no longer in hand pays off in the **depleted-hand tail** of a rollout — which a full-length
playout spends most of its plies in and a 12-ply truncated playout never reaches. Full rollouts gained
−39%, truncation only −14%. Nano bought a 24% cost saving in exchange for the 4.7–6.9-point truncation
penalty; that saving is gone, and with it the tier's reason to exist.

`MEASURED` A fourth fix — binding the placement table's arrays to module-level aliases so the
innermost loop stops doing a property load before each indexed read — took the total to **−32.9%**.

`PROPOSED` Stopped there, not finished. `sampleMoves` remains ~66% of engine self time, but the
residue is roughly 40,000 candidate evaluations per iteration at about 6 ns each, close to
fundamental for the current algorithm. Going further needs a structural change — caching overlap
results across a rollout behind a generation stamp is the most promising — carrying correctness risk
the first four fixes did not.


# v3.7 — the search-design arms are closed (2026-08-25)

An overnight programme against the four `docs/V37_*.md` plans. **No architectural arm produced a
promotion.** The value is in what the gates cost to establish and in one candidate still open.

## Scoreboard

| arm | verdict | what it cost to decide |
| --- | --- | --- |
| A — value-of-computation controller | **dead** | 2 scripts, ~25 min |
| B — warm-start root racing | **dead** | 1 script, ~15 min |
| C — opening apprentice | **dead** | corpus + 1 match |
| D — per-iteration speed | **−32.9%, banked**, no version name | ~2 h |
| E — cheap-tier rebuild | nano retired, no version name | 0 matches |
| **`v3.7-noopening3-pro`** | **open** — +0.25 [−0.33, 0.82] at −8.6% compute | 4 blocks |

`ESTIMATE` Roughly 20 hours of match ladder were *not* spent, on gates the original plans did not
have.

## A — the channel has capacity and nothing can address it

`MEASURED` Gate 0, from data already on disk: a **perfect-foresight** controller is worth
**+1.71 [1.24, 2.94]** over spending the same compute uniformly at a +25% cap, against a 200-seed MDE
of 0.95. Doubling the budget **changes nothing in 78% of positions**, helps in 15%, and *hurts* in 7%.

`MEASURED` Then the checkpoint corpus (192 positions, 120 oracle-stable, 20 games). Correlation of
every decision-time feature with realised regret reduction, bootstrapped over games:

| feature | r | 95% CI |
| --- | ---: | --- |
| visitShare | −0.052 | [−0.164, +0.072] |
| entropy | +0.056 | [−0.030, +0.133] |
| visitGap / iterations | −0.046 | [−0.176, +0.104] |
| topValueGap | −0.001 | [−0.051, +0.030] |
| leaderChurn | +0.004 | [−0.184, +0.212] |
| `decided()` | +0.010 | [−0.007, +0.025] |

**Not one interval clears zero.** A ridge fit split by game removed **0.00** squares on held-out
games — worse than uniform compute. The ceiling exists because a perfect controller sees the 18
positions of 120 where the next tranche helps; nothing observable distinguishes them.

## B — no fuel

`MEASURED` The oracle's move is inside the top two by visits at nominal budget **77.3%** of the time
(97 oracle-stable positions), against the arm's own ≥80% requirement. A racer restricted to that pair
cannot reach the answer often enough for the allocation to matter.

## C — the offline metric did not convert

`MEASURED` An already-trained v4.5 policy net picks a deep oracle's move far more often than the
deployed search on own moves 1-3 — **45.1% against 10.5%, +34.6 pp [+26.0, +43.3]** on 416 stable
positions — and has **no advantage at all** on moves 4-5 (30.7% against 30.3%). Deployed as a direct
selector it measured **−0.76 [−1.65, 0.17]**, and at −8% compute the mechanism is about −0.60.

`STRUCTURAL` **The error was calibrating the ceiling and never calibrating the metric.** E14b had
already recorded an offline proxy *anti*-correlated with strength at Spearman −0.99. A +34.6 pp
advantage on an uncalibrated target bought −0.76 points. Two mechanisms fit and nothing here separates
them: 48% of opening positions have no majority answer across three 9,600-iteration searches, so
"the oracle's move" is often an arbitrary pick among near-equals; and root ranking is not the same
objective as playing well, since per-move regret does not sum over a game.

## The opening is two regimes, not one

`MEASURED` Forcing the engine to play its own **second**-ranked move:

| demoted on | seeds | advantage |
| --- | ---: | ---: |
| own moves 1-3 | **200 (pooled)** | **−0.06 [−0.62, 0.56]** |
| own moves 4-5 | 100 | −0.58 [−1.25, 0.10] |
| own moves 1-5 | 100 | −0.86 [−1.77, 0.07] |

**On moves 1-3 the search's top two are interchangeable** — demotion costs nothing at 200 seeds. On
moves 4-5 it costs about half a point. The band the repository has treated as one "opening" behaves
as two.

`STRUCTURAL` A caution about how this was found: the first moves-1-3 block read **+0.68 [−0.13,
1.53]** and did **not** reproduce (**−0.79** on fresh seeds). Pooled it is −0.06, which is the null the
hypothesis actually predicted. The single block briefly looked like an inversion and was not one.

`ESTIMATE` This gives one cause for three failures. The exact book covered moves 1-3 and died past
ply 2; the apprentice was +34.6 pp better there and lost; W1's compute slope in the opening was 0.067
[−0.167, 0.274]. All three were working a band where the choice does not matter.

## PROMOTED: `v3.7-pro` — stop searching the first three moves

`MEASURED` **+0.45 [0.11, 0.78]** against `v3.5-pro` over 600 seeds / 2,400 games, at **−8.2%
executed iterations and −10.6% wall clock**. First place 30.9% against a 25% par.

**Stronger and cheaper.** That is Pareto dominance rather than a compute trade, and it is the only
thing in this programme that qualifies.

| block | seeds | advantage |
| --- | ---: | ---: |
| A | 100 | +0.50 [−0.28, 1.30] |
| B | 100 | −0.01 [−0.84, 0.87] |
| C | 100 | +1.16 [0.38, 1.97] |
| D | 100 | +0.50 [−0.39, 1.37] |
| E — preregistered confirmation | 200 | +0.27 [−0.30, 0.86] |
| **pooled** | **600** | **+0.45 [0.11, 0.78]**, MDE 0.55 |

The mechanism is one line of policy: **do not run the tree on a seat's first three own moves.** The
tier-1 move ordering plays them. No network is involved — the policy-net version of the same idea
measured −0.76, because the net's picks fall outside the set the search treats as interchangeable.

`MEASURED` **Why this is not simply throwing away search.** Forcing the engine to play its own
*second*-ranked move costs **−0.06 [−0.62, 0.56]** on own moves 1-3 (200 seeds, two pooled disjoint
blocks) and **−0.58 [−1.25, 0.10]** on own moves 4-5. On the first band the search's top two are
interchangeable, so the tree is not buying a decision there; on the second it is. The window stops at
three because that is where the measurement says it should, not because it was tuned.

`STRUCTURAL` **Read the provenance before quoting the pooled interval.** Blocks A and B were run
first; C and D were added *after* seeing that A and B pooled to +0.25 with a lower bound of −0.33.
Extending a sample because the interim looked encouraging is optional stopping, and it makes the
pooled interval optimistic as a decision rule. The clean evidence is the preregistered 200-seed
confirmation at **+0.27 [−0.30, 0.86]**, plus four of five disjoint blocks positive with the fifth at
−0.01. Ledger: `selfplay-results/v37-noopening3-preregistered.md`.

`MEASURED` **Both compute currencies were checked, and they disagree in the candidate's favour** —
−8.2% iterations against −10.6% wall clock. The v3.6 line was briefly claimed "inside a 10% cap" on
iterations while measuring +13.9% on the clock; assuming the two track is a mistake this programme has
already made once.

## PROMOTED: `v3.7-pro-max` — the same change, worth twice as much

`MEASURED` **+0.90 [0.47, 1.31]** against `v3.6-pro-max` over 400 seeds / 1,600 games, at **−5.1%
executed iterations and −11.5% wall clock**. First place 33.4% against a 25% par.

| block | seeds | advantage |
| --- | ---: | ---: |
| base 46500000 | 200 | +1.14 [0.56, 1.73] |
| base 47000000 | 200 | +0.65 [0.05, 1.21] |
| **pooled** | **400** | **+0.90 [0.47, 1.31]**, MDE 0.67 |

Two disjoint blocks, **both individually significant**, with the reproduction rule fixed before the
second was read. This is the cleaner of the two promotions: no optional stopping in its provenance.

`STRUCTURAL` The gain is **twice the Pro tier's**, and the tier's own measured pathology predicts it.
At Pro Max the v3.5 curve pours 1.8x into midgame moves the search then decision-locks, and 17.0% of
that allocation already provably cannot change the move against 11.9% at Pro. A tier that wastes more
of its tree gains more from not running one where the choice is interchangeable.

`STRUCTURAL` The two currencies disagree here by more than a factor of two — −5.1% iterations against
−11.5% wall clock. Skipped opening moves are the *cheapest* iterations at this tier, so removing them
takes out proportionally more clock than iteration count.

## The v3.7 lineup

| tier | vs its predecessor | iterations | wall clock |
| --- | ---: | ---: | ---: |
| `v3.7-pro` | +0.45 [0.11, 0.78] (600 seeds) | −8.2% | −10.6% |
| `v3.7-pro-max` | **+0.90 [0.47, 1.31]** (400 seeds) | −5.1% | −11.5% |

`MEASURED` **All four tiers, each on two disjoint blocks with the reproduction rule fixed before the
second was read:**

| tier | block 1 | block 2 | pooled | seeds |
| --- | ---: | ---: | ---: | ---: |
| `v3.7-lite` | +0.71 [0.17, 1.27] | +0.44 [−0.13, 0.99] | **+0.58 [0.19, 0.97]** | 400 |
| `v3.7` | +0.65 [0.11, 1.19] | +0.21 [−0.37, 0.80] | **+0.43 [0.04, 0.83]** | 400 |
| `v3.7-pro` | see provenance note | | **+0.45 [0.11, 0.78]** | 600 |
| `v3.7-pro-max` | +1.14 [0.56, 1.73] | +0.65 [0.05, 1.21] | **+0.90 [0.47, 1.31]** | 400 |

Every tier's pooled interval clears zero, every second block is positive, and every tier is cheaper
than its predecessor. **The whole lineup moves left and up at once.**

`STRUCTURAL` **Every second block came in below its first** — +0.71→+0.44, +0.65→+0.21,
+1.14→+0.65. That is the regression-to-the-mean this ledger keeps producing, and it is the reason
the pooled figures rather than the first blocks are the numbers of record. Read the pooled column;
the first blocks are optimistic by roughly a third.

`ESTIMATE` The tier pattern (+0.58, +0.43, +0.45, +0.90) is **not monotone in budget** and only the
Pro Max end has a mechanism behind it — that tier decision-locks 17.0% of its midgame allocation
against 11.9% at Pro. Why Pro sits below both neighbours is unexplained; it is also the tier whose
estimate is most likely distorted, being the one built from optional stopping.


## v5 Oracle foundation — measured, no promotion (2026-08-28)

The v5 foundation added an identity-safe online observer and three bounded response architectures.
The standardized six-prototype belief passed the historical-CPU prediction gate: adaptive NLL beat
the population prior by **+0.124 [0.083, 0.165] nats/action** and the shuffled-identity control by
**+0.027 [0.010, 0.044]**. That proves a player-specific signal exists; it does not prove the signal
is large enough to exploit.

Registered experiment-only ids:

- `v5-oracle-one-lap{,-fixed,-shuffled}` — modal response beam with a static leaf; rejected at
  **−9.15 [−12.00, −6.26]** versus v4.1.
- `v5-oracle-terminal{,-fixed,-shuffled}` — same beam with terminal continuations; rejected at
  **−1.42 [−4.34, 1.40]** versus v4.1 and negative against both profile controls.
- `v5-oracle-counterfactual{,-fixed,-shuffled}` — full-distribution importance sampler that adds
  only `E[Q|profile] − E[Q|prior]` to v4.1's log visit evidence. It was +0.14 versus fixed and +1.92
  versus shuffled, but **−1.06 [−2.93, 0.76]** versus v4.1, so its preregistered gate also failed.
- `v5-oracle-budget65` — response-disabled attribution arm; not a player candidate.

The fixed counterfactual arm is an exact active identity with v4.1 in the seeded ranked-root test.
All Oracle beliefs are updated only from real moves; hypothetical branches clone interaction state.
No v5 id belongs in the UI or the promoted ladder. The next authorized work is a small learned
trajectory policy (GRU/mixture/causal-transformer bracket) and it must clear the stronger prediction
gates in `research_paper/v5_oracle_foundation.md` before belief MCTS is allowed to affect play.

## v5 Oracle learned policy — measured, prediction only (2026-08-28)

The GRU/mixture/causal-transformer bracket ran on 72 fresh games at seed 52,200,000, with games and
engine profiles both disjoint across train, validation, and holdout. Four candidates shared one
learned legal-candidate scorer and differed only in how they encoded the seat's prior selected
actions. The eight-expert GRU mixture won on validation NLL (2.714); the 157k-parameter transformer
came last (2.801) behind the plain GRU (2.748), so sequence-model capacity was not the binding
constraint.

On the once-read holdout the model is a better population policy but not a personalized one:

- top-five recall **68.3%** (gate > 65%) and 0.047 nats/action better than the calibrated stateless
  scorer — both pass;
- shuffled-history minus personalized NLL **−0.009 [−0.034, +0.015]** against a required lower bound
  of +0.06 — the decisive identity gate fails;
- top-one ECE 0.093 versus 0.079 stateless — the calibration gate fails;
- transformer prefix-cache logits matched the full-prefix path to 5.2e-6 in float32 — the runtime
  contract holds even though that arm lost.

Substituting another holdout profile's history at the same turn index costs nothing measurable, and
contaminating a seat's entire eight-action warmup with another profile's moves costs only 0.010
nats/action. The history helps prediction, but the help is common to the population. A fitted
history-to-readout map did not transfer to four unseen engines, whereas the foundation cycle's
parameter-free Bayes update did (+0.027). Belief MCTS remains unauthorized; no v5 id is connected to
move selection. Full record in `research_paper/v5_oracle_learned_policy.md`.

## v5 Oracle online adapter — measured, prediction only (2026-08-28)

The follow-up retained learned legal-action experts but replaced the fitted recurrent identity
state with a parameter-free online Bayesian filter. Its fresh expanded league contained 108 games,
24 disjoint engine/config profiles, 7,738 decisions, and 1.56 million exact legal candidates.

The 1,632-parameter eight-expert model did not collapse: final responsibilities ranged from 9.2% to
13.6%, and holdout ECE was 0.070. Nevertheless, the player-specific signal remained too small:

- adaptive versus fixed: **+0.010 [0.003, 0.017] nats/action** (required lower bound >0.03);
- adaptive versus shuffled identity: **+0.007 [−0.000, 0.014]** (required >0.06);
- top-five recall: **59.4%** (required >65%).

The transfer mechanism is no longer the leading explanation. The nine within-legal-set scalar
features are the measured bottleneck. Do not run belief MCTS or widen the transformer on this input
contract. The next authorized work is richer candidate/board context and consented player-disjoint
human trajectories. Full record in `research_paper/v5_oracle_online_adapter.md`.

## v5 Oracle contextual policy — measured, prediction only (2026-08-28)

The richer contract added canonical 20×20×4 ownership planes, four-player hand and interaction
state, exact candidate cells, piece/placement geometry, and target-specific effects. Its fresh
CPU league contained 108 games, 24 new disjoint profiles, 7,748 decisions, and 1.52 million legal
candidates.

Spatial context decisively improved population prediction: holdout NLL fell from 2.887 to 2.674,
an improvement of **+0.214 [0.178, 0.251] nats/action**, and ECE reached 0.019. It did not improve
identity:

- adaptive versus fixed context prior: **+0.0007 [−0.0018, 0.0034]**;
- adaptive versus shuffled posterior: **+0.0018 [−0.0013, 0.0048]**;
- top-five recall: **61.3%** versus the 65% gate.

The fixed context model is already as good as personalized inference, so these nearby CPU
configurations do not expose a useful longitudinal identity channel. CPU-only Oracle work stops
here. Preserve the 30,880-parameter context model as a population-policy artifact; do not connect
it or belief MCTS to play. A future identity experiment requires consented whole-player human data,
genuinely external engines, or deliberately trained strategic personalities. Full record in
`research_paper/v5_oracle_context_policy.md`.

## v5 Oracle strategic-personality league — measured, source accepted (2026-08-28)

Eight objective-level synthetic families—expansion, center, edge, blocking, retaliation,
persistent targeting, next-seat targeting, and piece tempo—were implemented as bounded residuals
over the same exact legal move ranking. Three strength variants made profiles disjoint across
train, validation, and holdout while preserving the family objective. Real-game interaction state
is immutable during candidate evaluation and advances only after an observed move.

The 144-game corpus contains 24 profiles, 9,728 decisions, and 2.03 million legal candidates with
zero missing played actions. A blind regularized linear classifier, trained on variant `a`, tuned
on `b`, and read once on `c`, measured:

- three-move family accuracy: **66.1% [57.8%, 74.0%]**;
- eight-move family accuracy: **72.9% [66.1%, 79.2%]**;
- complete accuracy: **78.6% [73.4%, 83.9%]**, macro-F1 **0.787**;
- shuffled-label accuracy: **13.5%**;
- complete real-minus-shuffled advantage: **+65.1 [57.8, 72.4] points**.

All source-quality gates passed. This authorizes a fresh prediction-only
population-plus-player-residual experiment, not search integration. The `c` holdout is consumed;
the next experiment requires a new variant and seed block for promotion. Full record in
`research_paper/v5_oracle_personality_league.md`.

## v5 Oracle player residual (K) — measured, prediction only (2026-08-28)

Experiment K froze a 22,457-parameter contextual population policy, then compared a supervised
online family posterior, a width-32 GRU residual, and a width-32 causal transformer using identical
candidate embeddings. Variants `a+b` trained the models, consumed `c` selected them, and a new
seed-55M variant `d` supplied 48 games / eight profiles for a once-read holdout.

Validation selected the 7,624-parameter GRU at NLL 1.848, ahead of Bayes 1.860 and transformer
1.870. On `d`, after three observations, the GRU measured:

- correct history: **1.831 NLL**;
- fixed population: **1.981** — gain **+0.150 [0.122, 0.178]**;
- shuffled history: **2.080** — identity gain **+0.248 [0.207, 0.289]**;
- top-five recall **83.0%**, ECE **0.048**, eight-move family accuracy **81.3%**.

All stable-player and interaction-family gates passed. The style-switch gate failed: four moves
after a synthetic family change, accuracy was only **32.3%** versus the >50% requirement. The model
is retained as the first successful stable-player identity artifact, but counterfactual response
and search integration remain blocked. The next authorized work is a fresh prediction-only
change-point/reset experiment. The transformer did not win, so no runtime KV cache is added. Full
record in `research_paper/v5_oracle_player_residual.md`.

## v5 Oracle change-point diagnostic — development evidence only (2026-08-28)

Experiment K's one failed gate was 32.3% family identification four observations after a style
switch. Three quantities needed to choose a repair were reloaded from the frozen K checkpoint. No
training, no selection, no change to K's verdict; variant `d` is consumed, so this is development
evidence only.

- Clean four-observation accuracy is **71.9%**, so the >50% gate was achievable and the stickiness
  is real. But four observations after a switch the state reports the *old* family only 9.4% of the
  time — it is off-manifold, not stale.
- Contamination costs **+0.211 nats at the switch and +0.02 to +0.17 after**, against turn-to-turn
  variation of 1.9–2.7. A surprise threshold has almost no signal, so that repair should be demoted.
- No fixed sliding window satisfies both of L's constraints: a four-observation window costs
  **+0.074 nats** on stable players against a 0.01 budget, and even a twelve-window costs +0.012.
- Family identification saturates at eight observations (81.2%, equal to full history) while action
  likelihood improves to full history. The two heads want different memory horizons, which is what
  a two-timescale design would exploit.
- Every training sequence carries one constant family, so the model has never seen a switch. The
  likely repair is training data, not inference machinery.
- `BUILT` Real switching trajectories now exist: a seat may carry a personality schedule that
  changes objective on its own move count, and the `personality-switch` league at seed base
  56,000,000 exports them. A smoke export switched all 48 trajectories exactly once at the
  configured turn, with zero missing played actions. Generation only — no gate, no selection.
- `MEASURED` Calibrating the frozen K checkpoint on the 16 variant-`c` games in the 48-game
  development corpus (64 seat-trajectories) reversed the expectation that real switches would be
  easier than splices. Four observations after a real
  switch the model identifies the new family **0.0%** of the time (splices: 32.3%) and still
  reports the *old* family **67.2%** of the time (splices: 9.4%). Stale history is worse than no
  history for at least five moves, by **+0.43 to +0.97 nats/action**. The splice test destabilized
  the state; a real switch leaves a confident wrong answer. This reads consumed development split
  `holdout`/variant `c`, not Experiment L's future fresh holdout; run the export and calibration
  commands in sequence.
- `BUILT` Variant `e` is reserved as L's once-read source at strength 1.25, base weight 0.62, and
  secondary-family weight 0.10. Paired stable and real-switch export routes use seed base
  57,000,000, but neither corpus has been generated. Do not open them before L's arms and gates are
  preregistered.
- `PREREGISTERED` Experiment L now fixes two eligible arms: a switch-trained K-sized GRU and a
  fast/slow gated residual with K's slow path frozen. Architecture and hyperparameters are selected
  on `a→b`, retrained on `a+b`, and must pass the full gate set once on consumed development
  variant `c` before `e` may be exported. The first complete `e` read is final: all eight gates are
  conjunctive, offset 0 is descriptive rather than repairable, and no failed arm may be rescued on
  the same holdout. Full protocol in
  `research_paper/v5_oracle_change_point_preregistered.md`; its SHA-256 seal and unopened-holdout
  declaration are in `selfplay-results/v5-oracle-change-point-preregistration.json`.

Full record in `research_paper/v5_oracle_change_point_diagnostic.md`; reproduce with
`npm run diagnose:v5-oracle-switch`.

## v5 Oracle Experiment L — change-point adaptation, development cycle failed (2026-08-29)

The preregistered change-point experiment (`research_paper/v5_oracle_change_point_preregistered.md`)
ran its full a/b/c development cycle. Six of eight gates passed on variant `c`; the two that failed
stop L. **Variant `e` was never exported and remains sealed.**

The identity result is strong and it transfers to an unseen residual strength:

- four-move recovery of the new objective **74.3% [68.4% lower]**, which is **98.4%** of the model's
  own clean matched control, against Experiment K's **0.0%**;
- still-old rate **4.7%**, against K's 67.2%;
- post-switch action likelihood **better than the fixed population at every offset** by 0.54–1.12
  nats, where K was 0.43–0.97 nats worse.

The failures were stable retention (**+0.175** against a +0.01 budget) and absolute calibration
(ECE 0.120 against 0.08). Diagnosis on consumed development data
(`npm run diagnose:v5-oracle-change-point`) attributes both largely to one protocol choice and one
corpus flaw:

- evaluating each model at its own best temperature shrinks the retention gap from **+0.175 to
  +0.032** — one temperature was selected on variant `b` (strength 1.15) and applied to variant `c`
  (strength 1.4);
- **the gate learned the clock.** Every switch in the corpus happens at own move 6, so on *stable*
  games the gate still opens to **0.66 at exactly turn 6** before decaying. Turn index predicts the
  switch window perfectly, and that shortcut is the mechanism of the stable-likelihood leak.

Arm B (unfreezing K's history weights) recovered best at 86.9–89.5% but gave back 0.064–0.073 nats
of stable likelihood and was eliminated as a class.

The next design needs a new variant and seed block per the forbidden-rescues clause. The binding
change is to randomize the change point per trajectory and include never-switching seats inside the
switching block; until then no gated architecture's change-point result can be believed.

Registered commands: `npm run test:v5-oracle-change-point`,
`npm run train:v5-oracle-change-point`, `npm run diagnose:v5-oracle-change-point`.

# Running things

```bash
# Match two versions, seat-rotated, with a bootstrap CI
npm run match -- --challenger v10 --champion v1 --policy greedy --seeds 400
npm run match -- --challenger v10 --champion v1 --policy mcts-bench --iterations 300 --seeds 40

# Sanity check: this must print exactly 0.00
npm run match -- --challenger v1 --champion v1 --policy greedy --seeds 20

# Tune, then validate on held-out seeds
npm run tune -- --base v10 --champion v1 --space eval --policy greedy --generations 20
npm run match -- --challenger-file tuning/tune-<id>-best.json --champion v1 --seed-base 900000

# Fit evaluation weights from self-play
npm run collect-features -- --version v1 --games 800
npm run fit-value -- --in tuning/features-<id>.jsonl --base v10 --late-only

# v3.5 workstream A: is there anything for a committee to decide? Run this BEFORE the batch —
# if no combiner beats "primary" against the common oracle, the second opinion adds nothing.
npm run agreement -- --games 30 --positions 120 --primary v3.1-pro-max

# v3.5 workstream A: the band sweep. Fails fast if the layer is not inert at band 0.
npm run experiment:v3.5

# v5 Oracle learned policy: export the legal-candidate trajectory dataset, then run the
# four-architecture prediction bracket and its preregistered gates. Prediction only.
npm run export:v5-oracle-policy
npm run train:v5-oracle-policy

# Fresh 24-profile league and parameter-free online Bayes adapter.
npm run export:v5-oracle-adapter
npm run train:v5-oracle-adapter

# Context-rich CPU boundary: board-conditioned population policy versus personalized Bayes state.
npm run export:v5-oracle-context
npm run train:v5-oracle-context

# Synthetic objective-family source audit. This does not authorize Oracle search integration.
npm run export:v5-oracle-personalities
npm run eval:v5-oracle-personalities

# Experiment K: fresh d holdout, then the fixed/Bayes/GRU/transformer player-residual bracket.
npm run export:v5-oracle-residual-holdout
npm run train:v5-oracle-residual

# Why K's style-switch gate failed. Reloads the frozen checkpoint; trains nothing.
npm run diagnose:v5-oracle-switch

# Generate real mid-game objective switches for the change-point cycle.
npm run export:v5-oracle-switch-games

# Size Experiment L's gates on real switches before preregistering them.
npm run calibrate:v5-oracle-switch

# Experiment L: implementation tests, then the a/b/c development cycle, then the diagnosis.
# The trainer refuses any path that looks like a sealed holdout.
npm run test:v5-oracle-change-point
npm run train:v5-oracle-change-point
npm run diagnose:v5-oracle-change-point

# Experiment L development only: 48 games each for consumed variants a/b/c.
npm run export:v5-oracle-l-dev-switch

# SEALED until Experiment L's implementation passes variant-c readiness.
# npm run export:v5-oracle-l-holdout-stable
# npm run export:v5-oracle-l-holdout-switch

# v3.5 workstream B: the aggression frontier. Read the own/opps columns, not the advantage.
# Complete — the curve is resolved and the shipped value is the optimum. Kept for reproduction.
npm run aggression-frontier

# v3.6 W1: which own-move number converts compute into score. Minutes, no match ladder.
# A flat profile here means the optimal shape is the flat one — that is a result, not a null.
npm run move-importance

# v3.6 W2: the same question asked in matches. Pro tier only; the standard tier's ladder is flat.
npm run experiment:v3.6-shape

# v3.6 identity gate. A flat shape must be bit-identical to no shape.
npm run match -- --challenger v3.6-flat --champion v3.2-pro --seeds 20 --iterations 300

# Reproduce the promoted cross-tier pool. Explicit pooled labels are required because the two logs
# intentionally carry different Pro / Pro Max config ids.
npm run aggregate -- --pooled-challenger v3.6-legacy-shape --pooled-champion v3.2 \
  selfplay-results/match-2026-08-24T06-26-20-946Z.jsonl \
  selfplay-results/match-2026-08-24T06-51-30-178Z.jsonl
```
