# Why the research-report engine underperformed

## A postmortem on `v12` — and on the first draft of this postmortem

---

**Verdict.** The first draft of this document listed six structural criticisms of
`blokus_ai_research_report_v3.md`, derived by reading the code, each with an argument for why it was
costing playing strength. All six were then turned into ablations and measured. **None of them
improved the engine. Three made it significantly worse.** The report's design choices, where they
could be measured at all, were either correct or immaterial.

The replacement explanation — that v12 is simply untuned — was then also measured, and it is **only
about 60% of the story**. Tuning v12's evaluation against v11 for 20 CEM generations moved it from
−2.84 to **−1.12 [−1.52, −0.70]** on held-out seeds: a real +1.72, and still significantly behind
v11.

So the honest state of knowledge is:

- v12's evaluation is the best *hand-designed* one in this repo (+2.18 over v4, beating the previous
  hand-designed v10 at +1.20 with non-overlapping intervals).
- **The gap to v11 is now fully accounted for, and closed.** Two changes did it, neither of them
  from this document's list of criticisms:

| | vs v11, eval level, 400 held-out seeds | |
| --- | --- | --- |
| v12 as implemented | −2.84 [−3.23, −2.46] | |
| + CEM tuning of the evaluation | −1.01 [−1.44, −0.59] | **+1.83** |
| + fractional Voronoi tie-break | **−0.15 [−0.54, 0.24]** | **+0.86** |

The second is the report author's own suggestion and the only mechanism either of us proposed that
survived measurement: a cell several seats reach in the same number of steps is split 1/k between
them rather than awarded whole to whoever moves soonest. Winner-take-all made |T_i| jump by whole
regions between siblings differing by one placement, and those jumps were noise with respect to the
outcome. As a standalone ablation on the frozen v12 it measures **+0.96 [0.57, 1.37]** — the first
of twelve hand-set changes to improve the engine.

**That closed the evaluation. It did not close the engine — the search was giving the gains back.**

| tuned v12 + fractional ties, vs v11 | advantage | 95% CI |
| --- | --- | --- |
| eval level (greedy, no tree), 400 seeds | −0.15 | [−0.54, 0.24] |
| search level (300 iterations), 100 seeds | **−3.98** | [−4.91, −3.04] |

An earlier draft asserted that "the entire deficit is in the evaluation". That was read off a
25-seed run with a ±2.5 interval; the report's author flagged it as unestablished and asked for 100
seeds, and at 100 seeds it is false.

The cause turned out to be §6's playout truncation, and it is the largest single effect in the whole
investigation (§8.11). Truncating at ~12 plies costs about **5.7 points** against playing the
rollout out; §2.2 argues playouts are informative "because the scoring rule is simple" and then
discards precisely that. With full-length playouts and the two evaluation fixes, the combined
candidate reaches:

| candidate vs v11 | advantage | 95% CI |
| --- | --- | --- |
| eval level, 400 seeds | −0.15 | [−0.54, 0.24] |
| **search level, 200 held-out seeds** | **−0.55** | **[−1.32, 0.20]** |

(The candidate is **three** changes — tuned evaluation, fractional Voronoi ties, full-length
playouts. A fourth, 4-corner playout sampling, was worth +0.75 under truncation and is worth nothing
once playouts run to the end; see §8.13.)

**Parity at both levels — and then withdrawn.** The incumbent's own rollout truncation (24 plies,
hard-coded) had never been exposed as a parameter. Giving it the same fix is worth **+6.93 [4.74,
9.17]**, and the two corrected engines meet at **−4.45 [−5.89, −2.97]** in the incumbent's favour.
The parity was measured against an opponent carrying a handicap this engine had just removed.** The final accounting appears in §8.12. The single pattern that
holds across all of it: **every gain came from changing what something computes; nothing came from
changing what anything is worth.**

Every claim below carries an evidence class.

| Tag | Meaning |
| --- | --- |
| `MEASURED` | A number from this repo, with the artifact. |
| `PRIOR` | Measured here before v12 existed. |
| `STRUCTURAL` | Provable by reading the code; no experiment needed. |
| `REFUTED` | Was a hypothesis in draft 1; measured and found false. |

---

## 1. What actually happened

`MEASURED` Two paired runs, seat-rotated, mcts-bench / 300 iterations, 25 seeds × 4 seats, on the
same seeds eight minutes apart (`selfplay-results/match-2026-08-17T02-30-23-133Z-summary.txt`,
`…02-22-34-339Z-…`):

| | Advantage vs v4 | 95% CI | First place | Mean score |
| --- | --- | --- | --- | --- |
| v11 | **+7.34** | [4.64, 9.95] | 46.0% | −7.39 |
| v12 | +1.90 | [−0.67, 4.31] | 32.0% | −11.87 |

`MEASURED` Both determinism gates now pass, so these numbers are trustworthy and the paired
comparison is valid:

```
v12 vs v12, greedy,     20 seeds → -0.00 [-0.00, 0.00]
v12 vs v12, mcts-bench, 10 seeds →  0.00 [-0.00, 0.00]
```

The greedy gate alone would not have been enough: `rankMovesGreedyV12` never touches the tree and
never draws from the RNG, so it is deterministic by construction. The mcts-bench gate is the one
that validates the +1.90.

---

## 2. The explanation that survived

`MEASURED` At **eval level** — the greedy policy, which uses the evaluation directly with no tree, so
this isolates `E_i` — 400 seeds / 1600 games each:

| Pair | Advantage | 95% CI | First place |
| --- | --- | --- | --- |
| v11 vs v4 | +5.40 | [4.92, 5.89] | 51.8% |
| **v12 vs v4** | **+2.18** | **[1.78, 2.58]** | 36.3% |
| v10 vs v4 | +1.20 | [0.81, 1.59] | 33.8% |
| **v12 vs v11** | **−2.84** | **[−3.23, −2.46]** | 17.3% |

Three things follow.

**2.1 The report's evaluation is good.** v12 beats v4 by +2.18, and beats the previous *hand-designed*
evaluation (v10, +1.20) with non-overlapping intervals. As a piece of hand design it is the best in
the repo's history.

**2.2 The whole gap is the evaluation, and it is fully resolved.** v12 vs v11 at eval level is
−2.84 [−3.23, −2.46]. The additivity check holds: 2.18 − 5.40 = −3.22 against a measured −2.84. The
search-level gap (+1.90 vs +7.34, both with wide intervals) is consistent with the eval-level gap
alone. There is no evidence that v12's *architecture* costs anything.

**2.3 Tuning is worth a lot, but not enough.** `PRIOR` `tuning/cem-eval-run.log`: base v10, 20
generations × 2304 games, best-generation fitness 4.00 → 7.06. Its output is v11. Same structure,
same features, only the numbers changed: **+1.20 → +5.40**.

`MEASURED` The same treatment was then applied to v12 — base v12, reference v11, space `v12-eval`
(66 parameters), population 24, 20 generations, 2304 games each
(`tuning/tune-2026-08-17T03-48-51-737Z.jsonl`):

```
gen 1   best −1.50   elite −2.16   pop −3.35
gen 9   best +0.14   elite −0.64   pop −1.89     first crossing of zero
gen 12  best +1.16   elite +0.42   pop −0.78     peak
gen 19  best +0.93   elite +0.42   pop −0.41
gen 20  best +0.19   elite +0.01   pop −0.85
```

**Held out on clean seeds (400 seeds, base 7777777), the winner scored −1.12 [−1.52, −0.70] against
v11 — still significantly worse.**

Two things follow, and both matter more than the headline.

*Tuning bought +1.72 of the ~2.8-point gap* (−2.84 → −1.12), well resolved. It is a large effect and
it is not the whole effect. **About 1.1 points are structural and remain unexplained.**

*Generation-best fitness overstated the result by 2.3 points* (+1.16 reported, −1.12 held out). This
is the selection bias the repo's promote rule exists to catch, caught in the act.

**2.4 `MEASURED` A protocol defect found on the way: the documented held-out seed base was not held
out.** The tuner draws generation `g`'s seeds from `g · 100_000 + i`, so `--seed-base 900000` — the
base the README prescribed and the base v11's own holdout validation used — overlaps generation 9.
24 of those 400 seeds were seeds the tuner had optimised on.

Re-running v11 vs v4 on genuinely clean seeds gives **+5.77 [5.29, 6.24]** against the contaminated
**+5.40 [4.92, 5.89]** — slightly *higher*, so the contamination was real but immaterial, and v11's
standing is unaffected. Fixed in the README and annotated in `scripts/tune.ts`.

---

## 3. Seven hypotheses, measured

Each ablation changes exactly one axis and is measured **against v12 itself**, so the effect is read
directly rather than through a two-step difference. Eval-level runs are 400 seeds / 1600 games;
search-level are 100 seeds / 400 games.

| # | Hypothesis from draft 1 | Ablation | Result | Verdict |
| --- | --- | --- | --- | --- |
| 3.1 | Margin should be taken against the mean of opponents, not the best | `v12-mean` | +0.52 [−0.21, 1.31] | null |
| 3.1b | The rank blend costs score; the standing shift should be off | `v12-margin` | −0.08 [−1.03, 0.87] | null |
| 3.2 | A truncated leaf needs a material anchor, as v4/v11 have | `v12-material` | **−1.25 [−2.02, −0.49]** | `REFUTED` — but see §8.13, this result is regime-dependent |
| 3.3 | `E_i` should include opponent material | `v12-oppsquares` | +0.35 [−0.62, 1.29] | null |
| 3.4 | The per-region sqrt corner transform flattens the best feature | `v12-lincorners` | **−1.33 [−1.70, −0.95]** | `REFUTED` |
| 3.5 | The waste term degenerates into a harmful perimeter penalty | `v12-nowaste` | **−0.59 [−0.90, −0.28]** | `REFUTED` |
| 3.6 | The funnel deletes the cut moves Δsplit exists to find | `v12-cutaware` | +0.24 [−0.50, 0.98] | null |
| — | All of the above at once | `v13` | −0.44 [−1.17, 0.34] | null |

**Not one improved v12.** Three made it significantly worse.

### The three refutations, and what they teach

**3.4 The sqrt corner transform is worth +1.33.** Draft 1 argued that since the board is one region
for most of the game, `f(C) = √|C|` merely squashes the most predictive feature, cutting the marginal
corner from 1.00 to 0.16 at ten corners. The arithmetic is correct and the conclusion was wrong.
Concavity is apparently the point: it stops the evaluation from chasing an eleventh corner in a
region where it already has ten, which is exactly the behaviour §3.1 was reaching for. `STRUCTURAL`
observation upheld, `REFUTED` implication.

**3.5 The waste term is worth +0.59, and it works *through* the degeneracy.** Draft 1 noted that with
the monomino held — which the report itself recommends — `smallestRemaining` is 1 all game and waste
collapses to `|T_i ∩ own edge halo|`, i.e. own frontier length, which correlates with corner count.
That is exactly what the code does. It is also, measurably, a useful feature: those cells are ones
the colour has permanently sealed off from itself, and counting them is worth more than the corner
correlation costs.

**3.2 A material anchor at truncated leaves costs 1.25 points — the opposite of the prediction.**
This is the most interesting result of the set. `PRIOR` v9 moved v4's `materialBlend` from 0.6 to
0.45 and was the worst challenger of its batch; draft 1 read that as "material anchoring is load
bearing" and noted v12 has none. But adding a 60% anchor to v12 makes it significantly *worse*.

The resolution is that **the leaf blend is not a constant of the domain — it is a function of how
good the positional evaluation is.** v4's evaluation is weak, so its truncated leaves need the actual
score to stay honest. v12's evaluation is strong enough (+2.18 over v4) that replacing 60% of the
leaf value with a raw score margin throws away more information than it adds. v9 and this run are the
same lesson approached from opposite ends.

### The one invalid test, kept as a self-check

`v12-oppsquares` was first run at eval level and returned **−0.02 [−0.06, 0.01]** — a suspiciously
tight interval. The reason is structural: under the greedy policy a move is ranked by
`E_after − E_before` for the mover, and placing a piece does not change opponents' `placedSquares`,
so the term cancels exactly in the difference. The ±0.03 residual is the second-order effect of
`context.leader` flipping. Re-run at search level it is +0.35 [−0.62, 1.29], still null.

This is the same kind of protocol self-check as `v10f-endgame`'s +0.01: a change that cannot
mechanically affect the decision must measure ≈ 0, and it does.

### Ablations do not compose

`v13` bundles the three significantly-harmful changes plus four nulls. Additivity predicts
−1.25 − 1.33 − 0.59 ≈ **−3.2**; it measured **−0.44 [−1.17, 0.34]**. The components partly cancel —
removing the waste penalty and rescaling the corner weights compensate each other through the overall
balance of `E`. Single-axis results describe the neighbourhood of v12, not a decomposable sum.

---

## 4. What the report got right

- `MEASURED` **The diminishing-returns corner transform** (§3.1): +1.33.
- `MEASURED` **The waste term** (§3.2): +0.59.
- `MEASURED` **Reading `E_i` alone at a truncated leaf** (§2.2): the alternative costs 1.25.
- `MEASURED` **The evaluation as a whole**: +2.18 over v4 at eval level, the best hand-designed
  evaluation in this repo's history, beating the previous one (v10, +1.20) with non-overlapping
  intervals.
- `MEASURED` **The bitboard representation**: ~20% cheaper per move than v11 at equal iterations
  (6.2 min vs 7.8 min per 100 games at 300 iterations), and ~1.8× faster than v4 at the greedy
  policy (185,000 games/hr against the ~65,000 in the docs).
- `MEASURED` **The move generator**: verified against the legacy generator move-for-move over ~150
  positions and >10,000 moves. §8's instruction — build the bitboard generator with a slow reference
  beside it — was the most valuable sentence in the report and caught two real bugs during
  construction.
- `PRIOR` **The phase schedule** (`v10d-phase`, +1.02).

---

## 5. What still stands against the report

Only three items survive, and none of them is a design error.

**5.1 `MEASURED` It says nothing about where strength comes from.** The measurement record is
consistent: evaluation weights decide outcomes, architecture does not. v11's eval-level advantage
(+5.40) is its search-level advantage (+5.50). `v10b-puct` −1.03, `v10c-widen` +1.96 (n.s.),
`v10f-endgame` +0.01. Sections 2 and 6 of the report — algorithm selection and architecture — are
~60% of its length; the weights appear as one subordinate clause, *"tuned by self-play or CMA-ES"*.
The report should say that the clause is the product and budget its own length accordingly.

**5.2 `STRUCTURAL` §7's oracle definition measures self-consistency, not quality.** "A long-time
control run of *the same engine* as an oracle" makes each engine its own judge, so losses are not
comparable across versions. Fixed in `scripts/oracleLoss.ts` with `--common-oracle`.

**5.3 `STRUCTURAL` No cost model anywhere.** Every recommendation is written as though the budget
were unbounded, and the measurements run at 300 iterations per move. This is a real gap even though
the funnel it forced turned out not to cost anything (`v12-cutaware`, +0.24 n.s.): the report should
state each feature's cost per iteration and share of a realistic budget.

### Defects, unchanged by any of this

**C1 `STRUCTURAL` `objectiveBlend` overrides its own base.** `objectiveBlend(0, −20) = 1.0`: setting
`rankBlend: 0` becomes *pure rank* once 20 squares behind. Genuinely wrong, now switchable — but
turning it off measures null (`v12-margin`, −0.08), so it is a correctness wart, not a strength bug.

**C2 `MEASURED` The old cost claim had no artifact.** "316 ms vs 371 ms" came from one smoke game
each; replaced with the wall-clock figures above.

---

## 6. What this episode says about the method

The first draft of this document did to the report exactly what the report did to Blokus: it produced
six confident, internally coherent, mechanism-level explanations from reading and reasoning, wrote
them in the voice of findings, and was wrong about all six. Three of the "problems" were load-bearing
features whose removal cost more than a point each.

Two things made the difference, and both are cheap:

1. **Parameterising before arguing.** Every criticism was turned into a config flag defaulting to
   current behaviour. That converted forty minutes of prose into forty minutes of measurement.
2. **Measuring against the thing being criticised**, not against a distant baseline. `X vs v12`
   reads the effect of X directly; `X vs v4` would have buried each one inside a three-point
   difference.

The lesson generalises to the report's revision: **a design document for this domain should ship its
claims as ablations, not as assertions.** Anything that cannot be stated as "config flag F, default
D, measured effect E" is not yet a recommendation.

---

## 7. Revision directives for report v4

Draft 1 proposed twelve changes. Nine are withdrawn as refuted or unsupported. What remains:

| # | Section | Change |
| --- | --- | --- |
| 5.1 | new §0 | State that evaluation weights decide strength and architecture does not, with the measurement table. Budget the document's length accordingly. |
| 5.3 | new §0 | Add a cost model: per-feature cost per iteration and share of a 300-iteration budget. |
| 5.2 | §7 | Specify a common oracle for cross-version comparison; note the self-oracle measures search stability. |
| 2.3 | §8 | Name the incumbent, demand single-axis ablations against it, and state that **an untuned engine must not be compared with a tuned one** — that comparison is worth ~4 points here and will dominate any structural effect. |
| 6 | §8 | Require every recommendation to be expressed as a parameter with a default and a named ablation. |
| 3.2 | §2.2 | Record that the leaf material blend depends on the quality of the positional evaluation — v4 needs 0.6, v12 is hurt by it — rather than being a domain constant. |
| — | §3.1, §3.2 | **Keep the sqrt corner transform and the waste term, and cite their measured values** (+1.33, +0.59). Note that the waste term operates through the monomino-held case, which is the common one. |
| — | §4.3 | Demote the endgame section. `v10f-endgame` +0.01 [−0.00, 0.03]; its length is out of proportion to its measured value. |
| — | §5 | Seat conditioning is a tuning axis, not design-time constants (`v10e-seat`, −0.10). |

---

## 8. The residual ~1 point — three candidates, all now tested, none supported

Tuning explained +1.72 of the ~2.8-point gap. The report's author reviewed the findings above and
ranked three explanations for the rest. All three have now been measured. **None of them accounts
for it.**

| Candidate | Test | Result |
| --- | --- | --- |
| Fit is under-powered | Refit with 4× seeds per candidate, seat dimension dropped (46 params) | **−1.01 [−1.44, −0.59]** vs the noisy fit's −1.12. No change. `REFUTED` |
| `E_i` is missing v11's features | Implement `mobility` and `uniqueCorners`, add to the space, refit (52 params, 16 generations) | **−0.86 [−1.24, −0.47]**, overlapping. The fit drove `uniqueCorners` to 0.00–0.13 and `mobility` small with inconsistent sign. `REFUTED` |
| — the same question, independently | Partial rank correlation of each feature with the final margin, controlling for `E_i` | `uniqueLiberties` **+0.012**, `mobility` **−0.015** over 12,864 positions. No incremental signal. `REFUTED` |
| Design choices in §§3–5 | Seven single-axis ablations | Three significantly harmful, four null. `REFUTED` |

**8.1 The fitter is not the constraint.** Quadrupling samples per candidate (24 → 96 seeds) and
removing 20 seat dimensions produced a held-out result statistically identical to the noisy fit. The
run also validated the framework: selection bias fell from 2.3 points to ~1.0, the 1/√n scaling.
**The fit converges to ≈ −1.0 regardless of budget.**

**8.2 The missing features do not recover it, by two independent methods.** `STRUCTURAL` §3.1 names
legal move count and frontier pressure; §3.2's `E_i` omits both. Both are now implemented —
`mobility` as v11's `|C| + 2·pieces` proxy, `uniqueCorners` as corners no opponent also holds —
defaulting to weight 0. At guessed weights they measure **−0.91 [−1.32, −0.50]**; fitted over 16
generations, **−0.86 [−1.24, −0.47]**, indistinguishable from the fit without them. Generation 13
remained the peak and the fit given free rein set `uniqueCorners` to 0.00–0.13.

The position-level diagnostic (§8.5) reaches the same conclusion from an entirely different
direction: conditional on `E_i`, `uniqueLiberties` adds **+0.012** and `mobility` **−0.015** of rank
correlation with the eventual margin over 12,864 positions. They carry no signal `E_i` lacks.

**8.5 The finding that reframes the question: `E_i` is the *better* predictor.**
`MEASURED` `scripts/evalQuality.ts`, 12,864 positions drawn from games generated by both engines
(sampling from only one engine's play would favour that engine's evaluation). Spearman correlation
of each evaluation with the margin the game actually ended on:

| | all | opening | midgame | endgame |
| --- | --- | --- | --- | --- |
| v11 evaluation | 0.444 | **0.227** | 0.388 | 0.861 |
| v12 `E_i` (vs mean) | **0.494** | 0.196 | **0.423** | **0.887** |

**v12's evaluation ranks positions better than v11's** — overall and in both the mid-game and
endgame — and still loses by a point in play.

That is not a contradiction, it is a localisation. Correlation over a pooled sample measures the
ranking of *unrelated* positions; play depends on ranking *siblings*, the successors of one node. An
evaluation can be globally well-calibrated and still discriminate poorly among the twenty moves
actually available at a node, and only the second thing decides games. **The remaining deficit is
therefore most likely in sibling discrimination, which none of the three candidates addressed and no
measurement here has yet probed.**

Two calibration faults the same diagnostic exposes, both about weights rather than features
(partial correlation with the outcome, controlling for `E_i` — near zero means `E_i` already knows
it):

- **`waste` is mis-scheduled across phases:** −0.157 in the mid-game (still predicts worse outcomes
  given `E_i`, so it is *under*-weighted there) and +0.138 in the endgame (*over*-weighted). CEM
  moved mid-game waste 0.35 → 0.55, the right direction, and left the endgame at 0.91.
- **`f(C)` is under-weighted in the mid-game** (+0.114).

v11's evaluation as a whole retains +0.065 incremental over `E_i` (+0.121 opening, +0.178 endgame),
so it does know something — but demonstrably not through unique liberties or mobility.

*Caveat:* the four seats of a position, and positions within a game, are correlated observations.
These rank features; they are not significance tests.

**8.6 Within-node variance: the two evaluations decide moves by different things.**
`MEASURED` `scripts/siblingVariance.ts`, 941 nodes, up to 32 sampled legal children each, using the
*tuned* v12 parameters. For each node every child is scored and each component's standard deviation
across siblings is taken as a share of the total's — i.e. how much of the actual decision each term
is doing. A term that barely varies across siblings cannot affect play whatever its weight, and its
weight is unidentifiable to a play-based tuner.

| share of sibling spread | v12 all | v11 all | v12 endgame | v11 endgame |
| --- | --- | --- | --- | --- |
| material (`a·S` / placed+remaining) | 0.373 | **0.641** | 0.224 | **0.715** |
| corners | 0.277 | 0.239 | 0.354 | 0.263 |
| territory | 0.313 | 0.135 | 0.370 | 0.089 |
| waste | 0.318 | — | **0.862** | — |
| reachable area | — | 0.175 | — | 0.349 |
| centre | 0.116 | 0.209 | 0.015 | 0.017 |

**v11 ranks siblings primarily by material; v12 does not.** v12's material share is roughly half
v11's, and in the endgame it falls to 0.224 while `waste` carries 0.862 — in the phase where the
game is exactly "place as many squares as you can", v12 chooses moves mostly by minimising its own
frontier.

That looked like the mechanism, and it is not. Cutting endgame waste on the tuned config from 0.835
to 0.55 and to 0.30, measured against that same tuned config over 1600 games each:

| | advantage | 95% CI |
| --- | --- | --- |
| endgame waste → 0.55 | +0.08 | [−0.01, 0.17] |
| endgame waste → 0.30 | +0.04 | [−0.06, 0.14] |

Both null, with intervals of ±0.1 — the two configs play almost identically. A term that *dominates*
an ordering is precisely one whose weight cannot reorder anything, so its share being large and its
weight being irrelevant are the same fact. The endgame is not where the point is lost.

The packability proxies the report's author proposed were also tested here as unweighted candidates,
by sibling coefficient of variation: **0.49 in the opening but 0.07 in the endgame.** They barely
distinguish endgame siblings at all, so packability cannot be the endgame fix either.

**8.8 The one that worked: fractional Voronoi ties.** `MEASURED` The report's author proposed it as
a smoothing fix to be applied regardless of what else was found, on the grounds that winner-take-all
tie resolution makes |T_i| jump by whole regions between siblings that differ by one placement, and
that those jumps are noise with respect to the outcome. `owner` still records the tempo winner
(the waste term needs a definite owner per cell); only the *counts* are split.

| | advantage | 95% CI |
| --- | --- | --- |
| `v12-fracties` vs frozen `v12` | **+0.96** | [0.57, 1.37] |
| tuned v12 + fractional ties, vs v11 | **−0.15** | [−0.54, 0.24] |

The first is the only one of twelve hand-set changes to improve the engine; the second closes the
residual — v12 is no longer significantly worse than v11 at eval level.

**Worth recording how nearly this was missed.** The first run of the ablation returned
`−0.00 [−0.00, 0.00]`, a *zero-width* interval. That is the mirror-match signature: the two configs
played byte-identical games. A genuine null shows variance, so an exactly-zero result is not a
finding, it is evidence that the change never reached the code path. It hadn't — `deepScore`
evaluates every candidate through a separate scratch `EvalContext` that had not been given the flag,
so the new territory rule applied only to the baseline term and cancelled out of
`E_after − E_before`. With ten prior nulls in a row it would have been very easy to file this as an
eleventh.

**8.9 A methodology fault of my own: parameters were fitted under a policy that cannot read them.**
`v12-eval` was made to include the four leaf-value parameters (`sigmoidScale`, `evalScale`,
`rankBlend`, `leafMaterialBlend`) on the stated grounds that "a tune of the evaluation that cannot
touch the leaf's value shaping is optimising a scoreboard the search never reads". That is exactly
backwards. All the fitting was done at the **greedy** policy, where `rankMovesGreedyV12` ranks by
`ΔE` and never calls the backup at all — so those four have no effect on fitness and drifted freely
under selection noise:

| | default | after fitting |
| --- | --- | --- |
| `sigmoidScale` | 12 | 19.56 |
| `evalScale` | 28 | 35.21 |
| `rankBlend` | 0.35 | 0.343 |
| `leafMaterialBlend` | 0 | 0.041 |

Both scales inflated, which flattens the leaf value function and leaves PUCT following its prior.
Restoring the four to defaults and re-measuring at search level gives **−2.81 [−4.25, −1.39]**
against the drifted config's −3.98 [−4.91, −3.04]: nominally better by ~1.2, but the intervals
overlap heavily, so **the drift is not established as the cause and at most explains part of it.**

Note also that restoring the *defaults* is not obviously right either. Tuning raised E's magnitude
(mid-game `squares` 1.40 → 2.38 among others), so the evalScale appropriate to the tuned E is
probably larger than the one calibrated against the untuned E. Neither 28 nor 35.2 has ever been
measured against the thing it controls. **Leaf-value scaling has to be fitted at `mcts-bench`, and
never has been.**

The practical consequence for everything above: **eval-level results in this document stand;
search-level results for any fitted config do not**, because every fitted config carries
randomly-walked tree parameters.

**8.10 Is the leaf scale the lever? Probably not — partial evidence.** `evalScale` was swept at
search level against v11, on the tuned + fractional-ties config with the other three leaf parameters
held at defaults. The sweep was stopped after two of four points, so this is incomplete:

| `evalScale` | advantage vs v11 | 95% CI |
| --- | --- | --- |
| 20 | −4.31 | [−5.34, −3.32] |
| **28** (default) | **−2.81** | [−4.25, −1.39] |
| 40, 55 | not measured | |

Going from 20 to 28 gains +1.50, so the scale is not irrelevant — but the intervals overlap, and the
drifted configuration at 35.2 measured −3.98, *worse* than 28 (though it also differed in the other
three leaf parameters, so it is not a clean comparison). Taken together the two clean points lean
toward **the default being roughly right rather than badly mis-calibrated**, which would mean the
~3 points the tree costs are not in the leaf scale.

That is the reason the sweep was run before the fit rather than after. A four-parameter CEM at
`mcts-bench` inside any realistic budget forces ~8 seeds per candidate — a fitness standard error
around 1.7 points on effects of ~1 point, under-powered by construction in exactly the way §8.1
already diagnosed once. If the optimum sits near the default, that fit would have spent four hours
establishing it.

### The tree, not the evaluation, is the open problem

The evaluation is at parity with v11 (−0.15 [−0.54, 0.24]) and the search gives back ~3 points.
Three mechanisms are untested and none of them is a weight, which matters given that eleven of
twelve reweightings measured null and the one recomputation worked:

- **The playout policy samples a single open corner per ply** and enumerates only placements covering
  it, so it cannot compare a move at one corner against a move at another. This was chosen to avoid
  the spatial bias of capping a full generation; the cost is a much weaker simulation policy than
  v4/v11's, which rank the top few of a capped legal set.
- **Playouts truncate at 12 plies** — three moves per seat — and then read `E_i`. Whether that is
  long enough for the material consequences of a placement to appear has never been measured.
- **Interior nodes shortlist 24 moves** out of several hundred, chosen by a cheap size/centre filter
  before the real ordering runs. The root uses 40 with the full ordering.

Each is a single-axis ablation at a fraction of a fit's cost, and each is a statement about *what
the search computes* rather than what its terms are worth.

**8.11 All three were tested. The second one is the largest effect in the investigation.**
`MEASURED` Single-axis ablations against the frozen `v12`, mcts-bench at 300 iterations, 200 seeds /
800 games each:

| Ablation | advantage vs v12 | 95% CI |
| --- | --- | --- |
| `v12-deep` — truncate playouts at 24 plies, not 12 | **+3.57** | [2.85, 4.31] |
| `v12-corners4` — pool playout candidates from 4 open corners, not 1 | **+0.75** | [0.09, 1.42] |
| `v12-wide` — interior shortlist 48 moves, not 24 | +0.21 | [−0.44, 0.85] |

Sweeping the truncation depth shows it is not a tuning nicety but a first-order design error:

| `playoutCutoff` | advantage vs v12 | 95% CI | first place |
| --- | --- | --- | --- |
| 12 (§6's "~12 plies") | — | baseline | 25% |
| 18 | +1.29 | [0.65, 1.92] | 34.3% |
| 24 | +3.57 | [2.85, 4.31] | 45.0% |
| 36 | +5.13 | [4.45, 5.86] | 50.0% |
| 48 | +4.89 | [4.28, 5.50] | 46.9% |
| **84 (no truncation)** | **+5.71** | [5.05, 6.35] | **52.1%** |

**Playing the rollout to the end is worth about 5.7 points.** §2.2 argues that "random playouts in
Blokus are informative because the scoring rule is simple" and then prescribes truncating them at
~12 plies and reading a heuristic instead — which discards precisely the informativeness the same
paragraph claims. Twelve plies is three moves per seat, far too few for the material consequences of
a placement to appear. The early-termination citation (Lorentz, on Amazons and Breakthrough) does
not transfer: those are games where a rollout is long and an evaluation is cheap. Blokus rollouts are
bounded at 84 plies and, on bitboards, cost less than the evaluation they were being truncated for.

**8.12 The gap closes at both levels.** Combining the tuned evaluation, the fractional Voronoi
tie-break, full-length playouts and 4-corner playout sampling (`tuning/v14.json`):

| vs v11 | advantage | 95% CI | first place |
| --- | --- | --- | --- |
| eval level, 400 seeds | −0.15 | [−0.54, 0.24] | — |
| search level, 48 seeds | −0.16 | [−1.47, 1.17] | 34.4% |
| **search level, 200 held-out seeds (confirmation)** | **−0.55** | **[−1.32, 0.20]** | **30.8%** |

against −3.98 for the same evaluation with the report's search parameters.

**Confirmed at 200 held-out seeds: parity, not a promotion.** The interval now resolves to ±0.76 and
still spans zero, with the point estimate slightly negative. First place is 30.8% against a par of
25%, but first-place rate is not the promote statistic. **v11 remains champion**; the candidate is a
second engine of champion strength reached by a completely different route.

The final accounting of the original −2.84 eval-level and ~−4 search-level deficit:

| | worth |
| --- | --- |
| CEM tuning of the evaluation weights | +1.83 |
| Fractional Voronoi tie-break (how territory is *counted*) | +0.86 |
| Full-length playouts (how the leaf is *estimated*) | ~+3 to +5.7 |
| 4-corner playout sampling | +0.75 under truncation, **0 under full playouts** (§8.13) |
| Everything else tried — 11 reweightings, 2 feature additions, 3 fit variants | 0 |

**8.7 Eleven consecutive hand-set changes to `E_i` measured null or negative — and then one did not.** Seven ablations,
the guessed-weight feature addition, `v13`, and the two endgame-waste cuts. The tuned configuration
sits at a local optimum that *reweighting* cannot improve — and the change that finally worked was
not a reweighting. It altered how a feature is *computed*, leaving every weight alone.

That is the lesson worth carrying into the report's revision. Eleven attempts to move v12 by
changing what its terms are worth all failed; one attempt to change what a term *measures*
succeeded immediately. The sibling-variance and partial-correlation diagnostics were pointing at
weights, and weights were the wrong target the whole time.

**8.3 The symptom moved as the fits improved, and that is the most informative thing here.**

| | leftover gap vs v11 | piece-size lag |
| --- | --- | --- |
| v12 untuned | 2.57 sq | −0.43 @ k=10–11, extending to k=14, overhang at k=16–19 |
| v12 tuned (noisy) | 1.61 sq | −0.35 @ k=11, confined to k=9–12 |
| v12 tuned (low-noise) | 0.96 sq | −0.20 @ k=11 |

At every stage the held-out deficit tracks the leftover-squares gap almost exactly (−1.12 vs 1.61;
−1.01 vs 0.96). But the piece-size schedule has now essentially converged to v11's while the gap
persists. So v12 is **not** holding large pieces too long — it is placing pieces of the right size
into configurations it cannot finish. That is a shape-compatibility failure, and neither of the two
features that most directly measure shape compatibility recovered it when fitted.

**8.4 Nine consecutive hand-set changes to `E_i` have measured negative or null.** Seven ablations,
the guessed-weight feature addition, and `v13`. That is not nine unlucky guesses: the evaluation sits
at a local optimum where hand perturbation is reliably harmful. It is also why every remaining
question has to be settled by refitting rather than by ablation.

### What has not been tried

- **Sibling discrimination.** The lead §8.5 opens, and now the most promising: for each position,
  rank its legal successors by each evaluation and compare against a long-budget oracle's ordering.
  `scripts/oracleLoss.ts` already has the machinery. If v12's *global* calibration is better while
  its *sibling* ordering is worse, that is the whole story and it is a statement about the shape of
  `E_i` near a decision, not about which features it contains.
- **Re-fitting with the calibration faults §8.5 names** — mid-game waste and `f(C)` up, endgame
  waste down — as a targeted prior on the fit rather than letting CEM rediscover them from scratch.
- **A joint fit over the union of both feature sets.** What was tested was *adding* two v11-style
  proxies to v12's `E_i`. The author's stronger proposal — fit over the union of v11's ten features
  and v12's under one protocol — would settle whether the fitting procedure is the ceiling for
  *both* engines, which would reframe v11's +5.77 as much as v12's −1.0.
- **Search-level v12 vs v11 at ≥100 seeds.** Still only the 25-seed run exists. The search-level gap
  (≈5.4) is nominally larger than the eval-level gap (2.84); at those intervals that is about 1.4
  standard errors, so "the whole deficit is in the evaluation" is a reasonable reading but not an
  established one. If the search-level gap really is larger, the prior or leaf calibration is
  amplifying an evaluation error.
- **Whether the residual is in `E_i`'s *structure* rather than its feature list** — the Voronoi
  metric itself, the discrete phase detector, or the λ parameterisation.

### Earlier draft, superseded

The two candidates below were written before either was measured. Both are now in the table above;
the text is kept only so the sequence of reasoning stays legible.

**8.1 The tune may simply be under-converged.** `v12-eval` is **66 parameters** against the 33 that
produced v11, run at the same population (24) and generation count (20) — half the samples per
dimension, with an elite of 6 estimating a 66-dimensional mean. The trajectory supports this: the
population mean was still climbing at the end (−3.35 at g1 → −0.41 at g19) and had not plateaued.

```bash
# more samples per dimension
npm run tune -- --base v12 --champion v11 --space v12-eval --population 48 --generations 30
# or tune subspaces in sequence, which is what 66 dimensions actually wants
npm run tune -- --base v12 --champion v11 --space v12-weights --generations 15
npm run tune -- --base <result> --champion v11 --space v12-lambda --generations 15
```

**8.2 v12 may be missing features v11 has.** `STRUCTURAL` v11's evaluation carries `mobility`
(tuned weight 1.01), `uniqueLiberties` (0.86) and `reachableArea` (0.19 late). v12's `E_i` has **no
counterpart to any of them**. It has no mobility term at all — and although `exclusiveReach` exists
in `src/ai/v12/territory.ts` (cells only this seat can reach, the direct analogue of
`uniqueLiberties`) **it is computed and never used in the evaluation**. The report's §3 does not
include these features.

That is a fact about the code. Whether adding them recovers 1.1 points is a hypothesis, and the
experiment is one new phase weight plus one ablation.

### Secondary, in order of value

1. **Search-level v12 vs v11 at ≥100 seeds.** Only the 25-seed run exists; its ±2.5 interval is why
   the tree's contribution cannot be separated from noise for either engine.
2. **Oracle loss with a common oracle**, by phase, to localise where the residual is conceded:
   ```bash
   npm run oracle-loss -- --version v12 --common-oracle v11 --games 8 --oracle-iterations 3000
   npm run oracle-loss -- --version v11 --common-oracle v11 --games 8 --oracle-iterations 3000
   ```
3. **The remaining report ablations** (`v12-maxn`, `v12-nopack`, `v12-nosplit`, `v12-onephase`,
   `v12-noseat`), which test the report's own claims rather than this document's.

Report v4 should be written once §8.1 and §8.2 are settled. Writing it now would repeat the failure
described in §6 for a third time.

---

## 8.13 Which earlier results the truncation fix made stale

Moving `playoutCutoff` from 12 to 84 did not only improve the engine; it changed **which parameters
do anything at all**. Under truncation a leaf's value came from `E_i`. With full-length playouts
almost every playout reaches a terminal position, so leaf values come from **real final scores**.

Consequences for the record above:

| Parameter | Under 12-ply truncation | Under full playouts |
| --- | --- | --- |
| `evalScale` | shaped every leaf value | **nearly inert** — only non-terminal leaves |
| `leafMaterialBlend` | shaped every leaf value | **nearly inert** — same reason |
| `sigmoidScale` | terminal leaves only (rare) | **shapes every leaf value** |
| `rankBlend` | both | **shapes every leaf value** |

So:

- **§8.9's drifted-parameter problem largely dissolves.** Two of the four parameters that drifted are
  the two that full playouts make inert. That does not excuse fitting them under a policy that
  cannot read them — the tuner fix stands — but it means the drift is no longer a live explanation
  for anything.
- **§8.10's `evalScale` sweep measured a knob that barely applies any more.** Its two points are
  still valid *for the 12-ply regime* and should not be quoted for the current engine.
- **`v12-material` (−1.25) tested a parameter that is now inert.** The finding it supported — that
  the right material anchor depends on how good the positional evaluation is — was drawn from a
  regime where `E_i` *was* the leaf value. Under full playouts the question does not arise, because
  the leaf value is the score itself.
- **`v12-corners4` (+0.75) is regime-dependent too, and now measures nothing.** Removing corner
  pooling from the full-playout candidate costs **−0.10 [−0.62, 0.42]** over 800 games. Under
  truncation the leaf value was `E_i` reached by a short policy-driven walk, so the simulation
  policy's local quality fed straight into it; over ~80 plies to a real score, local policy errors
  average out. The promotion candidate drops it: three changes, not four.
- **`sigmoidScale` and `rankBlend` were never fitted at a policy that reads them** — and once tested
  there, both are null. Scale: 6 → −0.24 [−0.98, 0.51], 20 → +0.19 [−0.81, 1.22], 30 → −0.77
  [−1.56, 0.05] against the shipping 12. Rank blend: 0 → +0.28 [−0.35, 0.93] against 0.35. They do
  shape every leaf value under full playouts; the engine is simply not sensitive to them. That is a two-parameter space, which makes a CEM fit at
  `mcts-bench` affordable in a way the earlier four-parameter version was not.

The general lesson, and the one worth carrying into the report: **an ablation is only valid inside
the regime it was measured in.** Fifteen measurements in this document are sound; four of them
describe an engine configuration that no longer exists.
