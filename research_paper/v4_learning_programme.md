# What v4 Is Missing

## A lifecycle for the learned Blokus agent — diagnosis of v4.1–v4.5, and a programme for v4.6 → v5

Companion to `blokus_ai_research_report_v4.md`. Research and design only; nothing here has been
implemented or measured by this document. Every number attributed to the project is a citation of an
existing measurement, not a new one.

---

## §0. How to read this document

It keeps revision 4's tag discipline and adds two tags, because a plan needs to distinguish "someone
measured this" from "I did this arithmetic on someone else's measurement".

| Tag | Meaning |
| --- | --- |
| `MEASURED` | Measured in this project, with the number and where it lives. |
| `LITERATURE` | Established elsewhere. Transfer to Blokus is an assumption unless argued. |
| `STRUCTURAL` | Follows from the rules or from code in this repository; cite the file. |
| `ESTIMATE` | My arithmetic on measured quantities. States its assumptions. Not a measurement. |
| `PROPOSED` | A design or experiment. Untested by definition. |

### 0.1 The thesis, in one paragraph

`MEASURED` v4.1 through v4.5 improved offline ranking metrics monotonically — held-out sibling pair
accuracy 60.44% → 63.24%, root top-1 26.36% → 33.45% — and produced no playing-strength gain that any
of their matches could distinguish from zero.

`ESTIMATE` The natural reading is that the models are still not good enough. I think that reading is
wrong, and that four generations have been spent on it. The models are being deployed into **the root
PUCT prior**, the channel in which this project has now recorded a long run of nulls and small
negatives and not one reproduced gain; they are being trained on a **candidate set
twelve moves wide** while deployed against a shortlist **forty moves wide**; they are being selected
by an **offline metric that has never been calibrated against strength and has never carried an
error bar**; and they are being gated by **40-seed matches whose minimum detectable effect is 2.1
points against an advancement rule of 0.5**. Each of those four is individually sufficient to
produce exactly the observed pattern of "offline up, online flat". Until they are fixed, no
architecture change can be evaluated, and the architecture is not where the deficit is.

The corollary is the useful part. The project's own measurements say where strength lives — leaf
estimation, worth +4.7 to +6.9 — and no v4 generation since v4.0 has touched it. **v4.3, v4.4 and
v4.5 are policy-only.** They cannot, even in principle, move the lever that measurement identified.
A real v4 has to put the network where the points are.

### 0.2 What this document adds

1. **A single unit** (§1). Points per doubling of compute, derived from the project's own compute
   ladder, so that a mechanism's gain and its cost can be compared without hand-waving.
2. **A diagnosis** (§2) of why v4.1–v4.5 have not converted, with five specific, checkable defects.
3. **The literature that bears on each defect** (§3), chosen for transferability rather than fame,
   including the one result — simulation balancing — that already explains the project's biggest
   recent win and nobody has connected to it.
4. **A list of what v4.3, v4.4 and v4.5 are missing** (§4), stated as omissions rather than errors.
5. **A version ladder** (§5) — v4.6 through v5.0 — where each release has a hypothesis, a channel, a
   cost, a gate, and a named falsifier.
6. **An experiment catalogue** (§6), ordered by information per unit of compute, including four
   experiments that are cheap and could each terminate an entire branch of the programme.

---

## §1. One unit: points per doubling

`STRUCTURAL` Every decision in this project trades accuracy against compute, and the two have been
discussed in different currencies. They should not be. The project has measured the exchange rate
twice.

| Comparison | Compute ratio | Doublings | Advantage | Points / doubling |
| --- | ---: | ---: | ---: | ---: |
| Full playouts at 1× vs at 1/1.3× budget (≈300 iters) | 1.30 | 0.38 | 5.71 − 4.73 = 0.98 | ≈2.6 |
| v3.1-pro-max vs v3.1-pro (2400 vs 1377 iters) | 1.74 | 0.80 | +1.02 [0.24, 1.84] | ≈1.3 |

`ESTIMATE` **Take ≈1.3 points per doubling at the pro tier and ≈2.5 near 300 iterations.** The two
points are consistent with the usual diminishing-returns curve and are enough to price anything.
Three consequences, all of which change how the existing results read:

**A candidate that costs 8% of wall clock has already spent ≈0.15 points before it plays a move.**
The v4.3 root prior scored +0.20 [−1.20, 1.56] at an ≈8% compute discount, so its mechanism is worth
roughly +0.35 gross. That is a real, positive, correctly-signed effect. It is also about a quarter of
what one doubling buys, which is why no match at that scale could see it.

**A version name needs about one doubling.** If v4 is to be a generation over v3 rather than a
decoration, it should be worth ≥ +1.3 net — equivalently, it should let the pro tier play at pro-max
strength for pro-tier money. Nothing in v4.1–v4.5 has been within a factor of three of that.

**The measured levers, priced.**

| Change | Advantage | Doublings equivalent | Compute equivalent |
| --- | ---: | ---: | ---: |
| Full-length rollouts vs 12-ply truncation | +4.7 to +6.9 | 3.6 – 5.3 | 12× – 40× |
| Fitting evaluation weights (v3-era) | +4.5 | 3.5 | ≈11× |
| ε 0.15 → 0.60 in terminal rollouts | +0.88 | 0.68 | ≈1.6× |
| Fractional territory tie-break | +0.96 | 0.74 | ≈1.7× |
| Phase schedule | +1.02 | 0.78 | ≈1.7× |
| v4.3 root prior (gross) | ≈+0.35 | 0.27 | ≈1.2× |

`STRUCTURAL` Read the last row against the first. The learned policy programme is currently
competing for a prize an order of magnitude smaller than the one the same engine's leaf estimator
won by accident. That is not a statement about neural networks. It is a statement about which part
of the engine the network has been plugged into.

---

## §2. Diagnosis: five reasons v4.1–v4.5 did not convert

### 2.1 The deployment channel has almost no leverage, and its headroom has never been measured

`STRUCTURAL` The learned policy enters the engine at exactly one place — the `netPrior` block of
`BitboardSearch.initialise` in `src/ai/bitboard/mcts.ts`, guarded by `isRoot`. At the **root only**,
it rescores the shortlist that the hand heuristic already produced, softmaxes it at `netPriorTemp`,
and blends it into `node.priors` at `netPriorBlend`. It never runs at an interior node, never runs at
a leaf, and never affects a rollout. The comment above it states the reason plainly: running it at
every interior node "would cost more than the entire search budget".

`STRUCTURAL` In PUCT, the prior's influence on selection is `c · P(a) · √N / (1 + n(a))`. At the pro
tier the root receives ≈1377 iterations across ≤40 children. Once a child has a few dozen visits the
Q term dominates, and the played move is the most-visited child — a function of Q, not of P. The
prior therefore governs the *order in which children are opened* and roughly the first hundred
iterations of allocation. It is a tie-breaker on a decision that search mostly makes for itself.

`STRUCTURAL` And "the root prior" is not one channel but three, of which the learned model touches
only the last:

1. **Candidate generation.** `MoveOrderer.scoreMoves` — the cheap bitboard tier — scores every legal
   move and `sortByScore` truncates to `rootShortlist = 40`. Hundreds of moves are discarded here,
   before any network runs.
2. **Opening order.** Progressive widening opens children in shortlist index order (`node.opened`),
   which is the same heuristic ranking.
3. **PUCT weights.** The softmax probabilities, which is the only thing `netPriorBlend` alters.

`STRUCTURAL` A learned policy that only reweights (3) is competing for the smallest of the three, and
**cannot in principle recover a move that (1) threw away.** No experiment in the programme has
measured how often the right move is outside the heuristic's top 40. E2(c) does, and if the answer is
non-trivial the correct use of a learned policy changes from reranking to candidate generation.

`MEASURED` This is consistent with everything the project has measured in the same channel:
PUCT with a heuristic prior as a standalone change −1.03; prior temperature 3 −2.93; `cPuct` sweeps
null; widening 24→48 +0.21 [−0.44, 0.85]; ten-arm tree screen produced no reproducible winner;
learned-prior-only −0.59 [−1.87, 0.75]; v4.1 prior +0.12 [−1.02, 1.36]; v4.3 prior +0.20 [−1.20,
1.56]; v4.5 single-member prior −0.27 [−1.43, 0.93] and three-member ensemble −0.02 [−1.22, 1.09]
(`selfplay-results/match-2026-08-22T23-28-46-169Z-summary.txt`,
`match-2026-08-22T23-39-54-332Z-summary.txt`).

`STRUCTURAL` **The programme has never measured how much score is available in this channel at all.**
That is the omission that makes the rest of the ladder ungrounded: without a headroom number,
"+0.20, not significant" cannot be distinguished from "+0.20, and 0.30 was the maximum possible".
Two cheap experiments settle it and are the first two entries in §6.

`MEASURED` The most recent v4.5 configurations begin to escape this channel. `rootPriorPseudoVisits`
(`src/ai/versions/v3.ts:871-900`) injects the policy into the **root readout** — the final
argmax — rather than only into selection. Its 16-seed screens were +2.09 [−0.01, 4.15] at 128
pseudo-visits, +0.37 at 256, −0.03 at 512; the 40-seed confirmation
(`match-2026-08-23T00-08-33-361Z-summary.txt`) has no recorded result. That is a different and
better channel, and §3.3 says what the principled version of it is.

### 2.2 Train/serve skew in the candidate set

`STRUCTURAL` The exporter keeps `--top-k 12` candidates per root, ranked by the teacher's own visit
share (`scripts/exportTraining.ts`, the `slice(0, topK)` at candidate aggregation). **Every export
batch in the programme passes 12**: `v41ShiftExportBatch.ts`, `v42TeacherExportBatch.ts`,
`v43FeatureExportBatch.ts`, `v43ConsensusExportBatch.ts`, `v44SpatialExportBatch.ts`,
`v45SpatialScaleExportBatch.ts`, and the three v4.0 value shards (`topK: 12` in their metas). The
training probes then cap again at `--max-k 12` (`ml/probe_action_spatial.py`). The deployed prior
scores `rootShortlist: 40` candidates (`src/ai/bitboard/config.ts:522`) and softmaxes over all of
them.

`ESTIMATE` So the model is trained to rank the twelve moves a 2400-iteration search already liked,
and deployed to rank forty moves of which roughly twenty-eight are outside its training
distribution. Its logits on those twenty-eight are extrapolation, and a softmax has no way to be
agnostic: an out-of-distribution move that happens to receive a high logit is *promoted*, and
promoted at exactly the moment when the hand prior — trained implicitly on the whole shortlist —
would have suppressed it. A model can therefore improve monotonically on the twelve-wide task while
degrading on the forty-wide one, which is the observed pattern.

`MEASURED` The report already noticed the symptom without naming the cause: "uniform top-1 is about
9% at the measured average root width of 11.1". 11.1 is not Blokus's root width. It is the export
cap. The offline task and the deployment task are different tasks and have never been the same
width.

`MEASURED` §9.7 item 2 of the report proposed the fix — "Retain hard negatives below the teacher's
top set" — and the exporters do not do it.

### 2.3 The offline metric has no error bar, no incumbent baseline, and no calibration to strength

`STRUCTURAL` Three separate problems, all in the same table.

**No error bar.** Every offline comparison in §9.7–§9.8 is a point estimate on a single held-out
shard. v4.4's holdout was 580 roots from 32 games; v4.3's was 878 roots.

`ESTIMATE` Take the v4.4 headline, 33.45% vs 30.27% top-1 on 580 shared roots. Paired, that is a net
flip of ≈18 roots. Under a McNemar-style estimate with a plausible 25% discordance rate (≈145
discordant roots), the standard error on the difference is √145/580 ≈ 2.1 points, putting a
3.2-point gain at ≈1.5σ. Roots inside one game are strongly dependent — the same board, three plies
apart — so a clustered bootstrap over the 32 games would widen that further; a design effect of 2
would put it near 1.0σ. **The document's own §7 requires a minimum detectable effect beside every
null. The offline ladder has never once obeyed it.** The report's own note that "repeat
initialisations moved the scalar baseline by several tenths" says the seed noise is of the same order
as the effects being promoted.

**No incumbent baseline.** §9.2 gate 5 requires that "a policy candidate must first beat the hand
prior offline by phase". No table in §9.7 or §9.8 reports the hand prior's pair accuracy or top-1 on
any holdout. The arms are compared to each other and to uniform (9%), never to the thing they are
replacing. `MoveOrderer.deepScore` (`src/ai/bitboard/ordering.ts`) is a fixed, deterministic function
and can be scored on the identical holdout in minutes. Until it is, "33.45% top-1" has no sign.

**No calibration.** Pair accuracy, top-1 and policy-mass regret are proxies. Nobody has checked that
any of them orders known-strength changes correctly. The project is unusually well placed to check:
it owns a set of changes whose strength effects are measured and span −3 to +7 points.

### 2.4 The online gate cannot see the effect it gates on

`MEASURED` The per-seed standard deviation of the rotation statistic is ≈4.8, so the minimum
detectable effect at 80% power is ≈13.4/√seeds. Every v4 online gate has run at 40 seeds.

| Seeds | MDE | Games |
| ---: | ---: | ---: |
| 16 | 3.35 | 64 |
| 40 | 2.12 | 160 |
| 100 | 1.34 | 400 |
| 718 | 0.50 | 2,872 |

`ESTIMATE` The advancement rule is +0.5. Detecting +0.5 at 80% power needs ≈718 seeds — eighteen
times the block that has actually been run. **Every "+0.12 [−1.02, 1.36]" in the v4 ledger is
uninformative with respect to its own decision rule.** The programme has been running a sequence of
experiments whose only possible outcomes were "reject" and "no information", and then reading the
second as evidence about the model.

`ESTIMATE` This also explains the recurring pattern the v3.2 shift documented so carefully: a
16-seed screen at MDE 3.35 selects the top of a noise distribution, and the 40-seed confirmation
regresses. Eight candidates in that shift followed exactly that arc. It is not bad luck; it is the
arithmetic of screening at 3.35 for effects near 1.0.

### 2.5 The value head — the only component that touches the measured lever — was abandoned after one experiment whose data violated a known rule

`MEASURED` The v4.0 value model measured −10.62 at 100% leaf weight, −1.73 at 50%, −0.47 at 25%.
Monotone damage in leaf weight, correctly diagnosed in the report as bias. No value model has been
trained since. v4.1 through v4.5 are policy-only.

`LITERATURE` AlphaGo hit precisely this failure and named its cause. Trained on positions drawn from
complete games, its value network reached MSE 0.19 on train and 0.37 on test — it memorised game
outcomes, because successive positions differ by one stone and share a label. The fix was to build a
dataset of 30 million positions **each from a separate game**, after which train and test MSE were
0.226 and 0.234 ([Silver et al., 2016](https://www.nature.com/articles/nature16961)).

`MEASURED` The v4.0 value model's training set is on disk and is exactly this dataset. Its three
shards (`ml/data/train.meta.json`, `train-8200000.meta.json`, `train-8300000.meta.json`) hold
153,124 + 80,959 + 89,512 = **323,595 rows from 186 + 98 + 109 = 393 games** — the report's figure,
reproduced. That is ≈823 rows per game, every one of them labelled from the same four final scores,
and the sibling rows within a root differ by a single placement.

`ESTIMATE` So the effective sample size for a value regression is on the order of 393 independent
outcomes, presented as 323,595 rows. This is the AlphaGo failure mode with the correlation roughly an
order of magnitude worse than the case AlphaGo had to fix. The −10.62 is not evidence that a Blokus
value function is hard; it is the expected result of fitting one to memorise four hundred games.

`STRUCTURAL` It is also the wrong target, which §3.2 develops: the model was asked to predict a
searched or final value, when the quantity MCTS actually averages at a leaf is something else and
much easier.

---

## §3. What the literature actually says, mapped to this engine

### 3.1 The rollout policy: the project has already discovered simulation balancing without knowing it

`MEASURED` Raising the uniform-random branch of the terminal rollout from ε=0.15 to ε=0.60 is worth
+0.88 [0.25, 1.54] at pro-max and is the only promoted change of the entire v3.2 shift. Fully
uniform, ε=1.00, was worth only +0.36. ε=0.05 was −1.01. The response curve has an interior optimum.

`LITERATURE` This is a textbook result with a name and a theory. **Increasing the strength of a
playout policy routinely makes the wrapping search weaker.** Silver and Tesauro's *Monte-Carlo
Simulation Balancing* ([ICML 2009](https://icml.cc/Conferences/2009/papers/500.pdf)) formalised why:
what MCTS needs from a simulation policy is not that it plays well, but that the *expectation* of its
outcome tracks the true value of the position — that its errors cancel rather than accumulate in one
direction. They optimise a balance objective by policy gradient over a softmax policy on ~100 simple
patterns and report ≈200 Elo over strength-trained alternatives on 5×5 and 6×6 Go. Huang, Coulom and
Lin's *Monte-Carlo Simulation Balancing in Practice*
([CG 2010](https://www.remi-coulom.fr/CG2010-Simulation-Balancing/SimulationBalancing.pdf))
reproduced it at 9×9 and confirmed the paradox directly: supervised-strong playout policies lost to
balanced ones inside the search.

`STRUCTURAL` The mapping to this engine is exact. `playoutScore`
(`src/ai/bitboard/playout.ts:137-139`) is a two-term linear policy — piece size and centre distance —
and ε-greedy over it is a crude, single-parameter interpolation between that policy and uniform. The
ε sweep is a one-dimensional search over the space simulation balancing searches properly. The
measured curve — the fitted heuristic being *too strong*, uniform being *too weak*, optimum in the
interior — is the signature the balancing literature predicts.

`ESTIMATE` One knob on a two-term policy was worth 0.68 doublings. The programme has never fitted the
two weights, never added a third term, and never tried a target other than "play well". **This is the
single largest unoptimised channel in the engine, it is where the last real gain came from, and no v4
generation has touched it.**

`LITERATURE` The cost model is the reason it must stay small, and AlphaGo calibrates it precisely:
its rollout policy was a linear softmax over hand-crafted local patterns at **2 µs/move and 24.2%
move-prediction accuracy**, against the policy network's 3 ms and 57%. The weak, fast policy is the
one that went inside the rollouts, by a factor of 1500 in speed and at less than half the accuracy.
A learned rollout policy for Blokus is not a small MLP. It is a table plus a handful of weights.

`ESTIMATE` The budget, made concrete. At the pro tier a move costs ≈190 ms (≈41 ms at 300 iterations,
`src/ai/bitboard/net.ts:8`, times the 4.59 iteration scale) and runs ≈1,377 rollouts of ≈70 plies,
each scoring up to `playoutMoveCap` = 12 candidates: ≈1.2 million candidate scorings per move. A 25%
budget share allows ≈40 ns per scoring — on the order of a hundred cycles. That admits **one array
lookup plus five to ten multiply-adds**. It does not admit a 256-input MLP (≈25k flops), which is
why the network as currently built can never enter the rollout. It comfortably admits a
precomputed static per-placement bias table: 30,433 placements × 4 bytes = 122 KB, × 3 phases = 366 KB,
which the browser build can ship.

`LITERATURE` The online alternatives are already measured out. MAST at piece level, MAST at exact
placement, within-game MAST persistence, and piece-level RAVE were all null in the v3.2 shift.
Cazenave's Playout Policy Adaptation with move Features
([PPAF](https://www.sciencedirect.com/science/article/pii/S0304397516302699)) generalises MAST by
keying on move *features* rather than move identity, which is the one variant not tried, but it is
still online learning from a few hundred rollouts per move. Offline fitting has orders of magnitude
more data and no per-move cost. Prefer offline.

### 3.2 The leaf value: the MLP's comparative advantage is variance, not ranking

`STRUCTURAL` This is the argument that decides where a network belongs in this engine.

A full rollout is a sample: approximately unbiased with respect to the quantity the search wants,
and high variance. An MLP is the opposite: zero variance, biased by its approximation error. Blending
them is a bias–variance trade, and the trade is only worth making where variance is the binding
constraint. At the root of a 1377-iteration search, variance is not binding — the top children have
hundreds of samples. **At a freshly expanded leaf, which has exactly one, variance is everything.**
That is the MLP's comparative advantage in this engine, and the root prior does not exploit it.

`LITERATURE` AlphaGo combined the two rather than choosing: `V(s_L) = (1−λ)·v_θ(s_L) + λ·z_L` with
λ = 0.5, i.e. equal weight to value network and rollout. The project ran the same sweep and got
−0.47 at 25% and −1.73 at 50% — monotone, no interior optimum. A monotone λ-curve is the diagnostic
signature of a *biased* value estimate; AlphaGo's interior optimum is the signature of an unbiased
but imperfect one. The sweep was correct; the value function under it was not.

`PROPOSED` **Change the target, and the bias disappears by construction.** MCTS does not want the
true minimax value of a leaf. It backs up the mean of the returns its own rollout policy produces.
Define

  *V_π(s) = E[ z(s) | s, rollout policy π ]*

and fit V̂ to that. Then:

- The labels are free and already being computed. Every rollout the engine runs is a
  `(state, return)` pair; a single pro-tier game generates ≈100,000 of them.
- V̂ is unbiased for *exactly the quantity the search averages*, so mixing it in at any λ is variance
  reduction rather than a bias trade — the control-variate construction of Veness, Lanctot and
  Bowling, *Variance Reduction in Monte-Carlo Tree Search*
  ([NIPS 2011](https://papers.nips.cc/paper/2011/hash/d736bb10d83a904aefc1d6ce93dc54b8-Abstract.html)),
  which applies exactly this idea to MCTS and reports gains on Pig, Can't Stop and Dominion.
- The regression is easier than the one v4.0 attempted. Predicting a rollout policy's mean outcome
  is a smoother function than predicting perfect play, and the label noise is i.i.d. rather than
  shared across a whole game.
- At λ = 1 the rollout disappears entirely, and with it the dominant cost of an iteration. `ESTIMATE`
  If removing the rollout makes an iteration *k*× cheaper, §1's exchange rate turns that into
  ≈1.3·log₂(*k*) points before any accuracy loss: k = 5 gives +3.0, k = 10 gives +4.3, k = 20 gives
  +5.6. This is the only prize on the table larger than the whole v3→v3.2 programme. **The value of
  *k* has never been measured** — the truncation sweep measured a 12-ply playout plus a composite
  evaluation at 1/1.3 of a full playout, which bounds nothing about replacing the playout entirely.
  Measuring *k* is a profiling task, not a research task, and it should precede everything else in
  this subsection.

`STRUCTURAL` The decision rule for how good V̂ must be is a one-line inequality. If the rollout return
has per-sample standard deviation σ_R and V̂ has RMSE ε_v against V_π, then V̂ beats an n-sample
rollout estimate at that node when ε_v < σ_R/√n. At a fresh leaf n = 1, so **any** V̂ with
ε_v < σ_R is an improvement in isolation; the real test is whether it holds once the freed compute
is spent on more nodes. σ_R has never been measured here and is a one-line diagnostic.

`LITERATURE` The ordering matters and follows from §3.1: V_π is defined relative to π, so **balance
the rollout policy first, then distil it.** Distilling a biased rollout policy produces a fast,
faithful reproduction of a biased estimator.

`LITERATURE` The general principle behind all of this is Grimm et al.'s **value equivalence**
([NeurIPS 2020](https://arxiv.org/abs/2011.03506)): a learned model should be accurate with respect
to the planning computation that consumes it, not with respect to the world. Training a Blokus value
head to predict final scores, when the search consumes rollout means, is a value-inequivalent model
by construction.

### 3.3 The targets: visit counts are the wrong policy target at 300 iterations, and there is a closed form for the right one

`MEASURED` The project measured its own label noise: two independent 300-iteration searches of the
same position select the same move 62.9% of the time and agree on 72.8% of non-tied visit-pair
orderings. v4.3's response was to average three searches, which raised holdout top-1 by 0.70 points
and left regret flat.

`LITERATURE` There is a better answer than averaging. Grill et al., *Monte-Carlo Tree Search as
Regularized Policy Optimization* ([ICML 2020](https://arxiv.org/abs/2007.12509)), show that AlphaZero's
search is an approximation to the solution of

  *π̄ = argmax_y [ qᵀy − λ_N · KL(π_θ ‖ y) ]*,  giving  *π̄(a) ∝ π_θ(a)·exp(q(a)/λ_N)*

with λ_N shrinking as visits accumulate. They propose three uses — ACT (play π̄), SEARCH (traverse by
π̄), LEARN (train on π̄) — and report that **LEARN, training on π̄ rather than on the empirical visit
distribution, is the most impactful, especially at low simulation budgets.** Danihelka et al.'s
*Policy improvement by planning with Gumbel* ([ICLR 2022](https://openreview.net/forum?id=bERaNdoegnO))
reaches the same place from the fixed-budget side: the improved policy is
`softmax(logits + σ(completedQ))`, where unvisited actions get a mixed value derived from the prior
and the visited children's Q, and this is what should be both played and learned.

`STRUCTURAL` Three direct consequences for this project:

1. **The target should be `softmax(prior_logits + σ(Q))`, not the visit histogram.** It is
   computable from data already exported (`exportTraining.ts` records value and visits per
   candidate), it is far smoother than visits at 300 iterations, and it does not require three
   searches per position. The consensus machinery can be kept for the roots where it is cheap, but
   the noise it is fighting is largely an artefact of using visits as the target.
2. **`rootPriorPseudoVisits` is a rediscovery of ACT, and its constant should be λ_N, not 128.** The
   v4.5 experiments fix the pseudo-visit count at 128/256/512 for every position. Grill's λ_N and
   Gumbel's σ both make the prior's weight a function of how many visits the node actually received,
   which is the difference between a calibrated readout and a tuned constant. This is the most
   promising thread in the current work and it is one formula away from being principled.
3. `MEASURED` **One caveat, from this project's own diagnostic.** Two independent searches agreed on
   72.8% of visit-pair orderings but only 67.5% of searched-value orderings. Here, raw Q is *noisier*
   than visits — so a naive "train on Q" would be worse, and the recommendation is specifically the
   regularized/completed form, which shrinks toward the prior exactly where visits are few. State
   this when running the experiment; it is the falsifier.

`LITERATURE` KataGo (Wu, *Accelerating Self-Play Learning in Go*,
[arXiv:1902.10565](https://arxiv.org/abs/1902.10565)) contributes two more target-side mechanisms
with measured ablations, both cheap here:

- **Forced playouts and policy target pruning** (1.25× training speedup when removed): force each
  root child to at least `√(k·P(c)·ΣN)` playouts, then *prune those forced visits back out of the
  training target*. This decouples exploration noise from the label — the exact problem the consensus
  averaging was attacking.
- **Playout cap randomization** (1.37×): run the expensive full search on only p ≈ 25% of turns and a
  cheap search on the rest, generating policy targets only from the full searches. This is how you
  get many value labels and few, high-quality policy labels from the same self-play budget — directly
  relevant to §3.2, where value labels are wanted in bulk.

### 3.4 The trunk: a three-layer 16-channel convnet cannot compute the quantities Blokus turns on

`STRUCTURAL` The v4.5 pooled trunk (`src/ai/bitboard/spatialNet.ts:112-171`) is three 3×3
convolutions at 16 channels over four ownership planes. Its receptive field is 7×7. Region
connectivity, territory ownership, whether a region is sealed, and whether a placement is an
articulation point are all **global** properties of the empty-cell graph. No stack of 3×3
convolutions with a 7×7 field can compute them at any width. The network is being asked to learn,
from four raw occupancy planes, exactly the quantities the engine already computes exactly in
`regions.ts` and `territory.ts`.

`LITERATURE` KataGo's two largest single ablations are both aimed at this problem, and they are the
two largest for a reason:

- **Global pooling layers, 1.60×.** Per channel, compute the mean, the mean scaled by board size, and
  the max; push them through a small dense layer; add back as per-channel biases. This lets the
  convolutional stack condition on global context that "would be hard or impossible with the limited
  perceptual radius of convolution alone". It is perhaps twenty lines in `spatialNet.ts` and costs
  O(cells × channels) once per root — free, because the trunk is already amortised across candidates.
- **Game-specific input features, 1.55×.** KataGo hands the network liberties, ladders and pass-alive
  regions rather than making it derive them. The Blokus analogues are already computed every node:
  per-seat open-corner planes, own forbidden-edge cells, region id/size, the multi-source distance
  maps behind the territory statistic, and per-seat reachability. Adding them costs input channels
  and nothing else.

`LITERATURE` **Auxiliary dense targets, 1.65×.** KataGo predicts final ownership per point and a
score distribution alongside the game result, weighted at 1.5/b² and 0.02. Blokus has an exact
analogue that is free to export: at the end of every training game, each of the 400 cells is owned by
one of four seats or empty. A 5-way per-cell ownership head gives **400 dense labels per position**
against the current 1, and it teaches the trunk precisely the territory concept the hand evaluation
approximates. Wu et al.'s multi-labelled value networks
([arXiv:1705.10701](https://arxiv.org/abs/1705.10701)) make the same case for predicting a
distribution over scores rather than a scalar, reporting 67.6% against a scalar-value baseline in Go.
Blokus's maximand is a score margin, so a score-distribution head is more natural here than in Go.

`STRUCTURAL` The pooled architecture's core idea — encode the parent board once, pool under the
candidate footprint — is right and should be kept. What it pools is too thin: a single mask-mean over
the footprint, of a 16-channel embedding. §9.7 of the report proposed pooling under **footprint, edge
halo and corner halo**; the implementation pools only the footprint
(`spatialNet.ts:199-243`). Mean-pooling alone also discards *where within the footprint* a feature
sits. Concatenating mean and max pools over three masks costs six vectors instead of one, is
arithmetically negligible, and restores most of the discarded interaction information.

`STRUCTURAL` One more structural gap: candidates are scored **independently** and then softmaxed.
The model cannot express "this is the only remaining move that keeps the left lane open", because
nothing in its input depends on the other candidates. One set-context layer over the ≤40 candidates —
mean/max over the candidate embeddings, concatenated back to each — makes each score a function of
the set. Cost is one extra 40×d pass per root. This also makes the model's behaviour less sensitive
to candidate-set width, which is the §2.2 skew.

### 3.5 Making the network affordable where it matters: NNUE

`STRUCTURAL` The §3.2 argument says the network should run at leaves, and the §3.1 budget says a
256-input MLP cannot. The gap is bridged by the technique alpha-beta engines adopted for exactly
this reason.

`LITERATURE` NNUE — efficiently updatable neural networks, Nasu 2018, in Stockfish since 2020
([chessprogramming.org/NNUE](https://chessprogramming.org/NNUE)) — keeps the first layer's
pre-activation in an **accumulator** and updates it incrementally as the position changes. A chess
move alters two to four input features, so the wide first layer costs a few hundred adds instead of a
full matrix product. The remaining layers are narrow and quantised to int8.

`ESTIMATE` The fit to Blokus is unusually good, better than to chess. A placement covers at most five
cells and alters its own edge and corner haloes; `Position.apply/undo`
(`src/ai/bitboard/position.ts`) already maintains exactly those masks incrementally. With features
indexed by (cell, owner) and an accumulator of width 256, a placement costs ≈5 × 256 ≈ 1,300 adds
against 400 × 256 ≈ 102,000 for a fresh pass — a ≈75× reduction — and `undo` is the same operation
with the sign flipped, which the search does constantly. The subsequent narrow layers (256→32→32→4)
cost ≈9,000 multiply-adds per evaluation; at 1,377 leaf evaluations per move that is ≈12M
multiply-adds, on the order of 15 ms in tuned typed-array JavaScript, or ≈5 ms with int8 and
WebAssembly SIMD (2–3× is the commonly reported figure for int8 on the WASM backend). Against a
190 ms move budget that is 3–8%, i.e. ≈0.05–0.15 points of compute — affordable if and only if the
value head is worth more than ≈0.2 points, which §3.2 argues is a low bar for the right target.

`STRUCTURAL` NNUE is the enabling technology for the entire §3.2 programme, and it is currently
absent. The existing `net.ts` recomputes 168 or 256 features and a full forward pass from scratch
every call, which is why the network can only be afforded once per move.

### 3.6 Evaluation: sequential testing, and calibrating a cheap proxy against known effects

`LITERATURE` Computer chess solved §2.4's problem thirty years ago and runs it at scale. Fishtest
uses a **generalized sequential probability ratio test**: specify two Elo bounds, accumulate the log
likelihood ratio game by game, and stop as soon as either bound is crossed
([Fishtest mathematics](https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html)).
Clearly-null and clearly-good candidates terminate early; only genuinely borderline ones consume the
full budget. Against fixed 40/100/400-game blocks this typically halves expected sample size at the
same error rates, and — more importantly — it makes the decision rule and the power explicit before
the games are played.

`PROPOSED` The second half of the fix is to stop paying for games at all during screening.
**Calibrate a cheap proxy against the changes whose strength is already known.** This project owns an
unusually good calibration set:

| Change | Measured advantage |
| --- | ---: |
| 12-ply → 84-ply rollouts (equal compute) | +4.73 |
| 12 → 36 plies | +5.13 |
| 12 → 18 plies | +1.29 |
| Phase schedule | +1.02 |
| Fractional territory tie-break | +0.96 |
| ε 0.15 → 0.60 (pro-max) | +0.88 |
| Root sequential halving | −1.01 |
| Prior temperature 3 | −2.93 |

`PROPOSED` Any candidate offline metric — pair accuracy, top-1, policy-mass regret, oracle-search
disagreement rate, leaf-estimator RMSE — can be scored on all eight and checked for rank correlation
with the measured advantage. A metric that cannot order these eight has no business promoting a
model, and this is the test that v4.1–v4.5's metric has never been given. It costs a few hours of
diagnostics and nothing in match compute.

`PROPOSED` The truncation ladder deserves special mention because it is not merely a calibration set,
it is a **measured accuracy-to-strength curve for leaf estimators specifically**. Six configurations
(12/18/24/36/48/84 plies) are six leaf estimators of increasing fidelity with known strength effects.
Regress each against terminal outcomes on a common position set to get an RMSE for each, and the
result is a curve from *leaf-estimator RMSE* to *points*. Any new leaf estimator — a learned V̂, a
control-variate blend, a shorter rollout — can then be placed on that curve offline, before a single
match is played. §6 lists this as experiment E3; I think it is the most valuable single measurement
available to this project.

---

## §4. What v4.3, v4.4 and v4.5 are specifically missing

Stated as omissions. Each is a thing that was not done, not a thing that was done wrongly.

**v4.3 — the local-interaction representation (63.02% pair, 29.45% top-1; online +0.20).**

1. It was trained on the top 12 candidates and deployed against 40. Hard negatives absent (§2.2).
2. It never measured the hand prior on the same holdout, so the 1.09-point pair gain has no
   incumbent to be a gain over (§2.3).
3. Its single-shard holdout carried no interval; at ≈1.5σ the improvement is suggestive, not
   established (§2.3).
4. It changed the *inputs* while the target stayed a single search's visit histogram — the noisier
   half of the pipeline (§3.3).
5. It was gated by a 40-seed match with MDE 2.12 against a +0.5 rule (§2.4).

**v4.3 target experiment — consensus labels (63.11% / 31.78%, no online test).**

6. It correctly identified label noise and attacked it with brute force. The regularized/completed-Q
   target (§3.3) attacks the same noise analytically, needs one search rather than three, and is a
   strictly better use of the same export budget. It was not tried.
7. KataGo's forced-playout + policy-target-pruning mechanism — which removes exploration noise from
   the label at source — was not tried.
8. Confidence weighting was tried and hurt overall regret. That is a real result and it points the
   same way: the problem is the *form* of the target, not the weighting of noisy instances.

**v4.4 — the pooled spatial diagnostic (63.24% pair, 33.45% top-1, 0.1268 regret).**

9. It found the right architecture — shared parent encode, pool under the action mask, combine with
   engineered features — and then gave it a trunk that structurally cannot see regions, territory or
   connectivity: three 3×3 convolutions, 7×7 receptive field, four ownership planes (§3.4).
10. No global pooling. KataGo's largest architectural ablation, 1.60×, and it is cheap here because
    the trunk is amortised (§3.4).
11. No derived input planes, though the engine computes all of them every node (§3.4).
12. No auxiliary dense targets. Final per-cell ownership is free to export and gives 400 labels per
    position instead of 1 (§3.4).
13. Pools only the footprint, not the edge and corner haloes the report itself specified; mean-pool
    only, no max-pool (§3.4).
14. "Overfit after only a few epochs" on 4,064 training roots — a capacity/data statement, not an
    architecture statement. Auxiliary targets are the standard remedy and were not available.

**v4.5 — the ported ensemble and pseudo-visit readout (online −0.27, −0.02; screens +2.09/+0.37/−0.03).**

15. It kept the whole stack inside the root prior channel, whose headroom is still unmeasured (§2.1).
16. The pseudo-visit readout is a genuine escape from that channel and a rediscovery of Grill's ACT,
    but with a hand-set constant where the theory gives λ_N (§3.3).
17. The 128/256/512 arms were screened at 16 seeds, MDE 3.35. +2.09 [−0.01, 4.15] at that width is
    the same object as eight candidates in the v3.2 shift that did not reproduce; the confirmation
    block has no recorded result (§2.4).
18. Three-member ensembling was applied to the *prior*, where averaging reduces a variance that
    barely matters, rather than to a value estimate, where it would reduce the variance that does.

**All three, jointly.**

19. **None of them has a value head.** The lever measurement identified as worth +4.7 to +6.9 has
    been untouched since v4.0's single failed attempt, and that attempt used a target the search does
    not consume and data that violated the decorrelation rule AlphaGo published in 2016 (§2.5, §3.2).
20. **None of them touches the rollout policy**, where the project's own most recent win came from
    and where a fitted policy has never been attempted (§3.1).
21. **None of them can run anywhere except the root**, because nothing in the stack is incrementally
    updatable (§3.5).
22. **None of them was evaluated by a metric known to predict strength**, though the calibration set
    for building one has existed since the truncation sweep (§3.6).
23. **None of them was allowed to generate candidates.** All five reranked a 40-move shortlist that a
    two-microsecond hand heuristic had already selected out of hundreds. The models were given the
    easiest third of the root problem and judged on the whole of it (§2.1).

---

## §5. The programme: v4.6 → v5.0

Each release states a hypothesis, the channel it enters, its cost in doublings, its gate, and the
observation that would kill it. Nothing is promoted on offline metrics.

### v4.6 — Instrumentation. No strength claim, and none permitted.

`PROPOSED` The release that makes the next four possible. It ships diagnostics, not strength.

- **Channel headroom.** The prior ablation ladder and the root regret audit (E1, E2 in §6). Output:
  a number of points available in the root-prior channel. If it is below +0.5, v4.7 is cancelled and
  the finding alone repays the whole release.
- **A calibrated offline metric.** Score every candidate metric against the eight-change calibration
  set (§3.6). Output: one metric with a documented rank correlation to measured strength, plus the
  hand prior's score on it, which becomes the baseline every future model must clear.
- **The leaf-estimator curve.** RMSE-to-points from the truncation ladder (E3).
- **Error bars on everything offline.** Clustered bootstrap over games, not roots. Retro-fit to the
  v4.1–v4.5 table so the existing ladder can be read honestly.
- **GSPRT gating.** Replace fixed 16/40/100-seed blocks with sequential tests at declared bounds
  (§3.6). Screens become cheaper and their false-positive rate becomes a stated quantity.
- **σ_R and *k*.** The per-sample standard deviation of the rollout return, and the speedup from
  replacing the playout with a constant-time leaf value (E9). Together they set the accuracy bar and
  the maximum prize for every value model that follows.

Gate: the metric orders the calibration set correctly. Falsifier: no cheap metric does, in which case
the programme must accept that only matches can decide, and must budget accordingly.

### v4.7 — The policy pipeline, fixed in place

`PROPOSED` Everything in §2.2, §2.3 and §3.3 that does not require a new architecture. Cheap, and it
determines whether the four generations of representation work were ever given a fair test.

- Export **all 40 shortlisted candidates**, not the top 12. Hard negatives included.
- Train on **`softmax(prior_logits + σ(Q))`** rather than the visit histogram.
- Add **forced playouts with policy target pruning** at export time.
- Add **playout cap randomization**: full searches on 25% of turns for policy labels, cheap searches
  elsewhere — which is also where the bulk value labels for v4.9 come from.
- Replace `rootPriorPseudoVisits = 128` with **λ_N**.
- Add the **set-context layer** so candidates are scored jointly (§3.4).

Cost: negligible at inference; the export is a rerun. Expected size: `ESTIMATE` bounded above by
whatever v4.6 measures the channel to be worth. Gate: beat the hand prior on the calibrated metric,
then GSPRT at the **standard** tier — where a prior has the most leverage and games are cheapest —
before the pro tier. Falsifier: the corrected pipeline moves the calibrated metric by less than the
hand prior's own margin over uniform.

### v4.8 — The rollout policy

`PROPOSED` The highest-leverage unoptimised channel in the engine (§3.1).

- Replace `playoutScore`'s two hand-set terms with a **linear softmax over ~8 cheap features plus a
  static per-placement bias table** — the AlphaGo rollout-policy shape, inside the 40 ns budget.
- Fit it by **simulation balancing**: minimise Σ_s ‖V*(s) − E_π[z(s)]‖² over sampled positions,
  where V* comes from deep reference searches. Not by imitation of a strong policy, which the
  literature says makes the search weaker.
- Fit the **temperature jointly**, which subsumes ε: ε=0.60 becomes a special case of a fitted
  softmax rather than a tuned constant.
- Fit **all four seats**, not just the mover. In a four-player game three quarters of every rollout
  is opponent modelling.
- `PROPOSED` Optional second stage: make the temperature state-dependent using the policy's own
  entropy — the report's own "state-dependent ε learned from held-out search disagreement", now with
  a policy that can supply the signal.

Cost: `ESTIMATE` ≈0–5% wall clock if the table is precomputed. Expected size: `ESTIMATE` the ε knob
alone was worth 0.68 doublings; a fitted multi-term policy at fitted temperature should be able to
find more of the same curve, but the balancing literature's gains are reported in Elo on small Go
boards and do not transfer as a number. Gate: GSPRT against `v3.2-pro-max` at equal wall clock.
Falsifier: the balanced policy's rollouts predict deep-search values no better than ε=0.60's do — in
which case ε=0.60 is already near the balance optimum and this channel is closed.

### v4.9 — The leaf value, done as variance reduction

`PROPOSED` The first v4 release to touch the lever worth +4.7, and the first that could justify the
generation number.

- **Target `V_π(s) = E[z(s) | s, π]`**, the rollout policy's own expected return, with labels
  harvested free from rollouts the engine already runs (§3.2). π must be v4.8's balanced policy.
- **Decorrelate the data**: at most a small number of positions per game for the outcome-style
  targets, per AlphaGo; cluster-aware cross-validation everywhere.
- **NNUE-style incremental trunk** so the evaluation is affordable at leaves (§3.5): accumulator over
  (cell, owner) features, narrow int8 tail, WASM SIMD.
- **Auxiliary heads**: per-cell final ownership (400 labels) and a per-seat score distribution (§3.4).
- **Deploy in three stages, each separately gated**: (a) as a pure control variate on the rollout
  return, which cannot bias the estimate; (b) as a λ-mix, sweeping λ and *requiring an interior
  optimum* — a monotone curve means the target is still wrong and the release stops; (c) as a
  partial rollout replacement with playout cap randomization, converting the saved compute into
  iterations.
- Place V̂ on v4.6's leaf-estimator curve **before** any match.

Cost: `ESTIMATE` 3–8% of wall clock at stage (a)–(b); strongly negative (i.e. a saving) at stage (c).
Expected size: `ESTIMATE` stages (a)–(b) are worth tenths of a point if the variance reduction is
real; stage (c) is the 3.5–5.6-doubling prize and is the only thing in this document that could
produce a v3-scale jump. Falsifier: the λ-curve is monotone again after the target change, or V̂'s
RMSE places it below the 24-ply rung of the truncation ladder.

### v5.0 — The loop

`PROPOSED` Only after two of {v4.7 policy, v4.8 rollout, v4.9 value} have independently passed a
GSPRT. Closed self-play with a replay buffer retaining older opponents, promotion by seat-rotated
GSPRT, and — this is the part the project keeps skipping — evaluation as a **strength-versus-compute
curve** rather than a fixed-iteration match. A learned stack that loses at 1377 iterations and wins
at 400 is a shipping win for a browser game and is invisible to every gate run so far.

`LITERATURE` The loop is Expert Iteration (Anthony, Tian & Barber,
[NIPS 2017](https://discovery.ucl.ac.uk/10038400/)); the four-seat vector value is Petosa & Balch
([arXiv:1910.13012](https://arxiv.org/abs/1910.13012)); the efficiency tricks that make a small-scale
loop viable are KataGo's, and their combined measured speedup is ≈9.1× on a domain far larger than
this one.

---

## §6. Experiment catalogue

Ordered by information per unit of compute. The first four are cheap and each can terminate a branch.

**E1 — Prior ablation ladder.** `PROPOSED` Degrade `v3.2-pro`'s root prior toward uniform and measure
strength at each step. **This needs no new code.** `softmaxPriors`
(`src/ai/bitboard/ordering.ts:280-302`) divides by `priorTemp`, so raising it flattens the
distribution: sweep `priorTemp` ∈ {6 (shipped), 12, 24, 100, 10⁶ ≈ uniform}. Cost: five GSPRT runs at
the standard tier. **This measures the total value of the root-prior channel.** If a uniform prior
costs less than ≈1 point, no learned prior can earn a version number, and v4.1–v4.5's results were a
ceiling effect rather than a modelling failure. I expect this to be the single most consequential
number the project can buy this month.

`STRUCTURAL` One caveat that makes this two experiments rather than one. Flattening `priorTemp`
removes the prior's *probabilities* but not its *ordering*: progressive widening opens children in
shortlist index order, which `sortByScore` has already set from the same heuristic scores. So the
temperature sweep measures the PUCT-weight channel alone. **Run a second arm that also shuffles the
shortlist order**, and the difference between the two isolates how much of the hand prior's value is
carried by the opening order rather than by the weights. That distinction matters directly for v4.7:
a learned model that only changes probabilities is competing for the smaller of the two.

`MEASURED` One rung already exists, in the other direction: `priorTemp` = 3 — a *sharper* prior —
measured −2.93 [−4.61, −1.29]. So the channel is demonstrably able to lose three points. Whether it
can gain any is precisely what has never been asked, and the asymmetry is itself informative: a
channel where sharpening a mediocre prior costs three points is one where the prior's *shape*
matters, which is a reason to expect E1's answer to be larger than zero.

**E2 — Root regret audit, and the shortlist ceiling.** `PROPOSED` Sample N positions from real games.
Run the deployed search (1377 iters) and an oracle (≥20,000 iters). Record:

(a) root-move disagreement rate; (b) the oracle's Q-gap between its move and the deployed move —
summed over a game, an upper bound on the score available to *any* root-only improvement;
(c) **how often the oracle's move is outside `scoreMoves`' top 40**.

`STRUCTURAL` (c) is the one nobody has looked at and it bounds the learned policy from above
independently of everything else. The shortlist is truncated by the cheap bitboard heuristic
(`sortByScore` on `MoveOrderer.scoreMoves`, `mcts.ts` ≈ line 541) before the network is ever
consulted; a learned prior *cannot* surface a move the heuristic did not shortlist. If (c) is
non-trivial, the highest-value use of a learned policy is **candidate generation**, not reranking —
a different and much more promising deployment than any tried so far. Cost: hours, no matches.
Pairs with E1.

**E3 — The leaf-estimator curve.** `PROPOSED` On a common position set, compute for each of
{composite eval, 12/18/24/36/48-ply truncated rollout, 84-ply rollout, v4.0's value net} the RMSE
against the terminal outcome. Plot RMSE against the measured strength of each truncation rung. Output:
a function from leaf-estimator accuracy to points, which prices every future value model offline.
Cost: one diagnostic script.

**E4 — Hand-prior offline baseline.** `PROPOSED` Score `MoveOrderer.deepScore` on the identical
holdout shards used by v4.1–v4.5, with a clustered bootstrap. Cost: minutes. Output: the missing
column in every table in §9.7–§9.8.

**E5 — Metric calibration.** `PROPOSED` Score five candidate offline metrics against the eight
known-strength changes of §3.6; report rank correlation. Cost: low. Output: the promotion metric for
everything after v4.6.

**E6 — Train/serve skew, isolated.** `PROPOSED` Re-export at `--top-k 40` and retrain the existing
v4.3 256-feature model unchanged. Compare online against the identical model trained at top-12.
This is a single-axis test of §2.2 and needs no new architecture. Cost: one export, one training run,
one GSPRT.

**E7 — Regularized target.** `PROPOSED` Same data, three targets: raw visits; three-search consensus;
`softmax(prior_logits + σ(Q))`. Evaluate on E5's calibrated metric. Cost: three training runs, no new
export. Settles §3.3 and, if the third wins, retires the consensus export.

**E8 — λ_N readout.** `PROPOSED` Replace `rootPriorPseudoVisits`'s constant with λ_N and re-run the
pv sweep under GSPRT. Cost: small. Settles whether the pv128 screen was signal.

**E9 — σ_R and *k*.** `PROPOSED` Two profiling numbers that price the whole of §3.2 and cost an
afternoon. (a) σ_R: the per-sample standard deviation of the rollout return, by phase, from logged
rollouts — this sets the accuracy bar every value model must clear. (b) *k*: how much cheaper an
iteration becomes when the terminal playout is replaced by a constant-time leaf evaluation — measured
by stubbing the playout with a fixed value and timing the search. §1 converts *k* into the maximum
prize available to a value head (≈1.3·log₂ *k* points). Run this **before** training anything.

**E10 — Global pooling and derived planes.** `PROPOSED` Four arms on the v4.4 pooled architecture:
baseline; + global pooling; + derived input planes (corners, forbidden cells, region id/size,
distance maps); + both. Evaluate on E5's metric with error bars. Cost: four training runs.

**E11 — Auxiliary ownership head.** `PROPOSED` Add a 400-cell 5-way final-ownership head at KataGo's
weighting; measure its effect on the *policy* metric. Tests whether dense supervision fixes the
few-epoch overfitting v4.4 reported. Cost: one export change, two training runs.

**E12 — Halo pooling and max-pool.** `PROPOSED` Pool under footprint, edge halo and corner halo, with
mean and max. Cost: one training run. Completes the architecture §9.7 originally specified.

**E13 — Set-context layer.** `PROPOSED` One deep-sets layer over the candidate set before scoring.
Cost: one training run. Tests whether joint scoring matters.

**E14 — Rollout-policy balance objective.** `PROPOSED` Fit the two existing `playoutScore` weights
plus temperature by simulation balancing against deep-search values, and compare to ε=0.60 at equal
compute. This is the smallest possible version of v4.8 and tests the whole idea before any table is
built.

**E15 — Static placement table.** `PROPOSED` Add a precomputed per-placement bias to the rollout
policy, fitted by the same objective. Measures whether placement identity carries rollout-relevant
information beyond size and centre distance.

**E16 — V_π regression.** `PROPOSED` Harvest `(state, rollout return)` pairs from existing self-play,
fit V̂, and report its RMSE against σ_R and against E3's curve. No engine change, no match. This is
the cheapest possible test of the entire v4.9 thesis.

**E17 — Control-variate deployment.** `PROPOSED` Use V̂ as a control variate on rollout returns; sweep
the coefficient; require the λ-curve to have an interior optimum. Cost: one engine change, GSPRT.

**E18 — NNUE accumulator benchmark.** `PROPOSED` Before training anything, benchmark an
accumulator-based forward pass on the existing apply/undo path against the current `net.ts`. Cost: a
day of engineering. Output: the real cost number that decides whether §3.2's stage (c) is reachable
in a browser.

**E19 — Compute-curve evaluation.** `PROPOSED` Re-run the best existing learned prior at 100, 300,
700, 1377 and 2400 iterations against v3.2 at the same budgets. Tests the §5 v5.0 hypothesis that the
network's value is concentrated at low compute, where every gate so far has been blind.

**E20 — GSPRT harness.** `PROPOSED` Not an experiment; the infrastructure that makes E1, E6, E8, E14
and E17 affordable. Build it first.

**E21 — The policy as candidate generator.** `PROPOSED` Conditional on E2(c). Score *every* legal
move with a **pure spatial scorer** — the shared conv trunk plus mask pooling, with the 256-feature
vector branch removed — and take the top 40 as the shortlist. The point of dropping the vector branch
is cost: the expensive part of today's prior is not the network, it is the `apply` + `refreshContext`
territory pass run once per child (`mcts.ts`, the netPrior loop). Without it, candidate scoring is
one shared trunk pass plus a handful of adds per move, so scoring four hundred moves can cost less
than scoring forty does now. This is the only deployment in which a learned policy can do something
the hand heuristic structurally cannot. Cost: one training run reusing the v4.4/v4.5 architecture,
one engine change, one GSPRT.

---

## §7. What would make this document wrong

`STRUCTURAL` Stated in advance, in the spirit of revision 4's §8.

1. **If E1 shows the root-prior channel is worth ≥2 points**, then §2.1's central claim is wrong, the
   v4.1–v4.5 programme was aimed correctly, and the whole diagnosis reduces to §2.2–§2.4 —
   measurement problems rather than a targeting problem. That would be a good outcome and would make
   v4.7 the flagship release rather than a cleanup.
2. **If E6 shows top-12 vs top-40 training makes no online difference**, §2.2 is a plausible story
   that happens not to bind, and the offline/online gap must be explained by §2.3–§2.4 alone.
3. **If E16 shows V̂ cannot predict V_π better than σ_R**, the §3.2 programme collapses and v4.9
   should not be attempted. This is the cheapest disconfirmation available and should be run early.
4. **If E14 shows a balanced rollout policy is no better than ε=0.60**, then ε=0.60 already sits near
   the balance optimum, the v3.2 win was the whole of that channel, and v4.8 is cancelled.
5. **If E18 shows the NNUE accumulator cannot beat 10% of wall clock in JavaScript**, the value head
   stays at the root and the 3.5-doubling prize is out of reach in a browser. The honest response
   would be to reframe v4's target as strength-per-millisecond at *low* tiers (E19) rather than a
   pro-max knockout.
6. **A general caution.** This document argues from a compute-strength exchange rate derived from two
   measurements, one of which has a 95% interval of [0.24, 1.84] — a factor of seven. Every
   "doublings" figure inherits that uncertainty. The ordering of the mechanisms is robust to it; the
   individual numbers are not.

`ESTIMATE` And one uncomfortable possibility that should be stated rather than buried: it is entirely
possible that **no neural network can beat this engine at equal wall clock in a browser**, because a
bitboard MCTS with full terminal rollouts is a very efficient use of a single JavaScript thread, and
network inference is the one thing that environment does worst. If that is true, the correct v4 is
not a stronger engine but a *cheaper* one — the same strength at a quarter of the compute, which is
worth more to a browser game than two points of margin. E19 is the experiment that distinguishes
these worlds, and it has never been run.

---

## §8. Summary of recommendations, ranked

1. `PROPOSED` **Measure the headroom of the channel you are optimising** (E1, E2). Four generations
   have been spent inside a channel of unknown and probably small capacity.
2. `PROPOSED` **Build one calibrated offline metric** against the eight known-strength changes (E5),
   and put an error bar on every offline number (v4.6).
3. `PROPOSED` **Replace fixed-block matches with GSPRT** (E20). The current gates cannot see the
   effects they gate on.
4. `PROPOSED` **Fix train/serve skew** — export 40, deploy 40 (E6).
5. `PROPOSED` **Replace the visit-count target** with the regularized/completed-Q policy (E7), and
   `rootPriorPseudoVisits` with λ_N (E8).
6. `PROPOSED` **Fit the rollout policy by simulation balancing** (E14, E15). This is the largest
   unoptimised channel and the source of the last real gain.
7. `PROPOSED` **Bring back the value head with the right target** — the rollout policy's own expected
   return, deployed first as a control variate (E16, E17). This is the only path to a v3-scale jump.
8. `PROPOSED` **Make the network incrementally updatable** (E18), because everything in (7) requires
   evaluation at leaves.
9. `PROPOSED` **Give the trunk what it structurally cannot compute** — global pooling and derived
   planes (E10) — and dense auxiliary supervision (E11).
10. `PROPOSED` **Evaluate on the compute curve, not at one budget** (E19). The network's value may
    already exist at the tiers nobody has tested.
11. `PROPOSED` **If E2(c) says the shortlist throws away real moves, let the policy generate
    candidates** (E21) — the one root job a hand heuristic structurally cannot do better.

`ESTIMATE` If only three of these are done, do 1, 3 and 7: measure the channel, fix the gate, and put
the network on the lever that measurement already identified. Items 2, 4, 5 and 9 make the existing
policy programme honest and are worth doing, but on the evidence they are competing for tenths of a
point. Item 7 is the only one whose ceiling is a generation.

---

## References

Anthony, T., Tian, Z., & Barber, D. (2017). Thinking Fast and Slow with Deep Learning and Tree
Search. *NIPS 30*. https://discovery.ucl.ac.uk/10038400/

Cazenave, T. (2016). Playout policy adaptation with move features. *Theoretical Computer Science*.
https://www.sciencedirect.com/science/article/pii/S0304397516302699

Danihelka, I., Guez, A., Schrittwieser, J., & Silver, D. (2022). Policy improvement by planning with
Gumbel. *ICLR*. https://openreview.net/forum?id=bERaNdoegnO

Grill, J.-B., Altché, F., Tang, Y., Hubert, T., Valko, M., Antonoglou, I., & Munos, R. (2020).
Monte-Carlo Tree Search as Regularized Policy Optimization. *ICML 37*.
https://arxiv.org/abs/2007.12509

Grimm, C., Barreto, A., Singh, S., & Silver, D. (2020). The Value Equivalence Principle for
Model-Based Reinforcement Learning. *NeurIPS 33*. https://arxiv.org/abs/2011.03506

Huang, S.-C., Coulom, R., & Lin, S.-S. (2010). Monte-Carlo Simulation Balancing in Practice.
*Computers and Games*. https://www.remi-coulom.fr/CG2010-Simulation-Balancing/SimulationBalancing.pdf

Hubert, T., Schrittwieser, J., Antonoglou, I., Barekatain, M., Schmitt, S., & Silver, D. (2021).
Learning and Planning in Complex Action Spaces. *ICML 38*. https://arxiv.org/abs/2104.06303

Nasu, Y. (2018). Efficiently Updatable Neural-Network-based Evaluation Functions for Computer Shogi.
See also https://chessprogramming.org/NNUE and
https://official-stockfish.github.io/docs/nnue-pytorch-wiki/docs/nnue.html

Petosa, N., & Balch, T. (2019). Multiplayer AlphaZero. https://arxiv.org/abs/1910.13012

Silver, D., & Tesauro, G. (2009). Monte-Carlo Simulation Balancing. *ICML 26*.
https://icml.cc/Conferences/2009/papers/500.pdf

Silver, D., et al. (2016). Mastering the game of Go with deep neural networks and tree search.
*Nature* 529. https://www.nature.com/articles/nature16961

Veness, J., Lanctot, M., & Bowling, M. (2011). Variance Reduction in Monte-Carlo Tree Search.
*NIPS 24*. https://papers.nips.cc/paper/2011/hash/d736bb10d83a904aefc1d6ce93dc54b8-Abstract.html

Wu, D. J. (2019). Accelerating Self-Play Learning in Go. https://arxiv.org/abs/1902.10565

Wu, T.-R., et al. (2018). Multi-Labelled Value Networks for Computer Go. *IEEE ToG*.
https://arxiv.org/abs/1705.10701

Stockfish Fishtest statistical methods (GSPRT).
https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html
