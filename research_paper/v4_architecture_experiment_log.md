# Blokee v4 architecture experiment log

**Started:** 2026-08-25  
**Status:** active architecture search  
**Goal:** identify an efficient learning-based search architecture that can become a stronger base than the v3 family and can ultimately surpass `v3.7-pro-max`. The first iteration is not required to beat `v3.7-pro-max`; it must establish a credible strength-per-wall-clock path and a higher learning ceiling.

This file is the durable record for the run. Results are appended only after artifacts exist on disk.

## 1. Live baseline

The champion at the start of this run is `v3.7-pro-max`, promoted on 2026-08-25. It is `v3.6-pro-max` with tree search skipped on each seat's first three own moves. The repository records:

- +0.90 [0.47, 1.31] points against `v3.6-pro-max`, 400 seeds / 1,600 games;
- 5.1% fewer executed iterations;
- 11.5% less wall time;
- no learned component in the promoted path.

A fresh local cost benchmark on 2026-08-25 (`tmp/v4-baseline-bench.json`, 300 base iterations, three order-rotated repeats) measured:

- `v3.7-pro-max` opening fixture: 0.6 ms because the tree is skipped;
- `v3.7-pro-max` midgame fixture: 964.8 ms for 4,181 executed iterations, 230.7 microseconds/iteration;
- `v3.7-pro-max` endgame fixture: 562.0 ms for 3,413 executed iterations, 164.7 microseconds/iteration.

The opening shortcut is therefore inherited unchanged by every serious v4 candidate. Neural work on own moves 1–3 would spend compute where v3.7 has already shown that the tree itself is unnecessary.

## 2. Architecture hypothesis

The first architecture family is **prefix-search plus learned rollout tail**:

1. Keep exact bitboard state transitions, move generation, max-n tree backup, progressive widening, and the v3.7 opening shortcut.
2. At a newly expanded leaf, run the incumbent stochastic rollout policy for a real prefix of `n` plies.
3. At that prefix state, evaluate a small multi-output network trained on repeated continuation rollouts.
4. Predict all four seat-relative backed values together. Retain a distribution head so later variants can sample coherent returns or abstain.
5. If an uncertainty gate rejects the prediction, continue the real rollout to termination.
6. Spend the saved time on more tree iterations and compare at equal wall clock, not merely equal iteration count.

This differs from v4.6 in the load-bearing way suggested by its failure: v4.6 replaced the entire trajectory at the expanded leaf. v4.7 preserves a real stochastic prefix before compressing only the tail.

## 3. Why this architecture can have a higher ceiling

The claim is architectural, not that the first small model is already stronger.

- The exact search remains available, so model quality can improve without giving up legal correctness or the proven v3 tree.
- The learned target is on-policy continuation value at the state where it is deployed, rather than root imitation or a value from a mismatched state distribution.
- Prefix length is a continuous compute/approximation control. Better models can safely move the cutoff earlier; weak or unfamiliar states can fall back to full simulation.
- The teacher can improve through reanalysis and self-play without changing the browser inference contract.
- Multi-seat outputs preserve the multiplayer backup interface instead of collapsing the game to a binary win target.
- A small tail model can turn quality improvements into additional exact tree iterations, whereas a large root model must overcome its inference cost before helping.

## 4. Preregistered first-stage matrix

The first pass is deliberately small and diagnostic.

### Data

- Collect a game-disjoint corpus from `v3.7` or `v3.7-pro` self-play.
- Sample states from the actual expanded-leaf distribution.
- From each leaf, execute a stochastic incumbent prefix and clone the prefix state.
- Label the prefix state with repeated full terminal continuations.
- Split train, validation, and holdout by source game, never by row or leaf.

### Models

- Cheap baseline: ridge-initialised residual MLP, widths 64 and 32.
- Output: four conditional means plus four log variances in backed-value space.
- Primary model selection: validation RMSE of the four means.
- Holdout is reported once after selection.

### Deployment arms

- Prefix 8 plies, deterministic mean.
- Prefix 16 plies, deterministic mean.
- Prefix 24 plies, deterministic mean.
- The best prefix with uncertainty fallback, if validation calibration supports a nontrivial acceptance region.
- Full rollout `v3.7` identity baseline.

### Gates

1. **Contract:** deterministic replay, search tests, model-load failure behavior, and unchanged v3.7 behavior all pass.
2. **Offline:** the model beats a constant predictor and reports game-disjoint holdout error. Ridge is a required baseline.
3. **Economics:** at least one prefix arm reduces measured midgame wall time per base iteration by 20% or more. A smaller gain is unlikely to repay approximation error.
4. **Search fidelity:** at equal iterations, a useful arm should avoid a catastrophic loss. A result below -2 points in a 16-seed screen is killed immediately.
5. **Frontier:** only surviving arms receive extra iterations according to measured speed and advance to an equal-wall-clock match.
6. **Transfer:** an architecture is not called a base until its direction reproduces at Pro and remains economically favorable at Pro Max.

Sixteen-seed matches are triage only (approximate MDE 3.35 points). They can kill large failures but cannot promote an architecture. No candidate is promoted from this stage.

## 5. Anti-overfitting rules

- Seed blocks are disjoint across training data, triage, and confirmation.
- Hyperparameters are chosen on validation games; holdout games are not recycled into training during this run.
- Tournament arms are specified before reading their match output.
- Equal-iteration and equal-wall-clock claims are kept separate.
- Any candidate selected from multiple arms needs a fresh confirmation block.
- A result against `v3.7` does not imply a result against `v3.7-pro-max`; tier transfer is measured later.

## 6. Baseline verification

- Repository tests before v4.7 changes: 32 files passed, 196 tests passed.
- Baseline cost artifact: `tmp/v4-baseline-bench.json`.
- No v4.7 training or playing-strength result had been produced when sections 1–5 were written.

## 7. Results

### 7.1 Deterministic learned-tail family

New training sets were exported from the actual `v3.7-pro` expanded-leaf distribution using the
existing 24-game, game-tagged root corpus. Prefix 8, 16, and 24 each received a separately matched
student. The 16-ply set contained 1,805 rows; the selected ridge mean achieved 0.1083 holdout RMSE
against 0.1199 for a constant predictor. Larger residual trunks did not consistently beat ridge.

Measured cost at the standard tier:

- prefix-8 residual MLP: 191.0 versus 241.0 microseconds/iteration in the midgame;
- prefix-8 linear distillation: 166.3 microseconds/iteration, a 31.0% reduction;
- prefix 16: only a small midgame saving;
- prefix 24: slower than `v3.7` in the midgame.

Equal-iteration triage, 16 seeds / 64 games per arm:

- prefix-8 residual: -9.44 [-12.10, -7.12];
- prefix-8 linear: -11.62 [-14.54, -8.85];
- prefix 16: -8.23 [-10.34, -6.10];
- prefix 24: -4.46 [-6.07, -2.78].

**Decision:** kill deterministic tail replacement. Loss shrinks with a longer real trajectory, but
the first prefix that approaches tolerable fidelity has already lost its cost advantage. The result
supports the v4.6 diagnosis that a conditional mean removes search-useful trajectory variation.

### 7.2 Joint stochastic continuation

Preregistered follow-up: re-export prefix-16 and prefix-24 labels with the full empirical four-seat
covariance. Fit ridge means and select covariance shrinkage on validation games only. Deploy a
single multivariate Gaussian sample through a learned Cholesky factor, preserving cross-seat
dependence. Eight-seed screens may kill gross failures; no result from this follow-up can promote.

The selected covariance models improved over constant means offline and retained the full
cross-seat covariance (validation selected zero diagonal shrinkage), but deployment failed:

- prefix-16 joint sample: -16.17 [-19.25, -13.24], 8 seeds / 32 games;
- prefix-24 joint sample: -6.08 [-7.45, -5.07], 8 seeds / 32 games.

**Decision:** close the whole learned-tail family. A marginal Gaussian, even multivariate, is still
not the conditional trajectory process. Do not spend more data or larger models on this channel.

### 7.3 Learned terminal-rollout policy

Preregistered next family: keep full terminal rollouts and learn their cheap action policy.

- Distil `v3.2-pro-max` search visit targets from the existing v4.5 game-disjoint shards.
- Restrict the student to phase, piece, orientation, size, home-relative anchor, and centre distance.
- Use a phase-conditioned linear/listwise model so deployment is a handful of table lookups.
- Retain the incumbent epsilon-random branch; learning changes the guided branch, not the existence
  of trajectory diversity.
- Select regularization and blend with the incumbent static rollout score on validation shard G.
- Read shard H once as holdout.
- Require better held-out ranking/regret than the incumbent rollout ordering before any match.
- Benchmark per-iteration cost; reject overhead above 5%.
- Run one 16-seed equal-iteration triage. A fresh block is required for any continuation.

The linear student reached 26.8% top-1 agreement on holdout, but the incumbent rollout ordering
reached 34.6%. When the learned correction strength was selected on validation, the selected value
was exactly zero. Holdout therefore remained identical to the incumbent.

**Decision:** stop before a match. Search-policy imitation is the wrong target for the rollout's
guided branch, just as expected from simulation-balancing theory.

### 7.4 Search-aware rollout-policy reinforcement learning

Preregistered final first-pass family: optimize the rollout policy on actual playing strength rather
than imitation or one-step prediction.

- Policy class: phase-specific epsilon plus global static corner-halo, edge-halo, and sampling
  temperature. All features are precomputed placement properties.
- Optimizer: seeded cross-entropy-method evolution against a fixed `v3.7` reference, which is a
  black-box policy-gradient/evolution-strategy RL update on game return.
- Initial point exactly reproduces `v3.7`: epsilon 0.60 in all phases, zero new weights, zero
  temperature.
- Search budget: standard tier, 300 base iterations.
- Discovery: population 6, three generations, four common-random-number seeds per candidate.
- Selection seeds are not used again.
- The discovered config receives a fresh 16-seed match against `v3.7`; this is still triage, not
  promotion. A weak or null validation result closes the family at this policy capacity.

The identity point reproduced `v3.7` exactly (0.00 advantage with zero-width interval over four
seeds), establishing that the trainable family itself does not alter the baseline when its new
parameters are neutral.

Three discovery generations completed in 384.5 seconds. The generation-best fitnesses were +1.98,
+4.65, and +2.25 points; the population means were -1.32, +0.88, and -0.25. That spread is direct
evidence that four-seed discovery fitness is noisy, so the +4.65 selected value is not treated as
an estimate of strength. The selected policy was:

- opening epsilon 0.611;
- midgame epsilon 0.457;
- endgame epsilon 0.747;
- corner-halo weight 0.062;
- edge-halo penalty 0.063;
- greedy guided branch (temperature 0).

On the preregistered fresh 16-seed block it scored **+1.18 [-0.67, 3.09]** against `v3.7`, with
42.2% first places. This is an encouraging out-of-sample direction, but the interval includes zero
and the sample is too small for an architecture claim. It therefore advances to one larger,
independent confirmation block; that block is confirmatory for this fixed configuration and is not
used for further tuning.

The fixed 40-seed / 160-game confirmation scored **0.00 [-1.27, 1.27]**, with 25.6% first place.
The apparent validation lead did not reproduce. Measured midgame cost was 207.2 versus 204.0
microseconds per executed iteration for `v3.7`; the 1.6% difference is below the run's timing-noise
floor. The policy is therefore cost-neutral and strength-neutral.

**Decision:** do not promote the six-parameter policy. It remains a successful identity-safe RL
integration test and establishes a reusable search-aware objective, but phase-global epsilon and
four static placement terms do not supply enough conditional capacity. Do not tune these six knobs
again.

## 8. Architecture decision after the first experimental pass

No tested candidate is a measured playing-strength improvement over `v3.7`, and none is promoted.
That negative result is important: claiming that `v4.8-rollout-rl` already beats v3 would be false.

The surviving **v4 architecture direction** is:

1. inherit the complete `v3.7` exact-search backbone, including the opening shortcut;
2. keep stochastic rollouts terminal, because every attempt to replace their tail lost badly;
3. replace only the rollout's guided *action policy* with a cheap state/action policy;
4. train that policy on search-level game return in a seat-rotated opponent league, not on frozen
   teacher imitation;
5. canonicalize by mover/home corner and make the policy phase-, hand-, and local-state-dependent;
6. compile or distil it to precomputed placement/action tables plus a very small contextual residual,
   keeping candidate scoring within the rollout's tens-of-nanoseconds budget;
7. retain the v3 policy as an exact identity point and an explicit mixture/fallback;
8. gate every generation on strength per wall clock against historical checkpoints and all v3.7
   tiers, with `v3.7-pro-max` as the final fixed frontier.

This has a higher *architectural ceiling* than v3 because v3 is one hand-authored point in this
policy family, while v4 can improve its trajectory distribution from self-play indefinitely without
discarding exact dynamics or the proven tree. It is also consistent with every local result: value
compression is fast but biased, imitation optimizes the wrong target, low-capacity black-box RL is
safe but neutral, and full stochastic trajectories remain load-bearing.

The next experiment should not be another scalar sweep. It should be a game-disjoint offline
policy-gradient/PPAF bootstrap over canonical move features, followed by league self-play and
reanalysis. The first runtime student should be a phase-conditioned canonical placement table with
a tiny hand/local-context correction; its identity/fallback mixture makes it reversible. Pro and
Pro Max transfer are deferred until that richer policy beats the fixed six-parameter arm on fresh
standard-tier seeds.

## 9. Reproducibility artifacts

- Baseline cost: `tmp/v4-baseline-bench.json`
- Learned-tail datasets and students: `ml/data/v47-*`, `ml/v47-*`
- Tail cost/triage: `selfplay-results/v47-*`
- Cheap imitation student: `ml/v47-rollout-policy.json`
- RL discovery log: `tuning/tune-2026-08-25T19-57-00-571Z.jsonl`
- Selected six-parameter config: `tuning/tune-2026-08-25T19-57-00-571Z-best.json`
- Fresh 16-seed validation: `selfplay-results/match-2026-08-25T20-03-37-877Z.jsonl`
- Fresh 40-seed confirmation: `selfplay-results/match-2026-08-25T20-06-10-345Z.jsonl`
- RL policy cost: `selfplay-results/v48-rollout-rl-cost-bench.json`

The literature survey and full design-space critique remain in
`research_paper/v4_architecture_critique_and_options.md`. Sections recommending learned tail-value
replacement are superseded by the measured failures in this log.
