# v3.7 workstream A — contextual value-of-computation controller

## Hypothesis

The failed banking arm asked a weak question: “is the current root value spread narrow?” It then
redistributed previously unspent iterations. The stronger question is:

> Given what this search has done so far, how much expected final-score regret will the next tranche
> of simulations remove?

Extra compute is permitted. Nothing is taken away from another move, and no second tree is started.
The incumbent search runs to its normal shaped budget; the controller may buy one or more additional
tranches up to a preregistered game-level cap.

## Theory translated to this engine

Rational metareasoning treats “run more search” and “stop and play” as competing actions. Continue
when the estimated value of computation (VOC) exceeds its cost. This follows Hay et al.'s Bayesian
selection framing and Tolpin & Shimony's observation that root search should minimize simple regret,
not cumulative rollout regret:

- [Selecting Computations: Theory and
  Applications](https://people.eecs.berkeley.edu/~russell/papers/uai12-meta.pdf)
- [MCTS Based on Simple Regret](https://arxiv.org/abs/1207.5536)

The papers do not license their guarantees directly here: MCTS samples are correlated and the
four-player max^n return is non-stationary as the tree grows. They motivate the controller and the
features; held-out Blokus data decides whether it works.

## W1 — checkpoint corpus

Sample positions by game, tier, seat, own-move index, and phase. On each position continue one search
through cumulative checkpoints `{0.5, 1.0, 1.25, 1.5, 2.0} * nominal_budget` and record at each:

- selected move and leader changes since the previous checkpoint;
- top-four visits, visit shares, backed-up values, and empirical return variances;
- visit gap and the exact `decided()` remaining-iteration threshold;
- root entropy, legal move count, opened-child count, and shortlist size;
- score lead, remaining piece-square totals, phase, seat, and own move;
- long-budget stable move and regret of every checkpoint choice.

Use at least two independent long-budget searches. Keep a label only when their top move or top-three
set is stable. Split train/calibration/holdout by source game, never by position.

Primary label at checkpoint `b`:

`delta_regret(b -> b_next) = oracle_value(choice at b_next) - oracle_value(choice at b)`.

Secondary labels are “leader changes by the next checkpoint” and “current choice disagrees with the
stable oracle.”

## W2 — controller

Fit a small calibrated model, not a large value network. Start with monotone logistic/isotonic models
over:

- leader churn;
- normalized visit gap;
- top-two confidence overlap;
- return variance;
- own-move index and phase;
- remaining budget until `decided()`.

Predict the expected positive regret reduction of the next tranche. Continue while

`E[delta_regret | features] > lambda * tranche_cost`.

Choose `lambda` on the calibration split to meet one of three expected executed-compute caps:
`+10%`, `+25%`, or `+50%`. Freeze the chosen cap and threshold before any match.

Implementation constraints:

- continue the existing `V12Search`; never reset or pool trees;
- the nominal v3.5/v3.6 allocation remains the minimum;
- `decided()` remains an unconditional stop because further visits provably cannot alter
  visit-count selection;
- track a hard per-seat game cap so a sequence of difficult positions cannot exceed the declared
  compute tier;
- record controller decisions and counterfactual predicted VOC for every move;
- record the **per-move cost distribution** (p50 / p95 / max milliseconds), not only the mean. This
  controller spends variably by position, and one that averages +25% while occasionally spending 3x on
  a single move is a different product from one that spends +25% uniformly. A p95 blowout is a reject
  at an otherwise acceptable mean.

## W3 — offline gates

**Gate 0 — can this arm be measured at all?** Convert the corpus result into an expected match-point
equivalent and compare it with the decisive block's MDE **before committing to any ladder**.

The reason this is now first: `G_architecture` strips out the value of the extra compute and leaves
only the value of *spending it better*. That is a root-selection effect, and E2 bounds the whole
root-selection channel at **0.279 squares of oracle regret per move** — a figure that is
winner's-curse inflated, and per-move regret does not sum over a game. A 200-seed decisive block has
MDE 0.95. It is genuinely unclear whether the ceiling clears it.

If the computed ceiling sits below MDE, **the arm cannot be measured and must not be run**. Record the
ceiling; that is the result. Spending 7 hours to produce a null that was arithmetically guaranteed is
the failure this programme exists to avoid.

Then advance only if all of these hold on game-level bootstrap intervals:

1. The highest predicted-VOC quartile contains at least half of the measured positive
   `delta_regret` mass.
2. Calibration is monotone: higher predicted VOC means higher realized regret reduction.
3. A replay simulation reaches its compute cap within ±2 percentage points.
4. At that cap it recovers at least twice the regret of uniform extra compute on the same corpus.
5. The result holds separately for Pro and Pro Max or the candidate is named for only one tier.

## Match arms

Do not sweep model internals in matches. The offline gate nominates one controller and one cap.

- `v3.7-voc-pro` against `v3.5-pro`, plus a calibrated higher-iteration `v3.5-pro` compute control.
- `v3.7-voc-pro-max` against `v3.6-pro-max`, plus a calibrated higher-iteration
  `v3.6-pro-max` compute control.

Start at 40 seeds. Follow the master plan's 100 + 200 + 200 ladder only if both absolute and
equal-compute comparisons remain positive.

## Result — 2026-08-24: gate 0 passed, W3 failed, arm stopped

### Gate 0 passed with room

`MEASURED` Computed from `selfplay-results/move-importance.json` (468 positions, 24 games, paired 1x
vs 2x searches with oracle labels) at **no new compute cost**:

| cap | uniform extra compute | perfect controller | ratio |
|---|---:|---:|---:|
| +10% | 9.5 sq | 89.8 sq | 9.4x |
| **+25%** | 22.3 sq | 114.6 sq | **5.1x** |
| +50% | 40.5 sq | 114.6 sq | 2.8x |

`G_architecture` under perfect foresight is **+1.71 [1.24, 2.94]** points (game bootstrap, 2000
resamples) against a 200-seed MDE of 0.95. **The channel has capacity.** The premise of this
workstream — that the compute a uniform ladder buys is spent mostly where it cannot help — is correct:
across the corpus, doubling the budget changes nothing at all in **78%** of positions, helps in 15%
and actively *hurts* in 7%.

### W3 failed: nothing observable predicts which positions

`MEASURED` The checkpoint corpus (`scripts/v37VocCorpus.ts`, 192 positions, 120 with a stable oracle
label from two independent long searches, 20 games). Correlation of each decision-time feature with
the realised regret reduction, bootstrapped over games:

| feature | r | 95% CI |
|---|---:|---|
| visitShare | −0.052 | [−0.164, +0.072] |
| entropy | +0.056 | [−0.030, +0.133] |
| visitGap / iterations | −0.046 | [−0.176, +0.104] |
| topValueGap | −0.001 | [−0.051, +0.030] |
| leaderChurn | +0.004 | [−0.184, +0.212] |
| `decided()` | +0.010 | [−0.007, +0.025] |
| own-move index | +0.054 | [−0.233, +0.224] |

**Not one interval clears zero.** A ridge fit on these features, split by game, removed **0.00** squares
of regret on the held-out games — *worse than spending the same compute uniformly* (−35% of ceiling),
with every standardised weight below 0.03.

`STRUCTURAL` The apparent 49%-of-ceiling score for the "continue where `decided()` is false" null is
noise: `decided` correlates +0.010 [−0.007, +0.025] with gain, and the null selects essentially at
random among a large majority of positions. With 41 held-out decisions and k=10 picks, that arm's
score is a draw, not a finding.

### Why this is a stop and not a bigger corpus

`STRUCTURAL` The failure is not that the model is too small or the data too few. It is that **the
signal is concentrated in 15% of positions and nothing visible at decision time distinguishes them.**
The ceiling exists precisely because a perfect controller can see the 18 positions of 120 where the
next tranche helps; the features cannot.

`ESTIMATE` The corpus can resolve |r| above roughly 0.15 and every point estimate is below 0.06. A
feature with r ≈ 0.10 would be missed here — but r ≈ 0.10 does not reach 55% of the ceiling either,
which is what clearing a 200-seed MDE requires. Collecting more games would sharpen the intervals
around a set of near-zero correlations.

**Kill condition met:** *"The controller is no better than phase/own-move index alone."* It is not
better than uniform. The arm stops before any match, which is what gate 0 and W3 exist to achieve —
roughly 7 hours of ladder not spent.

## Kill conditions

- Extra budget concentrates mostly where `decided()` would soon stop anyway.
- The controller is no better than phase/own-move index alone.
- Oracle labels disagree across independent long searches too often to calibrate.
- Uniformly adding the same compute wins the equal-compute comparison.

## Files

- `src/ai/bitboard/mcts.ts`: checkpoint statistics without changing default selection.
- `src/ai/bitboard/index.ts`: continuation controller and hard game cap.
- `src/ai/bitboard/config.ts`: optional controller config; absent is identical.
- `scripts/v37VocCorpus.ts`, `scripts/fitV37Voc.ts`, `scripts/v37VocReplay.ts`.
- `src/ai/bitboard/voc.ts` and focused arithmetic/calibration tests.

