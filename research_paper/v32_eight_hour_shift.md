# v3.2 eight-hour adaptive research shift

Started 2026-08-22 01:46 PDT. Baseline: v3.1-pro unless a result explicitly says otherwise.
Promotion requires equal wall-clock compute, deterministic replay, four seat rotations, fresh seed
blocks, and a reproduced positive result. Screens select experiments; they do not justify promotion.

## Experiment ledger

### A. Persistent subtree reuse

Implemented per-seat tree persistence with phase-boundary invalidation and root promotion. Promotion
rebuilds the wider 40-move root shortlist and transplants statistics only for surviving interior
moves, avoiding a hidden 24-vs-40 candidate-width change. Search state is reset between games.

Diagnostic results:

- Reduced probe (4 games, 100 base iterations): 16/285 roots reused (5.6%), 5.0 retained visits per
  hit and 0.28 per search.
- Full pro probe (2 games, 300 base iterations): 16/136 roots reused (11.8%), 7.63 retained visits
  per hit and 0.90 per search.

Decision: stop before tournament. At v3.1-pro's roughly 1,377 fresh iterations per move, 0.90 retained
visits per search recycles less than 0.1% of the budget. Full terminal rollouts make the tree broad
and shallow enough that the actually observed four-ply continuation is rarely present. This is a
structural failure of the candidate, not evidence against transposition sharing within a move.

### B. Remaining-piece feasibility prior

The child-state feature counts legal placements per remaining piece and scores diminishing
flexibility plus a strong penalty for large pieces with zero or one home. On 96 sampled v3.1-pro
roots, its within-root correlation with `log1p(visits)` was +0.127; the teacher's selected move fell
in its top five 58.3% of the time. Signal peaked in the midgame (+0.175).

The root-only feature cost about 8–12% before calibration, so candidates receive 4.0 rather than
4.59 iteration scale (13% fewer iterations). A repeated three-phase check placed both below baseline
wall time, with enough margin to tolerate benchmark noise.

Initial 16-seed / 64-game screens:

- Weight 2: +1.37 [−1.19, 3.77], 42.2% first place, 78.30 squares placed. Advance.
- Weight 4: −0.06 [−1.96, 1.73], 39.1% first place, 77.80 squares placed. Stop; no evidence that a
  stronger prior helps.

Fresh-seed confirmation for weight 2 (40 seeds / 160 games): **+0.13 [−0.96, 1.39]**, 24.4%
first place and 77.26 squares placed. Stop. The initial +1.37 screen did not reproduce, so neither
weight advances to a promotion-scale run. This is also a useful calibration example: the 16-seed
screen's interval was wide enough to contain both a meaningful gain and the confirmed near-null.

### C. Equal-compute independent-tree ensemble

Implemented two independent root trees and pooled their visit counts, dividing the total iteration
allowance rather than granting each tree a full budget. Repeated timing showed duplicate root setup
and shallow-tree overhead, so the ensemble was reduced from the baseline's 4.59 iteration scale to
4.0; its last fixed-position timing sample was 12.3% below baseline wall time.

The 16-seed / 64-game screen scored **−2.99 [−4.40, −1.54]**, with 17.2% first place and 75.23
squares placed. Reject. The effect is already significant at the screen gate and agrees with the
compute ladder's warning: two half-depth searches are substantially weaker than one full search.
Pooling independent noise does not repay repeatedly discovering the same wide root.

### D. Piece-family root allocation

Generalised the existing two-level spatial selector to allocate root simulations first by piece
identity and then by placement. The 16-seed / 64-game screen scored **−0.67 [−2.19, 1.04]**, with
23.4% first place and 75.95 squares placed. Stop. The interval is compatible with a small effect in
either direction, but the negative point estimate does not justify spending confirmation compute.

### E. Variance-tuned PUCT

Added per-node second moments and the UCB1-Tuned confidence factor to the existing PUCT exploration
term. A noisy first wall-time sample suggested overhead, so the first two blocks conservatively
received 4.1 rather than 4.59 iteration scale. Its 16-seed / 64-game screen scored
**+1.99 [0.30, 3.91]**, with 34.4% first place and 78.41 squares placed. Advance to a fresh-seed
confirmation. That 40-seed / 160-game block stayed positive at **+0.57 [−0.47, 1.64]**, 29.4%
first place and 77.70 squares placed. The two disjoint point estimates pool to roughly +0.98, but
the confirmation alone is not significant.

A more robust five-repeat benchmark used process CPU time as well as wall time. At scale 4.1 the
all-node candidate used 14.8% less CPU than v3.1-pro; the root-only arm at scale 4.5 used 6.0% less.
Normalised by iteration scale, both variance paths were slightly cheaper per iteration because they
traversed different tree shapes. Restore 4.59 for the next blocks: it remains about 4–5% below the
baseline CPU estimate and removes the conservative iteration handicap from the first two results.

Root-only attribution at the restored 4.59 scale scored **−1.08 [−2.09, −0.06]** over 24 seeds / 96
games, significantly worse. Reject the root-only form. The direction reversal localises the useful
mechanism below the root: variance-aware traversal of opponent continuations, not merely a different
best-arm allocator for the final move. The all-node form advances to a larger full-iteration block.

The decisive full-iteration block (100 fresh seeds / 400 games) scored **−0.11 [−0.72, 0.49]**,
29.0% first place and 77.27 squares placed. Pooling all three disjoint all-node blocks gives 156
seeds / 624 games and **+0.28 [−0.23, 0.80]**, 29.6% first place. Reject for v3.2: the primary
score-advantage statistic remains indistinguishable from zero, and the largest clean block itself is
slightly negative. The elevated inclusive first-place share is secondary and can be inflated by
ties; it does not override the precommitted promotion metric.

### F. First-play urgency reduction

The 0.05 arm produced exact rotational equality, **0.00 [−0.00, 0.00]**. Inspection explains why:
progressive widening opens a new child and immediately samples it, so PUCT never scores an unvisited
opened child and the FPU reduction branch cannot affect a move. Stop and cancel the redundant 0.10
arm. This is a structural no-op, not evidence that a live FPU implementation would be neutral.

### G. Piece-diverse progressive widening

Interleaved the best placement of each distinct piece ahead of duplicate-piece alternatives while
preserving every prior score. This zero-cost attempt to diversify the first opened root children
scored **−1.24 [−3.17, 0.70]** over 16 seeds / 64 games, with 26.6% first place. Stop. Together with
piece-family PUCT, both tested ways of forcing piece-level allocation have negative point estimates.

### H. Action-conditioned learned prior

The clean policy-only ablation—no audit, racing or grouping—scored **−0.59 [−1.87, 0.75]** over 40
seeds / 160 games, with 24.4% first place and 76.86 squares placed. Full learned-prior replacement
does not advance. This isolates and confirms the warning from the earlier bundled combinations:
60.98% held-out pair agreement is not sufficient to improve the search policy.

A phase diagnostic on the held-out tail found 56.8% pair agreement in the opening, 59.5% in the
midgame and 68.5% in the endgame; top-1 was 29.0%, 21.3% and 45.5%, respectively. Therefore retain
only two final policy questions: 25%/50% probability blends with the hand prior, and an endgame-only
gate. These are restrictions of the failed model, not new training claims.

Those restrictions also failed to advance: 25% blend **+0.24 [−1.90, 2.28]**, 50% blend **−0.47
[−2.36, 1.30]**, and endgame-only **+0.32 [−1.54, 2.09]**. The endgame gate's 36.5% inclusive
first-place rate is interesting but does not override its uncertain score advantage. Close this
policy artifact; improve labels or representation before another deployment sweep.

### I. Terminal-rollout epsilon

The original 0.15 randomness rate had never been fitted under full terminal rollouts. Bracketing it
at 0.05 scored **−1.01 [−3.34, 1.04]**; 0.30 scored **+1.08 [−0.60, 2.88]** over 16 seeds / 64
games, with 34.4% first place. Stop the low arm and advance 0.30 to a fresh 40-seed confirmation.

The 0.30 confirmation stayed positive at **+0.66 [−0.41, 1.68]**, 33.8% first place. Pooling the
two fixed blocks gives 56 seeds / 224 games and **+0.78 [−0.12, 1.67]**, 33.9% first place. This is
the most consistent lead of the shift but still does not clear zero, so it advances to one decisive
100-seed block rather than to a version name.

The decisive fresh block scored **+0.02 [−0.76, 0.85]** over 100 seeds / 400 games, with 24.5%
first place. Pooling all three disjoint blocks gives 156 seeds / 624 games and **+0.29 [−0.32,
0.91]**, 27.9% first place. Reject for v3.2. As with variance-tuned PUCT, the largest clean block
did not reproduce the smaller-screen lead. Retain 0.15 as the shipped value unless a phase-specific
arm demonstrates a reproducible gain; do not rename a pooled null.

### J. Piece-level Move-Average Sampling

Implemented online MAST statistics over `(seat, piece)` inside terminal playouts, reset at every
root search. A pre-tournament determinism audit caught and fixed an initial lifetime bug that would
have allowed statistics to leak across moves and games; no MAST match was run with the faulty
lifetime. The candidate now learns only from rollouts belonging to the current move, preserving the
seed-replay contract. Compute calibration and the 0.5/1.0 weight screens follow.

At the full 4.59 iteration scale, repeated CPU calibration put the 0.5 and 1.0 arms 4–6% below the
baseline CPU estimate. Their 16-seed screens were both positive: weight 0.5 **+1.61 [−0.05,
3.28]**, weight 1.0 **+0.74 [−0.46, 1.89]**. Advance only 0.5. Its fresh 40-seed / 160-game block
scored **−0.03 [−1.18, 1.18]**, with 30.0% first place. Reject the piece-level per-root form; the
screen again did not reproduce. Test exact-placement sharing and within-game persistence only as
mechanistic follow-ups, not as a wider weight sweep.

The within-game piece table was weak and uncertain at **+0.30 [−2.23, 3.07]** over 16 seeds, so it
stops. Exact-placement MAST—30,433 absolute placements rather than 21 piece identities—screened at
**+1.65 [−0.01, 3.42]**, then stayed positive on 40 fresh seeds at **+0.66 [−0.51, 1.89]**. The
two disjoint blocks pool to **+0.94 [−0.05, 1.99]**, 33.5% first place. This is still a null, but it
is the first online-learning candidate whose fresh block did not reverse direction. Give it one
100-seed decisive block, with no retry if that block fails.

The decisive 100-seed / 400-game block scored **−0.02 [−0.99, 1.00]**, with 29.3% first place.
Pooling all three blocks gives 156 seeds / 624 games and **+0.33 [−0.40, 1.07]**, 30.8% first
place. Reject all MAST variants for v3.2. The higher inclusive first-place rate again does not
translate into score advantage, and the largest block is effectively exact zero. Cancel the
variance+MAST combination and tier transfer: combining two independently null main effects is not
a justified use of confirmation compute.

### K. Piece-level RAVE

Implemented all-moves-as-first statistics over piece identities: a tree node learns from pieces the
same mover played later in the tree path or terminal rollout, then blends that estimate into PUCT
with a decaying pseudo-count. Determinism tests passed. At 4.3 iteration scale, CPU calibration was
3.4% below baseline for equivalence 10 and 0.5% below for equivalence 50. Over 24 seeds / 96 games,
equivalence 10 scored **+0.49 [−1.15, 2.30]** and equivalence 50 **−0.39 [−1.81, 1.20]**. Stop.
The weaker blend misses the precommitted +0.5 point gate and the stronger blend reverses; there is
no dose-response evidence worth confirming.

### L. Upper terminal-rollout epsilon bracket

Because ε=0.30 was neutral in its decisive block, bracketed the more-random regime rather than
assuming 0.15 was near an optimum. ε=0.45 was weak at **+0.28 [−2.03, 2.37]** over 16 seeds.
ε=0.60 screened at **+1.86 [−0.14, 4.09]**, then reproduced on 40 fresh seeds at **+1.17
[−0.20, 2.47]**. Pooling the disjoint blocks gives 56 seeds / 224 games and **+1.36 [0.29,
2.45]**, 32.1% first place. This is the first pooled interval of the shift to clear zero. Advance to
one fresh 100-seed block; promotion still requires that largest block to support the gain.

That decisive pro-tier block stayed positive at **+0.33 [−0.40, 1.08]** over 100 seeds / 400
games, 30.0% first place. Pooling all three blocks gives 156 seeds / 624 games and **+0.70 [0.10,
1.31]**, 30.8% first place. The largest block does not independently clear zero, so call this a
modest, provisional effect rather than a pro-tier knockout. All three point estimates are positive,
however, so advance to tier transfer.

At the standard tier, ε=0.60 scored **+0.77 [−0.41, 1.97]** over 40 seeds / 160 games. At the
critical pro-max tier it scored **+1.38 [0.02, 2.91]**, 36.9% first place: the first result of the
shift to significantly beat v3.1-pro-max. Run one larger, disjoint pro-max replication. If that
block is also positive and the pooled pro-max interval clears zero, the candidate satisfies the
report's reproduce-before-promotion rule and earns the v3.2 name.

The disjoint 100-seed / 400-game pro-max replication was positive at **+0.68 [−0.04, 1.42]**,
28.5% first place. Pooling the two pro-max blocks gives 140 seeds / 560 games and **+0.88 [0.25,
1.54]**, 30.9% first place. Both independent point estimates are positive and the pooled interval
clears zero at identical iteration budgets. This satisfies the predeclared promotion rule: the
60%-random terminal-rollout policy becomes canonical `v3.2`, `v3.2-pro`, and `v3.2-pro-max`.

Purely uniform terminal rollouts (ε=1.00) scored **+0.36 [−1.32, 2.23]** over 24 seeds / 96
games, 27.1% first place. This misses the +0.5 screen gate and stops. The useful regime is therefore
an interior mixture rather than evidence that all rollout heuristics should be removed: ε=0.60
appears to reduce systematic heuristic bias while retaining enough informed rollout moves to keep
terminal estimates useful.

Phase localization then separated the schedule. Raising ε only in the midgame scored **−1.46
[−3.02, 0.06]**; raising it in midgame and endgame scored **−0.99 [−3.32, 1.45]**. Raising it in
opening and midgame while restoring ε=0.15 in endgame scored **+2.55 [0.60, 4.76]**, 40.6% first
place. The contrast identifies opening randomness as necessary in this screen and suggests that
late-game heuristic rollouts regain value once fewer moves remain. Because each arm has only 16
seeds, confirm the winning schedule directly against canonical `v3.2-pro` on fresh seeds before
changing the promoted configuration.

The direct 40-seed / 160-game confirmation against canonical `v3.2-pro` scored **−0.10 [−0.27,
0.06]**, 28.1% first place. The very tight interval is expected because the two algorithms behave
identically until the endgame phase; changing only that late ε has almost no score effect on these
seeds. Do not replace the simpler all-phase `v3.2` schedule. The earlier +2.55 screen was selection
noise and/or a baseline-relative interaction that does not translate into an incremental v3.2 gain.

### M. v4.1 larger policy distillation

Exported 256 new v3.1-pro-max teacher games (204,820 rows / 18,482 root groups) as eight independent
32-game shards. Training used the old 82 games plus new shards A–G: 245,251 rows / 22,141 groups,
3.7 times the old model's data. Shard H—25,671 rows / 2,308 exported groups—remained entirely
untouched. The evaluator excludes single-child groups, leaving 2,265 roots and 135,071 ordered
sibling pairs for the external comparison.

Simply adding data with the old mixed policy/value objective made the policy worse on H: pair
accuracy fell from 60.44% to 58.41%, while root top-1 stayed at 26.36%. A shard-G-only
optimization audit identified the auxiliary outcome anchor as the conflict. Removing it and training
the same 42,020-parameter network purely on the visit-ranking objective raised untouched-H pair
accuracy to **61.45%** and root top-1 to **27.68%** after deterministic retraining. Improvements
appeared in every phase; midgame top-1 rose from 20.74% to 22.46%, and endgame pair accuracy from
68.67% to 70.76%.

A corrected RankNet experiment also exposed and fixed a padding bug (`NaN × 0` in invalid pairs),
but its shard-G gain over the simpler listwise model was immaterial and its top-1 was lower. Keep the
smaller listwise policy-only model. Its external improvement earns one online policy-prior gate on
top of `v3.2-pro`; it is not evidence for deployment by itself.

The final deterministic online gate stayed positive but below the advancement rule: **+0.12
[−1.02, 1.36]** over 40 seeds / 160 games against `v3.2-pro`, 26.9% first place. An earlier
pre-determinism realization scored +0.43 [−0.64, 1.59], also null; it is provenance rather than the
release result. Do not deploy or spend a decisive block. The policy-only objective is a real offline
recovery, but 61.45% pair agreement still does not show a significant playing-strength gain. Use the
remaining shift to separate teacher quality from data volume with separately auditable shards.

The controlled v4.2 export added 256 v3.2-pro-max games (207,534 rows / 18,641 groups). Its training
set had the same original 82 games plus 224 new games, the same 42,020-parameter network and the same
policy-only objective as v4.1; only the new teacher changed. On untouched v3.2 shard H, v4.1 scored
61.82% pair accuracy / 29.81% root top-1, while v4.2 scored **61.68% / 29.67%**. The −0.14-point
pair change and −0.13-point top-1 change are operationally flat. Phase effects also trade off:
v4.2 improves midgame top-1 but loses opening accuracy. Stop before an online match. The next
bottleneck is representation or target structure, not more games from a teacher only 0.88 points
stronger.
