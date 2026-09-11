# Blokee v5 Oracle learned-policy experiment

**Started:** 2026-08-28  
**Status:** preregistered before model training or holdout evaluation

## Question

Can a compact trajectory model infer enough player-specific policy signal from a player's earlier
moves to justify a later belief-conditioned search experiment? This phase is prediction-only. No
learned model is connected to move selection.

KV caching is part of the transformer runtime contract, not a source of intelligence or a memory
of prior games. Each real opponent owns one incremental prefix cache. Observed actions may extend
that cache; hypothetical search actions may not mutate it. Training uses complete teacher-forced
sequences, while deployment may reuse the exact same prefix through cached keys and values.

## Dataset contract

- Source: 72 fresh games, 24 each for train, validation, and holdout, beginning at seed 52,200,000.
- Population: twelve engine/policy profiles spanning `v1`, `v2-pro`, `v3.1`, `v3.2`, `v3.7`, and
  `v4.1`, split four profiles per block.
- The four seats in a game come from one block. Therefore both games and profiles are disjoint
  across train, validation, and holdout.
- Search profiles use 40 base iterations. The first eight plies use seeded top-three opening
  sampling.
- A decision contains the exact legal candidate set, the played index, and nine within-legal-set
  standardized features. Passes advance interaction time but are not categorical targets.
- History contains only that player's prior selected feature vectors. Engine identity, profile id,
  game score, and future actions are never model inputs.

The binary contract is `v5-oracle-legal-candidate-trajectories-v1`: candidate rows are float32 and
decision metadata are int32. Every played move must occur in its exact legal set and every source
game must finish, or the experiment is invalid.

## Fixed candidates

All candidates share a learned legal-candidate scorer and differ only in how they encode the prior
selected-action sequence:

1. stateless population scorer;
2. one-layer GRU, width 64;
3. one-layer GRU gating eight linear policy experts;
4. two-layer causal transformer, width 96, four heads, feed-forward width 192.

Optimization uses Adam, early stopping selected only on validation NLL, and temperature scaling
selected only on validation NLL. Holdout metrics are read once after architecture and temperature
selection. Metrics begin after three prior observed actions unless explicitly marked all-turn.

## Controls and gates

The selected learned model is evaluated with its real history and with a different held-out
profile's history at the same turn index. Games are the bootstrap unit.

Search integration is authorized only if all of these hold on the untouched holdout:

- shuffled-history NLL minus personalized NLL has a game-bootstrap 95% lower bound above
  **0.06 nats/action**;
- top-five recall is above **65%**;
- ten-bin top-one expected calibration error is at most **0.08**, and no more than 0.01 worse than
  the calibrated stateless scorer;
- cached and full-prefix transformer logits agree to maximum absolute error below **1e-5**;
- on unseen hybrid histories made by splicing two different held-out profiles after eight actions,
  a surprise-reset rule chosen on validation is no worse in NLL than keeping the contaminated
  history, and its final four decisions are within 0.10 nats/action of clean-history prediction.

Failure keeps v5 prediction-only and sends the next cycle toward richer board/action features or a
larger behavioral league. Passing authorizes root-sampled belief MCTS, not promotion to v5; playing
strength still requires fresh wall-clock-matched matches against v4.1-ultra.


## Results

`MEASURED` The exported dataset satisfied the binary contract: 72 finished games, 5,150 decisions,
1,048,221 candidate rows, and zero played moves outside their exact legal set. Splits are disjoint
by game and by profile as specified.

Validation selection, read before the holdout:

| candidate | parameters | validation NLL | top-5 | ECE | shuffled − personalized |
| --- | --- | --- | --- | --- | --- |
| stateless | 1,409 | 2.858 | 61.8% | 0.092 | +0.000 |
| GRU 64 | 29,185 | 2.748 | 63.8% | 0.058 | +0.042 |
| GRU + 8 experts | 27,824 | **2.714** | 63.7% | 0.054 | +0.051 |
| transformer 96/4 | 157,505 | 2.801 | 62.8% | 0.052 | +0.024 |

The eight-expert mixture won on validation NLL and was selected with temperature 1.35. The
transformer was the weakest history-conditioned arm despite 5.4 times the mixture's parameters;
with 96 training sequences it stopped improving after 12 epochs while the mixture improved until
epoch 214.

On the untouched holdout, after three observations per seat:

- personalized NLL **2.580**; calibrated stateless NLL 2.627; shuffled-history NLL 2.571;
- shuffled minus personalized: **−0.009 [−0.034, +0.015] nats/action** (gate: lower bound > 0.06);
- top-five recall **68.3%** (gate: > 65%) — pass;
- top-one ECE **0.093** against 0.079 for the calibrated stateless scorer (gate: ≤ 0.08 and no more
  than 0.01 worse) — fail on both clauses;
- cached versus full-prefix transformer logits agreed to **5.2e-6** maximum absolute error in
  float32 (gate: < 1e-5) — pass;
- the validation-selected surprise-reset threshold of 3.75 nats transferred to the holdout splices:
  the rule was 0.011 nats/action better than keeping the contaminated history and its final four
  decisions were 0.007 better than clean-history prediction — pass.

Two of five gates fail, including the decisive identity channel. Search integration is not
authorized and v5 stays prediction-only.

`DIAGNOSIS` The learned encoder is a better *population* policy and not a personalized one. It beats
the calibrated stateless scorer by 0.047 nats/action and clears the top-five bar that the stateless
scorer misses, so history content genuinely helps prediction. But substituting a different holdout
profile's history at the same turn index costs nothing measurable, which means the benefit is
common to the population rather than specific to the seat.

The splice block independently confirms this. Replacing a player's first eight observed actions
with another profile's actions changed prediction by only 0.010 nats/action. If the model carried a
real identity state, contamination of the entire warmup would have been expensive. The reset gate
therefore passes vacuously: there is little contamination to repair. Gate five should be read as
uninformative here, not as evidence of graceful change-point handling.

This is Experiment B's failure mode returning one level up. Within-legal-set standardization stopped
absolute phase and geometry from leaking into the authored Bayesian posterior, but it does not stop
a *trained* readout from encoding whatever the four training profiles had in common. The Bayesian
observer's +0.027 nats/action came from a runtime update rule with no fitted parameters, so it
adapted to engines it had never seen; the mixture's gate was fitted to four profiles and does not
transfer to four new ones. Validation showed +0.051 because validation drove early stopping and
architecture choice; the once-read holdout removed that optimism entirely.

One confound is worth recording against the next design. The holdout block contains both `v3.1`
search and `v3.2` search, adjacent engine generations whose behaviour is genuinely similar, so its
shuffled control is a harder discrimination than the validation block's. This weakens the holdout
comparison but cannot explain the whole collapse from +0.051 to −0.009.

## Decision

The preregistered failure branch applies: v5 remains prediction-only, and the next cycle goes to
richer features or a larger behavioral league rather than to belief-conditioned search. Concretely,
in the order the evidence supports:

1. **Widen the league before widening the model.** Twelve profiles in blocks of four is too few for a
   *trained* identity mechanism to generalize; the model can memorize four styles rather than learn
   to infer style. Stratify blocks so that within-block behavioural distance is matched, and report
   the shuffled control separately for near-generation and far-generation donor pairs.
2. **Prefer runtime adaptation over fitted identity.** The one mechanism that transferred to unseen
   engines was the parameter-free Bayes update. A learned candidate scorer combined with an online
   per-seat update — rather than a learned history-to-readout map — keeps the transfer property
   while gaining the population accuracy the encoder just demonstrated.
3. **The features, not the sequence model, are the likely ceiling.** Nine within-set scalars are a
   thin channel. Adding board/action context is a better use of the next cycle than a larger
   sequence model; the transformer's loss to a 28k-parameter mixture says capacity is not binding.

KV caching is settled as a runtime question. The mixture needs one fixed-size recurrent state per
opponent, which is cheaper than a growing prefix cache and keeps the same immutability contract:
hypothetical branches copy the state, only observed moves advance it. The transformer cache path was
implemented and verified anyway, so the contract is proven if a later cycle revives that arm.

No v5 identity is connected to move selection. Any future strength claim still requires a fresh,
wall-clock-matched confirmation against v4.1-ultra.
