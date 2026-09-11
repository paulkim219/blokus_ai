# Blokee v5 Oracle foundation experiment

**Started:** 2026-08-28  
**Status:** preregistered; no result had been read when the gates below were written.

## Objective

Establish whether a compact, online opponent belief can predict a player's next move better than a
population-average policy. This is a channel-capacity experiment, not a v5 strength claim. The
existing v4.1 search is unchanged.

## Phase 0 contract

- Player metadata is a prior only; beliefs are updated from observed moves.
- Directed interaction state records decayed pressure, corner denial, physical contact,
  persistence, and retaliation.
- Real-game interaction state is immutable during candidate evaluation. Hypothetical branches
  receive cloned state.
- No Oracle option is connected to move selection in this phase, so the shipping identity path is
  unchanged by construction.

## Prototype Bayes model

Six authored prototypes score every legal action from the same compact features:

1. balanced;
2. expansionist;
3. blocker;
4. centre seeker;
5. edge runner;
6. retaliator.

Each seat begins with the same uniform prior. After a real action, Bayes' rule updates only that
seat's posterior. A small likelihood floor and posterior drift prevent permanent overconfidence.
No gradients are taken during a game.

## Experiment A — controlled behavioral population

### Data blocks

- Temperature selection: 24 games beginning at seed 51,000,000.
- Exact-prototype holdout: 80 games beginning at seed 51,100,000.
- Unseen hybrid holdout: 80 games beginning at seed 51,200,000.
- Every game uses four distinct styles; all legal actions are scored; passes are deterministic and
  omitted from action metrics.
- Primary metrics begin after three earlier observations of the player. Whole-game metrics remain
  secondary diagnostics.

### Controls

- **Fixed prior:** the population mixture never adapts to the seat.
- **Profile shuffled:** another seat's posterior predicts the current player.
- **Uniform action:** one divided by legal-action count.
- **Known-style oracle:** the generator's true action distribution; this is a ceiling, not a
  deployable baseline.

### Preregistered pass gate

On the exact-prototype holdout, game-bootstrap 95% lower bounds must show:

- fixed-prior NLL minus adaptive NLL greater than **0.05 nats/action**;
- shuffled-profile NLL minus adaptive NLL greater than **0.03 nats/action**;
- post-warmup prototype identification greater than **45%** (six-way chance is 16.7%).

On the unseen-hybrid holdout, both NLL improvements must have lower bounds above zero. A failure
stops architecture integration and sends the feature/prototype contract back for revision.

## Experiment B — historical CPU population

If Experiment A passes, collect fresh, game-disjoint trajectories from broad engine families rather
than assuming authored styles transfer. The primary comparison remains adaptive versus fixed prior
and profile shuffle. Historical engine identity is used only to stratify results, never as an input
to the predictor.

**Preregistered after Experiment A passed and before this block ran:**

- engines: `v1`, `v2-pro`, `v3.1`, `v3.2`, `v3.7`, and `v4.1`;
- 12 seeds beginning at 51,300,000, each with four balanced seat rotations (48 games);
- 60 base MCTS iterations, identical opening sampling, and the temperature 0.6 selected only on
  Experiment A's training block;
- primary metrics after three earlier observations of the seat;
- bootstrap unit is the four-rotation seed, not the individual move or game.

The one-lap response layer is authorized only if the historical-CPU profile-shuffle comparison also
has a 95% lower bound above zero, the fixed-prior comparison does as well, all 48 games finish, and
the exact legal generator contains every played move. Offline top-k accuracy alone cannot authorize
search integration.

## Later playing-strength control

Any response-aware search must be compared against v4.1 at the same wall-clock budget. Its measured
gain must then shrink under profile shuffling; otherwise ordinary compute or a generic policy change
can explain the result.

## Results — Experiment A

`MEASURED` The training block selected temperature 0.6. On 80 untouched exact-prototype games,
after three observations per seat:

- adaptive NLL: 3.141;
- fixed-prior minus adaptive NLL: **+0.304 [0.281, 0.328]**;
- shuffled-profile minus adaptive NLL: **+0.863 [0.788, 0.940]**;
- six-way prototype identification: **71.3%**;
- top-five next-action recall: 51.6%.

On 80 untouched hybrid-style games, fixed-prior minus adaptive was **+0.242 [0.220, 0.264]** and
shuffled-profile minus adaptive was **+0.656 [0.612, 0.702]**. Both preregistered gates pass.

## Results — Experiment B

`MEASURED` All 48 games completed and all 2,868 scored actions were present in the exact legal move
set. Adaptive prediction beat the fixed prior by **+0.067 [0.049, 0.085] nats/action**, but beat the
profile-shuffled control by only **+0.004 [−0.006, 0.017]**. The historical-CPU gate fails, so the
one-lap response layer is not authorized.

`DIAGNOSIS` The posterior is learning a useful common recent-action distribution, but the same
distribution transfers between seats. Raw feature magnitudes change with game phase, legal-set size,
and board geometry; this can make every seat converge toward the same phase-dependent mixture even
when the update is nominally per-player.

## Experiment C — legal-set-standardized beliefs

**Preregistered after Experiment B failed and before Experiment C ran.** The sole model change is to
convert each scalar style feature to a z-score within the current legal action set before computing
prototype likelihoods. The interaction state, prototypes, Bayes update, drift, warmup, candidate set,
and controls remain fixed. This asks “which available option did the player prefer?” rather than
letting absolute phase/geometry leak into the profile.

- Synthetic temperature selection: 24 games at seed 51,600,000.
- Exact synthetic holdout: 80 games at seed 51,700,000.
- Hybrid synthetic holdout: 80 games at seed 51,800,000.
- Fresh historical-CPU holdout: the same six engines and protocol, 12 seeds beginning at
  51,400,000, four rotations each, 60 base iterations.

Experiment C must first satisfy Experiment A's original synthetic gates. The decisive CPU gate is
unchanged: both fixed-prior and shuffled-profile NLL improvements must have seed-bootstrap 95% lower
bounds above zero, with all games complete and no missing played actions.

## Results — Experiment C

`MEASURED` The standardized observer passed both synthetic holdouts. Temperature 0.6 was selected
again on the fresh training block. After three observations per seat, the exact-prototype holdout
reached adaptive NLL 1.871, fixed-prior minus adaptive **+0.788 [0.757, 0.819]**, shuffled-profile
minus adaptive **+2.384 [2.257, 2.510]**, 93.5% six-way identification, and 79.2% top-five recall.
On the unseen hybrid holdout, fixed-prior minus adaptive was **+0.055 [0.028, 0.082]** and
shuffled-profile minus adaptive was **+0.974 [0.907, 1.042]**.

On the fresh historical-CPU block, all 48 games completed and all 2,873 scored actions were in the
exact legal set. Adaptive NLL was 3.147. Fixed-prior minus adaptive was
**+0.124 [0.083, 0.165] nats/action** and shuffled-profile minus adaptive was
**+0.027 [0.010, 0.044]**. The identity-shuffle gate passes and authorizes the bounded response
experiment below. This is evidence of usable player-specific signal; it is not yet evidence of
playing strength.

## Experiment D — one-lap response triage

**Preregistered after Experiment C passed and before any response-aware match ran.** The response
layer sits above the unchanged `v4.1` engine. It first obtains v4.1's root ranking, then re-evaluates
a six-move root shortlist after one complete turn-order lap. At each opponent node, the standardized
posterior mixture predicts legal-action probabilities; a width-three, beam-six chance search keeps
the most probable continuations. Hypothetical moves update only cloned directed-interaction state
and never update real player beliefs. Leaf states use v4.1's existing four-seat evaluation and
standing-dependent objective. The root value is 75% v4.1 and 25% response value, with a 0.10
standard-deviation risk penalty. Once active, 65% of the original MCTS iteration allocation is kept
for the base search; no response re-ranking occurs until every opponent has at least three observed
non-pass moves.

Three controls differ only in the posterior supplied to the same response code:

1. **personalized:** the observed seat's own posterior;
2. **fixed:** the uniform prototype prior;
3. **shuffled:** the next seat's posterior in turn order.

The implementation must first pass legality, immutability, low-evidence identity, and fixed-budget
replay tests. A fresh cost screen uses six paired all-Oracle/all-v4.1 games beginning at seed
51,900,000. The initial playing screen uses 12 fresh seat-rotated seeds per arm: personalized versus
fixed beginning at 51,910,000, personalized versus shuffled at 51,920,000, and personalized versus
v4.1 at 51,930,000. Every block uses 60 base iterations, eight opening-sampled plies, and top-three
opening sampling. This small screen is a triage, not a promotion test: it authorizes a larger
confirmation only if personalization is directionally positive against both posterior controls,
every game finishes, and its measured move cost remains inside the intended 2–4 second production
envelope when scaled from the measured v4.1-ultra rung.
Any eventual v5 strength claim still requires a fresh, wall-clock-matched confirmation with a
game/seed bootstrap and human-style holdouts.

## Results — Experiment D

`MEASURED` All 156 games completed. In six all-player cost games, v4.1 used 18.5 ms/move and the
one-lap model used 77.6 ms/move at 60 base iterations (4.20×). The response layer activated on 343
calls and changed v4.1's selected move on **51.6%** of them. Each active call evaluated 33.4 leaf
states and spent 90.1 ms in response expansion on the per-process clock.

The seat-rotated strength screens were:

- personalized versus fixed: **−1.87 [−5.52, 1.48]**;
- personalized versus shuffled: **+1.83 [−2.19, 6.02]**;
- personalized versus v4.1: **−9.15 [−12.00, −6.26]**.

The preregistered triage fails. The positive shuffled comparison says profile identity can affect
play in the right direction, but the fixed-prior comparison does not replicate it and the large,
significant loss to v4.1 prohibits scaling this design. The response layer is far too influential:
a shallow static evaluation after likely replies replaces half of a long-horizon engine's choices.
The cost is acceptable relative to the eventual 2–4 second envelope, but extra compute is buying
worse decisions.

## Experiment E — terminal continuation response

**Preregistered after Experiment D failed and before this variant ran.** The sole response-value
change is to replace the static one-lap leaf evaluation with three seeded v4.1 terminal playouts per
beam leaf. Their four-seat backed values are averaged and converted to the same square-like scale as
the base root value. Seeds are derived from the leaf position, so every root candidate receives a
reproducible continuation audit without consuming or perturbing the base MCTS random stream. Root
width six, reply width three, beam width six, 25% response blend, 0.10 risk penalty, three-observation
warmup, and 65% base-search allocation remain fixed. This isolates the suspected horizon/value
contract error.

A response-disabled 65%-iteration arm is included to attribute any remaining loss to the reduced
base allocation. Fresh blocks use 60 base iterations and the same opening protocol:

- paired cost: six seeds beginning at 52,000,000;
- terminal personalized versus fixed: 12 rotated seeds at 52,010,000;
- terminal personalized versus shuffled: 12 rotated seeds at 52,020,000;
- terminal personalized versus v4.1: 12 rotated seeds at 52,030,000;
- response-disabled 65% budget versus v4.1: 12 rotated seeds at 52,040,000.

A larger confirmation is authorized only if terminal personalization is directionally positive
against fixed and shuffled, nonnegative against v4.1, every game completes, and the response layer
actually activates. The budget-only arm is diagnostic and does not participate in the gate.

## Results — Experiment E

`MEASURED` All 204 games completed. The terminal continuation reduced the all-player cost ratio to
3.55× at the small 60-iteration budget and still changed 50.9% of active choices. It evaluated 33.1
chance leaves and 99.3 terminal continuations per active call. The strength screens were:

- terminal personalized versus fixed: **−2.12 [−5.76, 1.06]**;
- terminal personalized versus shuffled: **−0.67 [−3.53, 1.87]**;
- terminal personalized versus v4.1: **−1.42 [−4.34, 1.40]**;
- response-disabled 65% budget versus v4.1: **−1.01 [−3.83, 1.11]**.

The horizon repair recovered almost the entire catastrophic Experiment D loss: the remaining
−1.42 is close to the −1.01 cost of withholding 35% of base iterations. It nevertheless fails both
identity controls. Prediction accuracy is not the remaining problem. The beam renormalizes only
modal replies even though historical-CPU top-five recall is 55.7%, and it adds a generic response
value even though v4.1 already models generic opponents. This creates selection bias and
double-counting; it is not a valid way to turn a calibrated density into a best response.

## Experiment F — counterfactual identity delta

**Preregistered after Experiment E failed and before this architecture ran.** The base v4.1 search
keeps 100% of its iterations. Opponent modeling can change a root value only by the estimated
counterfactual identity delta

`E[value | observed profile] − E[value | population prior]`.

For each of six base root candidates, twelve response scenarios are sampled from the 50/50 mixture
of the personalized and population policies. Sequential importance weights evaluate both policies
on the *same* sampled leaves and the same seeded terminal continuation, cancelling generic response
value and most Monte Carlo noise. Sampling uses each full legal distribution—no top-k truncation or
renormalization. The root adjustment is 0.25 times this delta and enters as a bounded addition to
log visit evidence with a four-square scale; it does not replace v4.1's visit-based selector with
raw mean-value sorting. Only the original six-move shortlist can be reordered. There is no
additional risk penalty.
The fixed-prior arm has identical target and reference distributions, so its adjustment must be
exactly zero and its played moves must reproduce v4.1 at a fixed seed.

Fresh 60-iteration blocks use six paired cost seeds at 52,100,000 and 12 rotated seeds each for
counterfactual personalized versus fixed at 52,110,000, versus shuffled at 52,120,000, and versus
v4.1 at 52,130,000. A larger confirmation is authorized only if the fixed identity test is exact,
all games complete, response calls activate, personalization is directionally positive against both
identity controls and v4.1, and fewer than 25% of active choices change. The change-rate cap is a
guard against another noisy auxiliary value taking over the base engine.

## Results — Experiment F

`MEASURED` Before the match, the active fixed-prior arm reproduced v4.1's complete ranked root
result exactly in a seeded test. All 156 match games then completed. At 60 base iterations, the full
distribution sampler cost 286.2 ms/move versus 17.2 ms/move for v4.1 (16.59×), activated on 352
calls in the cost block, and changed 24.4% of active choices. The strength screens were:

- counterfactual personalized versus fixed: **+0.14 [−1.44, 1.74]**;
- counterfactual personalized versus shuffled: **+1.92 [−0.58, 4.51]**;
- counterfactual personalized versus v4.1: **−1.06 [−2.93, 0.76]**.

The fixed and shuffled directions are encouraging, and the selector stays inside the change cap,
but the preregistered v4.1 mean is negative. Experiment F therefore fails and is not promoted. Its
cost is compatible with the proposed Oracle class—v4.1-ultra itself was measured at 437 ms/move—but
cost cannot rescue a directionally weaker policy.

## Foundation decision

The compact Bayesian observer establishes a real but small identity channel. On historical CPUs,
the identity-specific gain over a shuffled profile is only 0.027 nats/action, an average likelihood
ratio of about 1.027. That is enough to detect identity and to produce causal differences in play,
but not enough to justify aggressive best responses. Across three response designs, only the
counterfactual full-distribution version behaved safely, and it still did not beat v4.1.

No one-lap wrapper is a v5 candidate. Preserve the implemented versions as falsification evidence
and move the next development block to a richer *policy representation* plus belief-conditioned
tree search:

1. Train a small per-player trajectory encoder and legal-candidate scorer on a diverse engine/style
   league, with whole-player and whole-game splits. Compare a GRU/DeepSets baseline, an eight-expert
   latent mixture, and a two-layer causal transformer (roughly 96 hidden units, four heads).
2. Cache only the three real player-history encodings at runtime. A transformer KV cache is an
   incremental computation cache, not a database of games, and hypothetical tree moves must never
   mutate it.
3. Require a materially larger identity channel before search integration: shuffled-profile NLL
   gain lower bound above 0.06 nats/action, top-five recall above 65%, calibrated confidence, and
   graceful change-point reset on unseen hybrid styles.
4. Integrate the winning policy through root-sampled belief MCTS: sample one coherent latent policy
   per opponent per simulation, use that policy only at opponent nodes, preserve exact transitions
   and vector terminal scoring, and retain v4.1-ultra as the robust fallback particle.
5. Spend the 2–4 second budget on more exact simulations and policy particles. Do not spend it on a
   larger language model: the rules are exact, the history is short, and the missing capacity is a
   calibrated conditional action model, not natural-language memory.

This is the stopping boundary for the foundation cycle. The next online strength experiment begins
only after a learned trajectory model passes the stronger prediction and calibration gates above.
