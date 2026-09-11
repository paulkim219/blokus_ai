# v3.7 promotion research plan — strength per executed compute

## Objective

Find a real architectural successor to the promoted v3 line:

- `v3.5-lite`, `v3.5`, and `v3.5-pro`: the measured 21-own-move curve.
- `v3.6-pro-max`: the same curve at `iterationScale: 8.33`, promoted at
  **+0.84 [0.31, 1.37]** for **+9.2% executed compute**.

The next candidate may cost more than the incumbent. The rule is not “stay under 10%”; it is:

> Buy compute only when the architecture converts it into more strength than the incumbent would
> obtain from the same compute.

That requires an equal-executed-compute control, not a formula based on the old 1.3-points-per-
doubling estimate alone.

## Promotion statistic

For candidate `X`, shipping incumbent `I`, and an incumbent effort control `I@C_X` calibrated to
match `X`'s executed compute:

- `G_absolute = advantage(X, I)` — is the candidate stronger than what ships?
- `G_architecture = advantage(X, I@C_X)` — is it stronger than simply buying the incumbent more
  iterations?
- `R = executed_compute(X) / executed_compute(I)` — measured spent iterations/search when
  per-iteration work is unchanged; wall milliseconds/move when it changes.

A promotion candidate must satisfy all three:

1. `G_absolute` has a 95% lower bound above zero on the decisive pool.
2. `G_architecture` has a positive point estimate on both decisive blocks and a pooled 95% lower
   bound above zero.
3. `R` stays inside the cap preregistered for that arm. Caps may be 1.10 or 1.25; choosing a larger
   cap is allowed before results, never after them. **1.50 is withdrawn at Pro Max**: it is ~900 ms a
   move, past where the measured frontier is still climbing and past what a browser can spend. Reserve
   it for an explicitly separate "ultra" tier if one is ever wanted.

This is stricter and cleaner than converting points to compute with a single global slope. It asks
the counterfactual directly.

### The other half of the frontier

The rule above only promotes a candidate for being **stronger at matched compute**. That is one of the
two directions worth moving, and three of the five workstreams below produce nothing else.
Workstream C expects to be cheaper on accepted openings; D and E are cost reductions by construction.

`R` must therefore be read in the currency that actually changes. Where per-iteration work is
unchanged, spent iterations per search is right. Where it changes — which is exactly what D does — it
is **wall milliseconds a move**, and the two can disagree: `v3.6-pro-max` measures +9.5% executed
iterations against +13.9% wall clock, because the extra iterations run deeper in the tree where nodes
cost more.

**Rule F — Pareto promotion.** A candidate also promotes if it *dominates on (strength, cost)*:

- strictly stronger with cost ratio ≤ 1.00, **or**
- not weaker — 95% lower bound above −0.10 — at strictly lower measured cost.

Same block ladder, same interval discipline, same preregistration. A candidate that is both cheaper
and stronger needs no equal-compute control, because there is no extra compute to control for.

### Cost distribution, not just the mean

Workstreams A and B spend variably by position. Record **p50 / p95 / max milliseconds a move**, not
only the mean. A controller averaging +25% that occasionally spends 3x on one move is a different
product from one spending +25% uniformly, and a p95 blowout is a reject at an otherwise acceptable
mean.

## Required incumbent frontier

Before testing an architectural arm, calibrate the incumbent at executed-compute ratios
`{1.00, 1.10, 1.25, 1.50}` around the target tier. 1.50 is measured here as a *diagnostic* point on
the curve even though it is no longer an allowed promotion cap at Pro Max — knowing where the frontier
flattens is the reason to measure it. For each point record:

- allocated and spent iterations/search;
- milliseconds/move and milliseconds/game;
- decision-locked fraction;
- advantage against the shipping effort level on a shared 100-seed block.

Fit `advantage = beta * log2(executed_compute_ratio)` only as a diagnostic. The actual promotion
control is the measured incumbent effort level closest to the candidate's compute.

## Candidate order

Ordered by expected strength-per-compute gained per hour spent. This is a revision: the original order
led with the controller, and every arm in it targeted the top of the ladder.

`MEASURED` The reason for the change is the shape of the frontier. Marginal rate along it is
**≈4.3 points per doubling from 75 ms to 178 ms**, against ≈1.5 from 178 to 353 and ≈2.7 from 353 to
613. The exchange rate cited elsewhere in this document agrees — ≈2.5 per doubling near 300 iterations
against ≈1.3 at Pro. Compute converts about twice as well at the cheap end, and so does anything that
makes an iteration cheaper. Arms that *buy* compute can only apply where spending more is acceptable,
which is the half of the ladder where it converts worst.

1. **Per-iteration cost reduction** — `V37_SPEED_PLAN.md`. No match ladder: a behaviour-preserving
   change is verified by seed-replay identity, and strength is inherited. Shifts every tier at once.
2. **Cheap-end rebuild** — `V37_CHEAP_TIER_PLAN.md`. Two matches, no new code. The cheapest published
   tier is built on rollout truncation, whose penalty this repo separately measures at 4.7–6.9 points.
3. **Confidence-gated oracle distillation** — `V37_ORACLE_DISTILLATION_PLAN.md`. The only original arm
   that can move a tier left, and it targets the phase with the largest measured headroom.
4. **Contextual value-of-computation controller** — `V37_METAREASONING_CONTROLLER_PLAN.md`. Run the
   checkpoint corpus and the ceiling-versus-MDE check before committing to a ladder.
5. **Warm-start top-two root racing** — `V37_ROOT_RACING_PLAN.md`. **Sequenced after arm 4, sharing its
   corpus.** The two are halves of one design: 4 decides *whether* to spend another tranche, 5 decides
   *how*. Arm 4's corpus answers whether root diffusion is the binding constraint, which is arm 5's
   entire premise. Running them as parallel ladders spends ~7 hours to find that out.

These remain independent *mechanisms*. Do not bundle them before one promotes.

## Compute budget

The ladder below, plus an equal-compute control, is ~540 seeds x 2 configs per arm — roughly **7 hours
at Pro Max per arm**, before any offline corpus. The three original arms are ~21 hours. Arms 1 and 2
together are under an hour. That ratio is the whole argument for the order above.

## Experiment funnel

The v3.6 ledger shows that every 16-seed strength screen in this channel selected noise. Sixteen
seeds are retained only as a liveness/determinism test.

1. **Offline mechanism gate.** A game-disjoint corpus must show that the mechanism targets actual
   oracle regret or search instability, with bootstrap intervals over games.
2. **Compute calibration.** At least eight full self-play games per arm; record both allocated and
   spent compute. Construct `I@C_X` from the measurement.
3. **40-seed feasibility block.** One block per preregistered arm. This may kill an arm but cannot
   nominate a release.
4. **100-seed confirmation.** Fresh seeds. Advance only if both `G_absolute` and
   `G_architecture` are positive and the candidate remains inside its cap.
5. **Two 200-seed decisive blocks.** Fresh, disjoint seeds; no extension, replacement, or retry.
   Pool only the two blocks named before either starts.

Use common seat rotations and opening draws for candidate/incumbent comparisons. Verify seed
disjointness automatically rather than by prose.

## Closed channels — do not repackage them

- Naive root-spread banking: incoherent across six measurements.
- Equal-budget two-tree ensembles: significantly harmful.
- Sequential halving from iteration zero: harmful at Pro.
- Variance-tuned PUCT, root rollout audits, RAVE, MAST, committee pooling, and phase `v2-pro`
  arbitration: already stopped under larger held-out blocks or gates.
- Exact-hash opening books under randomized opening sampling: 9.4% overall coverage and no fresh
  hits after ply 2.

The proposed root racer is allowed only because it preserves incumbent PUCT for the full nominal
budget and applies a different rule to *new* compute. The proposed opening apprentice is allowed
only because it directly selects or abstains; it is not another weak learned prior blend.

## Programme kill condition

If arms 1 and 2 land, arm 3 abstains at low coverage, and arm 4's offline ceiling sits below the
decisive block's MDE, the honest conclusion is that the v3 architecture's remaining headroom is in
**implementation cost rather than search design**. The next generation should then be a representation
change, not another allocation mechanism. State this now so it is not re-litigated later.

## Research basis

- Hay, Russell, Tolpin & Shimony, [Selecting Computations: Theory and
  Applications](https://people.eecs.berkeley.edu/~russell/papers/uai12-meta.pdf): computations are
  actions whose value is the expected improvement in the final decision minus computation cost.
- Garivier & Kaufmann, [Optimal Best Arm Identification with Fixed
  Confidence](https://proceedings.mlr.press/v49/garivier16a.html): allocate samples to distinguish
  the leader from plausible challengers and stop at a confidence threshold.
- Kaufmann & Koolen, [Monte-Carlo Tree Search by Best Arm
  Identification](https://proceedings.neurips.cc/paper/2017/hash/a6d259bfbfa2062843ef543e21d7ec8e-Abstract.html): summarize deeper uncertainty at the root and
  apply best-arm identification there.
- Li et al., [Hyperband](https://www.jmlr.org/papers/volume18/16-558/16-558.pdf): adaptive resource
  allocation is appropriate for screening, but final evidence must be held out from selection.

## Deliverables

- `scripts/benchBitboard.ts` and `scripts/v37ReplayDiff.ts` (arm 1; note that `scripts/benchSearch.ts`
  measures the **legacy object engine** and is not fit for this)
- `scripts/v37ComputeFrontier.ts`
- `selfplay-results/v37-compute-frontier.json`
- one preregistration ledger per arm
- exact configs retained under experiment ids even when rejected
- an update to `docs/ALGORITHMS.md` only after decisive blocks finish

