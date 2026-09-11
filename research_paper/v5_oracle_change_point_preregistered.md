# Blokee v5 Oracle Experiment L — preregistered change-point adaptation

**Preregistered:** 2026-08-29  
**Status:** development cycle complete; variant `c` confirmation failed; variant `e` never opened

## Question and authorization boundary

Experiment K established a causal stable-player identity channel, but the selected GRU failed its
synthetic splice switch gate. The subsequent coherent-game calibration made the failure sharper:
four observations after a real objective switch, new-family accuracy was **0.0%**, the old family
still won **67.2%** of predictions, and stale history was **+0.43 to +0.97 nats/action** worse than
the fixed population model over the first five post-switch decisions.

Experiment L asks one question:

> Can a prediction-only model replace a confidently obsolete identity within four observed moves,
> without giving back K's stable-player action-likelihood gain?

Passing L authorizes only the offline counterfactual-response experiment. It does not authorize
belief MCTS, a played-move change, or an Oracle release.

## Frozen data contract

### Development

The development source consists only of already-consumed variants `a`, `b`, and `c`:

- stable games: `ml/data/v5-oracle-personalities`;
- coherent switching games: a 48-game-per-variant export at seed base **56,000,000**, written to
  `ml/data/v5-oracle-l-dev-switch`;
- variant `a`: fitting;
- variant `b`: architecture, window, loss-weight, temperature, and epoch selection;
- variant `c`: one development confirmation after every choice is frozen.

The switching corpus uses the existing cross-family pairs and changes at the seat's sixth completed
move. Training batches contain equal numbers of stable and switching seat-trajectories. Whole games
remain the resampling and split unit; a seat-trajectory may not appear in more than one split.

### Sealed holdout

Variant `e` is fixed at strategic strength **1.25**, base-rank weight **0.62**, and
secondary-family weight **0.10**. It is not used for fitting, early stopping, temperature selection,
architecture choice, debugging, or threshold changes.

The once-read holdout contains two paired blocks, both at seed base **57,000,000** with the same
seat rotation and opening sampler:

- `ml/data/v5-oracle-l-holdout-stable`: 48 stable games;
- `ml/data/v5-oracle-l-holdout-switch`: 48 switching games.

Neither export command may run until the development implementation, candidate checkpoint,
evaluation script, output schema, and this protocol all pass their tests. If an `e` export is
partial or structurally invalid, it may be rerun only with the same command and seed range. Its
metrics may not be inspected before the complete paired export passes structural validation.

## Shared causal and model contract

All arms use K's frozen contextual population encoder and candidate embeddings. At decision `t`,
the model sees only actions from turns `< t`; the played action at `t` is never part of its own
history input. Family and switch labels may appear in training losses because this is a synthetic
source audit, but neither label is a runtime input.

The fixed-population path must remain callable independently. Real-game identity state is updated
only after a real observed action. Nothing in L enters search or changes self-play moves.

Training inherits K's optimizer and batching unless overridden below: Adam at `1e-3`, maximum 70
residual epochs, patience 10, sequence batch 8, family-loss weight 0.15, and temperature selected
from `{0.65, 0.8, 1.0, 1.25, 1.5, 1.8}`. Every eligible configuration is trained at seeds
**5901, 5902, and 5903**. Evaluation averages their pre-softmax logits; no lucky seed is selected.

## Frozen arms

### Controls

1. **Fixed population.** K's frozen contextual population logits, with no history residual.
2. **K frozen GRU.** The exact Experiment K checkpoint and temperature. This is the stale-history
   baseline and is not eligible for selection.
3. **Fast-only window diagnostic.** A width-32 GRU re-encoded from only the last eight observed
   actions. It measures the stable-history cost of discarding the slow path and is not eligible.

### Eligible B — switch-trained single GRU

K's width-32 GRU architecture is initialized from the frozen K checkpoint, then trained on the
balanced stable/switching development mixture with time-varying family labels. All history weights
may update. The only grid is L2 residual regularization in `{1e-4, 3e-4, 1e-3}`.

This arm tests the narrow claim that coherent switch training, rather than new inference machinery,
is sufficient.

### Eligible C — fast/slow gated residual

The slow width-32 GRU and its action query are copied from K and frozen. A new width-32 fast GRU
re-encodes only the most recent `w` observed actions, where `w ∈ {4, 6, 8}`. Both paths produce an
action residual and family logits. A width-16 gate receives the slow latent, fast latent, their
absolute difference, their family-distribution disagreement, and current fixed-model action
surprise. It emits `g_t ∈ [0,1]` and combines the action latent as

```text
z_t = (1 - g_t) z_slow,t + g_t z_fast,t
```

The runtime gate receives no true switch flag. During development only, a binary auxiliary target
is one for the first eight observations after a real switch and zero on stable/pre-switch history.
Its loss weight is selected from `{0.10, 0.25}`. The fast family head retains K's 0.15 loss weight.
All slow-path and population weights remain frozen.

This arm tests the evidence-backed hypothesis that stable action prediction needs long memory while
current identity needs a short, replaceable state.

No transformer or KV-cache arm participates. K's transformer lost validation, and L tests memory
semantics rather than sequence-computation speed. The verified cache implementation remains
available if a future transformer wins an identity gate.

## Development-only selection rule

Each configuration is trained on variant `a` and evaluated on variant `b` as the three-seed logit
ensemble. A configuration is eligible only if all of the following hold on `b`:

- empty-history logits match fixed logits within `1e-6`;
- stable NLL is no more than `0.02` nats/action worse than the frozen K GRU;
- four-observation post-switch new-family accuracy is at least `25%`;
- mean action NLL excess over fixed at post-switch offsets 1–4 is at most `0.20` nats/action.

Eligible configurations are selected lexicographically:

1. highest four-observation post-switch new-family accuracy;
2. if within two percentage points, lowest mean action NLL excess over fixed at offsets 1–4;
3. if within `0.01` nats/action, lowest stable NLL;
4. if still tied, fewer trainable parameters, then smaller window, then lower loss weight.

The selected architecture and hyperparameters are retrained from the same three seeds on variants
`a+b`. The resulting three-checkpoint ensemble is frozen and read once on development variant `c`.
Variant `c` must pass every holdout gate below using the same evaluation code. Failure stops L;
nothing is changed and variant `e` remains unopened. Passing `c` permits the paired `e` export and
one holdout read. No refit occurs after `c`.

## Metric definitions

- **Stable action NLL:** mean legal-action negative log likelihood from own turn index 3 onward in
  the stable block.
- **Switch family accuracy at `n`:** auxiliary-family argmax after exactly `n` post-switch actions
  from that seat have been observed.
- **Still-old rate at `n`:** fraction whose family argmax remains the pre-switch family.
- **Recovery ratio:** switch family accuracy at four observations divided by stable matched-control
  family accuracy at four observations.
- **Post-switch action excess:** candidate NLL minus fixed-population NLL at offsets 0–4, where
  offset 0 is the first new-style action before any new-style action has been observed.
- **Top-five recall and ECE:** K's definitions, on stable turns from index 3 onward.

Confidence intervals use **20,000 whole-game bootstrap replicates** with seed **5,900,001**. Stable
and switching blocks are paired by game index when a difference uses both. Seat decisions from one
game are never resampled independently.

## Once-read variant-`e` gates

Every gate is conjunctive. Point estimates are computed over all 48 games; `lower` and `upper`
refer to the percentile whole-game 95% interval.

1. **Structural integrity.** Both blocks contain 48 finished games, zero missing played actions,
   all 192 switching seat-trajectories change family exactly once at own turn index 6, and stable
   trajectories never change family.
2. **Exact fallback.** Empty-history candidate logits match fixed-population logits within `1e-6`.
3. **Stable retention.** Candidate minus frozen-K stable NLL is at most `+0.01` point estimate and
   has upper bound at most `+0.02`.
4. **Stable identity value.** Fixed minus candidate stable NLL has lower bound above `+0.03`;
   top-five recall exceeds `65%`; ECE is at most `0.08` and no more than `0.01` above fixed.
5. **Four-move identity recovery.** New-family accuracy is at least `50%`, its lower bound exceeds
   `40%`, and recovery ratio is at least `0.70`.
6. **Stale-identity rejection.** Still-old rate after four observations is at most `25%`, with an
   upper bound below `35%`.
7. **Post-switch action safety.** Mean candidate-minus-fixed NLL across offsets 1–4 is at most
   `+0.05`, with upper bound at most `+0.10`. Each individual offset is reported; none may exceed
   `+0.20` point estimate.
8. **Interaction-family floor.** On stable blocker, retaliator, persistent, and next-hunter games,
   mean correct-minus-shuffled identity gain exceeds `+0.04` nats/action and no family is below
   `-0.01`, preserving K's original interaction gate.

Offset 0 is reported but deliberately not gated: before the first new-style action is observed, no
causal detector can know that the objective changed. Deployment safety at offset 0 would require
an external signal or unconditional fixed fallback, neither of which L claims to provide.

## Decision rule and forbidden rescues

L passes only if one development-selected candidate passes all eight gates on the first complete
variant-`e` read. A failure may be diagnosed on consumed `e` data, but no threshold, temperature,
window, checkpoint, ensemble member, or arm may be changed and called the same experiment. Any
revised design requires a new personality variant and new seed block.

On pass, the exact frozen ensemble advances to prediction-only counterfactual reply tests. On fail,
K remains the stable-player research artifact, the fixed population remains the safety path, and
counterfactual response plus belief MCTS stay blocked.

## Required implementation artifacts before opening `e`

- a development export command that writes `ml/data/v5-oracle-l-dev-switch` without touching `e`;
- a deterministic training/evaluation script implementing the arms and selection rule above;
- unit tests for causal shifting, time-varying labels, fast-window truncation, frozen slow weights,
  gate inputs, paired whole-game bootstrap, and exact fallback;
- a smoke result on variant `a` only;
- a frozen development result and checkpoint that have passed variant `c` readiness;
- an output JSON schema containing every gate, confidence interval, corpus hash, checkpoint hash,
  seed, parameter count, and temperature.

Only after these artifacts exist and pass may the two already-defined variant-`e` export commands
be run.


## Results — development cycle

`MEASURED` Implementation artifacts completed first: the trainer/evaluator
(`ml/train_v5_change_point.py`), the seven required test areas
(`ml/test_v5_change_point.py`, `npm run test:v5-oracle-change-point`), a variant-`a` smoke result,
and the output schema. The tests caught two implementation defects before any training ran: the
fast window counted the causal zero-pad as an observation, and in the gated arm the fast GRU and
gate were never built, so nothing outside the frozen slow path could learn. A third latent defect —
restoring K's checkpoint into transposed slots, because the gated arm calls the slow family head
before the slow query — was closed by building the slow sub-model through its own call and is now
covered by a test asserting that a shut gate reproduces K's logits.

Structural validation passed: 144 stable and 144 switching games, 576 switching trajectories each
changing family exactly once at own turn 6, stable trajectories never changing, zero missing played
actions. The frozen K control reproduced Experiment K's recorded validation NLL of 1.8481 on the
same split, confirming the evaluation code agrees with K's.

### Selection on variant `b`

| configuration | recovery@4 | still-old@4 | excess 1–4 | stable vs K | eligible |
| --- | --- | --- | --- | --- | --- |
| arm B, L2 1e-4 | 87.4% | 6.3% | −0.530 | +0.064 | no |
| arm B, L2 3e-4 | 89.5% | 6.3% | −0.535 | +0.066 | no |
| arm B, L2 1e-3 | 86.9% | 6.8% | −0.680 | +0.073 | no |
| arm C, w4 g0.10 | 55.0% | 12.6% | −0.634 | +0.018 | yes |
| arm C, w4 g0.25 | 55.5% | 12.6% | −0.614 | +0.010 | yes |
| arm C, w6 g0.10 | 61.8% | 9.9% | −0.673 | +0.026 | no |
| arm C, w6 g0.25 | 59.7% | 9.4% | −0.653 | +0.019 | yes |
| arm C, w8 g0.10 | 69.1% | 7.3% | −0.515 | +0.021 | no |
| **arm C, w8 g0.25** | **69.1%** | **6.8%** | **−0.685** | +0.016 | **selected** |

Against the frozen K baseline on the same split — recovery 1.0%, excess **+0.374** — every arm
solved the change-point problem. Unfreezing K's history weights (arm B) solved it best but gave back
0.064–0.073 nats of stable-player likelihood against a 0.02 eligibility budget, so arm B was
eliminated as a class. The lexicographic rule ranks recovery first and therefore passed over
w4 g0.25 at exactly +0.010, the only configuration positioned to clear the stricter +0.01 gate.

### Confirmation on variant `c`

`MEASURED` Six of eight gates passed.

| gate | measured | required | verdict |
| --- | --- | --- | --- |
| 1 structural integrity | complete | — | pass |
| 2 exact fallback | 0.0 | ≤ 1e-6 | pass |
| 3 stable retention | **+0.175** (upper +0.269) | ≤ +0.01, upper ≤ +0.02 | **fail** |
| 4 stable identity value | gain lower +0.130, top-5 81.6%, ECE **0.120** | ECE ≤ 0.08 | **fail** |
| 5 four-move recovery | **74.3%**, lower 68.4%, ratio **0.984** | ≥ 50%, lower > 40%, ratio ≥ 0.70 | pass |
| 6 stale rejection | **4.7%**, upper 8.3% | ≤ 25%, upper < 35% | pass |
| 7 post-switch safety | **−0.774**, upper −0.635 | ≤ +0.05, upper ≤ +0.10 | pass |
| 8 interaction floor | all four families positive | mean > 0.04, none < −0.01 | pass |

Per the decision rule, L stops. Nothing was refit, no threshold was changed, and variant `e` was
never exported.

## Diagnosis

`MEASURED` Reproduce with `npm run diagnose:v5-oracle-change-point`. Consumed development data only.

**The identity result is real and it transfers.** On a residual strength never trained on, the model
replaces a confidently obsolete identity within four moves at **74.3%**, which is 98.4% of its own
clean matched control — it has essentially closed the gap to knowing the answer outright. Still-old
collapses from Experiment K's 67.2% to 4.7%, and post-switch action likelihood is better than the
fixed population at every offset by 0.54 to 1.12 nats, against K being 0.43 to 0.97 nats *worse*.
Gates 5, 6 and 7 were the point of the experiment and they passed decisively.

**Most of the stable-retention failure is temperature, not capability.** Evaluating both models at
their own best temperature reduces the gap from **+0.175 to +0.032**. The protocol selects one
temperature on variant `b` (strength 1.15) and applies it to variant `c` (strength 1.4); that
temperature is badly miscalibrated on the harder variant, which also explains the absolute ECE
failure in gate 4 — the candidate's 0.120 is *better* than the fixed model's 0.138 at the same
temperature, but both exceed the 0.08 absolute bound.

**The gate learned the clock, not the change.** Mean gate opening by the seat's own turn index:

| own turn | 1–4 | 5 | 6 | 7 | 8 | 10 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| switching games | 0.00 | 0.02 | 0.64 | 0.76 | 0.81 | 0.86 | 0.80 |
| **stable games** | 0.00 | 0.02 | **0.66** | 0.43 | 0.28 | 0.18 | 0.14 |

On games where no objective ever changes, the gate still opens to 0.66 at exactly own turn 6 and
only decays afterwards as the evidence contradicts it. Every switch in the corpus occurs at own
move 6, so turn index is a perfect predictor of the switch window and the gate exploited it. That
shortcut is the mechanism of the stable-likelihood leak, and it means this corpus cannot separate
genuine change detection from clock-watching.

The fault is in the corpus, not the model: `--switch-after` was fixed at 6 for the whole league.

## Consequences for the next design

A revised design requires a new personality variant and a new seed block, per the forbidden-rescues
clause. Three changes are indicated, in order of importance:

1. **Randomize the change point per trajectory**, and include never-switching seats inside the
   switching block, so that turn index carries no information about whether a switch occurred. Until
   this is fixed, no gated architecture's change-point result can be believed.
2. **Do not carry one temperature across variants of different residual strength.** Either match
   variant difficulty across development and holdout, or calibrate per block in a way that is fixed
   before the holdout is read.
3. **Reconsider the lexicographic order.** Ranking recovery first selected a configuration that
   could not clear the retention gate while a sibling at +0.010 was positioned to. If retention is
   the binding constraint, it belongs above recovery in the ordering rather than below it.

Experiment K remains the stable-player research artifact, the fixed population remains the safety
path, and counterfactual response plus belief MCTS stay blocked.


## Follow-up — corpus fix implemented and probed (2026-08-29)

`BUILT` The binding change from the diagnosis is implemented. The switching league now draws each
seat's change point independently and leaves a quarter of seats in the switching block with one
objective for the whole game, so turn index no longer predicts whether a switch occurred.

- `scripts/oracleTrajectoryExport.ts` — `--switch-after-min` (4), `--switch-after-max` (12),
  `--switch-fraction` (0.75), and `--seed-base` for the new block a revised design requires. Draws
  are a deterministic per-seat hash, so exports stay reproducible: over 8,000 seats the switch
  fraction is 0.743, the change-point distribution gives chi-square 6.2 on 8 degrees of freedom, and
  the two draws are uncorrelated at 0.011.
- A fresh development corpus at seed base **58,000,000**: 144 games, 9,660 decisions, zero missing
  played actions, 433 switching and 143 never-switching trajectories, change points spanning 4–12.
- Experiment L's own structural check correctly **refuses** this corpus, because it asserts every
  switch falls at own move 6. L's consumed block at 56,000,000 is untouched.

`MEASURED` A design probe trained the selected architecture (arm C, window 8, gate weight 0.25) on
the new corpus for one seed. It is not an experiment: no preregistration, no gates, no holdout.

| own turn | 1–3 | 4 | 5 | 6 | 7 | 8 | 10 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| switching games | ≤0.01 | 0.06 | 0.16 | 0.24 | 0.36 | 0.44 | 0.57 | 0.63 |
| stable games | ≤0.01 | 0.06 | 0.13 | 0.17 | 0.24 | 0.25 | 0.31 | 0.26 |

Measured against each seat's own change point instead of the clock:

| offset from switch | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| gate | 0.31 | 0.53 | 0.62 | 0.67 | 0.71 | 0.74 |

**The clock shortcut is gone.** There is no spike at any fixed turn; peak gate on stable games falls
from 0.66 to 0.31, and the gate now rises with evidence accumulated since each seat's own change
point, which is what a change detector should do.

**The stable-game leak is not fixed, only reshaped.** Mean gate opening on stable games is ~0.17,
against ~0.15 in Experiment L. The spike became a drift: because change points are uniform on 4–12,
the probability that a switch has already happened genuinely rises with turn index, and the gate
encodes that prior. On stable games the prior is simply wrong. Since stable-likelihood retention was
one of the two gates L failed, this matters and should not be reported as solved.

One caveat on the probe: it stopped at its 25-epoch cap with the best epoch at 24, so it was still
improving. The numbers above are a floor, not a converged result.

### What this implies for the next protocol

1. The corpus fix is necessary and works for what it was aimed at; keep it.
2. It is not sufficient for stable retention. The gate needs a reason to be confident that *no*
   switch has occurred — candidates are interleaving switching and never-switching seats within the
   same games so the prior is shared, an asymmetric penalty on gate opening over stable histories,
   or a higher gate-supervision weight than the 0.10/0.25 grid explored here.
3. False-positive gate rate on stable trajectories deserves to be a first-class reported quantity in
   the next design, not something recovered from a diagnosis afterwards.
