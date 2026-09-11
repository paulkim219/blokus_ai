# v4.2 selective-search experiment — preregistration

**Written before running the selective-action analysis:** 2026-08-26  
**Decision status:** no candidate is promoted by this document

## Claim under test

The proposed v4.2 architecture uses a learned policy only when a confidence controller expects its
direct move to be at least as good as the deployed search; otherwise it abstains and runs the exact
v3.7 search. The first test window is own moves 4–5. Earlier work already showed that unconditional
direct selection is not strong enough in this band, so the experiment is about whether uncertainty
features isolate a useful subset, not whether the policy's average move is better.

Two routes are tested:

1. **Selective action:** skip MCTS and use the pooled policy on accepted roots; search normally on
   rejected roots.
2. **Selective compute:** at nominal budget, predict which roots should buy a second tranche.

## Data separation

The opening corpus has 800 positions from 40 games. Positions from one game are correlated, so all
splits and uncertainty calculations use the game as the independent unit. Selective-action models
are evaluated with five-fold cross-fitting by game: every reported prediction is made by a model
that did not train on that position's game.

The primary band is own moves 4–5. The primary analysis uses positions where at least two of three
independent deep searches agree on the top move. Unstable positions are reported separately and are
not used to make the offline pass decision.

## Observable features

No oracle or deployed-search output is available to the controller. Features are limited to values
available before deciding whether to search:

- own-move index and legal-move count;
- policy top-one/top-two and top-one/top-three margins;
- normalised policy entropy;
- three-member ensemble vote share, chosen-move disagreement, and margin disagreement;
- agreement and rank under the engine's cheap tier-1 ordering;
- selected piece size and centre distance.

The learned controller is ridge regression with fixed regularisation λ=10. The comparison rules are
raw policy margin, ensemble vote/disagreement, heuristic agreement, and move 5 only. Coverage levels
are fixed in advance at 10%, 20%, 30%, 50%, and 100%.

## Offline targets and caveat

Run 0 of the deep oracle stores values for its top eight children. When both the policy and deployed
move appear in that head, gain is their direct value difference. A move outside the head is assigned
a conservative value below the stored tail; this produces a complete *censored proxy* but is not a
playing-strength metric. The report must therefore include both proxy gain and the uncensored subset.

The prior calibration established that root-decision regret is misleading for search-dynamics
changes. Consequently this offline analysis is only a safety/signal screen. It cannot promote a
candidate. Fresh online games are mandatory.

## Fixed gate

The 20% coverage arm is the primary arm. It passes the offline screen only if its cross-fitted:

- conservative proxy gain is positive;
- uncensored oracle-head gain is non-negative; and
- majority-oracle top-one agreement is no worse than deployed search.

At least 10% coverage is required. Confidence intervals are bootstrapped over games and reported,
but are not required to exclude zero at this corpus size. If no learned or fixed controller passes,
the selective-action candidate is rejected without an online match. If one passes, it is implemented
with exact v3.7 fallback and tested in a fresh seat-rotated match plus a wall-clock/iteration audit.

The continue/stop route retains its existing gate: it must recover roughly 55% of the perfect
controller's advantage at the +25% compute cap and beat every fixed null controller on held-out
games.

## Exploratory continuation recorded after the offline result

The primary 20% ridge arm failed because its exact resolved gain was negative. The pre-listed 30%
arm nevertheless had all three quantities in the right direction, and a fresh 16-seed online probe
measured +0.98 [−0.54, 2.70] versus its exact v3.7-pro parent. This is suggestive, not a gate pass.

Before running more games, one disjoint **40-seed / 160-game block** is fixed at seed base 84220000.
It is interpreted on its own:

- lower confidence bound above zero: strong online pass, still requiring a later promotion block;
- point estimate non-negative and at least 3% lower executed iterations per ply: retain as an
  experimental v4.2 foundation;
- point estimate negative: reject this fitted gate; do not rescue it with the pooled result.

No threshold, feature, or model refit is allowed before this block.
