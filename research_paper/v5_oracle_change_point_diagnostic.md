# Blokee v5 Oracle change-point diagnostic (post-K)

**Started:** 2026-08-28  
**Status:** diagnostic only on consumed data; no gate, no selection, no verdict change

## Purpose

Experiment K passed eight of nine gates and failed one: four observations after a behavior switch,
the selected GRU identified the new family **32.3%** of the time against a >50% bar. K's decision
proposed three repairs — surprise-triggered reset, sliding-window memory, or a fast/slow Bayes-GRU
mixture — and sent the next cycle to test them.

Three quantities needed to choose among those repairs were never measured. This note measures them
from the frozen K checkpoint. Nothing is trained, nothing is selected, and Experiment K's recorded
verdict is unchanged. Variant `d` is already consumed, so every number here is development
evidence: Experiment L must still preregister against a fresh variant and fresh switched
trajectories.

Reproduce with `npm run diagnose:v5-oracle-switch`.

## Finding 1 — the gate was fair, and the stickiness is real

`MEASURED` Clean family accuracy by observation count on the same 192 holdout trajectories:

| observations | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clean | 28.1% | 45.8% | 66.7% | **71.9%** | 78.6% | 80.7% | 81.2% | 80.7% |
| four moves after a switch | 19.8% | 25.0% | 27.6% | **32.3%** | 41.1% | 46.4% | 53.6% | 55.7% |
| still reports the *old* family | 49.0% | 26.6% | 17.2% | **9.4%** | 5.7% | 3.6% | 2.1% | 1.6% |

With four clean observations the model reaches 71.9%, so the >50% gate was achievable and the
failure is not evidence scarcity. But the third row rules out the obvious story: four observations
after a switch the state reports the previous family only 9.4% of the time. It has already
abandoned the old identity without acquiring the new one — roughly 58% of its predictions are some
third family. The contaminated prefix produces an off-manifold latent rather than a stale one.

Recovery is slow. Twelve observations after a switch the model reaches 55.7% against 80.7% clean.

## Finding 2 — a surprise detector has almost no signal to fire on

`MEASURED` Action NLL of the new player's moves, by turns elapsed since the switch, under a
contaminated state, a clean state, and the fixed population model:

| turns since switch | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| contaminated | 2.134 | 2.101 | 1.947 | 2.509 | 2.674 | 2.535 |
| clean | 1.922 | 2.078 | 1.892 | 2.479 | 2.614 | 2.363 |
| fixed population | 1.920 | 2.102 | 2.065 | 2.473 | 2.739 | 2.497 |
| contaminated − clean | +0.211 | +0.023 | +0.055 | +0.030 | +0.060 | +0.173 |

Contamination costs **+0.211 nats at the switch itself and +0.02 to +0.17 afterwards**, while
ordinary turn-to-turn NLL moves between 1.9 and 2.7. The change-point signal is far smaller than
the background variation a per-observation threshold would have to see through. A
surprise-triggered reset should be demoted from K's list rather than tested first.

Two secondary readings matter. At the switch moment the contaminated state is *worse than using no
history at all* (2.134 against 1.920), which is exactly the operational hazard K described. But
action likelihood re-converges within one or two observations, while family identification stays
wrong for many. The sticky component is the auxiliary family head, not the action policy.

## Finding 3 — no fixed sliding window can satisfy both of L's constraints

`MEASURED` Re-encoding every turn from only its last `w` observations, on stable holdout players:

| window | 3 | 4 | 6 | 8 | 12 | full |
| --- | --- | --- | --- | --- | --- | --- |
| stable NLL, turns ≥ 3 | 1.9754 | 1.9548 | 1.9311 | 1.9100 | 1.8934 | **1.8811** |
| cost against full history | +0.0942 | +0.0737 | +0.0500 | +0.0289 | +0.0123 | 0 |
| mid-game family accuracy | 50.0% | 53.1% | 57.8% | 81.2% | 81.2% | 81.2% |

K's follow-up allows at most **0.01 nats/action** of stable-history degradation. A window short
enough to let four post-switch observations dominate costs **+0.074**, more than seven times that
budget. Even a twelve-observation window costs +0.012 and still misses it. There is no fixed window
that repairs switching and preserves stable likelihood.

The same table exposes a clean separation of concerns: family identification saturates at eight
observations (81.2%, identical to full history), while action likelihood keeps improving all the
way to full history. **The two heads want different memory horizons.**

The mid-game family accuracy at window 4 (53.1%) is lower than the 71.9% first-four-observation
figure in Finding 1 because they measure different things: opening behavior is more diagnostic than
an arbitrary mid-game window of the same length.

## Consequences for Experiment L

1. **Surprise-triggered reset is the weakest of the three candidates**, not the first to try. Its
   detector would operate on a +0.02 to +0.21 signal against ±0.8 of ordinary variation.
2. **A fixed sliding window cannot pass both gates** and should be run only as a diagnostic arm.
3. **A two-timescale architecture is the design the evidence supports**: a slow full-history path
   carrying the action residual, so stable NLL is preserved by construction, plus a fast
   short-horizon path carrying identity, which saturates at eight observations anyway.
4. **The likely root cause is training data, not inference.** Every training sequence has one
   constant family, and the auxiliary head is trained against one constant label. The model has
   never seen a switch. Before adding inference-time machinery, train on trajectories that switch,
   with time-varying family labels.
5. **The current switch test is harder and less realistic than the real scenario.** It concatenates
   action embeddings from two different players in two different games, so the spliced trajectory
   is not a coherent game. A true mid-game personality switch is a small change to the export path,
   because the personality is already supplied per move in `choosePolicyMove`. Generating real
   switch games fixes both the training gap in point 4 and the validity of the test.
6. **The 0.01 stable-NLL budget was set without this evidence.** It is satisfiable by a two-timescale
   design whose slow path is untouched, but not by any window or reset scheme measured here. It
   should be re-affirmed deliberately rather than inherited.

## Implemented — real switching trajectories

`BUILT` The change-point generator described in point 5 now exists. A seat may carry a
`StrategicPersonalitySchedule` instead of a fixed personality, and the objective changes on that
seat's own move count rather than the global ply, so the change point is expressed in the same
units as every observation-count metric in this programme.

- `src/ai/oracle/strategicPersonalities.ts` — the schedule type and `activeStrategicPersonality`.
- `src/ai/selfplay.ts` — per-seat move counts, per-move objective resolution, and the active
  objective passed to `onMove` so recorded labels follow the objective actually in force.
- `scripts/oracleTrajectoryExport.ts` — the `personality-switch` league at seed base 56,000,000.
  Each family is paired with the family four places away, so every pair crosses the
  spatial/interaction divide: expansion↔retaliator, center↔persistent, edge↔next-hunter,
  blocker↔tempo. `--switch-after` sets the change point and defaults to the seat's sixth move.

Because the exported label follows the active objective, the change point is recoverable from the
decision rows alone and training labels can be time-varying without a new binary contract. The
intended schedule is also written to `meta.switchPairs` for validation.

`MEASURED` A twelve-game smoke export produced 803 decisions with zero played moves outside their
legal sets. All 48 player-trajectories changed profile exactly once, every one of them at turn
index 6. A unit test replays the same seed with and without a schedule and confirms the games are
identical before the change point and genuinely divergent after it, so the switch changes play
rather than only the label.

This is generation only. It selects nothing and measures no gate.

Run it with `npm run export:v5-oracle-switch-games`.

## Calibration on real switches — the splice test was optimistic

`MEASURED` The frozen Experiment K checkpoint, run against the 16 development-variant-`c` games in
the 48-game corpus (64 seat-trajectories, all switching exactly once at the seat's sixth move, zero
missing played actions). Reproduce the corpus and calibration in sequence with
`npm run export:v5-oracle-switch-games` and `npm run calibrate:v5-oracle-switch`.

| observations | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clean, pre-switch segment | 31.2% | 62.5% | 73.4% | **73.4%** | 73.4% | 84.4% | — | — | — |
| new family, after a real switch | 0.0% | 0.0% | 0.0% | **0.0%** | 1.6% | 3.2% | 3.3% | 6.5% | 11.1% |
| still reporting the old family | 78.1% | 79.7% | 75.0% | **67.2%** | 60.9% | 53.2% | 43.3% | 41.3% | 29.6% |

Action NLL after the switch, against the same fixed population model:

| turns after switch | 0 | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- | --- |
| with history | 5.448 | 4.741 | 3.059 | 3.142 | 2.934 |
| fixed population | 4.479 | 3.920 | 2.612 | 2.663 | 2.507 |
| history minus fixed | **+0.969** | **+0.821** | **+0.448** | **+0.478** | **+0.427** |

`DIAGNOSIS` The expectation recorded above — that a real switch would be an easier problem than a
spliced one — was wrong, and in an informative direction. Real switching is **substantially
harder**:

- Four observations after a real switch the model identifies the new family **0.0%** of the time,
  against 32.3% on spliced prefixes.
- It reports the *old* family **67.2%** of the time, against 9.4% on splices.

The splice test destabilized the state rather than misleading it. An incoherent four-move prefix
borrowed from another game pushed the latent off-manifold, which knocked the old identity out
(9.4%) and occasionally let the correct new family win by default. A real switch does the
opposite: six coherent moves in the same game establish the old identity confidently, and the
model then holds that confident wrong answer for many moves. The earlier "off-manifold, not stale"
reading describes the splice artefact, not the phenomenon.

The action-likelihood consequence is correspondingly larger. Using the stale history is worse than
using no history at all for at least five moves after the switch — by **+0.43 to +0.97 nats/action**
against the splice test's +0.02 to +0.21. Experiment K's concern that "search exploitation would
remain confidently wrong after a midgame switch" is confirmed on real data, more strongly than the
evidence available when it was written.

Two notes for Experiment L's design. Turn offset **0 is not repairable by any mechanism** — no
detector can act before a single post-switch observation exists — so it should be reported as a
floor rather than gated. And the clean control here is limited to six observations because the
pre-switch segment is only six moves long; L's holdout block should include stable, non-switching
profiles so the matched clean control is available at every observation count.

## Prepared — sealed variant `e` holdout source

`BUILT` Variant `e` is defined for Experiment L but no `e` trajectory has been generated or read.
Its mixture is fixed at strategic strength **1.25**, base-rank weight **0.62**, and secondary-family
weight **0.10**. All three values differ from variant `d` while staying inside the ranges established
by development variants, so the holdout tests generalization without making parameter extremity the
dominant distribution shift.

Two explicit export routes are present but remain unopened until L is preregistered:

- `npm run export:v5-oracle-l-holdout-stable` — 48 stable variant-`e` games;
- `npm run export:v5-oracle-l-holdout-switch` — 48 real-switch variant-`e` games.

Both use seed base **57,000,000**, the same seat schedule, and the same opening sampler. Their
pre-switch prefixes are therefore paired; the stable block supplies clean controls beyond six
observations, while the switching block measures recovery. Merely defining the source and commands
does not consume the holdout. Experiment L's protocol is now written, but neither export may run
until its implementation and consumed variant-`c` readiness block pass.

## Scope limit

These are development numbers on consumed data and cannot authorize anything. The calibration
split is internally named `holdout`, but it is consumed variant `c`, not Experiment L's future
fresh holdout. These results also inherit
K's premise: the league is synthetic, and its families were authored to differ along the same
interaction features the model observes. Experiment I measured the opposite condition — nearby
real CPU configurations remained indistinguishable at +0.0018 nats/action even with rich board and
geometry observations. K demonstrates that the architecture can exploit identity when identity is
present. It does not re-open the question I closed, which is whether real opponents carry a
comparable signal.
