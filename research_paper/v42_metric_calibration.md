# v4.2 — building an offline metric that predicts strength

**Started:** 2026-08-26
**Status:** in progress

## Why this is the whole of v4.2

Four offline proxies have now passed a preregistered gate and bought no playing strength:

| Proxy | Channel | Offline result | Online result |
|---|---|---|---|
| sibling pair accuracy / root top-1 | root prior | 60.44% → 63.24%, 26.36% → 33.45% over five generations | no gain; channel later measured at −0.12 |
| candidate regret | rollout policy | −9.6% regret, +3.8pp top-choice on untouched holdout | −0.06 [−0.72, 0.61] head-to-head |
| rollout calibration (bias, MSE) | rollout policy | flat across the whole ε ladder | picks ε=1.00; measured best is ε=0.60 |
| sibling discrimination | rollout policy | strongly ordered | *anti*-correlated with strength, ρ −0.43 to −0.99 |

Nine generations, two channels, no conversion. The programme's binding constraint is not modelling
capacity. It is that **no offline quantity in this repository has ever been shown to track playing
strength**, so every gate built on one has passed while the match behind it did not.

v4.2 therefore trains nothing until that is fixed.

## Method

A metric is tested the only way that means anything: against changes whose strength is already
measured. Each arm is a `(challenger, baseline, measured)` triple drawn from the match ledger and
runnable as two registered configs, so the metric is evaluated on exactly the contrast the match
measured. Arms are scored on a shared position corpus with paired seeds, and the statistic is a
per-position difference so corpus difficulty cancels.

`scripts/metricCalibration.ts` holds the arm table and the harness.

## The anchor was re-measured first

The truncation ladder supplies the widest-range points in the calibration set, and those numbers were
the oldest in the repository — measured on the v4-era design engine under a different configuration.
Anchoring a metric on a stale number would silently miscalibrate everything built on it.

`MEASURED` `v3.2-pro-cutoff12` vs `v3.2-pro`, 16 seeds / 64 games, seed block 50100000:
**−5.67 [−7.60, −3.69]**, 10.9% first place, 73.69 squares placed against 89.

The anchor reproduces. The historical figure was +4.7 to +6.9 for the reverse contrast on two
independent engines; −5.67 on the shipping engine sits inside that range.

## Metric 1 — oracle regret of the engine's own decision

The first candidate is deliberately *not* a component metric, because all four failures above were.
It runs the actual configured search on each corpus position and scores the move it plays against a
common deep oracle's values for that root's children, in squares. It measures the decision the engine
makes, which is what a match measures too, at roughly 25x less compute per comparison — one search
per position instead of a full game per seed.

`MEASURED` 82 oracle-labelled positions, 300 base iterations, intervals bootstrapped over games:

| Arm | Measured strength | Δregret (squares) | Δagree |
|---|---:|---:|---:|
| truncation12 | −5.67 | **+0.464 [0.193, 0.753]** | −15.9pp |
| prior-temp3 | −2.93 | **+0.149 [0.011, 0.404]** | −11.0pp |
| eps15 | −0.70 | +0.027 [−0.063, 0.138] | −2.4pp |
| v41-table | −0.06 | +0.024 [−0.073, 0.125] | −8.5pp |
| uniform-prior | −0.12 | −0.091 [−0.271, 0.070] | −7.3pp |

Spearman against measured strength: **−Δregret 0.900**, Δagree 0.600.

### What this does and does not establish

`MEASURED` Spearman 0.900 is the first positive calibration result in the programme, and it is the
first time any offline quantity here has ordered a set of known-strength changes. But the intervals
say exactly where that ordering comes from:

- The two large regressions (−5.67, −2.93) are **resolved** — both Δregret intervals clear zero, and
  in the right order.
- The three small effects (−0.70, −0.12, −0.06) are **not resolved** — every interval spans zero, and
  their point estimates are within 0.12 of each other. The single rank inversion in the set is among
  them (uniform-prior).

`ESTIMATE` So the honest claim is: **at 82 positions this is a valid screen for large regressions and
has no resolving power in the ±1 point band where promotion decisions actually live.** Spearman 0.900
is driven by the two big arms; with five points and one inversion it is about p ≈ 0.04 one-tailed,
which is suggestive rather than settled. A metric that cannot separate a −0.70 change from a −0.06
change cannot gate a release, and eps15 versus v41-table is exactly that comparison — +0.027 against
+0.024.

`STRUCTURAL` The binding limit is **games, not positions**. The bootstrap resamples games because
positions inside one game share a board and a trajectory, and the oracle labels currently cover only
**5 games** out of the corpus's 24. Interval width scales roughly as 1/√games, so completing the
enrichment should narrow these by about 2.2x on the existing corpus alone. That is the next step, and
it is a pure compute cost with no design risk.

## The split that actually explains the results

`MEASURED` Re-run at 192 positions / 11 games, with the arms split by the mechanism the change acts
through:

| Arm | Channel | Measured | Δregret (192 pos) |
|---|---|---:|---:|
| truncation12 | leaf | −5.67 | +0.320 [0.178, 0.481] |
| leaf-blend-25-vs-50 | leaf | +1.26 | −0.071 [−0.219, 0.056] |
| leaf-blend-50-vs-100 | leaf | +8.89 | −0.410 [−0.586, −0.243] |
| prior-temp3 | dynamics | −2.93 | +0.054 [−0.049, 0.183] |
| eps15 | dynamics | −0.70 | −0.034 [−0.126, 0.044] |
| uniform-prior | dynamics | −0.12 | −0.144 [−0.333, 0.013] |
| v41-table | dynamics | −0.06 | −0.024 [−0.079, 0.036] |

| Subset | Spearman | Correct in sign |
|---|---:|---:|
| **leaf** (3 arms) | **1.000** | **3/3** |
| **dynamics** (4 arms) | 0.400 | 1/4 |
| all (7 arms) | 0.821 | 4/7 |

`ESTIMATE` The pooled 0.821 was hiding two different metrics. Oracle regret of the engine's own root
decision tracks **leaf-estimation** changes perfectly in this set and does no better than chance on
**search-dynamics** changes — 1/4 correct in sign is worse than a coin flip.

`STRUCTURAL` There is a mechanism for this, and it was predicted by earlier work rather than invented
to fit. A leaf-estimation change alters what the search believes about a position, and that is
visible in a single root decision — which is exactly what this metric scores. A search-dynamics
change alters how the budget is spent, and its cost is cumulative over eighty plies: a flatter prior
can find a *better* move at one root while wasting budget across a whole game. `v46_channel_audit.md`
reached the same conclusion from the other direction, finding that ε's benefit is invisible in every
per-leaf statistic and concluding it acts at the level of the search rather than the estimator.

### This is a hypothesis, not a confirmed result

`STRUCTURAL` **The channel labels were assigned after the pattern was visible.** That makes the split
hypothesis generation, not a test of it. Spearman 1.000 on three points also occurs by chance one
time in six. Nothing here yet licenses using this metric as a gate.

## Preregistered confirmation

Written before either arm below was measured or scored.

Two new arms, one per channel, neither used in the fit above:

1. **Leaf channel — `v3.2-pro-cutoff24` vs `v3.2-pro`.** Its strength is re-measured on the shipping
   engine first, because the historical 24-ply figure is from the v4-era engine.
   **Predictions:** Δregret is positive (truncating at 24 plies is worse than terminal rollouts, a
   direction established on two independent engines), and `|Δregret(cutoff24)| < |Δregret(cutoff12)|`,
   because 24 plies is a strictly better leaf estimator than 12.
2. **Dynamics channel — `v3.2-sh-pro` vs `v3.1-pro`**, a clean single-axis contrast (only
   `rootPolicy` differs), measured at **−1.01 [−1.68, −0.31]** over 400 games in the v3.2 shift.
   **Prediction:** the metric fails on it — either the sign is wrong, or the interval spans zero
   despite the effect being nine times larger than the smallest leaf arm the metric ordered
   correctly.

If prediction 1 fails, the leaf claim collapses. If prediction 2 *succeeds* — that is, if the metric
correctly resolves sequential halving — then the channel split is wrong and the pooled number was the
honest one all along.

### Confirmation result — both predictions held

`MEASURED` 300 oracle-labelled positions from 17 games, nine arms, 300 base iterations, intervals
bootstrapped over games. Sorted by measured strength:

| Arm | Channel | Measured | Δregret | 95% CI | Sign |
|---|---|---:|---:|---|---|
| truncation12 | leaf | −5.67 | +0.304 | [0.205, 0.419] | OK |
| prior-temp3 | dynamics | −2.93 | +0.075 | [−0.005, 0.169] | OK |
| **CONFIRM-cutoff24** | **leaf** | **−1.59** | **+0.037** | [−0.032, 0.109] | **OK** |
| **CONFIRM-seqhalving** | **dynamics** | **−1.01** | **−0.045** | [−0.135, 0.055] | **WRONG** |
| eps15 | dynamics | −0.70 | −0.009 | [−0.071, 0.043] | WRONG |
| uniform-prior | dynamics | −0.12 | −0.108 | [−0.234, −0.001] | WRONG |
| v41-table | dynamics | −0.06 | −0.003 | [−0.064, 0.069] | WRONG |
| leaf-blend-25-vs-50 | leaf | +1.26 | −0.082 | [−0.185, 0.002] | OK |
| leaf-blend-50-vs-100 | leaf | +8.89 | −0.400 | [−0.560, −0.242] | OK |

| Subset | Spearman | Correct in sign |
|---|---:|---:|
| **leaf** (4 arms) | **1.000** | **4/4** |
| dynamics (5 arms) | 0.300 | 1/5 |
| all (9 arms) | 0.850 | 5/9 |

**Prediction 1 held.** `CONFIRM-cutoff24` scored +0.037 — positive as predicted, and smaller in
magnitude than `truncation12`'s +0.304 as predicted. The leaf channel is now 4/4 in sign with a
perfect rank ordering across a set spanning −5.67 to +8.89.

**Prediction 2 held.** `CONFIRM-seqhalving` scored −0.045 — the wrong sign, for a change measured at
−1.01 over 400 games. The metric says sequential halving improves the engine's root decisions; the
match says it costs a point. That is the predicted failure, on a held-out arm, in the predicted
direction.

`MEASURED` The dynamics channel is now 1/5 correct in sign. Four of its five arms have the wrong
sign, and the one that is "correct" (prior-temp3) has an interval touching zero. Notably
`uniform-prior` is the only dynamics arm whose interval excludes zero — and it excludes it in the
**wrong direction**, confidently reporting that deleting the root prior improves per-move decisions
while the match measured −0.12.

### What is now established, and what to do with it

`MEASURED` **Oracle regret of the engine's own root decision is a validated offline proxy for
leaf-estimation changes and a actively misleading one for search-dynamics changes.** The leaf claim
survived a preregistered held-out test; the dynamics failure was predicted and reproduced.

`STRUCTURAL` The mechanism is coherent and was arrived at from two independent directions. A
leaf-estimation change alters what the search believes, which shows up in one root decision. A
search-dynamics change alters how budget is spent, and its cost accrues over ~80 plies — a flatter
prior or a halving schedule can genuinely pick a better move at a single root while losing the game.
`v46_channel_audit.md` reached the same place by finding ε's benefit invisible in every per-leaf
statistic.

`STRUCTURAL` **Operational rule for v4.3 onward.** Any candidate that changes leaf estimation — a
value head, a rollout truncation scheme, a leaf blend — may be screened on this metric at roughly
25x less compute than a match, and only promoted after a match. Any candidate that changes search
dynamics — priors, exploration, rollout policies, root allocation — **must not** be screened on it,
because on the evidence here that screen is worse than not screening at all. This is the first time
the programme can say which offline number applies to which kind of change.

`ESTIMATE` One caution that limits how far to push it. The metric resolves only large effects: of the
nine arms, three have intervals excluding zero, and the two held-out confirmation arms — both around
1 to 1.6 points — do not. So this is a **direction-and-ordering** instrument for leaf changes, not a
magnitude estimator, and it cannot by itself clear a +0.5 promotion bar. Its role is to kill bad
leaf-side candidates cheaply before they reach a match, which is precisely what the v4 programme
needed and never had.

## Using the metric: the v4.2 leaf-value candidate

### The leaf channel, fully validated

`MEASURED` Adding every learned-leaf configuration with a measured match result — three v4.7 tail
arms and five v4.6 leaf-value arms — brings the leaf channel to **12 arms, Spearman 0.958, 12/12
correct in sign**, spanning −14.80 to +8.89 points. The metric correctly flags all three v4.7 tails
(which lost 4 to 16 points in matches) and orders the v4.6 family from full replacement to 25% blend.

`ESTIMATE` Had this screen existed, it would have killed v4.7 and most of v4.6 before any of those
matches were played. That is the concrete value of the v4.2 work: the leaf channel is where every
learned-value candidate lives, and it is now screenable at roughly 25x less compute than a match.

### What the v4.6 ledger actually says

| Configuration | Real rollout retained | Measured |
|---|---|---:|
| `v4.6-leaf-mean` | none | −13.88 |
| `v4.6d-pooled-leaf-sampled05` | none, sampled | −14.80 |
| `v4.6-leaf-sampled-real25` | 25% of leaves | −7.04 |
| `v4.6b-leaf-sampled-real25` | 25% of leaves | −6.58 |
| `v4.6d-pooled-leaf-blend25` | all, 25% value blend | −1.15 |
| `v4.6e-canonical-pooled-blend25` | all, 25% value blend | −0.81 |

`STRUCTURAL` Strictly monotone in how much real rollout survives, with no interior optimum anywhere
in the tested range — the signature `v46_channel_audit.md` §3.2 named for a *biased* leaf estimate.
Nobody had looked below a 25% blend, which is the only place an interior optimum could be.

### The blend sweep

`MEASURED` Screened against `v4.2-leaf-blend00`, a compute-matched control at the identical
iteration scale with no learned value at all, so the contrast isolates the network rather than the
iterations it costs. 302 oracle-labelled positions from 17 games:

| Blend | Δregret vs control | Interval |
|---:|---:|---|
| 0.05 | +0.012 | [−0.060, 0.099] |
| 0.10 | −0.057 | [−0.130, 0.020] |
| **0.15** | **−0.064** | **[−0.126, −0.001]** |
| 0.25 | +0.073 | [0.002, 0.148] |

**There is an interior optimum, and 25% is past it.** Blend 0.15 is the only arm whose improvement
interval excludes zero; blend 0.25 is confirmed *worse* than the control, which is consistent with
its −0.81 match result. Blend 0.05 flipped sign between the 140- and 302-position runs and should be
treated as noise; 0.10 and 0.15 held their direction across both.

### Preregistered prediction

Written before the match below was run.

`PROPOSED` **`v4.2-leaf-blend15` beats `v4.2-leaf-blend00` at equal compute.** The two configs differ
only in `netBlend` (0.15 vs 0), so the contrast is the learned leaf value and nothing else.

Magnitude, from the local calibration slope: `CONFIRM-cutoff24` scored Δregret +0.073 at −1.59
points and `v46e-blend25` scored +0.073 at −0.81, so roughly 10–20 points per unit Δregret near
zero. A Δregret of −0.064 therefore predicts something in the range **+0.6 to +1.3 points**.

100 seeds / 400 games, fresh block 51000000, MDE ≈ 1.34.

**Falsifier:** a negative point estimate. If the first metric this programme has validated points at
a candidate and the candidate loses, the metric does not transfer from *ranking known changes* to
*selecting unknown ones*, and no gate should be built on it regardless of its Spearman.

### Result — the prediction failed

`MEASURED` `v4.2-leaf-blend15` vs `v4.2-leaf-blend00`, 100 seeds / 400 games, block 51000000:
**−0.36 [−1.08, 0.35]**, 26.0% first place.

The prediction was +0.6 to +1.3. The point estimate is negative, and the predicted range sits almost
entirely outside the measured interval. **The preregistered falsifier fired.**

`MEASURED` So the metric's scope is narrower than the calibration suggested:

- **Ranking changes whose strength is already known: excellent.** 12 leaf arms, Spearman 0.958,
  12/12 correct in sign, over a −14.80 to +8.89 range. Every catastrophic learned-leaf configuration
  is flagged with an interval excluding zero.
- **Selecting between candidates that are all close to parity: failed.** Asked to choose among four
  blends separated by less than a point, it picked one that then measured −0.36.

`STRUCTURAL` These are not in tension, and the earlier caution said so before the match: of the nine
original arms only three had intervals excluding zero, and both ~1-point confirmation arms did not.
A metric that resolves 5-point differences and not 1-point differences will order a wide calibration
set beautifully and be useless for promotion. Spearman over a wide range measures the wrong thing —
it is dominated by the arms nobody needed a screen for.

`ESTIMATE` **What the metric is actually for, stated narrowly enough to be true:** it is a *veto*, not
a selector. It can cheaply kill a leaf-side candidate that is badly wrong — and on this evidence it
would have killed all three v4.7 tails and four of the six v4.6 configurations before they consumed
match compute. It cannot rank candidates inside the ±1 point band, and no promotion gate may be
built on it.

## Status: no valid v4.2 model

`MEASURED` Three learned components have now been measured in this engine, each in its own channel,
each against a compute-matched control:

| Component | Channel | Best measured result |
|---|---|---:|
| root prior (v4.1–v4.5) | dynamics | channel worth −0.12 in total; deleting the prior costs nothing |
| rollout-policy student (v4.1) | dynamics | −0.06 [−0.72, 0.61] head-to-head |
| leaf value (v4.6, v4.7, v4.2 sweep) | leaf | −0.36 [−1.08, 0.35] at the screened optimum; −0.81 or worse everywhere else |

None of them helps. That is the honest state of the learned programme, and it is now supported by
matches rather than by offline proxies in all three cases.

`STRUCTURAL` v4.2 therefore has **no model to promote**. What it has produced is a validated veto for
the leaf channel, a measured demonstration that the dynamics channel cannot be screened offline at
all, and the first ledger in this programme where every learned component's contribution is known
rather than assumed.

## Open questions

1. Does the metric resolve the ±1 point band once the corpus reaches 24 games? If not, more games,
   or several seeds per position per config to cut per-position noise.
2. Δagree scored 0.600 and is the weaker of the two. It throws away magnitude — a move that is
   0.02 squares worse and one that is 2 squares worse both count as one disagreement — so regret is
   expected to dominate and does.
3. `STRUCTURAL` Every arm in the current set is search-side. A metric validated only on search-side
   changes has not been shown to transfer to a **learned value head**, which intervenes on leaf
   estimation rather than on move selection. Adding a value-side arm with known strength — the v4.0
   leaf-blend sweep measured −0.47, −1.73 and −10.62 at 25%, 50% and 100% — would test that, and
   those configs are still registered.
