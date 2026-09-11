# Blokee v5 Oracle context-rich policy experiment

**Started:** 2026-08-28  
**Status:** measured; identity gate failed; CPU-only Oracle work stopped

## Hypothesis

Two different identity mechanisms failed on the same nine standardized action scalars while expert
diversity and calibration remained healthy. The next experiment changes the observation contract,
not the search or transformer size. A player policy should be more identifiable when the model can
see where a candidate lands, which pieces remain, which opponent it affects, and the surrounding
board pattern.

This phase remains prediction-only. No learned result may change a played move.

## Contextual data contract

Every decision stores the same exact legal candidate set and played index plus:

- four canonical 20×20 ownership planes, reflected so the mover's home corner is top-left;
- all four remaining-piece masks, occupied-square counts, open-corner counts, directed pressure,
  and normalized ply;
- the original nine within-legal-set style features;
- piece identity, canonical anchor and centroid, all candidate cell indices, target-specific
  pressure, corner denial, edge/diagonal contact, and primary-target identity.

Board planes and state features are stored once per decision, not repeated per legal candidate.
The candidate's occupied cells gather local features from a three-layer board convolution, so the
model can distinguish spatially different moves with similar scalar summaries.

The fresh league begins at seed 53,000,000. It uses only profiles absent from the previous adapter
holdout: search-depth/width, PUCT, prior-temperature, widening, history, implicit exploration,
policy-mixture, MAST, RAVE, move-shape, and v4.1-tier variants. Games and profiles remain disjoint
across train, validation, and the once-read holdout.

## Fixed candidates

1. **Scalar adapter:** the preceding eight-expert sequence-level latent mixture using only the first
   nine candidate features, retrained on this fresh league.
2. **Context adapter:** the same eight-expert latent-policy and online Bayesian update, with a
   three-layer width-16 board encoder, candidate-cell feature gathering, a state encoder, and the
   59-feature candidate vector.

Both arms use validation-only early stopping, temperature, likelihood learning rate, posterior
drift, and surprise threshold selection. Holdout is read once after the arm and filter are fixed.

## Preregistered gates

Metrics begin after three observations and bootstrap by game. Context-rich belief MCTS is
authorized only if every holdout condition passes:

- scalar-adapter NLL minus context-adapter NLL has a 95% lower bound above
  **0.05 nats/action**;
- context adaptive NLL beats its fixed expert prior with a lower bound above **0.03**;
- context adaptive NLL beats a shuffled player's posterior with a lower bound above **0.06**;
- top-five recall exceeds **65%**;
- ten-bin top-one ECE is at most **0.08** and no more than 0.01 worse than context fixed;
- every context expert receives at least 3% mean final training responsibility;
- validation-selected surprise reset is non-inferior on holdout posterior splices and its final
  four predictions are within 0.10 nats/action of clean history.

Passing authorizes only an implementation experiment for root-sampled belief MCTS. It does not
promote v5. Failure ends CPU-only identity work until consented, player-disjoint human trajectories
or genuinely external engine data are available.

## KV-cache boundary

Neither arm is a transformer, so runtime memory is a fixed eight-number posterior per opponent. A
future transformer may reuse one real-history KV prefix per opponent only after this richer input
contract demonstrates a transferable identity channel. KV caching remains an inference
optimization and must never be mutated by hypothetical search moves.

## Results

`MEASURED` The contextual corpus satisfied every structural requirement: 108 finished games, 24
new disjoint profiles, 7,748 decisions, 1,518,883 exact legal candidates, and zero missing actions.
The scalar arm had 1,632 parameters; the contextual board model had 30,880. Validation selected
epoch 113 for scalar and epoch 16 for context before the holdout was read.

On the once-read holdout, after three observations:

- scalar adaptive NLL: **2.887**;
- context adaptive NLL: **2.674**;
- context gain over scalar: **+0.214 [0.178, 0.251] nats/action** — pass;
- context adaptive gain over its fixed expert prior:
  **+0.0007 [−0.0018, 0.0034]** — fail;
- context adaptive gain over a shuffled player's posterior:
  **+0.0018 [−0.0013, 0.0048]** — fail;
- context top-five recall: **61.3%** — fail against 65%;
- context ECE: **0.019** versus fixed 0.025 — pass;
- minimum mean final expert responsibility: **10.1%** — diversity pass.

The context model is a materially better and exceptionally well-calibrated *population* move
model. But the fixed, adaptive, and shuffled distributions are effectively identical. The
validation-selected surprise reset fired zero times on holdout splices because replacing the entire
eight-action posterior changed tail NLL by only 0.00004. That gate again passes vacuously.

Three of seven gates fail, including both identity gates. Search integration is not authorized.

## Decision

The observation-contract hypothesis was only half right. Board position, remaining pieces, exact
candidate geometry, and target-specific interaction explain the next move much better than nine
scalars. They do not make these CPU configurations distinguishable from their prior actions.

This resolves the CPU-only branch:

1. A larger transformer is not justified. The fixed context model already extracts the useful
   action signal without history, while three independent history mechanisms add no transferable
   identity.
2. The 30,880-parameter context model is retained as a population-policy research artifact, not a
   v5 player. Earlier generations already showed that stronger offline policy metrics do not by
   themselves authorize search integration.
3. The next identity experiment requires longitudinal behavior that actually varies: consented
   human players, genuinely external engines, or deliberately trained strategic personalities.
   More nearby configurations from the same engine family are not a valid substitute.
4. Human collection must preserve whole-player splits, session boundaries, player-controlled
   opt-in, deletion support, and a no-persistent-identity mode. CPU/human metadata remains a prior,
   never a skill label.

Until such data exist, Oracle development should pause at prediction. KV-cache engineering is
complete enough for a future transformer—the verified cache path is numerically correct—but there
is no evidence that a transformer prefix would contain player-specific information on the current
CPU league.
