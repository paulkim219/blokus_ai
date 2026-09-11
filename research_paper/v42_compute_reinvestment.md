# v4.2 — reinvesting the efficiency surplus

**Written before any arm below was measured:** 2026-08-26
**Status:** preregistered

## What the v4.2 files achieved, and why none of them produced a model

Three v4.2 lines of work are on record. All three are honest negatives, and together they say
something specific about where a v4.2 can come from.

| Work | Result | What it established |
|---|---|---|
| `v42_metric_calibration.md` | leaf-channel offline metric, Spearman 0.958, 12/12 correct in sign | a **veto** for leaf candidates — it would have killed v4.7 and most of v4.6 before their matches |
| `v42_metric_calibration.md`, blend sweep | screened blend 0.15 predicted +0.6 to +1.3; measured **−0.36 [−1.08, 0.35]** | the metric ranks known changes but cannot *select* among near-parity candidates |
| `v42_selective_search_experiment.md` | fixed 40-seed confirmation **−0.15 [−1.07, 0.80]** | the router mechanism works mechanically (29% of eligible searches skipped, 9.2% less wall time) but bought no strength |

`STRUCTURAL` Every learned component measured so far contributes nothing: root prior −0.12 for the
whole channel, rollout student −0.06, leaf value −0.36 at its screened optimum, selective router
−0.15. But two of those four produced a **real efficiency saving** — v4.1 is 17.9% cheaper per move
than `v3.1-pro`, and the selective router a further 9.2% — and in both cases the saving was banked
and never spent. The selective-search post-mortem names this as its own failure #4: *"the candidate
skipped work on accepted roots and threw those iterations away."*

That is the gap this document attacks. Not a new learned component — those have a poor record here —
but the unspent surplus that the working ones already produced.

## The measurement that has never been run

`MEASURED` Gate 3, whole-game timing at the Pro tier: `v4.1-pro` 139.8 ms/move against `v3.1-pro`'s
170.2. The surplus is **1.218x** — v4.1-pro can execute 21.8% more iterations before it costs what
the incumbent already costs.

`STRUCTURAL` Nobody has measured what that buys, because every v4 comparison in this project has been
run at fixed iterations. `E19` in `v4_learning_programme.md` proposed the strength-versus-wall-clock
curve and it was never executed.

## Preregistered design

Three arms, identical to `v4.1-pro` in every respect except `iterationScale`:

| Arm | Scale | Intent |
|---|---:|---|
| `v4.2-pro-s56` | 5.59 | spends exactly the surplus; should cost about what `v3.1-pro` costs |
| `v4.2-pro-s69` | 6.89 | overspends to ~1.5x `v4.1-pro` |
| `v4.2-pro-s92` | 9.18 | overspends to ~2x `v4.1-pro` |

Each is matched **against `v4.1-pro` as a common reference**, not against `v3.1-pro`. The arms share
everything but iteration count, so the paired contrast is far tighter than three separate 40-seed
estimates against a distant baseline would be, and the advantage over `v3.1-pro` is recovered as
`1.13 + margin`.

Wall clock is measured with `scripts/gate3Cost.ts` on whole games, on an otherwise idle machine.

## The decision rule

The requested criterion is that extra compute is worth spending when the score gain exceeds the
compute cost. That needs a number for what compute alone is worth, and the project has one:
`v3.1-pro-max` beats `v3.1-pro` by +1.02 for 1.74x the iterations, which is **1.27 points per
doubling**.

So for an arm with advantage `S` over `v3.1-pro` at cost `C` ms/move, define

> **above-curve = S − 1.27 · log2(C / 170.2)**

the amount by which it beats what the incumbent lineup would achieve if simply given the same
compute. `v4.1-pro` scores `1.13 − 1.27·log2(139.8/170.2) = 1.13 + 0.36 = **+1.49**`.

**Promotion rule.** An arm is promoted as `v4.2` only if its above-curve exceeds v4.1-pro's +1.49.
An arm that merely moves along the curve is a *tier*, not a generation, and would be named
`v4.1-pro-max` rather than `v4.2`.

`STRUCTURAL` This distinction is the whole point of the rule and it should be stated plainly before
the numbers arrive: **if the exchange rate for v4.1 is the same as for v3.1, then spending the
surplus produces a stronger engine but not a better one**, and the honest label is a new tier. The
release only earns a generation number if v4.1's architecture converts compute *better* than v3.1's
does — which is an empirical question nobody has asked, and which the shortcut plausibly affects,
since it removes tree search from the three plies where the branching factor is largest.

## Predictions

Recorded before running.

1. All three arms beat `v4.1-pro`, monotonically in scale, since more iterations is a strict
   improvement in this engine.
2. `s56` costs within ±8% of `v3.1-pro`'s 170.2 ms/move.
3. Above-curve stays within ±0.4 of +1.49 across the ladder — i.e. **v4.1 converts compute at
   roughly the incumbent rate and the ladder yields a tier, not a generation.** This is the null I
   expect to hold; the interesting outcome is it failing upward.

**Falsifier for promotion:** if no arm's above-curve exceeds +1.49, no `v4.2` is named from this
work, and the strongest arm ships as `v4.1-pro-max` instead.

---

## Results

### Wall clock

`MEASURED` Whole-game timing, three games per arm, paired against `v3.1-pro` inside the same run
(absolute ms drifts between runs on this machine; the within-run ratio does not).

| Arm | Iterations vs v4.1-pro | Cost vs `v3.1-pro` |
|---|---:|---:|
| `v4.1-pro` | 1.00 | **−17.9%** |
| `v4.2-pro-s56` | 1.22 | **+0.2%** |
| `v4.2-pro-s69` | 1.50 | +19.9% |
| `v4.2-pro-s92` | 2.00 | +54.1% |

Prediction 2 holds essentially exactly: `s56` reaches wall-clock parity with the incumbent, +0.2%.

### Strength

`MEASURED` 40 seeds / 160 games each, fresh disjoint blocks, against `v4.1-pro` as a common
reference.

| Arm | Advantage vs `v4.1-pro` | Predicted from compute alone | Excess |
|---|---:|---:|---:|
| `v4.2-pro-s56` | +0.93 [−0.11, 2.06] | +0.37 | +0.56 |
| `v4.2-pro-s69` | +0.57 [−0.80, 2.02] | +0.65 | −0.08 |
| `v4.2-pro-s92` | **+1.50 [0.48, 2.59]** | +1.15 | +0.35 |

Prediction 1 half-holds: all three are positive, but the ladder is not monotone — `s69` sits below
`s56`. All three intervals overlap heavily, so that is noise at 40 seeds, not a real dip.

### The incumbent control

`MEASURED` `v3.1-pro-s56` vs `v3.1-pro`, the same +21.8% iteration increment applied to the
incumbent: **+0.34 [−1.00, 1.70]**.

`MEASURED` The historical exchange rate predicted +0.36 for this increment. Measuring it directly at
this operating point gives +0.34. **The 1.27-points-per-doubling figure is confirmed where it is
being used**, which removes the main worry about extrapolating it from the pro→pro-max comparison.

### Both arms were then reproduced, and one did not survive

`MEASURED` The 40-seed ladder blocks are screens. Both headline arms were re-run on fresh disjoint
seeds under the standing reproduce-before-promotion rule, and they behaved very differently.

| Arm | Block 1 (40 seeds) | Further blocks | **Pooled** |
|---|---:|---:|---:|
| `v4.2-pro-s92` | +1.50 [0.48, 2.59] | +1.51 [0.73, 2.32] (100 seeds) | **+1.50 [0.86, 2.16]**, 140 seeds |
| `v4.2-pro-s56` | +0.93 [−0.11, 2.06] | −1.09 (17), +0.14 (55) | **+0.23 [−0.52, 1.00]**, 112 seeds |

`MEASURED` `s92`'s two independent estimates agree to 0.01. `s56`'s +0.93 was the familiar screen
artefact: across 112 seeds it settles at **+0.23**, below even the +0.37 that compute alone predicts.
The warning was on the record when the screen was reported — its interval was [−0.11, 2.06] and
contained the compute prediction comfortably.

### The curve

`MEASURED` Advantage over `v3.1-pro`, recovered as `1.13 + margin`, using pooled figures wherever a
reproduction exists:

| Config | Cost (v3.1-pro = 1.00) | Advantage vs `v3.1-pro` | Above-curve |
|---|---:|---:|---:|
| `v3.1-pro` | 1.000 | 0 | 0 |
| `v3.1-pro-s56` | ~1.218 | +0.34 | −0.02 |
| `v4.1-pro` | 0.821 | +1.13 | **+1.49** |
| `v4.2-pro-s56` | 1.002 | +1.36 | +1.36 |
| `v4.2-pro-s69` | 1.199 | +1.70 | +1.37 |
| `v4.2-pro-s92` | 1.541 | **+2.63** | +1.84 |

### Reading

`MEASURED` **Prediction 3 holds, and now cleanly.** Above-curve across the ladder is 1.36, 1.37 and
1.84 against `v4.1-pro`'s 1.49 — every value inside the predicted ±0.4 band, with `v4.1-pro` itself
sitting in the middle rather than at the bottom. No arm exceeds it.

`MEASURED` The two clean measurements of the same +21.8% increment are now **+0.23** for v4.1 and
**+0.34** for v3.1. They are indistinguishable, and both match the +0.37 the exchange rate predicts.
**v4.1 converts compute at the incumbent rate.** The earlier suggestion that it might convert better
came entirely from `s56`'s unreproduced screen and is withdrawn.

`STRUCTURAL` The preregistered falsifier has therefore fired: no arm's above-curve exceeds +1.49, so
**no `v4.2` is named from this work**. The ladder produces a legitimate compute tier and nothing more.

`STRUCTURAL` **Whether v4.1 converts compute better than v3.1 does is not resolvable at feasible
cost.** The two relevant numbers are +0.93 (v4.1's return on +21.8%) and +0.34 (v3.1's return on the
same). Their difference is +0.59 with a standard error near 0.85; separating them at 80% power would
need roughly 500 seeds per arm, some 4,000 games. The point estimates lean the right way and cannot
be promoted to a claim.

`STRUCTURAL` So this work produces a **stronger engine but not a better one**. Per the preregistered
rule, the naming follows the mechanism: the ladder moves along a curve whose starting point v4.1
already established, so the release is a compute tier. The engineering value is real and the
attribution is not — exactly the situation v4.1 itself was in, where the strength came from the
inherited shortcut rather than the learned student.

### Reproduction

`MEASURED` The strongest arm was re-run on a fresh disjoint block, per the standing
reproduce-before-promotion rule:

| Block | Seeds / games | `v4.2-pro-s92` vs `v4.1-pro` |
|---|---:|---:|
| 562092039 | 40 / 160 | +1.50 [0.48, 2.59] |
| 58100000 (fresh) | 100 / 400 | +1.51 [0.73, 2.32] |
| **Pooled** | **140 / 560** | **+1.50 [0.86, 2.16]** |

The two independent point estimates agree to 0.01 — unusually tight for this harness — and both
clear zero on their own. 34.8% first place against a 25% par. This is a solid, reproduced result and
the arm is promotable as a tier.

## Recommendation

`MEASURED` **One configuration is worth shipping: `v4.2-pro-s92`.** It is +1.50 [0.86, 2.16] over
`v4.1-pro` across 140 seeds with two agreeing independent blocks, and +2.63 over `v3.1-pro`, at
+54% wall clock against `v3.1-pro` (309 ms/move against 170 at the Pro tier).

`STRUCTURAL` **It should be named `v4.1-pro-max`, not `v4.2`.** The preregistered rule says the name
follows the mechanism, and the mechanism here is buying more of an exchange rate that `v4.1`
already established — precisely the relationship `v3.1-pro-max` has to `v3.1-pro`. Naming it `v4.2`
would assert an architectural advance that the above-curve column explicitly does not show.

`MEASURED` **`v4.2-pro-s56` should not ship.** At +0.23 [−0.52, 1.00] over 112 seeds it is
indistinguishable from `v4.1-pro`, and at equal wall clock to `v3.1-pro` it is worse than simply
running `v4.1-pro` and pocketing the 17.9% saving.

`STRUCTURAL` The requested criterion — spend compute when the score gain exceeds the compute cost —
is answered, and the answer is **no, not at this operating point.** Every arm tracks the exchange
rate: v4.1 returns +0.23 on a 21.8% increment where the incumbent returns +0.34, and `s92`'s +1.50
against a predicted +1.15 is a 0.35 excess inside an interval of ±0.65. There is more strength
available for more money, at the ordinary price. There is no bargain.

## Correction: `s92` was measured against the wrong tier

`STRUCTURAL` The recommendation above contained an error, found while choosing a name for the
release. **`v4.1-pro-max` already exists at scale 8** — it was registered as part of the v4.1 tier
family at promotion — so it was never an available name, and more importantly `s92` was never
compared against it.

| Config | Iterations at 300 base |
|---|---:|
| `v4.1-pro` | 1,377 |
| `v4.1-pro-max` | 2,400 |
| `v4.2-pro-s92` | 2,754 |

`s92`'s +1.50 is its advantage over `v4.1-pro`, the *middle* tier. Against the top tier that already
ships it is **+14.8% compute**, which the exchange rate prices at about **+0.25**. `s92` is a
near-duplicate of `v4.1-pro-max` and should not be released under any name.

`STRUCTURAL` This is the same error the ladder was built to avoid, made one level up: a compute
comparison is only meaningful against the configuration a user would otherwise run, and for a
top-tier release that is pro-max, not pro.

## `v4.1-ultra` — a tier that is actually a tier

`STRUCTURAL` A rung above pro-max should have the same ratio to it that pro-max has to the tier
below: roughly 2x. `v4.1-ultra` is `v4.1` at scale 16 — 4,800 iterations at 300 base — with nothing
else changed.

`MEASURED` Strength against `v4.1-pro-max`, three disjoint blocks:

| Block | Seeds / games | Advantage |
|---|---:|---:|
| 60100000 | 40 / 160 | +1.50 [0.10, 2.88] |
| 60300000 | 22 / 88 | +1.37 [−0.38, 3.22] |
| 60500000 | 45 / 180 | +1.54 [0.52, 2.65] |
| **Pooled** | **107 / 428** | **+1.49 [0.69, 2.26]** |

Three independent estimates spanning 0.17, all positive, two clearing zero on their own. 33.9% first
place against 25% par. **Reproduce-before-promotion is satisfied.**

`MEASURED` Compute alone predicts +1.27 for the doubling; the measured +1.49 is on the curve, like
everything else in this document.

### Wall clock, and a measurement that had to be redone

`MEASURED` Whole games against `v3.1-pro-max` on an **idle** machine: **437.1 ms/move against
297.8**, or **+46.8%**.

`STRUCTURAL` A first attempt at this measurement was taken while a tournament occupied six workers
and reported 579.6 against 436.3, +32.8%. The reasoning at the time was that gate 3 alternates which
version it times, so shared load should cancel in the ratio. **It did not.** The contended run
overstated absolute cost by a third and *understated* the ratio by fourteen points. Contention does
not cancel here, presumably because the two configurations have different memory and scheduling
profiles under pressure. Timing claims from this harness require an idle machine, and the earlier
anomaly noted in `v42_metric_calibration.md` — one config taking 1817s against a neighbour's 60s at
identical iteration scale — is likely the same effect.

## `v4.1-ultra` against the v3.1 lineup

`MEASURED` All three at the site's 100-seed protocol, 300 base iterations, four seat rotations,
challenger `v4.1-ultra` throughout. The greedy reference is `v1` played at `--champion-policy
greedy`, matching how every existing `*-vs-greedy` row in `site/src/data/publicMatchResults.json`
was produced.

| Opponent | Advantage | Seeds / games | First place | Squares placed |
|---|---:|---:|---:|---:|
| `v3.1-pro-max` | **+3.39 [2.59, 4.22]** | 100 / 400 | 43.5% | 79.5 |
| `v3.1` | **+5.09 [4.29, 5.91]** | 95 / 380 | 51.8% | 80.4 |
| greedy (`v1`) | **+26.58 [25.31, 27.84]** | 100 / 400 | 97.5% | 87.0 |

Every block reproduced: the `v3.1-pro-max` row is three disjoint chunks at +4.03, +2.65 and +3.49;
the greedy row is two at +26.15 and +27.00.

### The direct measurement corrects the chained one

`MEASURED` Chaining `v4.1-pro-max`'s +0.50 gate-6 screen with ultra's +1.49 over it predicted
**+1.99** against `v3.1-pro-max`. The direct measurement is **+3.39** — the chain understated the gap
by 40%.

`STRUCTURAL` The weak link is identified: that +0.50 came from a single unreproduced 40-seed block
with an interval of [−0.76, 1.69]. Chaining through it inherited all of its error. **Any tier
comparison in this project that routes through an unreproduced screen should be measured directly
before it is quoted**, which is now the second time this has cost a materially wrong number — the
first being `s92` measured against the wrong rung entirely.

### Tension with the ladder's conclusion, unresolved

`MEASURED` On wall clock `v4.1-ultra` is 1.468x `v3.1-pro-max` (437.1 against 297.8 ms/move, idle).
The exchange rate prices that at **+0.70**. The measured advantage is **+3.39**, so above-curve is
roughly +2.7 — well beyond `v4.1-pro`'s +1.49 and far outside anything the compute ladder produced.

`STRUCTURAL` This does not sit comfortably with the ladder's finding that v4.1 converts compute at
the incumbent rate, and the disagreement should be recorded rather than smoothed over. Two readings
are consistent with both sets of measurements:

1. The ladder compared **v4.1 against itself** at different scales, isolating compute. This compares
   **v4.1 against v3.1** at high compute, where the architecture gap is also present. If that gap
   *widens* with budget — plausible, since the opening shortcut frees proportionally more iterations
   as the budget grows — both results hold simultaneously.
2. The pro-tier +1.13 underestimated the architecture gap, in which case the ladder's above-curve
   figures were all anchored too low.

`PROPOSED` The experiment that separates them is cheap and has not been run: measure
`v4.1-pro` vs `v3.1-pro` and `v4.1-ultra` vs `v3.1-ultra` (an unregistered scale-16 v3.1) on the same
protocol. If the gap grows from +1.13 to something near +3, reading 1 is right and the v4.1
architecture scales better than v3.1 — which would be the first genuinely architectural result in the
v4 programme, and considerably more interesting than a compute tier.

## What would actually raise the ceiling

`STRUCTURAL` The ladder buys strength by moving along the exchange-rate curve. Getting above it needs
a mechanism, and the selective-search post-mortem already identified the most promising one: its
router removed 9.2% of wall time and discarded the savings. Combining that with this work — bank the
router's savings and spend them as iterations on contested roots — is the first candidate in this
programme that could plausibly beat the curve rather than ride it, because it moves compute from
positions where it is wasted to positions where it is not. That is `v42_selective_search_experiment.md`'s
proposed actor/router/bank/spender design, of which this document has now built and validated the
"spend it" half.
