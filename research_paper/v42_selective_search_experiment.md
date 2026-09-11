# v4.2 selective-search experiment

**Run:** 2026-08-26  
**Status:** rejected as a v4.2 candidate; retain the mechanism as an efficiency primitive

## Executive result

The proposed selective-search architecture was implemented and tested in both plausible forms.
Neither produced a valid v4.2 candidate.

- The **continue/stop compute controller** failed its held-out capacity gate. At a +25% compute cap,
  the fitted controller recovered **−35% of the perfect-controller advantage**. A fixed rule—search
  more when the nominal search is not yet decided—recovered 49%. The preregistered bar was about 55%
  and better than every null.
- The **direct neural action with exact-search fallback** failed its primary offline gate at 20%
  coverage: conservative proxy gain **+0.019**, uncensored oracle-head gain **−0.088**, and majority
  top-one agreement **+7.8 percentage points**. The proxy interval was [−0.270, 0.290].
- A pre-listed but secondary 30% arm looked better offline, so it was run only as an exploratory
  falsification test. The fresh fixed 40-seed confirmation measured **−0.15 [−1.07, 0.80]** against
  its exact `v3.7-pro` parent. Per the recorded rule, the negative point estimate rejects this fitted
  gate. The earlier 16-seed probe was +0.98 [−0.54, 2.70]; pooling the two gives a descriptive
  +0.17 [−0.64, 1.02], but that pooled number is not used to reverse the confirmation decision.
- The efficiency mechanism is real. The selected arm skipped about **29% of eligible own-move 4–5
  searches**, used approximately **5% fewer executed iterations per ply**, and measured **9.2% lower
  wall time per ply** in a three-seed paired cost audit. That saving did not convert to demonstrated
  strength because the saved budget was discarded rather than reinvested.

There should therefore be no `v4.2` promotion from this experiment.

## What was implemented

The candidate keeps `v3.7-pro` byte-for-byte outside a narrow decision window:

1. Own moves 1–3 retain v3.7's tier-1 heuristic shortcut.
2. On own moves 4–5, the pooled three-member policy ensemble ranks the normal root shortlist.
3. A ridge confidence head reads only pre-search features: policy margins and entropy, ensemble
   vote/disagreement, cheap-ordering agreement/rank, move index, legal count, piece size, and centre
   distance.
4. If its predicted advantage clears the threshold, the policy acts directly. Otherwise the engine
   runs the unmodified v3.7-pro search.

The implementation adds a minimum opening-selection bound and a calibrated abstention head to the
existing direct-selector path. The experimental version is `v4.2-selective-probe-pro`; its comment
marks it explicitly as non-promotable without fresh confirmation.

## Data and leakage controls

The opening corpus contains 800 positions from 40 games, labelled by three independent
`v3.6-pro-max` searches at 1,200 iterations. The primary window contains 320 positions on own moves
4–5; 254 have a two-of-three majority oracle move.

Positions from one game share an opening trajectory. Five-fold cross-fitting therefore split by
whole game, never by position. Every ridge prediction in the reported offline curve was made by a
model that did not train on that position's game.

The oracle stores values for only its top eight children. The analysis reports two quantities:

- a conservative complete proxy that assigns an outside-head move below the stored tail; and
- an uncensored comparison only where both the policy and deployed-search move appear in the head.

This is a search-dynamics change. The metric-calibration work showed that root oracle regret is
actively unreliable for this channel, so the offline measurements were treated only as a safety
screen. Online seat-rotated games remained decisive.

## Offline direct-action results

The full policy on stable own-move 4–5 positions was essentially parity in top-one agreement but
negative on the conservative value proxy: **−0.130** mean proxy gain and **+0.4 percentage points**
top-one agreement versus deployed search. Confidence needed to identify a safe subset.

| Coverage | Positions | Conservative gain | Exact resolved gain | Top-one delta |
|---:|---:|---:|---:|---:|
| 10% | 25 | +0.239 | +0.081 | +20.0 pp |
| **20% primary** | **51** | **+0.019** | **−0.088** | **+7.8 pp** |
| 30% | 76 | +0.206 | +0.024 | +14.5 pp |
| 50% | 127 | +0.113 | +0.028 | +9.4 pp |
| 100% | 254 | −0.130 | −0.018 | +0.4 pp |

The 20% arm failed the fixed gate because its uncensored gain was negative. More importantly, the
curve is not monotone: 10% looks good, 20% regresses, and 30% recovers. A calibrated risk score
should become safer as coverage shrinks. This score does not, so the apparent 30% pocket was always
at high risk of being a sample-specific ordering.

The full-data 30% fit looked substantially stronger than its cross-fitted estimate—proxy gain
+0.299 [0.009, 0.612], exact gain +0.105, top-one +19.7 pp—which is another sign that fitting and
threshold selection were consuming the small corpus.

## Online and efficiency results

All strength matches used 300 base iterations, eight randomized opening plies from the top three,
and challenger seat rotation.

| Block | Seeds / games | Advantage vs `v3.7-pro` | Interpretation |
|---|---:|---:|---|
| Exploratory probe | 16 / 64 | +0.98 [−0.54, 2.70] | encouraging, underpowered |
| **Fixed confirmation** | **40 / 160** | **−0.15 [−1.07, 0.80]** | **reject fitted gate** |
| Pooled, descriptive only | 56 / 224 | +0.17 [−0.64, 1.02] | not a rescue statistic |

The confirmation's seat effects were blue +1.41, yellow −2.22, purple −1.38, and green +1.58. The
sign changes by seat and the total is near zero; there is no evidence here that the router found a
generally stronger action policy.

The paired full-game cost audit over three seeds measured:

| Version | ms / ply | Zero-search moves / game | Executed / allocated iterations |
|---|---:|---:|---:|
| `v3.7-pro` | 165.30 | 13.0 | 279,221 / 332,085 |
| selective probe | 150.15 | 15.3 | 269,351 / 336,466 |

The 2.3 additional zero-search moves per four-seat game are 0.58 per seat, or about 29% of the two
eligible moves. Executed iterations per ply fell from about 1,144 to 1,086 (roughly 5.1%), while
wall time per ply fell 9.2%. Three games are enough to establish that the shortcut fires and removes
work, not enough for a precise production latency estimate.

## Why this version failed

### 1. The policy was not trained for the decision it was asked to make

The pooled v4.5 model was trained as a root ranker, then reused as an actor. Its average moves 4–5
quality is only parity with search. A confidence head cannot manufacture action advantage; it can
only try to isolate the subset where advantage already exists.

### 2. The target is censored and partly arbitrary

Only eight oracle children have values, and two of three deep runs often choose different but
near-equivalent moves. Tail imputation dominates some training labels; exact gain resolves only 123
of 254 stable rows. Top-one agreement then rewards matching an unstable identity rather than
maximizing continuation value.

### 3. Three ensemble members are weak uncertainty supervision

Member disagreement did not order risk monotonically. The fitted coefficients even give positive
weight to chosen-move member standard deviation, the opposite of the intended abstention mechanism.
That is a symptom of a small, correlated calibration set rather than a trustworthy epistemic signal.

### 4. Savings were discarded

Direct selection can improve efficiency, but by itself it does not raise the architecture's strength
ceiling. The candidate skipped work on accepted roots and threw those iterations away. A higher-
ceiling design must bank them and spend them on later roots where additional search has positive
value.

### 5. The pointwise metric does not train the game-level objective

The existing calibration already showed that root regret gets dynamics changes wrong in four of
five signs. Both controllers were still trained on local regret removal. The online result is
consistent with that mismatch: locally plausible decisions did not improve full-game score.

## What can make a valid v4.2 candidate

The next candidate should keep selective search but change the learning problem. The proposed
architecture is **actor + conservative router + budget bank + learned spender**:

1. **Train a purpose-built actor.** Collect on-policy v3.7 positions and label the full root
   shortlist with repeated pro-max continuation values. Train advantage-weighted behavior cloning
   or listwise policy improvement against the search action—not top-one imitation of one oracle run.
2. **Train the router on downside.** Predict the lower tail of `actor value − fallback value` with a
   quantile/conformal objective. Accept only when a held-out, game-grouped upper bound on harmful
   action rate clears a fixed risk tolerance. Require a monotone risk–coverage curve.
3. **Bank every saved iteration.** A direct action contributes its unused budget to a per-game bank.
   This converts efficiency into potential strength rather than merely a faster neutral model.
4. **Learn where to spend.** The spender chooses a budget multiplier from a small set such as
   `{0.5, 1, 2, 4}` using search-progress features. Train it as a constrained contextual bandit or
   policy-gradient controller on final seat-rotated score advantage minus a compute penalty. The
   simple `not decided` rule is the first baseline it must beat.
5. **Use game outcomes for the final router/spender objective.** Root oracle values can pretrain and
   veto catastrophic actions, but dynamics policy selection must be based on paired full-game
   returns because that is the channel's validated measurement level.

This has a genuinely higher ceiling than v3: the actor can eliminate low-value search, the fallback
preserves current behavior where confidence is insufficient, and the bank reallocates the saved
budget to contested roots. With an identity router (always abstain, spend 1×) it reduces exactly to
v3.7, so learning capacity can grow without removing the incumbent path.

## Next experimental sequence

1. Generate at least 200 independent opening games with complete values for the union of actor and
   fallback top candidates, plus multiple stochastic continuations per candidate. Keep 25% of games
   untouched until the router and threshold are frozen.
2. Train a purpose-built action-advantage actor and downside router. Reject unless the risk–coverage
   curve is monotone and at least 15% coverage remains under the held-out harm bound.
3. Separately train the budget spender, with `not decided` and fixed midgame spend as mandatory nulls.
4. Integrate actor/router/bank/spender and run a fixed 40-seed screen versus `v3.7-pro`. A neutral
   point estimate with at least 5% fewer executed iterations is enough to retain the foundation; a
   promotion still needs a larger preregistered block and the project-wide v4.1 efficiency/strength
   rule.
5. Only after the pro tier survives should the same architecture be scaled toward
   `v3.7-pro-max`. The first goal remains a reusable higher-ceiling mechanism, not an immediate
   pro-max upset.

## Reproducibility

- Preregistration: `research_paper/v42_selective_search_preregistered.md`
- Offline controller: `scripts/v42SelectiveOpeningOffline.ts`
- Offline results: `selfplay-results/v42-selective-opening-offline.json`
- Selective-compute fit: `scripts/fitV37Voc.ts`
- Cost audit: `selfplay-results/v42-selective-cost.json`
- 16-seed log: `selfplay-results/match-2026-08-27T05-12-26-417Z.jsonl`
- 40-seed confirmation log: `selfplay-results/match-2026-08-27T05-18-30-398Z.jsonl`
