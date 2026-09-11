# v4.6 — channel audit

Running ledger for the instrumentation release proposed in `v4_learning_programme.md` §5. Started
2026-08-23. Every entry states its sample size and its minimum detectable effect, per §2.4 of that
document; a null without an MDE is not a result.

Tags as in the programme: `MEASURED`, `ESTIMATE`, `STRUCTURAL`, `PROPOSED`.

---

## The trigger

`MEASURED` v4.5's pseudo-visit readout completed its 40-seed confirmation at **−0.02 [−0.93, 0.96]**
(`selfplay-results/match-2026-08-23T00-08-33-361Z-summary.txt`), against a 16-seed screen of
+2.09 [−0.01, 4.15]. That is the eleventh instance of the screen-regression arc the programme keeps
producing, and the fifth consecutive v4 generation to gate out. The v4.5 arms in full:

| Arm | Seeds / games | Advantage | Source |
|---|---:|---:|---|
| spatial-single prior | 40 / 160 | −0.27 [−1.43, 0.93] | `match-2026-08-22T23-28-46-169Z` |
| spatial-ensemble prior | 40 / 160 | −0.02 [−1.22, 1.09] | `match-2026-08-22T23-39-54-332Z` |
| pv128 screen | 16 / 64 | +2.09 [−0.01, 4.15] | `match-2026-08-22T23-53-04-476Z` |
| pv256 screen | 16 / 64 | +0.37 [−1.35, 1.89] | `match-2026-08-22T23-58-22-900Z` |
| pv512 screen | 16 / 64 | −0.03 [−2.36, 2.52] | `match-2026-08-23T00-03-31-887Z` |
| **pv128 confirmation** | **40 / 160** | **−0.02 [−0.93, 0.96]** | `match-2026-08-23T00-08-33-361Z` |
| earlymid gate | 16 / 64 | −0.13 [−2.84, 2.89] | `match-2026-08-23T00-21-51-003Z` |
| earlymid + pv128 | 16 / 64 | +0.66 [−1.67, 3.15] | `match-2026-08-23T00-25-31-829Z` |

---

## E1 — the root-prior channel has no measurable capacity

`STRUCTURAL` `softmaxPriors` (`src/ai/bitboard/ordering.ts`) divides scores by `priorTemp`, so
raising it flattens the PUCT prior toward uniform at exactly zero compute cost. `v3.2-pro-uniform`
(`priorTemp: 1e6`) is therefore v3.2-pro with its root prior deleted and nothing else changed — same
iteration scale, same ε, same shortlist, same everything.

`MEASURED` Two disjoint seed blocks against `v3.2-pro` at 300 base iterations:

| Block | Seeds / games | Advantage of *uniform* prior |
|---|---:|---:|
| 31000000 | 40 / 160 | −0.36 [−1.55, 0.86] |
| 32500000 (partial, interrupted) | 15 / 60 | — |
| **Pooled** | **55 / 220** | **−0.12 [−1.09, 0.89]** |

Minimum detectable effect at 55 seeds: **1.81**.

**Reading.** Deleting the hand-tuned root prior costs 0.12 points, and the interval excludes
anything larger than about 1.1. The prior *weights* channel is worth roughly a tenth of a point.

`ESTIMATE` This bounds the entire v4.1–v4.5 programme from above. Those five generations optimised
`node.priors` and nothing else. A **perfect** root prior — not a better one, a perfect one — is worth
at most what deleting the current one costs, and that is 0.12 [−0.89, 1.09] points. The advancement
rule is +0.5. §1 of the programme puts a version name at +1.3. The channel cannot pay either.

`ESTIMATE` Every "not significant" in the v4 ledger therefore reads as a **ceiling effect, not a
modelling failure**. The offline metrics were improving (pair accuracy 60.44% → 63.24%, top-1
26.36% → 33.45%) and they were improving something that does not convert, because the thing they
improve has no room to convert. This is the finding the programme has been missing since v4.0, and
it cost two 12-minute matches to get.

`STRUCTURAL` **What this does *not* say.** Three separate channels feed the root decision and only
the third was ablated here:

1. **Candidate generation.** A tier-0 filter scores every legal move by piece size and centre
   distance alone and cuts to 96; `MoveOrderer.scoreMoves` then sorts and truncates to
   `rootShortlist = 40` (`src/ai/bitboard/mcts.ts`, `initialise`). Hundreds of moves die here.
2. **Opening order.** Progressive widening opens children in shortlist index order.
3. **PUCT weights.** The softmax probabilities — the only thing `priorTemp` and `netPriorBlend`
   touch, and the only thing E1 measured.
4. **Readout.** Which child the finished tree actually plays. `rootPriorPseudoVisits` — v4.5's most
   recent and most promising idea — lives here, not in (3), so E1 does not bound it. E2(b), the
   oracle's regret on the deployed move, bounds every root-selection mechanism including this one.

`STRUCTURAL` A clean ablation of (3) alone is possible because `priorTemp: 1e6` makes
`Math.exp((score − max) / 1e6)` equal 1 for every child, so `node.priors` becomes exactly uniform and
the PUCT exploration term becomes identical across children. Selection is then driven purely by Q.
`v3.2-pro` sets `netPrior: false`, so no learned prior is in the path either way.

`MEASURED` One rung in the opposite direction already existed: `priorTemp = 3`, a *sharper* prior,
measured −2.93 [−4.61, −1.29] in the v3.2 shift. So the channel can lose three points while being
unable to gain one. That asymmetry is consistent with a prior whose job is to avoid catastrophe
rather than to find brilliance, which is what a well-behaved search should look like.

`PROPOSED` E2 measures channels 1 and 2 and is the remaining question: if the oracle's move is
routinely outside the 96-move tier-0 cut, the useful job for a learned policy is **candidate
generation**, which no v4 generation has ever been allowed to do.

---

## E2 — candidate generation is not the bottleneck; the training cap is

`MEASURED` 82 positions from 5 `v3.2-pro` games, each searched by the deployed engine (1,377
iterations) and by a ~7× oracle (`v3.2-pro-max` at 9,600). Regret is in **squares**: `index.ts`
reports ranked values as `logit(meanValue) × sigmoidScale`, back on the score-margin scale.

| Phase | n | mean legal | agree with oracle | regret (squares) | cut by tier 0 | outside top 40 | outside top 12 |
|---|---:|---:|---:|---:|---:|---:|---:|
| all | 82 | 220 | 50.0% | 0.279 | **0.0%** | 1.2% | 46.3% |
| opening | 25 | 356 | 8.0% | 0.620 | 0.0% | 0.0% | 56.0% |
| midgame | 48 | 188 | 66.7% | 0.186 | 0.0% | 2.1% | 50.0% |
| endgame | 9 | 11 | 77.8% | 0.058 | 0.0% | 0.0% | 0.0% |

`MEASURED` **The hand funnels are not throwing away the answer.** In 82 positions averaging 220
legal moves — 356 in the opening — the tier-0 filter, which ranks every legal move by piece size and
centre distance alone and keeps 96, discarded the oracle's move **zero times**. The 40-move
shortlist lost it once. This closes E21: a learned *candidate generator* has nothing to recover,
and the cheapest heuristic in the engine is already doing that job essentially perfectly.

`MEASURED` **The training cap is throwing it away, constantly.** The oracle's move is outside the
top 12 in 46.3% of positions, and every export batch in the v4 programme uses `--top-k 12`. Roughly
half of all training roots do not contain the move a deeper search prefers. This confirms §2.2 of the
programme — but note that E1 has already capped what fixing it could be worth.

`STRUCTURAL` Two cautions on the regret column, both of which push it upwards. The oracle is a
stronger search, not ground truth, and taking a max over ~16 noisy child values carries a
winner's-curse inflation. And per-move regret does not sum over a game, because the oracle's value
already prices future play. Treat 0.279 as an upper bound on the root-ranking channel; the
trustworthy number is E1's −0.12.

`MEASURED` The phase profile is the interesting part and it is new. Deployed-versus-oracle agreement
is **8% in the opening**, 67% midgame, 78% endgame, with regret 0.62 / 0.19 / 0.06. Whatever root
headroom exists is concentrated almost entirely in the opening, where the branching factor is
highest and the search is least settled. `PROPOSED` That is the classical case for an **opening
book**, not for a learned prior — and `src/ai/bitboard/book.ts` already contains the lookup
mechanism with no generated corpus behind it (v4 report §9.4).

## E14a — the rollout-balance metric fails calibration, and the bias hypothesis is falsified

`MEASURED` 227 positions from 11 `v3.2-pro` games, 200 rollouts per position per arm, paired rollout
seeds across arms. Reference: the realized final margin of each position's own game, in the squashed
units the tree backs up.

| ε | bias | mse | rho | measured strength |
|---:|---:|---:|---:|---:|
| 0.05 | −0.0332 | 0.02275 | 0.625 | −1.01 |
| 0.15 | −0.0342 | 0.02255 | 0.626 | 0 |
| 0.30 | −0.0344 | 0.02236 | 0.628 | +0.29 |
| 0.45 | −0.0353 | 0.02185 | 0.647 | +0.28 |
| **0.60** | −0.0336 | 0.02249 | 0.617 | **+0.70** |
| 1.00 | −0.0323 | **0.02179** | 0.654 | +0.36 |

Spearman against measured strength: −|bias| **0.143**, −mse **0.600**, rho **0.086**.

`MEASURED` **The metric picks the wrong arm.** Both bias and MSE are minimised at ε=1.00, which is
measured at +0.36, while the promoted ε=0.60 sits at +0.70. Worse, the whole ladder is flat: bias
spans −0.0323 to −0.0353 — about 1% relative — across configurations whose playing strength spans
1.7 points. A metric that moves by 1% while strength moves by 1.7 points is not measuring the
mechanism.

`MEASURED` **This falsifies the hypothesis behind v4.8.** The programme's §3.1 argued that ε=0.60
won because it reduced rollout *bias*, and that simulation balancing would therefore find more of the
same. The rollout estimator's absolute calibration is, in fact, almost completely insensitive to ε.
The named falsifier in §5 — "the balanced policy's rollouts predict deep-search values no better
than ε=0.60's do" — has fired, and it fired for one afternoon's compute instead of an eight-hour
match ladder. That is the instrumentation working as intended.

`STRUCTURAL` The mechanism is visible in why the flatness happens. A full rollout runs ~70 plies to a
real terminal score; over that many plies, per-ply policy differences average out of the *mean*.
This is the same effect §0.4 of the v4 report documented when enriching the playout candidate pool
went from +0.75 to −0.10 once playouts stopped being truncated.

`ESTIMATE` So the ε effect cannot live in the 200-rollout mean. It has to live in something the mean
destroys. The remaining candidate is **sibling decorrelation**: MCTS gives a fresh leaf *one*
rollout, and ranks siblings by small numbers of samples. A near-deterministic rollout policy makes
two sibling leaves replay nearly the same continuation, so their *difference* carries little
information even when each estimate is individually well-calibrated. Raising ε decorrelates them.
That is a variance-and-correlation property of single rollouts, and averaging 200 of them is exactly
the operation that hides it.

`PROPOSED` The replacement metric therefore has to measure what the tree measures: give each child of
a root a realistic handful of rollouts, rank them, and compare against a deep oracle's ranking of the
same children. E14b below.

## E14b — sibling discrimination is *anti*-correlated with playing strength

`MEASURED` 37 oracle-labelled roots, up to 8 children each, rollout budgets of 1/4/16 per child,
paired seeds across arms. The reference is the oracle's own ordering of those children.

| budget | metric | ε=0.05 | ε=0.15 | ε=0.30 | ε=0.45 | ε=0.60 | ε=1.00 | Spearman vs strength |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | top-1 | 27.0% | 21.6% | 18.9% | 21.6% | **10.8%** | 16.2% | **−0.986** |
| 4 | top-1 | 29.7% | 21.6% | 18.9% | 21.6% | 18.9% | 24.3% | −0.588 |
| 16 | top-1 | 35.1% | 37.8% | 35.1% | 27.0% | **18.9%** | 32.4% | −0.696 |
| 16 | rho | 0.249 | **0.330** | 0.212 | 0.213 | 0.206 | 0.165 | −0.886 |

`MEASURED` Every statistic, at every budget, is **negatively** correlated with measured playing
strength — nine sub-results pointing the same way, with Spearman between −0.43 and −0.99. The
promoted ε=0.60 is the *worst* sibling discriminator at budgets 1 and 16.

`STRUCTURAL` One confound is ruled out by direction. The oracle is `v3.2-pro-max`, which itself uses
ε=0.60, so any "a policy agrees with itself" artifact would favour the ε=0.60 arm. It came last.

`STRUCTURAL` One confound is *not* ruled out. A low-ε rollout is dominated by `playoutScore` =
size − centre distance, which correlates with both the tier-0 funnel score and `MoveOrderer`'s piece-
size term, and those shape the oracle's visit allocation and hence its values. Some of low-ε's
apparent advantage is shared heuristic, not accuracy. The sample is also small: 37 roots, and top-1
moves in 2.7% steps.

`ESTIMATE` **Taken with E14a, the ε=0.60 gain is not explained by any local property of the rollout
estimator.** It is not calibration (flat) and it is not sibling discrimination (backwards). Whatever
ε=0.60 is doing, it is doing at the level of the search — most plausibly acting as an *exploration*
knob, where noisier leaf estimates change how PUCT allocates visits and what shape the tree takes,
rather than as an *estimation* knob. That is a search-level effect and it is not visible in any
per-leaf statistic, which means the cheap-offline-proxy route into this channel is closed for now.

`STRUCTURAL` This is the second falsifier from `v4_learning_programme.md` §5 to fire, and it retires
v4.8 as specified there. It also carries a warning for anything that replaces the rollout with a
learned estimator: a value function fitted to be *accurate* would look like the ε=0.05 arm on both
metrics, and ε=0.05 measured **−1.01**.

`STRUCTURAL` One useful positive result falls out of the failure. The rollout estimator is very
nearly unbiased (−0.034 in squashed units, stable across every arm) and its calibration does not
move with the policy. That makes `V_π(s) = E[z(s) | s, π]` — the v4.9 target — a stable, well-defined
regression target rather than a moving one, which is the main risk that programme carries.

## Consequences already actioned

`STRUCTURAL` Three pieces of instrumentation were built alongside this result, because the audit is
worthless if the next candidate is evaluated the same way:

- **`scripts/rootHeadroom.ts`** — E2. Deployed search versus a ~10× oracle on a shared corpus:
  disagreement rate, the oracle's regret on the deployed move, and the oracle move's rank in both
  funnels.
- **`scripts/rolloutBalance.ts`** — E14/E5. An offline metric for the *rollout* policy, scored against
  the realized final margin of each position's own game, and calibrated against the six ε arms whose
  strength is already measured. Runs in seconds per candidate rather than one 400-game match per
  point.
- **`scripts/lib/rolloutCorpus.ts`** — the shared, cached position corpus with realized outcomes, and
  the policy evaluator. Splits are **by game**, never by position: positions inside one game share a
  board and an outcome.

`STRUCTURAL` The engine gained `playoutPolicy: 'linear'` (`src/ai/bitboard/playout.ts`): the legacy
two terms plus two *static* per-placement halo popcounts and a sampling temperature. Every added
term is a table lookup, because a pro-tier move scores roughly 1.2 million rollout candidates and the
budget is ~40 ns each. The legacy path is unchanged and the incumbent is reachable exactly at
`cornerWeight = edgeWeight = temp = 0`, `eps = 0.60`.

---

## E9/E18 — the leaf channel is economically large enough

`MEASURED` `scripts/v46LeafEconomics.ts` evaluated 90 phase-balanced positions from 12 games with
64 independent incumbent rollouts per position. Conditional rollout standard deviation was **7.54
squares overall**, split sharply by phase: **10.23 opening, 7.92 midgame, 1.75 endgame**. In the
exact backed-up units the tree consumes, the corresponding values were 0.2107 / 0.1806 / 0.0428.

`MEASURED` A 300-iteration search took 98.8 ms with terminal rollouts and 34.9 ms with the existing
MLP-sized deterministic replacement: **2.83× faster**, an `ESTIMATE` 1.95-point compute ceiling under
the measured 1.3 points/doubling exchange rate. The eventual 32×16 engineered-feature network ran
at about 4.5× rollout throughput; the richer pooled-spatial 64×32 model ran at **3.25×**. The channel
therefore passed its economics gate. Results: `selfplay-results/v46-leaf-economics.json`.

## E16 — target and representation ladder

`MEASURED` The first root-position pilot exposed a loss bug: Gaussian likelihood could inflate its
variance instead of learning the conditional mean. The corrected protocol uses disjoint train,
validation and sealed test games, selects checkpoints on validation mean RMSE, and calibrates the
variance head only after freezing that mean checkpoint.

`MEASURED` The actual-leaf exporter (`scripts/exportSearchLeafPilot.ts`) collected states from the
distribution MCTS really expands, then replayed selected leaves 32 times. The final corpus contains
3,641 repeated-label leaves from 360 searched roots and 24 independent games. Its target is not raw
score: it is the exact nonlinear four-seat value vector the tree backs up.

The representation ladder on the sealed three-game test set was:

| Representation | Test RMSE in backed-value units | Reading |
|---|---:|---|
| constant | 0.1435 | no state information |
| one real rollout, conditional SD | 0.1572 | noisy sample, not a learned predictor |
| 168 engineered features, ridge | 0.1267 | useful linear signal |
| 168 features, residual 32×16 MLP | 0.1264 | no meaningful nonlinear gain |
| exact 20×20 occupancy planes | 0.5300 | catastrophic location memorisation |
| pooled 4×4 occupancy/frontier/edge maps, ridge | 0.1170 | transferable spatial signal |
| pooled maps, residual 64×32 MLP | **0.1099** | first genuine nonlinear improvement |
| canonical pooled maps | 0.1170 | symmetry-safe ridge checkpoint; nonlinear gain did not replicate |

`STRUCTURAL` The exact-board failure and pooled-map success answer what “richer state
representation” means here: add spatial information at a resolution the number of independent games
can support. Exact cells need far more games or explicit equivariance. Coarse pooled geometry adds
signal without making each self-play board nearly its own feature basis.

## Search-level and online deployment gates

`MEASURED` Equal-wall oracle screens calibrated each arm's iteration budget from its measured
throughput. For the pooled model, half-variance sampling reached 1.79 squares of oracle regret versus
1.55 for incumbent rollouts; a 25% deterministic value blend while retaining every real rollout
reached 1.45. These were screens only: E14 had already shown this oracle metric can misorder playing
strength.

`MEASURED` Every replacement arm failed decisively at the standard v3.2 wall-clock tier:

| Arm | Seeds / games | Advantage vs `v3.2` |
|---|---:|---:|
| engineered raw-margin deterministic replacement | 16 / 64 | **−13.88 [−16.50, −11.40]** |
| engineered raw-margin sampled replacement | 16 / 64 | **−12.50 [−14.68, −10.30]** |
| engineered raw-margin sampled, 25% real leaves | 16 / 64 | **−7.04 [−8.83, −5.09]** |
| exact-backed-value half-noise replacement | 16 / 64 | **−11.39 [−12.97, −9.71]** |
| exact-backed-value sampled, 25% real leaves | 16 / 64 | **−6.58 [−8.71, −4.49]** |
| pooled-spatial half-noise replacement | 16 / 64 | **−14.80 [−16.52, −13.25]** |
| pooled-spatial half-noise, 25% real leaves | 16 / 64 | **−8.90 [−11.60, −5.97]** |

`MEASURED` Keeping every real rollout and blending the learned mean was qualitatively different:

| Arm | Seeds / games | Advantage vs `v3.2` |
|---|---:|---:|
| pooled-spatial 25% blend | 16 / 64 | −1.15 [−3.14, 0.61] |
| canonical pooled-spatial 25% blend | 16 / 64 | **−0.81 [−2.71, 1.12]** |

The canonical arm also reduced the earlier seat pathology, but its point estimate remained negative
and the 16-seed block had MDE 3.35. It is not a version candidate and does not merit a confirmation.
Full ledgers: `selfplay-results/v46-leaf-triage.json`, `v46b-leaf-triage.json`,
`v46d-leaf-triage.json`, `v46d-leaf-blend-triage.json`, and
`v46e-canonical-leaf-triage.json`.

## Decision — pure V_pi replacement is falsified

`MEASURED` Better marginal prediction, calibrated variance, richer transferable spatial features,
and 3.25× more iterations did **not** produce stronger search. Independent Gaussian sampling
recovered little, while retaining real trajectories recovered strength roughly monotonically. The
missing object is therefore not merely `E[z | s]` or `Var[z | s]`: terminal rollouts carry
trajectory-level, sibling-level and joint four-seat structure that an independently sampled leaf
head destroys. Faster search then repeats the model's residual errors thousands of times and becomes
more confidently wrong.

`STRUCTURAL` This also revises the programme's E16 falsifier. `RMSE(V_hat) < sigma_R` is necessary
but nowhere near sufficient. The engineered and spatial heads both passed that inequality and lost
by double digits. Any future learned leaf must be gated inside the actual search computation.

`PROPOSED` The next bounded MLP candidate is **n-step rollout bootstrapping**, not another direct
replacement. Run the real epsilon=0.60 rollout for 12/24/36 plies, then evaluate the reached state
with the canonical pooled MLP and undo. This preserves the early trajectory that appears to supply
search exploration and sibling structure, while replacing the expensive tail with a learned
continuation value. Train on `(cutoff state, completed rollout backed value)` pairs from the same
trajectory. Sweep cutoff at equal wall clock and require an interior strength optimum. This is the
only remaining leaf design directly supported by the v4.6 evidence.
