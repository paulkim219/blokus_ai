# v3.7 workstream C — confidence-gated oracle distillation

## Hypothesis

Opening search has the largest measured headroom and almost no response to extra runtime compute:
deployed/oracle agreement was 8%, while the opening compute-doubling slope was near zero. The exact
book was the right *kind* of mechanism but the wrong representation: fresh randomized openings fell
off exact hashes after ply 2.

Replace memorization with a direct apprentice policy that generalizes the stable decisions of a
long-search oracle and abstains to normal search when it is not calibrated. This is not another
learned PUCT-prior blend. On accepted states it returns a ranked top three directly; on rejected
states the incumbent search runs unchanged.

## Research basis

- Anthony, Tian & Barber, [Thinking Fast and Slow with Deep Learning and Tree
  Search](https://proceedings.neurips.cc/paper_files/paper/2017/hash/d8e1344e27a5b08cdfd5d027d9b8d6de-Abstract.html): Expert Iteration uses expensive planning as an expert and trains a fast
  apprentice to generalize those decisions.
- Hamrick et al., [Combining Q-Learning and Search with Amortized Value
  Estimates](https://openreview.net/forum?id=SkeAaJrKDS&noteId=B1eSGNwnjB): preserve information
  produced by search so later decisions need less planning.

The repository's failed learned-prior work is a direct warning: success requires direct stable-move
selection with calibrated abstention, not a small blend into a prior channel whose measured ceiling
is about 0.12 points.

## W1 — canonical oracle corpus

Generate randomized opening states through each seat's own move 5, not only global ply 8.

- Apply the four board rotations that map corners/seats onto one another; add reflections only after
  a move-legality and turn-order equivalence test proves them valid.
- Label every state with 5 independent long searches at at least 4x `v3.6-pro-max` executed compute.
- Store the full top-k visit distribution, not only the winning move.
- Keep stable top-one and stable top-three-set labels separately.
- Split by source game and seed range before training.

Use dataset aggregation: after the first apprentice is trained, play it with abstention, collect the
states it actually induces, label those with the oracle, and retrain. This is the Expert Iteration
loop and prevents a one-pass model from drifting off its training distribution.

## W2 — apprentice and abstention

Start with the smallest model already supported by the v4 tooling, but train a new contract:

- action target: oracle top-k distribution over legal moves;
- confidence target: whether independent oracle searches agree on top one/top three;
- symmetry-consistency loss across the four rotations;
- explicit legal-action mask.

At runtime:

- if calibrated confidence exceeds threshold, return the apprentice's ranked top three;
- during `openingRandomPlies`, preserve the harness's top-three sampling exactly;
- after randomized plies, play top one;
- otherwise abstain and run the incumbent search;
- never mix the apprentice score with PUCT values.

Choose the confidence threshold on a calibration split to meet a maximum stable-oracle error rate,
not to maximize coverage.

## Gate 0 — the ceiling, and a correction to the coverage bar below

`MEASURED` Calibrated the same way arm A's gate 0 was (a whole-game doubling removes 69.3 squares of
oracle regret and is worth 1.30 points):

| band | positions | regret at 1x | worth if perfectly answered |
|---|---:|---:|---:|
| own moves 1-3 | 72 | 82.3 sq | +1.54 pts |
| own moves 1-5 | 120 | 126.9 sq | **+2.38 pts** |
| all moves | 468 | 246.5 sq | +4.63 pts |

The opening ceiling is **+2.38 [2.08, 2.69]** (game bootstrap) against a 200-seed MDE of 0.95. **To
clear MDE the apprentice must capture 40% of the opening regret.**

`STRUCTURAL` **The coverage bar written below is too low to produce a measurable result.** 40% on own
moves 1-3 and 20% on 4-5, weighted by where the regret actually sits, is 33% coverage — worth
**+0.79 points**, under MDE — and that already assumes the apprentice is *perfect* on everything it
covers. As written, this gate would greenlight an arm and then spend a 540-seed ladder discovering it
could not be measured. Replace it with:

> **Coverage x accuracy on own moves 1-5 must reach 40% of the opening regret**, measured on the
> oracle-labelled corpus. Coverage alone is not a gate; the product is.

## Gate 0 — the head start, measured before training anything

`MEASURED` 29 oracle-stable opening positions (two independent `v3.6-pro-max` searches at 9,600
iterations, position discarded unless they agree), 18 games, `scripts/v37OpeningApprenticeGate.ts`:

| | rate |
|---|---:|
| deployed `v3.5-pro` picks the oracle's move | **10.3%** |
| already-trained `v4.5` pooled policy net picks it | **41.4%** |
| net ranks it top-3 | 72.4% |
| oracle move outside the 40-move shortlist | 3.4% |

**+31.0 pp [+10.3, +51.7]**, game-bootstrapped, clears zero. An artifact that *failed* as a root prior
picks the deep oracle's opening move four times more often than the search does.

`STRUCTURAL` This is the thesis of the arm, and it is now measured rather than argued. E1 capped the
root-*prior* channel at 0.12 points and five v4 generations poured better models into it. The models
were never the problem; the channel had no capacity. The same weights used as a **direct selector**
are far better than the search at the one phase where the search is weakest.

`MEASURED` **Two findings that complicate the design, both material.**

1. **The abstention signal is absent.** The net's own margin does not identify where it is right:
   accuracy by margin quartile runs 42.9% / 57.1% / 57.1% / 12.5%, with no monotone relationship.
   The arm depends on calibrated abstention, so the confidence head must be *trained for it* — there
   is no free signal in the existing artifact to lean on.
2. **Only 24% of opening positions have a stable oracle label** (29 of 120) even at 9,600 iterations
   with two independent searches. Most opening positions have no settled answer to learn. The
   addressable share of the +2.38 ceiling is therefore closer to the stable quarter, and W1 must
   measure it rather than assume it.

`STRUCTURAL` **This is a gate, not a result.** 29 positions, 12 successes against 3; the interval is
wide and the abstention finding rests on quartiles of seven. It says the arm is worth building.

## W1 interim — the arm should target own moves 4-5, not 1-3

`MEASURED` 460 opening positions from 23 games, three independent `v3.6-pro-max` searches at 9,600
iterations each (`scripts/exportV37OpeningOracle.ts`, partial run):

| own move | n | 2-of-3 stable | deployed regret | stable regret | ceiling |
|---:|---:|---:|---:|---:|---:|
| 1 | 27 | 33% | 15.2 sq | 6.6 | +0.14 |
| 2 | 35 | 17% | 13.6 sq | −0.2 | −0.00 |
| 3 | 40 | 42% | 11.6 sq | 5.7 | +0.12 |
| **4** | 55 | **76%** | 33.0 sq | 26.1 | **+0.56** |
| **5** | 67 | **90%** | 37.3 sq | 28.9 | **+0.62** |

| band | ceiling | vs MDE 0.95 |
|---|---:|---|
| own moves 1-3 | **+0.26** | below |
| own moves 4-5 | **+1.18** | clears |
| own moves 1-5 | +1.44 | clears |

`STRUCTURAL` **The coverage gate in W3 has the phase backwards, and so does the hypothesis at the top
of this document.** It asks for 40% coverage on own moves 1-3 and 20% on 4-5. But moves 1-3 are the
*least* settled — only 17-42% of them have a majority answer across three long searches — while moves
4-5 are 76-90% settled and carry three times the regret. An apprentice aimed at moves 1-3 would be
trained to imitate positions where the oracle itself cannot decide.

`STRUCTURAL` The mechanism is not mysterious. At own move 1 a seat has 21 pieces and a bare corner;
many openings are near-equivalent and the oracle splits between them. By own move 4-5 the board
constrains the choice enough that a right answer exists, while the branching factor is still high
enough that the deployed search misses it.

**Revised target: own moves 4-5.** Ceiling +1.18, which clears MDE on its own. Moves 1-3 are
diagnostic only — an apprentice may still be *trained* on them, but coverage there cannot be claimed
as strength, and a confidence head should be expected to abstain on most of them.

`STRUCTURAL` One caveat that understates these numbers: `deployedRegret` is null when the deployed
move falls outside the oracle's stored top-8, and those are the *largest* disagreements. Excluded
positions are concentrated in moves 1-3, so that band's true ceiling is somewhat higher than +0.26 —
but its instability is the binding constraint, not its regret.

## W1 full result — the arm survives, but not as designed

`MEASURED` 800 opening positions, 40 games, three `v3.6-pro-max` searches at 9,600 iterations each.
416 (52%) carry a 2-of-3 majority label.

### The regret measurement was biased, and fixing it matters

`MEASURED` `deployedRegret` is null whenever the deployed move falls outside the oracle's stored
top-8 — and that is exactly where the search is *worst*: 80% of own-move-1 positions, 65% at move 2,
59% at move 3, against 38% and 25% at moves 4-5. The earlier "+0.27 for moves 1-3" excluded the
search's biggest failures and was an artefact of the storage cap.

Scoring each excluded move at the 8th-place gap gives a rigorous **lower** bound:

| own move | lower-bound stable regret | ceiling >= |
|---:|---:|---:|
| 1 | 56.2 sq | +0.79 |
| 2 | 17.5 sq | +0.24 |
| 3 | 30.0 sq | +0.42 |
| 4 | 97.7 sq | +1.37 |
| 5 | 99.1 sq | +1.39 |

| band | ceiling |
|---|---:|
| moves 1-3 | **>= +1.45** |
| moves 4-5 | >= +2.75 |

### The head start is real, and it is in the opposite band from the regret

`MEASURED` Top-1 agreement with the majority oracle, 416 stable positions, game-bootstrapped:

| band | net | deployed search | difference |
|---|---:|---:|---|
| all stable | 36.3% | 22.6% | **+13.7 pp [+7.8, +19.5]** |
| **moves 1-3** | **45.1%** | 10.5% | **+34.6 pp [+26.0, +43.3]** |
| moves 4-5 | 30.7% | 30.3% | +0.4 pp [−6.6, +7.8] — **no advantage** |

`STRUCTURAL` The net and the search have **complementary strengths by move number**. At own move 1 the
search agrees with the oracle 1.7% of the time and the net 54.2%; by own move 5 the search is at 39.7%
and the net 33.1%. The search is bad early and good late; the net is the reverse.

`STRUCTURAL` **Gate 0's +31 pp was measured on an unrepresentative sample.** It drew from
`tmp/corpus.json`, which is strided across own-moves and over-sampled the early band where the net
wins. Stratified by own move, the advantage concentrates entirely in moves 1-3.

### What that leaves

`ESTIMATE` The existing net, used as a direct selector, closes 39% of the gap on moves 1-3 and 1% on
moves 4-5 — about **+0.56 points**, from moves 1-3 alone. That is below a 200-seed MDE of 0.95.

`ESTIMATE` A **trained** apprentice would need ~69% top-1 on moves 1-3 to clear MDE from that band, or
~83% on moves 4-5. The best top-1 in this repository's history is **36.5%** (v4.5 ensemble), and only
36% of moves 4-5 positions are unanimous across three 9,600-iteration searches — a student cannot
reliably exceed the agreement rate of the teacher it imitates. **Training a better apprentice is not
the route.**

`PROPOSED` **But +0.56 is not nothing, and it is free.** Replacing the search on own moves 1-3 *removes*
compute rather than adding it, so this is a Pareto candidate under rule F: not weaker at strictly lower
cost, and plausibly stronger. It needs no training — the artifact already exists. The measurement cost
is the issue: a +0.56 effect needs roughly 800 seeds (MDE 0.47) rather than 200.

**Revised arm: `v3.7-opening-select` — the existing v4.5 pooled net as a direct move selector on own
moves 1-3, abstaining to the incumbent search everywhere else.** No new model, no training contract,
no confidence head. The abstention rule is the own-move index, which gate 0 showed is the one signal
that actually separates the net's competence from the search's.

## Result — the offline metric did not convert. Arm stopped.

`MEASURED` `v3.7-select3-pro` against `v3.5-pro`, 100 seeds / 400 games, fresh block (base 43000000):
**−0.76 [−1.65, 0.17]**.

`MEASURED` It executes 8.0% less compute (276,715 against 300,725 spent per 3 games; 36 zero-search
moves against 3), worth +0.16 points of handicap at 1.3 points a doubling. Compute-corrected the
mechanism is about **−0.60**. It is not a Pareto candidate — it is cheaper *and* weaker.

`STRUCTURAL` **The error was calibrating the ceiling and never calibrating the metric.** Gate 0 asked
"how much regret is available" and answered it carefully. It never asked "does oracle top-1 agreement
predict playing strength", and this repository already knew that question matters: E14b found a
plausible offline proxy for a search property that was *anti*-correlated with strength at Spearman
−0.99. A +34.6 pp advantage on an uncalibrated metric bought −0.76 points.

`ESTIMATE` Two mechanisms are consistent with the sign, and nothing here separates them:

1. **The oracle is not ground truth in the opening.** Only 52% of opening positions have a 2-of-3
   majority across three 9,600-iteration searches — on the other 48% the "oracle's move" is one
   arbitrary pick among near-equals, and matching it means nothing. Agreement with an unsure referee
   is not a measure of correctness.
2. **Root ranking is not the same objective as playing well.** The deployed search chooses through
   full-length rollouts that price the rest of the game; the net imitates a deeper search's *root*
   ranking. Per-move regret does not sum over a game, and a move a deeper root ranking prefers can
   still lead somewhere worse.

**Arm C stops here.** Not on coverage, not on label noise, and not on model capacity — on the thing
the plan never tested, which is whether its offline target predicts strength at all. Any future
version of this arm must calibrate its metric against measured strength *before* the ceiling
arithmetic, not after.

## W3 — offline gates

On fresh games:

1. **Coverage x accuracy reaches 40% of the opening regret** on own moves 1-5 (superseding the
   original 40%/20% coverage-only bar, which gate 0 shows cannot clear MDE).
2. Among accepted states, top-one agreement with the stable oracle exceeds the incumbent at the same
   states, with a game-bootstrap lower bound above zero.
3. Mean oracle regret is lower than the incumbent's on accepted states.
4. Calibration holds by seat and own-move bucket.
5. Four-rotation predictions map back to the same move distribution within tolerance.

If the model clears top-k agreement but not regret, it is diagnostic only and does not play moves.

## Compute accounting and promotion

This arm should reduce runtime compute on accepted openings. Report:

- apprentice inference milliseconds;
- incumbent search iterations avoided;
- coverage and abstention rate;
- total executed compute per game.

First match it without reinvesting savings. If it is stronger and cheaper, it is already Pareto
dominant. Only a later independent arm may reinvest saved opening compute into the metareasoning
controller; do not bundle that into the first claim.

Use the same randomized-opening protocol as every promoted version. A deterministic-opening UI
evaluation may be reported separately but cannot substitute for the promotion statistic.

## Kill conditions

- Accepted-state regret is not better than incumbent search.
- Coverage collapses after dataset aggregation.
- Confidence is miscalibrated on a seat or rotation.
- The direct policy merely reproduces the failed v4 prior's ranking.

## Files

- `scripts/exportV37OpeningOracle.ts`
- `ml/train_v37_opening_policy.py`
- `src/ai/bitboard/openingPolicy.ts`
- `scripts/v37OpeningCoverage.ts`
- a new path-keyed artifact field distinct from `bookPath` and `netPrior`

