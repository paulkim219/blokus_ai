# Brief for the author of `blokus_ai_research_report_v3.md`

*Paste this whole document as your prompt. It is self-contained — it assumes no access to the
codebase.*

---

## What I'm asking you

I implemented your report in full and measured it against the engine it was meant to replace. It
lost, but not for any of the reasons I predicted, and three of the design choices I doubted turned
out to be measurably load-bearing. About 1.1 points of the gap is still unexplained.

I want two things from you:

1. **Interpretation checks.** In several places the report is silent on a choice that turned out to
   matter, and I picked something. Tell me where I misread you — a wrong implementation is a much
   better explanation than a wrong design, and I'd rather find that first.
2. **Where to look next**, given the measurements below.

Please don't be diplomatic about the numbers. If you think the measurement is wrong, say so and say
why — that's a useful answer.

---

## The two engines

**v11 (incumbent, the one to beat).** A hand-designed linear evaluation over ten features — placed
squares, remaining penalty, corner access, mobility, opponent mobility, centre control, blocking,
unique liberties, Voronoi territory, reachable area — inside an MCTS with PUCT and a heuristic
prior. Its leaf value is `tanh((my score − mean of the other three) / 20) · 0.6 + tanh(eval / 60) ·
0.4`. Its **weights were fitted by cross-entropy-method self-play over ~46,000 games**; the same
structure with hand-guessed weights scored +1.20 and with fitted weights +5.77 against a common
baseline, so roughly +4.5 of its strength is the fitting, not the design.

**v12 (your report, implemented).** Bitboards with a precomputed placement table; multi-player MCTS
with a four-component max^n vector backup; value = sigmoid of score margin blended with a rank
component; Voronoi territory from a multi-source BFS with the turn-order tie-break; articulation
points via Tarjan with the Δsplit ordering term; the waste term; phase × seat weight vectors; the
exact sealed-region packer; DAG transpositions; ε-greedy playouts truncated at 12 plies onto `E_i`.

Formulation B (the ILP) and Layer 3 (the network) were not built. Everything else was. The move
generator is verified against an independent slow reference implementation, move-for-move, over
~150 positions and >10,000 moves.

---

## How it was measured

This matters, because a bad statistic is how the project wasted five earlier nights.

- **Seat-rotated.** For each seed the challenger plays each of the four seats in turn while the
  incumbent fills the other three. The statistic is `challenger score − mean of the three incumbent
  seats`, averaged over the four rotations. **Its null is exactly zero**: with two identical configs
  all four rotations are the same game and the advantages cancel.
- **Common random numbers.** Every stochastic choice is seeded, so two configs are compared on
  identical rollout luck.
- **Bootstrap 95% CI over seeds** (so n = number of seeds, not games).
- **Two policies.** `greedy` uses the evaluation directly with **no tree**, which isolates the
  evaluation; `mcts-bench` runs 300 MCTS iterations per move. Budgets are in iterations, not
  milliseconds, so results don't depend on machine load.
- **Determinism gates pass** for v12 at both policies (mirror matches print exactly 0.00).

---

## Results

### Headline

**Evaluation only, no tree** (400 seeds / 1600 games each):

| Pair | Advantage | 95% CI |
| --- | --- | --- |
| v11 vs baseline | +5.77 | [5.29, 6.24] |
| **v12 vs baseline** | **+2.18** | **[1.78, 2.58]** |
| previous hand-designed eval vs baseline | +1.20 | [0.81, 1.59] |
| **v12 vs v11** | **−2.84** | **[−3.23, −2.46]** |

**With search, 300 iterations/move** (25 seeds / 100 games):

| Pair | Advantage | 95% CI | First place |
| --- | --- | --- | --- |
| v11 vs baseline | +7.34 | [4.64, 9.95] | 46.0% |
| v12 vs baseline | +1.90 | [−0.67, 4.31] | 32.0% |

Two readings. **Your evaluation is the best hand-designed one this project has produced** — it beats
the previous hand-designed evaluation with non-overlapping intervals. And **the entire deficit is in
the evaluation**: the eval-level gap of −2.84 accounts for the search-level gap within the noise, so
there is no evidence your architecture costs anything.

The other visible symptom: v12 ends each game with about **4.5 more squares still in hand** than v11
(mean score −11.87 vs −7.39 on identical seeds).

### Ablations — I was wrong about all of them

I read the implementation, formed six mechanism-level criticisms, then turned each into a one-axis
config flag and measured it against v12 itself. Nothing improved it; three made it significantly
worse.

| Change tested | Effect vs v12 | 95% CI |
| --- | --- | --- |
| Linear corner count instead of your per-region `√corners` | **−1.33** | [−1.70, −0.95] |
| Add a 60% actual-score anchor to the truncated leaf (as v11 has) | **−1.25** | [−2.02, −0.49] |
| Remove the waste term | **−0.59** | [−0.90, −0.28] |
| All seven changes at once | −0.44 | [−1.17, 0.34] |
| Rank blend off, standing shift off (pure margin) | −0.08 | [−1.03, 0.87] |
| Reserve shortlist slots for cut / corner-denying moves | +0.24 | [−0.50, 0.98] |
| Add opponent material to `E_i` | +0.35 | [−0.62, 1.29] |
| Margin against the **mean** of opponents instead of the best | +0.52 | [−0.21, 1.31] |

So, measured positives for your report: **the diminishing-returns corner transform is worth +1.33**,
**the waste term is worth +0.59**, and **reading `E_i` alone at a truncated leaf is right** — adding
a raw-score anchor costs 1.25.

That last one seems to be a real principle: the leaf blend is a function of how good the positional
evaluation is. The weak incumbent baseline needs 0.6 of raw score to stay honest; your evaluation is
strong enough that diluting it loses information.

### Fitting your weights

Your §8 says every quantity is an untested hypothesis, so I ran the same CEM procedure that produced
v11: 66 parameters (phase weights, λ profiles, seat profiles, value scaling), population 24, 20
generations, 2304 games per generation, optimising directly against v11.

```
gen 1   best −1.50   population mean −3.35
gen 9   best +0.14   population mean −1.89
gen 12  best +1.16   population mean −0.78     ← peak
gen 20  best +0.19   population mean −0.85
```

**Held out on clean seeds: −1.12 [−1.52, −0.70].** Still significantly behind v11.

(The +1.16 was selection bias — best of 24 candidates on 24 seeds. The held-out number is 2.3 points
lower. Worth knowing if you ever quote a tuner's own fitness.)

So fitting bought **+1.72** of the 2.84-point gap, and **~1.1 points remain, significant and
unexplained**.

---

## Where I need you

### 1. Interpretation checks — where the report was silent and I had to choose

**a. The maximand.** §1 says the maximand is "ambiguous (win, rank, margin, or raw score)" and never
resolves it; §5 prescribes a rank/margin blend by standing. I implemented
`σ((s_i − max_{j≠i} s_j) / scale)` blended with rank. But the statistic this engine is *graded* on is
`score − mean(other three)`, and v11's leaf value happens to use exactly that. **What did you
intend — margin against the best opponent or against the field?** (Switching to the mean measured
+0.52 [−0.21, 1.31], so it isn't the answer, but I'd like to know whether I read you correctly.)

**b. Opponent material.** Your `E_i` weighs opponents by territory and corners only — there is no
`S_j` term, so the agent cannot see a rival out-placing it on squares. **Deliberate?** (Adding it:
+0.35, null.)

**c. The waste term with the monomino held.** §3.2 says to test whether "the smallest remaining
piece" fits. Your own §4.3 advice is to keep the monomino for the +5 bonus — so the smallest
remaining piece is size 1 for most of the game, and the test collapses to "cells orthogonally
adjacent to my own colour", i.e. own frontier length. **Is that the intended reading?** It measures
*positive* (+0.59), so if it is an accident it is a lucky one, and I'd like to know which.

**d. Δsplit's cost budget.** §3.1 calls it the term that "makes the search look at cut moves at all",
but scoring it needs a region relabelling per candidate, and the branching factor peaks in the high
hundreds. I could only afford it at the root, over a shortlist pre-filtered by piece size — which is
exactly the filter that removes small-piece cut moves. Making the shortlist cut-aware measured +0.24
(null). **What per-node budget did you have in mind, and at what iteration count?**

**e. The playout policy.** §6 says ε-greedy with "cheap domain knowledge", truncated at ~12 plies.
Generating the full legal set at every playout ply is unaffordable, so I sample one open corner
uniformly per ply and enumerate only placements covering it. That makes the policy unable to compare
across corners. **Is that what you'd do, or did you have something specific in mind?**

### 2. A structural gap I can't attribute

v11's evaluation carries three features yours has **no counterpart to**: `mobility` (fitted weight
1.01), `unique liberties` — empty cells that are a legal corner for me and for nobody else (0.86) —
and `reachable area` (0.19, late game only). Your §3 doesn't include them.

Was that a deliberate judgement that Voronoi territory subsumes them, or an oversight? Note that
territory and unique liberties are *not* the same quantity: territory is "cells closer to me than to
anyone", unique liberties is "cells only I can legally play into next".

### 3. Given all the above — where would you look for the residual 1.1?

My two candidates, neither tested:

- The fit is under-converged: 66 parameters at population 24 is half the samples-per-dimension that
  produced v11 from 33 parameters, and the population mean was still climbing at generation 20.
- The missing features in §2 above.

### 4. Which of your own recommendations do you now consider load-bearing?

Some large sections of the report measured at approximately zero in this project, across both
engines:

- **The exact endgame packer (§4.3).** Measured +0.01 [−0.00, 0.03] as a standalone change. Sealed
  regions appear rarely and late, and exact packing rarely differs from what the rollouts already
  find.
- **Seat-conditioned weights (§5)** as *guessed* constants: −0.10 [−0.36, 0.16].
- **PUCT with a heuristic prior**, as a standalone change on a weak evaluation: −1.03 [−3.74, 1.66].

Meanwhile the phase schedule (§4) measured +1.02 and is the clearest single design win in the
project's history.

If you were writing revision 4 with these numbers in front of you, **what would you cut, what would
you promote, and what would you add that isn't in revision 3 at all?**

### 5. Is there a measurement we should have run and didn't?

Available cheaply: anything at the evaluation level (1600 games in ~40 seconds), search-level matches
at 300 iterations (~4 minutes per 400 games), per-ply oracle-loss analysis against a long-time-control
reference, and further CEM fitting over any subset of the parameters.

---

# Round 2 — answers to your three hypotheses

All three of the candidates you ranked have now been measured. **None of them accounts for the
residual.** Same protocol throughout: eval level, 400 held-out seeds on a clean base, 1600 games.

## Your #1 — the fit is under-powered: refuted

Refit with 4× the seeds per candidate (24 → 96) and the seat dimension dropped, per your advice
(66 → 46 parameters).

| | held out vs v11 |
| --- | --- |
| original fit (24 seeds, 66 params) | −1.12 [−1.52, −0.70] |
| **low-noise fit (96 seeds, 46 params)** | **−1.01 [−1.44, −0.59]** |

Statistically identical. **The fit converges to ≈ −1.0 regardless of budget.** Your prediction about
selection bias was exactly right, though: it fell from 2.3 points to ~1.0, the 1/√n scaling.

## Your #2 — missing features: refuted twice, by independent methods

Implemented both as v11's proxies (`mobility` = |C| + 2·pieces, `uniqueCorners` = corners no
opponent also holds), defaulting to weight 0 so the frozen v12 is untouched.

- At guessed weights: **−0.91 [−1.32, −0.50]**.
- Fitted, 52 parameters, 16 generations: **−0.86 [−1.24, −0.47]** — indistinguishable from the fit
  without them. Given free rein the tuner set `uniqueCorners` to 0.00–0.13 and `mobility` small with
  inconsistent sign, rather than anything like v11's fitted 0.86 and 1.01.
- Position-level diagnostic, 12,864 positions: conditional on `E_i`, `uniqueLiberties` adds
  **+0.012** and `mobility` **−0.015** of rank correlation with the eventual margin.

## Your #3 — piece management: right about the symptom, and it moved

| | leftover gap vs v11 | piece-size lag |
| --- | --- | --- |
| v12 untuned | 2.57 sq | −0.43 @ k=10–11, extending to k=14 |
| v12 tuned (noisy) | 1.61 sq | −0.35 @ k=11 |
| v12 tuned (low-noise) | 0.96 sq | −0.20 @ k=11 |

The deficit tracks the leftover-squares gap almost exactly at every stage. But the size curve has
now converged to v11's while the gap persists — so v12 is **not** holding large pieces too long. It
places pieces of the right size into configurations it cannot finish.

## The result that reframes the question

Your position-level suggestion was the most valuable thing in your reply, and it produced the one
genuinely unexpected finding. Spearman correlation with the margin each game actually ended on,
12,864 positions sampled from games generated by *both* engines:

| | all | opening | midgame | endgame |
| --- | --- | --- | --- | --- |
| v11 evaluation | 0.444 | **0.227** | 0.388 | 0.861 |
| v12 `E_i` | **0.494** | 0.196 | **0.423** | **0.887** |

**v12's evaluation is the better predictor** — overall, mid-game and endgame — and still loses by a
point in play.

Our reading: pooled correlation measures the ranking of *unrelated* positions, while play depends on
ranking *siblings*. An evaluation can be globally well-calibrated and discriminate badly among the
twenty moves available at one node, and only the second decides games. If that is right, the
residual is a statement about the shape of `E_i` near a decision, not about its feature list — which
would explain why three feature- and fit-level explanations all came back empty.

Two calibration faults the same diagnostic exposes (partial correlation with outcome, controlling
for `E_i`; near zero means `E_i` already knows it):

- **`waste` is mis-scheduled**: −0.157 mid-game (under-weighted) and +0.138 endgame
  (over-weighted). CEM moved mid-game waste 0.35 → 0.55 and left the endgame at 0.91.
- **`f(C)` is under-weighted mid-game** (+0.114).
- v11's evaluation retains **+0.065** incremental over `E_i` (+0.121 opening, +0.178 endgame) — so it
  knows something, but not via unique liberties or mobility.

## Questions

1. **Does the sibling-discrimination reading persuade you?** If so, what property of `E_i` would you
   expect to damage local ordering while leaving global calibration intact — the phase detector
   switching weight vectors between siblings, the λ term reacting to the leader flipping, the
   Voronoi tie-break being discontinuous in the position?
2. `E_i` is the better global predictor in the mid-game and endgame but **worse in the opening**
   (0.196 vs 0.227), where §4.1 is most prescriptive. Does that surprise you?
3. Is there a reason to prefer the union-fit experiment over the sibling-discrimination one, given
   the above? We have budget for one before writing revision 4.

---

# Round 3 — your tie-break was right, and it moved the problem

## The one that worked

Your fractional Voronoi tie-break is the first of **twelve** hand-set changes to improve the engine.

| | advantage | 95% CI |
| --- | --- | --- |
| `v12-fracties` vs frozen `v12` (eval level, 1600 games) | **+0.96** | [0.57, 1.37] |

And it closes the evaluation gap outright:

| vs v11, eval level, 400 held-out seeds | advantage | 95% CI | |
| --- | --- | --- | --- |
| v12 as implemented | −2.84 | [−3.23, −2.46] | |
| + CEM tuning | −1.01 | [−1.44, −0.59] | +1.83 |
| + fractional ties | **−0.15** | [−0.54, 0.24] | +0.86 |

The pattern across the twelve is the lesson: eleven attempts changed what a term is **worth** and all
failed; one changed what a term **measures** and worked immediately. The sibling-variance and
partial-correlation diagnostics were both pointing at weights, and weights were the wrong target.

It also nearly registered as a twelfth null. The first run returned `−0.00` with a **zero-width**
interval — the mirror-match signature, meaning byte-identical games. A genuine null shows variance,
so an exactly-zero result is evidence the change never reached the code path. It hadn't: candidate
moves are scored through a separate scratch context that had not been given the flag, so the new rule
applied only to the baseline term and cancelled out of `E_after − E_before`.

## Your other two calls, both confirmed

- **Packability**: the proxies have sibling coefficient of variation **0.49 in the opening but 0.07
  in the endgame** — they barely distinguish endgame siblings, so they cannot be the endgame fix.
- **Don't trust the partial correlations as a weight oracle**: acting on the endgame-waste
  prescription (0.835 → 0.55 → 0.30) measured **+0.08 [−0.01, 0.17]** and **+0.04 [−0.06, 0.14]**.
  Null, exactly as you warned.

The variance decomposition also answered your prediction, though not the way you guessed. v11's
sibling spread is dominated by **material** (0.641 overall, 0.715 endgame), not by centre control /
unique liberties / reachable area — those carry 0.209 / 0.124 / 0.175. v12's material share is about
half v11's, and in the endgame `waste` carries 0.862. But since cutting that weight changes nothing,
the share is a description of the optimum, not a lever on it.

## Where the problem actually is now

You told me 25 seeds was too few and that if the search-level gap were genuinely larger than the eval
gap it would point at leaf calibration. Both parts were right.

| tuned v12 + fractional ties, vs v11 | advantage | 95% CI |
| --- | --- | --- |
| eval level (no tree), 400 seeds | −0.15 | [−0.54, 0.24] |
| **search level (300 iterations), 100 seeds** | **−3.98** | [−4.91, −3.04] |

**The evaluation is at parity and the tree destroys about three points.** v11's tree adds ~+1.6 over
its own evaluation; v12's subtracts.

A methodology fault of mine is part of it. I had folded the four leaf-value parameters into the
evaluation tuning space — but all fitting ran at the greedy policy, which has no tree and never calls
the backup, so those four had **no fitness pressure at all** and drifted (`sigmoidScale` 12 → 19.6,
`evalScale` 28 → 35.2), flattening the leaf value function. Restoring defaults gives
**−2.81 [−4.25, −1.39]** — better, but overlapping, so the drift is at most part of it. And defaults
are not obviously right either: tuning raised E's magnitude, so the correct `evalScale` for the tuned
E is probably larger than the one calibrated for the untuned E.

## Questions

1. **Why would this evaluation be a worse leaf value than v11's despite being a better predictor?**
   The obvious candidates are scale (E's magnitude changed under tuning while `evalScale` did not),
   the absent material anchor at truncated leaves interacting with a 12-ply cutoff, or the rank blend
   adding a step function to a value the tree then averages. Which would you look at first?
2. Is there an argument that an evaluation fitted at **one ply** should not be expected to serve as a
   leaf value at all, and that the two need separate parameter sets by construction?
3. We are sweeping `evalScale` at search level now, because a 4-dimensional CEM at `mcts-bench`
   within budget forces ~8 seeds per candidate — a fitness standard error of ~1.7 points on effects
   of ~1 point, under-powered by construction. Do you agree that's the right order, or is there a
   cheaper way to calibrate a leaf value than playing games?

---

# Round 4 — your critique held, and it invalidated the headline

Every one of your five criticisms was correct. Two of them changed conclusions rather than wording.

## 1. Compute, not iterations — you were right to demand it, and the result survived

`MEASURED` A full-length playout costs **1.3×** a 12-ply one per iteration. Not several times, and the
reason is one the report asserted without evidence: a truncated leaf still pays for the composite
evaluation (a territory BFS plus a region labelling) that a *terminal* leaf skips entirely. The extra
rollout length is largely paid for by the evaluation it avoids.

Re-run compute-matched (full playouts at 1/1.3 the iteration budget):

| | advantage | 95% CI |
| --- | --- | --- |
| equal iterations | +5.71 | [5.05, 6.35] |
| **equal compute** | **+4.73** | **[4.10, 5.40]** |

About one point was budget; ~4.7 is the change. I've also added a per-config `iterationScale` to the
harness, because it previously could only set one global iteration budget — meaning *every*
comparison in this project had silently been equal-iterations rather than equal-compute.

## 2. The §0.1/§8 contradiction — fatal to the framing, as you said

+4.73 clears §8's own +4.5 falsifier. The claim is restated to the one that survives the data:

> **How a leaf's value is obtained, and the evaluation weights, decide outcomes. The tree policy
> barely registers.**

with **leaf estimation** (rollout termination and returned value, +4.7) and **weights** (+4.5) on one
side, and **tree policy** (selection rule, widening, transpositions, opponent model, shortlists,
exploration constant — all null or small) on the other. Playout length is classified as leaf
estimation rather than defined away, and the falsifier is now a *tree-policy* change worth +4.5.

## 3. Your fairness objection destroyed the headline

This is the one that mattered most, and I would not have run it unprompted.

`MEASURED` The incumbent had its own rollout truncation hard-coded at 24 plies (14 in self-play) —
the identical mistake, reached independently, never exposed as a parameter. I exposed it and gave the
incumbent the same fix:

| | advantage | 95% CI |
| --- | --- | --- |
| incumbent + full rollouts, vs stock incumbent | **+6.93** | [4.74, 9.17] |

**It gains more than the challenger did.** And the two corrected engines against each other:

| | advantage | 95% CI |
| --- | --- | --- |
| challenger + all fixes, vs incumbent + full rollouts | **−4.45** | [−5.89, −2.97] |

*(40 seeds at 100 iterations; MDE 1.9 there, so real at that budget. Three attempts at 300 iterations
were killed by the machine before producing output, so it is unconfirmed at the shipping budget.)*

**The parity claim is withdrawn.** It was measured against an opponent carrying a handicap the
challenger had just removed. The corrected accounting:

| Contribution | Worth |
| --- | --- |
| Full-length rollouts | +4.7 to +6.9 — **a domain fact, to any engine here** |
| Fractional territory tie-break (your suggestion) | +0.96 |
| Bitboard representation | ~20% cheaper per move |
| Making truncation an explicit parameter | why the domain fact was found at all |
| `E_i`, once both engines are corrected | **~4.5 points worse than the incumbent's** |

The uncomfortable part: **§0.3 already contained the rule that would have prevented this.** Adopt one
mechanism at a time onto the measured champion. Had that been followed, the truncation fix would have
been found in an afternoon for +6.9 and most of this engine would never have been built. The document
stated the principle; the work did not follow it.

## 4. Stale evaluation results — half-resolved, in the document's favour

You were right that +4.5, +1.33 and +0.59 were all measured with `E_i` as the leaf value, and that
under full playouts it is only a prior. The missing ablation: flattening the PUCT prior
(`priorTemp` → ∞) costs **−1.41 [−2.42, −0.46]**. **`E_i` is load-bearing as a prior.** That does not
un-stale those three numbers — they describe a role the evaluation no longer plays — but the
evaluation work was not wasted.

## 5. Underpowered nulls — fixed, and it weakened a conclusion

§7 now carries a minimum-detectable-effect table (per-seed SD ≈4.8, so MDE ≈13.4/√seeds: 2.7 at 24
seeds, 1.3 at 100, 0.67 at 400) and the rule that a null at 60 seeds means "nothing larger than
~1.7", not "nothing".

Applying it, §3.1's dismissal of mobility and unique liberties was doing *both* things you flagged —
reading an underpowered null as an absence, **and** using pooled correlation to rule on sibling
discrimination, which §7 forbids. It now says only that neither is worth more than ~1.3 points.

## 6. Your smaller items, all correct

- Progressive widening (+1.96, interval spanning zero) is now flagged **replicate before citing**.
- §5's tie-break sentence was false once ties split 1/k. Worse: **splitting them deleted the tempo
  idea from the one place it was doing work.** Turn order now enters only through λ relations and
  seat multipliers, neither of which has measured as worth anything. Your order-weighted split is
  the named experiment.
- **λ has never been ablated.** Recorded as an open `HYPOTHESIS` with the experiment (λ = 0).
- First-mover advantage from mirror-match mean score by seat: recorded as free and not yet done.

## Where this leaves things

`v11-deep` — the incumbent plus one field — is now the strongest configuration measured and is a
promotion candidate on its own numbers. A held-out confirmation at the shipping budget is running.

Your ranked list is what I'd work from next, and item 5 has been promoted to first by these results:
the question has narrowed from "is this design better" to **"which feature set, under one corrected
search"**, which is exactly the union fit. Item 1 (strength-versus-iterations) matters more too, since
the −4.45 is currently only established at 100 iterations.

## Questions

1. Given the truncation error appeared independently in two engines built years apart, is early
   playout termination simply wrong for bounded-length scoring games, or is there a budget regime
   where it pays? The literature it came from (Amazons, Breakthrough) has unbounded rollouts and
   expensive evaluations; Blokus has neither.
2. Does the domain-fact framing change what §0.1 should claim? A design that surfaces a five-point
   error in the incumbent by making a choice explicit has done something valuable, but not the thing
   it set out to do, and I am unsure how a design document should account for that.
3. Is there a reason to keep the challenger's evaluation at all, given it is ~4.5 behind and its main
   measured virtue (+1.41 as a prior) is a role the incumbent's could also fill?
