# Blokee v5 Oracle player-residual experiment (K)

**Started:** 2026-08-28  
**Status:** measured; stable-player identity passed; style-switch gate failed

## Question

The strategic source audit established a large transferable family signal: 78.6% complete-trajectory
classification and 72.9% after eight moves on an unseen residual-strength variant. Experiment K
asks the next causal question:

> Can an online history representation turn that signal into a better legal-action distribution
> for the correct opponent than for no history or another opponent's history?

This remains prediction-only. No result in this experiment may change a played move or authorize a
v5 release.

## Split contract

The consumed 54,000,000-seed personality corpus becomes development data:

- variants `a` and `b`: training;
- consumed variant `c`: architecture selection, regularization, temperature, and reset selection;
- new variant `d`: once-read holdout at seed base **55,000,000**.

Variant `d` is fixed before export. Every family uses strategic strength 1.05, base-rank weight
0.70 instead of 0.55, and a 0.15 secondary objective tied to the same family. This changes more
than residual amplitude while preserving the intended strategy. The eight `d` profiles play 48
fresh seat-rotated games with the same first-eight-ply top-three opening sampler. Whole games and
profiles remain disjoint.

## Shared policy decomposition

Every arm uses the same contextual candidate, state, and canonical board encoder:

```text
log π_j(a | s, h) = log π_0(a | s) + U(s, a) z_j(h)
```

`π_0` is trained first on variants `a+b` and then frozen. `U` is candidate-specific. The residual
path starts from zero and the explicit fixed control bypasses it exactly.

The history observation is the contextual embedding of each action actually chosen. It is shifted
one step, so the prediction at turn `t` sees only turns `<t`. Family labels are available only as a
0.15-weight auxiliary training head for this synthetic source experiment; no label or profile ID is
provided as runtime input.

## Fixed arms

1. **Fixed population:** frozen `π_0`, no history residual.
2. **Family Bayes:** eight supervised family residual policies with an online posterior updated
   only after real actions.
3. **GRU residual:** one width-32 causal GRU over prior chosen-action embeddings.
4. **Transformer residual:** one width-32, four-head causal self-attention block over the same
   prefix.

All arms share the population encoder and train only their residual/history parameters after it is
frozen. Validation selects regularization, calibration temperature, the Bayesian filter, and the
single history arm that will be named the candidate. All frozen arms are then reported on `d`; no
choice changes after that read.

## Controls and metrics

Metrics begin after three prior observations and bootstrap whole games.

- **Correct:** the target player's real prefix.
- **Fixed:** the exact population logits with no residual.
- **Shuffled:** a different holdout player's prefix is applied to the target position.
- **Empty-history fallback:** the residual is explicitly zero and must reproduce fixed logits.
- **Style switch:** concatenate two holdout player prefixes from different families and require the
  auxiliary head to identify the second family four observations after the switch.

Report action NLL, top-five recall, ten-bin top-one ECE, family accuracy by observation count,
per-family correct-minus-shuffled NLL, parameter count, and transformer full-prefix/cache-equivalent
logit error.

## Preregistered gates

The selected player residual advances to a counterfactual-response experiment only if every
variant-d condition passes:

- correct-history gain over fixed has a 95% lower bound above **0.03 nats/action**;
- correct-history gain over shuffled history has a lower bound above **0.06**;
- top-five recall exceeds **65%**;
- ECE is at most **0.08** and no more than 0.01 worse than fixed;
- eight-observation auxiliary family accuracy exceeds **50%**;
- mean correct-minus-shuffled gain across blocker, retaliator, persistent, and next-hunter exceeds
  **0.04**, with no one of those families below **−0.01**;
- four-observation post-switch family accuracy exceeds **50%**;
- empty-history logits match fixed within **1e-6**;
- transformer incremental-prefix logits match full-prefix logits within **1e-5** if the transformer
  is selected.

Passing authorizes only the next offline counterfactual-response benchmark. Belief MCTS and search
integration remain blocked until reply distributions after intrusion and targeting interventions
also pass.

## KV-cache boundary

The transformer arm uses a causal prefix and will be checked for incremental/full-prefix numerical
equivalence. A future runtime may hold one append-only cache per real opponent. Hypothetical search
moves may read or clone a derived representation but must never mutate the real prefix.

## Results

`MEASURED` The development corpus contained 144 games and 24 `a/b/c` profiles. The once-read
variant-`d` holdout contained 48 newly seeded games, eight new profiles, 3,278 decisions, 693,608
exact legal candidates, and zero missing played actions. The contextual population encoder had
22,457 parameters and reached validation NLL 2.077 before it was frozen.

Validation selected the history arms before `d` was opened:

- family Bayes: **1.8603 NLL**, 256 residual parameters;
- GRU: **1.8481**, 7,624 parameters — selected;
- transformer: **1.8697**, 10,856 parameters.

The selected GRU then measured on `d`, after three prior observations:

- correct-history NLL: **1.831**;
- fixed-population NLL: **1.981**;
- shuffled-history NLL: **2.080**;
- gain over fixed: **+0.150 [0.122, 0.178] nats/action** — pass;
- gain over shuffled: **+0.248 [0.207, 0.289]** — pass;
- top-five recall: **83.0%** — pass;
- ECE: **0.048**, versus fixed 0.051 — pass;
- family accuracy after eight observations: **81.3%** — pass.

Every interaction-specific family had positive correct-versus-shuffled gain: blocker +0.030,
retaliator +0.021, persistent +0.261, and next-hunter +0.447 nats/action. Their mean was +0.190 and
their minimum stayed above the preregistered −0.01 floor.

The empty-history path reproduced fixed logits exactly. The transformer prefix gate was not
applicable because validation did not select it. For transparency, the frozen holdout scores of
the non-selected arms were Bayes 1.805 and transformer 1.855 NLL. Bayes happened to outperform the
preselected GRU on `d`, but the selection is not changed after the holdout read.

The one failure was deliberate style switching. Four observations after concatenating a different
family's prefix, the GRU auxiliary head identified the new family only **32.3%** of the time,
below the >50% gate. Eight of nine gates passed; counterfactual-response work is not authorized.

## Decision

Experiment K establishes the first strong, causal opponent-history result in the Oracle program.
For stable synthetic players, the correct history improves action likelihood far beyond both fixed
and shuffled controls, including the difficult retaliation and targeting families. This is real
opponent adaptation rather than a generic policy improvement.

It is not yet the Oracle player:

1. The selected recurrent state is too sticky when behavior changes. Search exploitation would
   therefore remain confidently wrong after a midgame switch.
2. The next authorized work is a prediction-only change-point experiment, not counterfactual search.
   Tune a surprise-triggered reset, sliding-window GRU, or fast/slow Bayes-GRU mixture on consumed
   validation data, then evaluate once on a fresh variant and fresh switched trajectories.
3. Stable-history NLL may degrade by at most 0.01 while post-switch four-observation family accuracy
   must exceed 50%. Fixed and shuffled controls remain unchanged.
4. The transformer did not win validation, so KV-cache complexity is not justified for this model.
   The verified cache semantics remain available if a later transformer wins an identity gate.
