# Blokee v4 architecture: first training and experiment decision

**Date:** 2026-08-25  
**Decision:** retain the v3.7 exact-search backbone and develop v4 as a trajectory-preserving,
search-aware reinforcement-learning rollout policy. Do not promote any first-pass candidate yet.

## Executive conclusion

The first experimental pass did not produce an agent that is measurably stronger than `v3.7`, and
it was not intended to claim a premature win over `v3.7-pro-max`. It did resolve the central
architecture question.

Learned value replacement is the wrong primary channel for this engine. It saves substantial time,
but even a real rollout prefix followed by a learned four-seat value loses too much search fidelity.
Sampling a learned joint Gaussian does not restore the trajectory process. Frozen search-policy
imitation also fails because a rollout policy is valuable for the estimates it produces inside
MCTS, not because it copies the strongest one-step move.

The viable v4 base is therefore:

> **v3.7 exact max-n MCTS + full stochastic terminal rollouts + a cheap state/action rollout policy
> trained on search-level game return through league self-play and reanalysis.**

The hand-authored v3.7 policy is the exact identity/fallback point. Learning changes only which
actions the guided rollout branch samples. The first six-parameter CEM policy proved this path can
be trained and deployed without slowing the engine, but its confirmed strength was exactly neutral.
It is infrastructure evidence, not a promoted model.

## What was trained and measured

### Learned rollout-tail students

Game-disjoint training sets were exported from actual `v3.7-pro` expanded leaves. Separate students
were trained after 8, 16, and 24 real rollout plies, using repeated terminal continuations as the
target. The experiments included deterministic four-seat means, a 52 KB linear distillation, and
multivariate Gaussian sampling with learned cross-seat covariance.

The most economical arm cut midgame cost by about 31%, but lost 11.62 points at equal iterations.
The least damaging deterministic arm still lost 4.46 points and had already surrendered the useful
speed advantage. Joint sampling was worse, losing 16.17 points at prefix 16 and 6.08 at prefix 24.

**Result:** kill learned tail replacement. A conditional return distribution is not a substitute for
the stateful, correlated trajectory process that v3's MCTS consumes.

### Cheap rollout-policy imitation

A phase-conditioned linear/listwise policy was trained from game-disjoint search targets using only
features cheap enough for every rollout candidate. It achieved 26.8% held-out top-one agreement;
the incumbent static ordering achieved 34.6%. Validation selected a learned correction weight of
exactly zero.

**Result:** stop before online play. Search imitation is an inappropriate objective for simulation
control.

### Search-aware reinforcement learning

A seeded cross-entropy-method evolution strategy optimized actual seat-rotated match return against
a fixed `v3.7` population. The initial policy exactly reproduced v3.7. The six trainable parameters
were phase-specific epsilon, corner/edge halo weights, and sampling temperature.

The selected discovery candidate scored +1.18 points on 16 fresh seeds, but the fixed 40-seed
confirmation scored **0.00 [−1.27, 1.27]** over 160 games. Its first-place rate was 25.6%. Midgame
cost was 207.2 microseconds per iteration versus 204.0 for v3.7, a difference smaller than timing
noise.

**Result:** the objective and integration survive; the global six-parameter policy does not. Close
this capacity level and move to a conditional policy.

## Selected v4 architecture

### Search and game model

Keep unchanged:

- exact bitboard state transitions and legal moves;
- v3.7's no-tree shortcut on each seat's first three own moves;
- max-n four-seat vector backup and the existing score/rank transform;
- PUCT, progressive widening, history, transpositions, and decision locking;
- the exact/near-sealed endgame machinery;
- full terminal rollouts and their common-random-number evaluation discipline.

This preserves the parts with the strongest local evidence and makes v4 backward-compatible with
the v3 policy at every state.

### Learned rollout action policy

The next student should score the rollout's already-capped candidate set with:

- canonical mover-relative placement identity;
- phase and remaining-hand features;
- piece, orientation, size, anchor, centre distance, corner halo, and edge halo;
- a small number of incremental local-context features already available from bitboards;
- optional pooled statistics of the current candidate set.

The first runtime form should be a phase-conditioned canonical placement table plus a narrow linear
or low-rank contextual correction. It should remain within roughly one lookup and a small number of
multiply-adds per candidate. A larger teacher may use board planes, region structure, and candidate
set context offline, but it should be distilled rather than inserted into every rollout ply.

### Reinforcement-learning loop

Train the policy on the quantity deployment actually uses:

1. sample four-seat lineups from a league containing the learner, historical checkpoints, diverse
   exploiters, and fixed v3.7 tiers;
2. generate exact self-play with seat rotation and retain raw four-seat terminal scores;
3. use policy-gradient/PPAF-style updates on rollout actions, with search-level game advantage as
   the primary reward and v3.7 as a control variate;
4. reanalyse valuable or uncertain states with more search and distil the teacher into the runtime
   student;
5. aggregate states induced by the new policy rather than training forever on frozen v3 data;
6. preserve an explicit mixture with the incumbent guided policy and uniform exploration;
7. promote only on fresh opponent-lineup and seed blocks at equal wall clock.

Expert Iteration supplies the general search/generalization loop; multiplayer league training is
needed because latest-versus-latest self-play can cycle in a four-player general-sum game. The
supporting literature and alternative architectures are linked in
`v4_architecture_critique_and_options.md`.

## Why this has a higher ceiling than v3

V3.7 is one fixed, manually designed rollout policy. The proposed v4 policy family contains that
exact policy as its identity point, but can condition on substantially more state and improve from
new self-play generations. Its ceiling rises with data, teacher quality, policy capacity, and league
coverage while exact dynamics and search remain intact.

This is a ceiling argument, not a current-strength claim. The first learned instance is neutral.
The architecture becomes a validated stronger base only when a conditional student clears fresh
standard-tier matches, retains its wall-clock economics, and transfers through Pro to
`v3.7-pro-max`.

## Next experiment and stopping rules

The next run should train one canonical phase-conditioned placement-table student with a tiny
contextual residual. Do not run another global scalar sweep.

Advance only if all of the following hold:

- identity/fallback replay remains exact;
- candidate scoring adds no more than 5% per-iteration cost;
- a fresh standard-tier block beats both v3.7 and the neutral six-parameter arm;
- gains survive an opponent league rather than only mirror self-play;
- equal-wall-clock results stay positive at Pro;
- a separately preregistered Pro Max block is positive before any claim against
  `v3.7-pro-max`.

If the placement table cannot improve despite a correct search-level objective, close rollout
policy learning and revisit direct root action selection with calibrated abstention. Do not return
to learned leaf replacement without a model that reproduces conditional trajectory behavior rather
than only terminal marginals.

## Artifacts

- Full experiment record: `research_paper/v4_architecture_experiment_log.md`
- Prior web/literature review: `research_paper/v4_architecture_critique_and_options.md`
- RL discovery: `tuning/tune-2026-08-25T19-57-00-571Z.jsonl`
- Fixed discovered config: `tuning/tune-2026-08-25T19-57-00-571Z-best.json`
- Fresh validation: `selfplay-results/match-2026-08-25T20-03-37-877Z.jsonl`
- Fresh confirmation: `selfplay-results/match-2026-08-25T20-06-10-345Z.jsonl`
- Cost benchmark: `selfplay-results/v48-rollout-rl-cost-bench.json`

No experiment in this report supports promotion, and no claim is made that the current v4.8
candidate beats `v3.7-pro-max`.
