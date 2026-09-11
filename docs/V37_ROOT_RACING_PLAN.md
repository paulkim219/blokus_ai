# v3.7 workstream B — warm-start top-two root racing

> **Sequenced after workstream A, and sharing its corpus.** The two are halves of one design: A decides
> *whether* to spend another tranche, B decides *how* to spend it. A's checkpoint corpus already
> answers whether added compute diffuses across root children — which is this workstream's entire
> premise — and W1 below is explicitly an extension of it. Running both as parallel ladders costs
> ~7 hours to discover something A's offline corpus reports for free.
>
> B also inherits A's **gate 0**: convert the offline benefit into an expected match-point equivalent
> and check it against the decisive block's MDE before committing to a ladder. Both arms are
> root-selection mechanisms bounded by the same E2 figure.

## Hypothesis

The engine plays the most-visited root child. Ordinary PUCT is good at finding promising moves, but
added compute can still diffuse through many children after the plausible decision has narrowed to
two or three. Best-arm-identification theory says the remaining samples should distinguish the
leader from the challenger most capable of overtaking it.

This is not the rejected sequential-halving arm:

- incumbent PUCT runs unchanged for 100% of the nominal shaped allocation;
- no child is eliminated during that incumbent budget;
- racing controls only the *additional* 10%, 25%, or 50% tranche;
- it continues the same tree and retains every statistic already paid for.

## Research basis

- Kalyanakrishnan et al., [PAC Subset Selection in Stochastic Multi-armed
  Bandits](https://icml.cc/2012/papers/359.pdf): LUCB focuses samples on the empirical leader and the
  non-leader with the most overlapping confidence bound.
- Garivier & Kaufmann, [Track-and-Stop](https://proceedings.mlr.press/v49/garivier16a.html): track
  the allocation needed to separate the best arm and stop at a confidence criterion.
- Kaufmann & Koolen, [MCTS by Best Arm
  Identification](https://proceedings.neurips.cc/paper/2017/hash/a6d259bfbfa2062843ef543e21d7ec8e-Abstract.html): propagate tree uncertainty into root confidence intervals and sample the
  representative leaf of a marginal root child.
- Feldman & Domshlak, [Simple Regret Optimization in Online
  Planning](https://arxiv.org/abs/1206.3382): online planning is judged by the final selected action,
  so simple-regret allocation can differ from cumulative-regret UCT.

## W1 — root uncertainty audit

Extend the checkpoint corpus from workstream A. For the top four root children record:

- visit count and mean return for the root seat;
- sample variance and effective sample count;
- how often each child becomes the selected move at later checkpoints;
- which pair contains the stable long-budget winner;
- regret recovered by giving the next tranche only to `{leader, challenger}` versus normal PUCT.

Because tree samples are correlated, confidence intervals are ranking features, not claimed coverage
guarantees. Validate them empirically: among pairs assigned “90% separated,” the later winner should
reverse no more than about 10% on the held-out corpus.

## W2 — algorithm

After nominal PUCT finishes:

1. If `decided()` is true, stop.
2. Form a candidate set from the top four by visits plus any child whose empirical upper bound
   overlaps the leader's lower bound.
3. Identify the empirical leader and the challenger with the largest overlap or highest posterior
   probability of being best.
4. Restrict *root selection only* to those two for a small tranche; interior selection remains the
   incumbent max^n PUCT.
5. Recompute the pair after every 64 iterations. Stop when separated, decision-locked, or at the
   game-level compute cap.

Two offline variants are allowed:

- empirical-Bernstein overlap using backed-up return variance;
- non-parametric bootstrap probability that each root child is best.

The offline corpus chooses one. No match sweep of both.

## W3 — gates

On game-disjoint held-out positions, relative to uniform extra PUCT at the same iteration count:

1. Stable-oracle move agreement improves.
2. Mean oracle regret falls, with a game-bootstrap lower bound above zero for the improvement.
3. At least 80% of stable oracle winners are inside the raced set at nominal budget.
4. Extra visits do not concentrate on a child whose mean is based on fewer than the configured
   forced-exploration floor.
5. Benefit survives when stratified by own moves 1–5, 6–15, and 16–21.

If the root winner is already inside a decision lock on most positions, this arm has no fuel and
stops offline.

## Match protocol

The offline winner becomes one config at one cap. Compare it with:

- the shipping incumbent;
- the same incumbent with `iterationScale` calibrated to identical executed compute.

Use the master 40 -> 100 -> 200 -> 200 ladder. A positive result only against the shipping
incumbent is an effort level, not an architecture promotion.

## Files

- `src/ai/bitboard/config.ts`: `rootExtraPolicy?: 'puct' | 'topTwoRace'` and cap fields.
- `src/ai/bitboard/mcts.ts`: root-child restriction for added tranches only.
- `src/ai/bitboard/events.ts`: checkpoint/root-child statistics.
- `scripts/v37RootRaceReplay.ts` and `scripts/v37RootRaceBench.ts`.

