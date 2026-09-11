# Blokee v4 architecture critique and design space

## Research and architecture review only — no new experiments were run

**Date:** 2026-08-24  
**Scope:** critique the existing v4.0–v4.6 work, account for the current v3.5/v3.6 baseline, survey relevant machine-learning and reinforcement-learning designs, and recommend a v4 architecture that targets better strength per wall-clock cost than v3.  
**Non-goal:** this document does not train a model, generate a new corpus, benchmark inference, run self-play, or change a released algorithm.

The evidence labels used below are:

- **MEASURED** — already measured in this repository before this review.
- **STRUCTURAL** — follows from the game rules or the current implementation.
- **LITERATURE** — supported externally; transfer to Blokus remains an assumption.
- **INFERENCE** — a conclusion drawn here from existing evidence, not a new measurement.
- **PROPOSED** — an untested design or future validation step.

## Executive decision

The existing v4 programme should not be continued as “make the root prior larger” or “replace every rollout with a better MLP.” Both deployment paths have been tested deeply enough to reveal their structural limits:

- **MEASURED:** flattening the current PUCT prior to uniform cost only −0.12 points, with a 95% interval of [−1.09, 0.89]. A learned root prior is being inserted into a low-leverage channel.
- **MEASURED:** direct learned leaf replacements lost by roughly 6.6–14.8 points even after their speed was converted into more search iterations. A marginal mean/variance prediction is not a substitute for the joint, trajectory-level information in a real rollout.
- **MEASURED:** the v4.5 spatial policy genuinely improved held-out imitation metrics and still did not improve play as a PUCT prior. The model was learning something real; the deployment channel could not convert it.
- **MEASURED:** the current v3 line became about 29.5% cheaper per iteration on 2026-08-24 without changing behaviour. Any old v4 timing comparison is now stale, and v4 must beat the optimized v3.5/v3.6 frontier rather than the pre-optimization v3.2 timing baseline.

The recommended v4 is a **league-trained, uncertainty-gated, n-step hybrid search agent**:

1. Keep the exact bitboard rules, legal-move generator, incremental position, and max-n MCTS.
2. Keep a real rollout prefix so search retains the trajectory structure that v4.6 showed to be valuable.
3. Replace only the expensive rollout tail with a small learned **joint four-seat return distribution**, and fall back to a full rollout when the model is uncertain or out of distribution.
4. Use a separate action-conditioned policy/Q model as a **direct selector with abstention** in the narrow opening band where local evidence shows it can outperform search, and as a guide at low search budgets. Do not use it primarily as a high-budget PUCT-weight blend.
5. Train the system through a true Expert-Iteration/self-play RL loop against a population of current and historical opponents. The previous v4 generations were mostly supervised distillation of v3, not a policy-improvement loop.
6. Distil a larger offline teacher into small quantized browser students. The browser should not pay for a research-sized spatial model at every leaf.

In compact form:

```text
exact state + legal generator
          |
          +--> action model --> direct opening move only if calibrated confidence passes
          |                         otherwise abstain
          |
          +--> incumbent-style MCTS
                    |
                    +--> exact tree traversal
                    +--> real rollout prefix for n plies
                    +--> small joint-return student at cutoff
                              |
                              +--> low uncertainty: bootstrap the tail
                              +--> high uncertainty/OOD: finish the real rollout
                    +--> four-seat vector backup and visit readout

self-play league --> replay/reanalyse --> large teacher --> distillation --> browser students
```

This is more ML/RL-centric than v3 without discarding the component v3 is exceptionally good at: cheap, exact simulation.

## 1. What v3 actually is now

The relevant baseline is no longer the early v3 or even the initial v3.2 described in the first v4 work.

**STRUCTURAL:** the current v3 family is a highly optimized multi-player MCTS built on bitboards:

- exact legal move generation from precomputed placements and incrementally maintained haloes;
- a four-component value vector backed up through max-n selection;
- heuristic candidate funnels and progressive widening;
- full terminal rollouts, with 60% uniform moves in the v3.2 lineage;
- a fitted phase-dependent evaluation and a 21-own-move iteration allocation curve in v3.5;
- an increased Pro Max effort point under the v3.6 id;
- early decision locking and fixed effort tiers;
- a recent behaviour-identical 29.5% per-iteration optimization.

The principal local references are [the measured revision-4 report](./blokus_ai_research_report_v4.md), [the v4.6 channel audit](./v46_channel_audit.md), [the v3.7 promotion plan](../docs/V37_PROMOTION_RESEARCH_PLAN.md), [the speed result](../docs/V37_SPEED_PLAN.md), and the live configurations in [`src/ai/versions/v3.ts`](../src/ai/versions/v3.ts).

**MEASURED:** v3’s strength is not mainly the hand evaluation. Its decisive resource is many cheap terminal trajectories. Full rollouts were worth roughly +4.7 to +6.9 points versus short truncation, the epsilon change from 0.15 to 0.60 was worth +0.88 at Pro Max, and moving iteration budget across a player’s 21 moves added about +1.17 at Pro.

**INFERENCE:** v4 should be treated as an attempt to compress and improve this search computation, not as a generic neural replacement for the entire engine. A proposal that uses more inference time than the exact search it replaces has failed the product requirement even if its offline loss is lower.

## 2. What the existing v4 work got right

The programme contains several strong findings that should be retained.

### 2.1 Policy and value were eventually separated

The first v4 model used a sibling-ranking objective and then served the same model as a leaf value. The later work correctly distinguished:

- a policy target `P(s,a)` or `Q(s,a)`, which requires action-conditioned information and is judged within a legal candidate set; and
- a state value or return target, which must match the exact value contract the search backs up.

This separation is consistent with AlphaZero-style systems, but it is especially important here because a Blokus action is a structured placement, not a fixed board-cell label.

### 2.2 The spatial action representation was a real advance

The v4.5 design encoded a canonical parent board once, mean-pooled under each action footprint, and combined that vector with engineered action features. On a larger leak-free corpus it improved top-1 agreement and regret across independent seeds. That is evidence for **amortized shared-state plus action-mask scoring**, even though root-prior deployment was flat.

### 2.3 The audit measured channel capacity before building more models

The v4.6 audit correctly separated candidate generation, opening order, PUCT weights, and final readout. This was more informative than another architecture sweep. It found that:

- the 96-move tier-0 funnel lost the oracle move in 0 of 82 audited positions;
- the top-40 shortlist lost it once;
- the top-12 training cap excluded it in 46.3% of positions;
- the root-prior probability channel had little measurable value;
- root disagreement and regret were concentrated in the opening.

### 2.4 The leaf work moved onto the actual search distribution

Later exporters sampled leaves the deployed MCTS really expands, repeated rollouts from those states, split data by source game, and trained on the nonlinear backed-up value vector. This fixed several defects in v4.0’s data contract.

### 2.5 The v4.6 failure was diagnostically valuable

The direct leaf programme did not merely “fail to beat v3.” It showed that:

- a deterministic conditional mean is insufficient;
- an independently sampled Gaussian return distribution is insufficient;
- retaining real rollout trajectories recovers strength monotonically;
- marginal predictive RMSE below rollout standard deviation is not a sufficient deployment gate;
- coarse spatial summaries generalized better than exact cells at the available number of independent games.

That strongly motivates n-step bootstrapping and coherent joint return modelling.

## 3. Critique of the existing v4 architecture and reasoning

### 3.1 Most of v4 was imitation, not reinforcement learning

v4.1–v4.5 learned to reproduce visit distributions from a stronger v3 search. That is supervised policy distillation. It can compress a teacher but cannot exceed the teacher unless the student changes the data distribution, objective, search allocation, or policy-improvement operator.

**LITERATURE:** Expert Iteration explicitly alternates planning and generalization so the apprentice improves the next expert, rather than cloning a frozen expert forever ([Anthony, Tian & Barber, 2017](https://proceedings.neurips.cc/paper_files/paper/2017/hash/d8e1344e27a5b08cdfd5d027d9b8d6de-Abstract.html)). AlphaZero similarly closes the self-play improvement loop ([Silver et al., 2017](https://arxiv.org/abs/1712.01815)).

**INFERENCE:** “policy cloning has a ceiling” is correct for the attempted loop, but it does not establish a ceiling for search-based RL. The missing ingredient is not necessarily more counterfactual labels; it is a policy that changes self-play, receives outcome feedback, and becomes the next search prior/selector under population evaluation.

### 3.2 The original policy/value objective was internally inconsistent

The v4.0 model used a listwise sibling loss because v3 had a sibling-ranking problem, then replaced terminal rollouts with that output. A ranking model is invariant to transformations that can destroy calibration; a leaf value is not. The later corrected output contract did not repair this fundamental mismatch.

### 3.3 The data’s apparent row count overstated its independent information

The original 323,595 rows came from only 393 games, and many sibling rows differed by one action while sharing the same final outcome. Later leaf work used only 24 independent games, with a three-game sealed test split. These are useful pilots, not enough evidence for exact-cell spatial generalization.

The failure of exact 20×20 planes and success of 4×4 pooled maps is therefore better read as a **data-regime result** than as proof that fine spatial structure is unlearnable. Explicit symmetry, many more independent games, dense auxiliary labels, and an offline teacher can change that regime.

### 3.4 The top-12 export contract made the offline task unlike deployment

The model was trained mostly on moves the teacher already preferred, while deployment scored up to 40 candidates. Hard negatives and the deep oracle’s preferred action were frequently absent. This is a classic coverage and extrapolation problem for action-value learning.

The fix is broader than changing `top-k` from 12 to 40:

- preserve the teacher’s top set;
- add heuristic, spatially diverse, piece-diverse, and random legal negatives;
- record inclusion probability if actions are sampled;
- evaluate regret over the same legal set used in deployment;
- include states induced by the current learned policy through dataset aggregation.

[Sampled MuZero](https://proceedings.mlr.press/v139/hubert21a.html) provides a principled policy-iteration framework when only a subset of a complex action space is evaluated, although Blokus’s exact funnel already has excellent top-96 recall.

### 3.5 The root-prior ceiling was real, but one argument overstates it

The audit says that because deleting the current prior costs about 0.12 points, a perfect prior is worth at most that amount. That does not logically follow. The loss from current-to-uniform bounds the value of the **current** prior, not the gain from current-to-perfect. A poor prior could be close to uniform while a perfect prior is much better than both.

The stronger evidence is E2’s small oracle regret at the deployed budget, the 98.8% top-40 recall, and five generations of non-converting priors. Together they make high-budget root-prior work low priority. The opening-specific regret profile still leaves room for a direct policy or low-budget search policy.

### 3.6 Direct `V_pi` replacement learned the wrong statistical object for deployment

The v4.6 conclusion is sound: a conditional mean and independent marginal variance do not reproduce what terminal trajectories do inside MCTS. The architecture destroyed at least four kinds of structure:

- correlation among the four seats’ final scores;
- coherent errors across related leaves and siblings;
- the exploratory effect of a stochastic trajectory on tree shape;
- conditional information exposed during the first part of a rollout.

A Gaussian head with independently sampled seats or leaves cannot restore those. More independent samples of the same marginal model only make the search more confident in its residual systematic errors.

### 3.7 The value contract remains tied to an incumbent objective

The engine can back up a max-opponent margin blended with rank, while promotion is based on score minus the mean of the other three seats. The code itself notes this distinction in [`backup.ts`](../src/ai/bitboard/backup.ts). Training a value head directly on the incumbent’s transformed target preserves that objective choice and makes later correction difficult.

**PROPOSED:** store and predict raw terminal scores for all four seats, or a joint distribution over them. Apply the desired rank/margin/mean-opponent transformation at search time. This keeps the learning target factual and lets the product objective change without retraining the representation.

### 3.8 The NNUE cost estimate is optimistic unless the feature contract changes

NNUE is attractive because a placement changes only a few occupied cells, and official Stockfish documentation describes sparse accumulators, shallow integer inference, and incremental add/subtract updates ([Stockfish NNUE documentation](https://github.com/official-stockfish/nnue-pytorch/blob/master/docs/nnue.md?plain=1)).

However, the earlier estimate of “five cells times accumulator width” omits features Blokus evaluation depends on:

- edge and corner haloes change around the footprint;
- legal/open-corner status can change at several nearby cells;
- hands change by piece identity;
- reachability, territory, region ownership, and sealing can change globally.

NNUE remains plausible if the sparse accumulator represents only local occupancy/halo/hand features and exact global summaries are appended through a small side channel. It is not a free incremental form of the existing 424-feature leaf model.

### 3.9 Browser execution must be designed, not assumed

The current engine runs in a browser worker on typed arrays. A research model that is efficient on a batched GPU may be slow for batch-one leaf inference. ONNX Runtime Web exposes WebAssembly, WebGPU, and WebNN paths ([official web documentation](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)), and its WebAssembly build can use SIMD and threads ([build documentation](https://onnxruntime.ai/docs/build/web.html)), but startup cost, transfer cost, availability, and batch size matter.

The v4 contract should therefore define two targets from the start:

- a portable quantized WASM/typed-array student for reliable batch-one CPU inference;
- an optional batched WebGPU path for devices where many leaf evaluations can be queued without violating move latency.

### 3.10 The evaluation protocol improved, but promotion still lagged the stated rule

The repository correctly recognized that 40-seed blocks cannot resolve a +0.5 rule, that roots within a game are dependent, and that screen winners regress. The v4 record nevertheless repeatedly used small fixed blocks as advancement gates.

Future v4 work should predeclare a practically relevant effect interval and use sequential testing only after offline and cost gates. The architecture should be evaluated as a **strength-versus-wall-clock frontier**, not at a single iteration count.

## 4. Requirements for a credible v4

### 4.1 Product requirement

v4 must dominate or extend the current frontier in one of two ways:

- stronger at no greater p50/p95 wall-clock cost; or
- not materially weaker at meaningfully lower cost.

Iteration count is not a cost metric when one architecture adds network inference and another does not.

### 4.2 Search requirement

The exact simulator remains authoritative. A learned dynamics model must justify replacing a correct, cheap transition function; otherwise it only adds model error.

### 4.3 Learning requirement

At least one deployed decision must come from a policy improved by outcome feedback or iterative self-play, not only from frozen-teacher imitation.

### 4.4 Multiplayer requirement

Training and evaluation must preserve the four-player general-sum structure:

- rotate the learner through all seats;
- predict all four raw outcomes;
- train against a population, not only three copies of the newest model;
- audit cyclic and specialist matchups, not only scalar Elo-like strength.

[Multiplayer AlphaZero](https://arxiv.org/abs/1910.13012) is evidence that vector-value AlphaZero can work in small multiplayer games, not proof that naive self-play is stable in four-player Blokus. [OpenSpiel](https://arxiv.org/abs/1908.09453) is a useful reference for n-player general-sum evaluation, while AlphaStar’s diverse league illustrates the practical value of continually adapting strategies and counter-strategies ([Vinyals et al., 2019](https://www.nature.com/articles/s41586-019-1724-z)).

### 4.5 Data requirement

Splits must be disjoint by source game, self-play generation, seed range, and preferably policy checkpoint. Position-level random splits are invalid. Exact transformations must be tested before being used as symmetry augmentation.

### 4.6 Uncertainty requirement

The model must separate:

- **aleatoric uncertainty:** different terminal outcomes from the rollout/opponent population; and
- **epistemic uncertainty:** lack of support or disagreement among learned models.

Distributional RL models the return distribution rather than only its expectation ([Bellemare, Dabney & Munos, 2017](https://proceedings.mlr.press/v70/bellemare17a.html)); deep ensembles are a strong practical baseline for predictive uncertainty and distribution shift ([Lakshminarayanan, Pritzel & Blundell, 2017](https://proceedings.neurips.cc/paper_files/paper/2017/hash/9ef2ed4b7fd2c810847ffa5fa85bce38-Abstract.html)).

### 4.7 Efficiency requirement

Every learned component needs a maximum artifact size, cold-start cost, batch-one latency, memory footprint, and p95 move-time budget before model selection. Accuracy without a deployment budget is not an architecture result.

## 5. Recommended v4 architecture

### 5.1 Two-level teacher/student design

**PROPOSED offline teacher:** a moderately larger, explicitly symmetric, region-aware model used for labels, reanalysis, uncertainty estimation, and distillation. It is not shipped in the critical leaf loop.

**PROPOSED browser students:** two small models with separate contracts:

1. **Action student** for policy, action advantage, and confidence. It runs once at selected roots or opening states.
2. **Tail-value student** for a joint four-seat return distribution after an exact rollout prefix. It is quantized and designed for batch-one inference.

Separate students avoid forcing the leaf model to carry expensive action-set machinery and avoid forcing the root model into NNUE’s shallow incremental constraints. A shared offline teacher can still transfer a common representation.

### 5.2 State representation

The teacher should consume seat-relative, canonical features in four groups.

**Board planes:**

- occupancy for each relative seat;
- open-corner and forbidden-edge planes;
- per-seat reachability or distance-to-frontier planes;
- contested/owned territory indicators;
- empty-region size and ownership summaries;
- turn, phase, and own-move index.

**Hands:**

- exact 21-piece mask for every seat;
- size histogram and remaining squares as redundant easy features;
- optional piece embeddings shared with the action encoder.

**Global exact summaries:**

- placed and remaining squares;
- corner counts, territory, reachable count, waste, region counts;
- score lead and the current search objective parameters.

**Symmetry:**

- canonicalize the root/mover home corner;
- use only rotations/reflections whose seat and turn-order remapping passes legal-move equivalence tests;
- enforce prediction consistency under those transforms;
- prefer built-in equivariance or group averaging for the teacher when affordable.

The exact-board pilot’s location memorization makes symmetry a requirement, not optional augmentation.

### 5.3 Spatial trunk options

The default teacher should combine local and global structure:

- a small residual CNN or message-passing grid network over board planes;
- global mean/max pooling after each block or at least after the trunk;
- a region graph side branch whose nodes are empty connected regions and whose edges encode adjacency/chokepoints;
- concatenation with exact global and hand features.

The region graph is attractive because connectivity and sealing are global graph properties that a shallow 7x7 receptive field cannot compute. A full GNN is not required in the browser student; it can be teacher-only or reduced to exported region summaries. Board-game work has shown that GNNs can transfer structure across board sizes ([Ben-Assayag & El-Yaniv, 2021](https://arxiv.org/abs/2107.08387)), but that result does not establish a latency win here.

### 5.4 Action encoder and candidate context

For every legal candidate considered by the model, encode:

- piece identity, size, orientation, anchor, centroid, and home-relative coordinates;
- footprint, edge halo, and corner halo masks;
- local board embeddings pooled by both mean and max under all three masks;
- per-seat contacts, covered corners, created corners, denied corners, and region transitions;
- parent-to-child cheap deltas that do not require a full child territory recomputation.

The candidate scorer should include one lightweight permutation-equivariant set-context block:

- pool mean/max statistics across candidate embeddings and concatenate them back to each candidate; or
- use one small set-attention layer at the root.

This allows “good relative to the available alternatives,” which independent action logits cannot express. Deep Sets supplies the invariance/equivariance template ([Zaheer et al., 2017](https://arxiv.org/abs/1703.06114)); the Set Transformer is the heavier interaction-aware alternative ([Lee et al., 2019](https://proceedings.mlr.press/v97/lee19d.html)). The simple pooled context should be the browser default.

### 5.5 Output heads

The teacher should expose distinct heads with distinct losses.

**Policy head:** logits over the legal candidate set. Its principal target is an improved search policy, not raw visit counts. Regularized MCTS interprets search as a KL-regularized policy update ([Grill et al., 2020](https://proceedings.mlr.press/v119/grill20a.html)); Gumbel AlphaZero provides a principled low-simulation policy-improvement target and action selection rule ([Danihelka et al., 2022](https://openreview.net/pdf?id=bERaNdoegnO)).

**Action-value/advantage head:** `Q(s,a)` or `A(s,a)` on raw expected score changes for all four seats. It is trained from deeper reanalysis, repeated continuations, and eventually on-policy self-play. This is the natural head for direct selection and counterfactual action labels.

**Joint return head:** a compact mixture distribution over four raw final scores, rather than four independent Gaussians. One workable form is a categorical mixture over K joint four-seat vectors, with per-mode means and optional bounded residual scale. Sampling a mode preserves cross-seat covariance.

**Ownership head:** five-way final ownership for each cell (four seats or empty). This supplies 400 dense labels per completed game and teaches territory without asking the scalar value loss to discover it indirectly. KataGo attributes much of its efficiency to game-specific features, global pooling, and auxiliary targets ([Wu, 2019](https://arxiv.org/abs/1902.10565)).

**Score distribution heads:** categorical or quantile marginals for each seat’s final score. Even if search uses the mean, distributional TD can provide statistically richer value learning ([Rowland et al., 2023](https://proceedings.mlr.press/v202/rowland23a.html)).

**Confidence/OOD head:** probability that the direct policy’s top choice agrees with a stable long-search label, plus ensemble disagreement. Confidence is used for abstention, never treated as calibrated merely because a softmax is sharp.

### 5.6 The browser tail-value student

The shipped leaf model should be deliberately smaller than the teacher:

- sparse, incrementally updated occupancy/halo/hand accumulator;
- exact global scalars appended at the cutoff state;
- narrow quantized tail, for example accumulator -> 32/64 -> output heads;
- raw four-seat return output plus a small joint-mixture index/logit head;
- optional distillation of teacher ownership/region embeddings as auxiliary training only.

The NNUE principles fit the local sparse part: few nonzero inputs, small changes per move, shallow integer inference, and an accumulator updated by added/removed feature columns. The design must count halo and hand updates honestly and benchmark the cost of exact global features later; this document does not assume a particular speedup.

### 5.7 N-step rollout bootstrapping

This is the core deployment change.

At each new MCTS leaf:

1. Run the real v3 rollout policy for a phase-dependent prefix of `n` plies.
2. At the cutoff state, evaluate the tail-value student.
3. If epistemic uncertainty, symmetry inconsistency, or support distance exceeds a threshold, ignore the model and finish the real rollout.
4. Otherwise sample or take the expectation of the **joint** four-seat return distribution according to the predeclared deployment mode.
5. Transform raw scores into the configured rank/margin objective and back up the vector.
6. Preserve a randomized audit fraction of complete rollouts at every phase so the search and training stream continue to observe model error.

Why this is the primary recommendation:

- it preserves the early trajectory that v4.6’s direct replacement destroyed;
- it gives the model a shorter and smoother prediction horizon;
- it can save most of the depleted-hand tail where the optimized engine still spends time;
- it allows uncertainty-based abstention;
- it can be trained from every existing full rollout by taking cutoff states and completed returns;
- it creates a continuum between v3 (`n` to terminal) and a pure value net (`n = 0`) instead of an all-or-nothing switch.

Temporal-difference methods have long been combined with game-tree leaf evaluation ([Baxter, Tridgell & Weaver, 1999](https://arxiv.org/abs/cs/9901001)). The current design is closer to n-step distributional TD with an exact simulation prefix than to classical TDLeaf, but the core lesson is the same: train the evaluator in the computation that will consume it.

### 5.8 Coherent stochasticity

v4.6 sampled an independent Gaussian approximation at leaves. The replacement should instead preserve coherence:

- sample one ensemble member for a whole root search or rollout batch, not a new model per leaf;
- sample one joint four-seat return mode, not four independent seat noises;
- use common random numbers for paired counterfactual labels and evaluation;
- distinguish model disagreement from outcome stochasticity;
- retain real rollouts when uncertainty is high.

This is an **INFERENCE** from the local failures and uncertainty literature, not a guarantee that sampling will help. The deterministic expectation remains a required deployment mode and may win.

### 5.9 Direct opening policy with abstention

The v3.7 opening-apprentice work contains the strongest evidence for a learned action model in the repository:

- deployed search selected the stable opening oracle move 10.3% of the time in a 29-position pilot;
- the existing v4.5 policy selected it 41.4% of the time and ranked it top three 72.4%;
- later corpus work localized most stable, addressable opening headroom to own moves 4–5;
- the current model’s logit margin was not a usable confidence signal.

The v4 action student should therefore be allowed to play directly only when a separately trained and calibrated abstention head passes. Otherwise it returns control to unchanged search. This is a much higher-leverage use than changing PUCT weights.

### 5.10 Low-budget policy improvement

Gumbel AlphaZero and regularized policy optimization are most relevant at cheap tiers, where the prior has more influence and only some legal actions can be visited. The local sequential-halving arm was harmful when it replaced root allocation from iteration zero at Pro; that is a direct warning against transplanting the paper wholesale.

For v4, these methods are candidates for:

- producing smoother training targets;
- search at very low simulation budgets;
- choosing among the direct policy’s top set;
- training-time exploration.

They are not the default Pro/Pro Max readout without new evidence.

## 6. The reinforcement-learning lifecycle

### 6.1 Bootstrap without becoming trapped by the teacher

Initialize from the existing corpus and v3 search, but retain raw facts:

- exact state before the action;
- full legal or sampled legal set plus sampling probabilities;
- raw four-seat final score;
- terminal ownership map;
- search visits, child values, and uncertainty as auxiliary fields;
- policy checkpoint and opponent lineup that generated the state.

Pretrain the policy/action heads on deep-search targets and the return heads on completed outcomes. This is initialization, not the final algorithm.

### 6.2 Expert Iteration loop

Each generation should:

1. sample a four-seat lineup from the league;
2. play exact-game self-play using the current hybrid search;
3. store policy, raw outcome, ownership, cutoff, uncertainty, and full-rollout audit data;
4. reanalyse a selected subset with a larger search or teacher;
5. update policy, advantage, joint return, ownership, and confidence heads;
6. distil the teacher into the two browser students;
7. evaluate the candidate against a held-out league and the fixed v3 frontier;
8. add the candidate to the league only if it clears the predeclared promotion rule.

Expert Iteration is the clean conceptual fit because the exact v3 search is already a strong expert and the learned model can progressively alter the expert that generates the next corpus.

### 6.3 Population and opponent sampling

Naive latest-versus-latest self-play can cycle in a four-player general-sum game. A practical initial league should include:

- the current candidate;
- several historical v4 checkpoints;
- v3.5/v3.6 tiers;
- cheap/greedy and intentionally diverse rollout agents;
- occasional exploiters trained against the current main policy.

Sample lineups to cover both common and adversarial mixtures, rotate seats, and retain explicit payoff tensors. Alpha-Rank can help describe cyclic empirical matchups ([Omidshafiei et al., 2019](https://pmc.ncbi.nlm.nih.gov/articles/PMC6617105/)); a full PSRO/JPSRO system is an advanced option if simple league training exhibits clear cycles, not a day-one dependency.

### 6.4 Rewards and targets

Store raw scores and derive multiple training views:

- score minus mean of opponents, matching the promotion statistic;
- rank distribution;
- optional score versus current leader;
- four raw seat scores;
- per-cell final ownership.

Policy improvement should optimize the shipping objective, while auxiliary heads preserve information. A fixed guessed blend of rank and max-opponent margin should not be baked irreversibly into labels.

### 6.5 Replay and reanalysis

The replay buffer should be stratified by:

- source game and model generation;
- phase and own-move index;
- seat and canonical transform;
- opponent lineup;
- model uncertainty and search regret;
- direct-policy accepted versus abstained states.

Older data prevents catastrophic forgetting and gives the league memory. Reanalysis updates search targets without discarding factual terminal outcomes. MuZero Reanalyse shows how fresh search targets can be applied to stored trajectories ([Schrittwieser et al., 2021](https://arxiv.org/abs/2104.06294)), although v4 should keep exact dynamics rather than adopt MuZero wholesale.

### 6.6 Data aggregation

After the first direct policy is deployed in self-play, collect the states it induces and send uncertain or regrettable states back to the teacher. This DAgger/Expert-Iteration behavior is essential: a one-pass model trained only on v3 trajectories will otherwise be evaluated off distribution precisely when it begins to matter.

## 7. Architecture possibilities considered

The following are viable branches, ordered by fit to the local evidence rather than by general popularity.

### Option A — uncertainty-gated n-step hybrid MCTS

**Fit:** highest.  
**ML/RL role:** learned continuation distribution, policy improvement, direct opening policy, league self-play.  
**Efficiency path:** shorten rollout tails and skip selected opening searches.  
**Local support:** direct replacement failed while retaining real trajectories recovered strength; n-step bootstrapping is the remaining design named by the v4.6 audit.  
**Main risk:** the cutoff model’s bias can still reshape tree allocation; only matched-wall search evaluation can settle this.

This is the recommended v4 spine.

### Option B — full AlphaZero with exact dynamics

**Fit:** credible long-term, expensive near-term.  
**Design:** residual policy/value network evaluated throughout MCTS, no terminal rollouts, self-play RL.  
**Advantage:** clean policy-improvement loop and mature precedent.  
**Conflict with local evidence:** batch-one browser inference is expensive; learned leaf replacement has already failed badly; action width is much larger than chess/Go output heads; multiplayer self-play is less stable.  
**Use:** research teacher or low-simulation tier after the hybrid system has a strong value model.

### Option C — Gumbel AlphaZero / regularized MCTS

**Fit:** good for training targets and low budgets, uncertain at Pro.  
**Advantage:** principled improvement when not every root action is visited; better behavior with few simulations.  
**Conflict:** sequential halving from iteration zero was harmful locally, and high-budget root channels have little headroom.  
**Use:** cheap tier, training-time improvement operator, or post-policy top-k selection.

### Option D — Sampled MuZero

**Fit:** low to medium.  
**Advantage:** principled planning over sampled subsets in very large action spaces.  
**Conflict:** Blokus dynamics are exact, deterministic, and already fast. MuZero’s central benefit is learning unknown dynamics ([Schrittwieser et al., 2020](https://www.nature.com/articles/s41586-020-03051-4)); replacing this simulator introduces compounding error and more inference. The existing top-96 funnel already had perfect oracle recall in the small audit.  
**Use:** borrow sampled-action corrections and reanalysis, not the learned dynamics core.

### Option E — pure model-free PPO/actor-critic

**Fit:** medium as an efficiency baseline, low as the first strength candidate.  
**Advantage:** one policy pass per move can be far cheaper than search; PPO is simple and broadly effective ([Schulman et al., 2017](https://arxiv.org/abs/1707.06347)).  
**Conflict:** sparse delayed scoring, wide variable legal sets, high-variance four-player self-play, and no tactical correction at inference.  
**Use:** train the direct action model or establish how much strength a search-free tier can retain.

### Option F — offline/online distributional Q learning

**Fit:** medium.  
**Design:** action-conditioned `Q(s,a)` trained from replay, deep-search reanalysis, and self-play TD targets; direct argmax or small top-k search.  
**Advantage:** targets counterfactual action consequences rather than visits and is naturally compatible with variable candidate scoring.  
**Risk:** extrapolation on actions absent from the logged data; bootstrapping instability in a changing multiplayer policy; maximization bias.  
**Requirement:** broad hard-negative coverage, target networks, conservative/OOD handling, and on-policy refresh.

### Option G — learned direct opening apprentice

**Fit:** high but narrow.  
**Advantage:** measured evidence suggests the existing policy recognizes stable oracle moves much more often than deployed opening search, and accepted moves save search cost.  
**Risk:** stable labels are concentrated in own moves 4–5 and existing confidence is uncalibrated.  
**Use:** a v4 component, not the whole architecture.

### Option H — pure NNUE leaf evaluator

**Fit:** low as a direct replacement; high as the n-step tail student.  
**Advantage:** exceptional batch-one CPU efficiency and incremental updates.  
**Conflict:** all pure learned replacements lost decisively; global territory features are not sparse local updates.  
**Use:** compact continuation model after a real rollout prefix.

### Option I — spatial CNN with action masks

**Fit:** proven representationally, deployment-dependent.  
**Advantage:** v4.5 already validated the shared-state/action-mask idea.  
**Need:** deeper/global receptive field, derived planes, halo pooling, set context, more independent games, and auxiliary heads.  
**Use:** root action model and offline teacher.

### Option J — region/corner graph neural network

**Fit:** strong inductive bias, higher engineering risk.  
**Advantage:** directly represents regions, corners, placements, contested access, and chokepoints; avoids asking shallow convolutions to infer connectivity.  
**Risk:** dynamic graph construction and message passing may cost more than exact hand features; browser support is custom.  
**Use:** teacher branch or action model if a small graph can reuse engine-maintained region data.

### Option K — candidate Set Transformer

**Fit:** useful at roots, unnecessary at leaves.  
**Advantage:** models competition among a variable number of legal candidates.  
**Risk:** quadratic candidate interaction and little evidence that complex set attention beats mean/max context for 40–96 moves.  
**Use:** teacher; distil into a pooled-context student.

### Option L — learned rollout policy

**Fit:** uncertain and lower priority after v4.6.  
**Advantage:** extremely cheap table/linear policy can affect every simulated ply. Simulation balancing is established literature ([Silver & Tesauro, 2009](https://research.ibm.com/publications/monte-carlo-simulation-balancing--1)).  
**Conflict:** local E14a/E14b found that calibration and sibling-discrimination proxies misordered the epsilon policies, falsifying the proposed offline balance objective.  
**Use:** only through end-to-end self-play RL or search-level optimization with a tiny parameterization; do not revive the same failed proxy.

### Option M — learned value-of-computation controller

**Fit:** currently closed.  
**Evidence:** extra compute helps only a minority of positions, but the tested decision-time features could not identify them and the held-out controller recovered no regret.  
**Use:** revisit only if the new neural representation produces a clearly predictive uncertainty signal as a by-product. Do not make it a v4 dependency.

### Option N — opening book or retrieval-augmented policy

**Fit:** useful complement.  
**Advantage:** exact retrieval is nearly free; approximate embedding retrieval could generalize beyond hashes.  
**Conflict:** exact-hash coverage collapsed after early randomized plies.  
**Use:** cache stable teacher answers and nearest-neighbor examples behind the same abstention contract; the neural policy remains the generalizer.

### Option O — exact endgame solver plus learned gate

**Fit:** low strength headroom.  
**Evidence:** exact sealed-region packing was worth about +0.01 because full rollouts already solve most late cases.  
**Use:** correctness feature and value-label generator, not a central v4 lever.

## 8. Recommended training losses

The exact weights should be selected later, but the loss contract should be fixed before any new data is generated.

**Policy improvement loss**

- cross-entropy or KL to a regularized/Gumbel-improved search policy;
- mask illegal actions exactly;
- correct for sampled candidate inclusion where applicable;
- optional behavior-cloning term to prevent early collapse.

**Action advantage loss**

- robust regression or pairwise ranking on raw score-minus-field consequences;
- uncertainty weighting based on repeated search/continuation labels;
- hard-negative emphasis without dropping the rest of the legal support.

**Joint return loss**

- proper likelihood for a mixture over four-seat raw score vectors;
- categorical or quantile auxiliary losses for each seat;
- n-step distributional TD targets plus completed-game Monte Carlo anchors;
- target network or slowly updated teacher for bootstrapped targets.

**Ownership loss**

- per-cell five-way cross-entropy on final ownership/empty state;
- mask or down-weight trivially occupied cells if they dominate.

**Confidence loss**

- Brier or log loss for stable-oracle agreement;
- calibration by game-disjoint split, seat, phase, and own-move index;
- ensemble disagreement as an additional epistemic signal, not the target itself.

**Symmetry loss**

- map transformed policy outputs back to the original legal moves;
- require raw score and ownership outputs to transform consistently;
- fail the data pipeline if a transformation changes legal-action equivalence.

## 9. What should be reused and what should be replaced

### Reuse

- exact position, placement masks, and legal generator;
- bitboard MCTS and four-seat vector backup;
- deterministic replay and mirror-match identity gates;
- game-disjoint export shards;
- canonical cell/seat transforms after equivalence tests;
- shared-parent/action-mask spatial inference;
- full rollout implementation and the optimized placement sampler;
- cost-frontier and seat-rotated match statistics;
- opening apprentice data and v4.6 repeated leaf labels as bootstrap data.

### Replace or retire

- one network serving incompatible policy and leaf-value contracts;
- top-12-only policy exports;
- raw visit histograms as the sole policy target;
- high-budget learned PUCT-weight blending as the main deployment;
- direct all-leaf deterministic replacement;
- independent per-seat Gaussian leaf sampling;
- exact-cell models trained on a few dozen independent games without equivariance;
- outcome transforms baked into stored labels;
- fixed small match blocks used to resolve effects below their MDE;
- old pre-speedup cost comparisons.

## 10. Future validation ladder — specified, not executed

No item in this section was run for this review. It is a proposed order designed to stop weak branches before expensive self-play.

### Gate 0 — immutable contracts

- legal-set and symmetry equivalence;
- raw score/value-transform round trips;
- train/validation/test disjointness by game, generation, seed, and opponent lineup;
- teacher/student inference parity on fixed fixtures;
- deterministic full-rollout fallback identical to v3.

### Gate 1 — data support

- action coverage and inclusion probabilities across all served candidates;
- effective sample counts by independent game, not rows;
- phase/seat/opponent balance;
- calibration of direct-policy acceptance and OOD detection.

### Gate 2 — offline predictive value

- joint score negative log likelihood and calibration;
- raw-score RMSE by phase;
- ownership accuracy and region-level error;
- teacher regret of accepted direct actions;
- n-step tail error as a function of cutoff;
- clustered confidence intervals over games and model seeds.

Offline metrics are diagnostics. The v4.6 rollout audit proved that a plausible offline metric can rank playing strength backwards.

### Gate 3 — deployment economics

- artifact bytes and cold-start time;
- batch-one p50/p95 inference on target browsers;
- cutoff feature cost;
- full move p50/p95/max wall time;
- actual saved rollout plies and search iterations;
- separate WASM/typed-array and optional WebGPU results.

### Gate 4 — search-computation ablations

Future single-axis comparisons should isolate:

- full rollout versus n-step plus deterministic expectation;
- deterministic versus coherent joint sampling;
- uncertainty fallback versus fixed fallback rate;
- direct opening policy versus search on accepted states;
- student versus equal-wall-clock v3 with savings reinvested.

### Gate 5 — strength frontier

Only candidates that clear the first four gates should enter seat-rotated sequential tests against:

- the matching v3.5/v3.6 shipping tier;
- an incumbent effort control at equal wall clock;
- the held-out opponent league;
- at least one cheap tier and one Pro tier.

Promotion requires a Pareto or equal-compute architectural win, not merely a positive score against the unadjusted incumbent.

## 11. Kill criteria

The recommended branch should stop or narrow if any of these occurs:

- cutoff feature extraction plus inference consumes most of the rollout tail it replaces;
- uncertainty fallback fires so often that useful speed disappears;
- the n-step curve is monotone toward full rollout with no interior strength/cost optimum;
- joint distribution modelling does not outperform deterministic expectation inside actual search;
- direct opening-policy coverage times accuracy cannot clear the measurable regret threshold;
- self-play improves against the immediate predecessor but regresses against the league;
- the teacher cannot generalize across game- and checkpoint-disjoint splits;
- the browser student loses the teacher’s advantage during distillation;
- the model improves fixed-iteration strength but loses at equal wall clock;
- simple reduced-iteration v3 remains on or above the learned Pareto frontier.

## 12. Recommended implementation boundaries

If this design is approved later, keep v4 separate from the historical version files until it passes its gates.

Suggested boundaries:

- `src/ai/v4/contracts.ts` — immutable feature/output schema and transforms;
- `src/ai/v4/actionModel.ts` — root/direct action student;
- `src/ai/v4/tailValue.ts` — quantized continuation student;
- `src/ai/v4/hybridLeaf.ts` — n-step rollout, fallback, and backup integration;
- `src/ai/v4/confidence.ts` — calibration and abstention;
- `ml/v4/teacher/` — spatial/region teacher training;
- `ml/v4/student/` — distillation and quantization;
- `scripts/v4/` — export, reanalyse, league, cost, and validation tools;
- version ids remain experimental until a reproduced promotion.

This avoids adding another large set of v4 experiment ids to [`src/ai/versions/v3.ts`](../src/ai/versions/v3.ts) and keeps historical v4.0 contracts reproducible.

## 13. Final recommendation

Do not start v4 over by deleting the exact engine. Start over at the **learning and deployment contracts**.

The strongest design supported by the combined local and external evidence is:

- exact bitboard dynamics and legal generation;
- incumbent-style four-player MCTS;
- real rollout prefixes;
- a small quantized, uncertainty-gated, joint-return continuation model for rollout tails;
- an amortized spatial/action model used directly with abstention in stable opening states and as a low-budget guide;
- raw four-seat score and dense ownership supervision;
- regularized/Gumbel search targets rather than visit cloning alone;
- Expert Iteration with reanalysis, dataset aggregation, and a historical opponent league;
- a larger offline teacher distilled into browser-specific students;
- promotion on strength per measured wall-clock cost across tiers.

The core hypothesis is deliberately narrow:

> v4 can beat v3’s efficiency by learning only the portions of search that are expensive and predictable, while retaining exact simulation wherever learned approximation has already been shown to destroy useful structure.

That hypothesis is materially different from every v4.0–v4.6 deployment attempted so far, while reusing the representations, data plumbing, and negative results that those generations paid to discover.

## Selected external sources

- Anthony, Tian & Barber, [Thinking Fast and Slow with Deep Learning and Tree Search](https://proceedings.neurips.cc/paper_files/paper/2017/hash/d8e1344e27a5b08cdfd5d027d9b8d6de-Abstract.html), NeurIPS 2017.
- Baxter, Tridgell & Weaver, [TDLeaf(lambda): Combining Temporal Difference Learning with Game-Tree Search](https://arxiv.org/abs/cs/9901001), 1999.
- Bellemare, Dabney & Munos, [A Distributional Perspective on Reinforcement Learning](https://proceedings.mlr.press/v70/bellemare17a.html), ICML 2017.
- Danihelka et al., [Policy Improvement by Planning with Gumbel](https://openreview.net/pdf?id=bERaNdoegnO), ICLR 2022.
- Grill et al., [Monte-Carlo Tree Search as Regularized Policy Optimization](https://proceedings.mlr.press/v119/grill20a.html), ICML 2020.
- Hubert et al., [Learning and Planning in Complex Action Spaces](https://proceedings.mlr.press/v139/hubert21a.html), ICML 2021.
- Lakshminarayanan, Pritzel & Blundell, [Simple and Scalable Predictive Uncertainty Estimation using Deep Ensembles](https://proceedings.neurips.cc/paper_files/paper/2017/hash/9ef2ed4b7fd2c810847ffa5fa85bce38-Abstract.html), NeurIPS 2017.
- Lanctot et al., [OpenSpiel: A Framework for Reinforcement Learning in Games](https://arxiv.org/abs/1908.09453), 2019.
- Lee et al., [Set Transformer](https://proceedings.mlr.press/v97/lee19d.html), ICML 2019.
- Omidshafiei et al., [Alpha-Rank: Multi-Agent Evaluation by Evolution](https://pmc.ncbi.nlm.nih.gov/articles/PMC6617105/), Scientific Reports 2019.
- Petosa & Balch, [Multiplayer AlphaZero](https://arxiv.org/abs/1910.13012), 2019.
- Rowland et al., [The Statistical Benefits of Quantile Temporal-Difference Learning for Value Estimation](https://proceedings.mlr.press/v202/rowland23a.html), ICML 2023.
- Schrittwieser et al., [Mastering Atari, Go, Chess and Shogi by Planning with a Learned Model](https://www.nature.com/articles/s41586-020-03051-4), Nature 2020.
- Silver & Tesauro, [Monte-Carlo Simulation Balancing](https://research.ibm.com/publications/monte-carlo-simulation-balancing--1), ICML 2009.
- Silver et al., [Mastering Chess and Shogi by Self-Play with a General Reinforcement Learning Algorithm](https://arxiv.org/abs/1712.01815), 2017.
- Stockfish project, [NNUE technical documentation](https://github.com/official-stockfish/nnue-pytorch/blob/master/docs/nnue.md?plain=1).
- Veness, Lanctot & Bowling, [Variance Reduction in Monte-Carlo Tree Search](https://papers.nips.cc/paper_files/paper/2011/hash/d736bb10d83a904aefc1d6ce93dc54b8-Abstract.html), NeurIPS 2011.
- Vinyals et al., [Grandmaster Level in StarCraft II Using Multi-Agent Reinforcement Learning](https://www.nature.com/articles/s41586-019-1724-z), Nature 2019.
- Wu, [Accelerating Self-Play Learning in Go](https://arxiv.org/abs/1902.10565), 2019.
- Zaheer et al., [Deep Sets](https://arxiv.org/abs/1703.06114), NeurIPS 2017.

