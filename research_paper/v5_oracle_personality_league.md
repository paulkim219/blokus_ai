# Blokee v5 Oracle strategic-personality league

**Started:** 2026-08-28  
**Status:** measured; all source-quality gates passed

## Question

The contextual Oracle model predicts moves substantially better than the nine-scalar adapter, but
nearby configurations of the same CPU family remain indistinguishable from three to eighteen prior
moves. This experiment asks a narrower question before any new opponent model is trained:

> Can objective-level strategic behavior produce a transferable identity signal that is visible
> from an ordinary game trajectory?

This is a source-quality experiment, not a playing-strength or Oracle-integration experiment. No
personality result may change the shipped player or authorize belief MCTS.

## Personality contract

Every personality starts from the same exact legal rules and the same bounded base move ranking.
A strategic residual reranks those legal candidates from observable candidate geometry and an
immutable real-game interaction history. Imagined moves never update that history.

Eight families are fixed before export:

1. **expansion** — prefers frontier growth, outward reach, and large early placements;
2. **center** — races toward central access;
3. **edge** — develops along the perimeter;
4. **blocker** — maximizes denial and direct opponent contact;
5. **retaliator** — preferentially pressures players who recently pressured it;
6. **persistent** — continues pressuring its previously selected victim;
7. **next-hunter** — preferentially pressures the immediately following seat;
8. **tempo** — spends large pieces unusually early.

Each family has three residual-strength variants. Variant `a` appears only in training, `b` only in
validation, and `c` only in the once-read holdout. The family objective is shared, but the exact
profile is disjoint. Seats rotate, opening samples use a separate seeded stream, and every game and
profile belongs to exactly one split.

The league is deliberately synthetic and is labelled as such. It is not human data and is not a
substitute for a consented human evaluation lane.

## Blind separability benchmark

For every player-game trajectory, the benchmark observes only the contextual legal-set features
and the moves actually chosen. It does not receive the profile ID, version string, seat label,
score, or family name as input. A regularized multinomial linear classifier predicts one of the
eight objective families from the mean and standard deviation of the selected-action features.

Regularization is selected on variant `b`. The holdout variant `c` is read once after preprocessing,
feature selection, and regularization are fixed. Results are reported for the first 3, 5, 8, and 12
observations and the complete trajectory. Confidence intervals bootstrap whole games, preserving
the four correlated seats.

A negative control trains the same classifier on independently shuffled training labels and is
evaluated on the real holdout labels.

## Preregistered gates

The strategic league is accepted as a useful Oracle training source only if all holdout conditions
pass:

- complete-trajectory family accuracy has a 95% bootstrap lower bound above **45%** (chance 12.5%);
- eight-observation family accuracy has a lower bound above **35%**;
- complete-trajectory macro-F1 exceeds **0.40**;
- every family has at least **20%** complete-trajectory recall;
- the complete-trajectory accuracy advantage over the shuffled-label classifier has a lower bound
  above **20 percentage points**;
- every exported game finishes and every played action appears in its exact legal candidate set.

Passing means only that the league contains learnable, transferable behavioral variation. The next
experiment would train the contextual population-plus-player-residual model on these profiles and
repeat the existing fixed-versus-adaptive and correct-versus-shuffled history gates. Failure means
the personality generator must be redesigned using validation-only evidence or replaced with
external/consented longitudinal data.

## KV-cache boundary

This benchmark aggregates short trajectories and has no transformer cache. If the league passes,
a later history transformer may maintain one append-only KV cache per real opponent. Candidate
search branches may read that cache or clone a derived state, but no hypothetical move may mutate
the real-history prefix.

## Results

`MEASURED` The full corpus contains 144 finished games, 24 disjoint profiles, eight objective
families, 9,728 decisions, and 2,026,478 exact legal candidates. All played actions were present in
their legal sets. Each split produced 192 player-game trajectories; the classifier was trained on
variant `a`, regularized on `b`, and read variant `c` once.

Holdout family classification was:

- first three observations: **66.1% [57.8%, 74.0%]**;
- first five observations: **78.1% [71.9%, 84.4%]**;
- first eight observations: **72.9% [66.1%, 79.2%]**;
- first twelve observations: **76.6% [71.4%, 81.8%]**;
- complete trajectory: **78.6% [73.4%, 83.9%]**, with macro-F1 **0.787**.

Complete-trajectory shuffled-label accuracy was 13.5%, close to the eight-class chance rate. The
real-minus-shuffled advantage was **+65.1 [57.8, 72.4] percentage points**. Worst-family recall was
45.8%, belonging to the persistent-targeting family; expansion, center, and edge were each 100%.
The main remaining confusion is among blocker, retaliator, persistent, and next-hunter, which is
the difficult interaction-specific distinction the eventual history model must learn.

All six preregistered gates passed. The non-monotonic prefix curve is retained as measured: five
moves happened to classify better than eight on this finite sample, so the experiment does not
claim that information decreases with history.

## Decision

The synthetic personality league is accepted as a behavioral source for one prediction-only
population-plus-player-residual experiment. This is the first Oracle cycle in which an unseen
configuration's behavior is strongly identifiable after only a few moves.

The result is intentionally limited:

1. The classifier observes features closely related to the authored objectives, so this is a
   positive source-quality result—not evidence that the final Oracle architecture works and not a
   proxy for human identity.
2. Search integration remains unauthorized. The next model must still beat fixed and
   shuffled-history controls on legal-action likelihood before it may influence a move.
3. Variant `c` is now consumed. A later player-residual experiment may use this corpus for
   development, but its promotion holdout must use a newly preregistered variant and new seed block.
4. The next model should freeze or initialize from the contextual population encoder and learn a
   low-dimensional candidate-specific residual from opponent history, with auxiliary target and
   change-point heads. A small GRU and transformer should compete; KV caching matters only if the
   transformer wins the identity gate.
