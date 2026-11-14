# v6 — native engine, scaled self-play data, and learned priors: preregistration

Written 2026-10-18, before any of the measurements below were taken. Results go in
`v6_native_and_learning_results.md`; this file is not edited after the runs start, except to append
the dated addendum section at the end.

## Why

The v4 and v5 programmes ended with the same diagnosis from two directions. Every learned component
was trained on a few hundred games (`v4_learning_programme.md`: ~393 independent outcomes; the v5
transformer arm had 96 sequences), its labels came from a noisy, truncated teacher (top-12 of
~40 root children; the oracle's move fell outside the top 12 in 46.3% of positions), and its
3×3 trunk could not see past a 7×7 window. None of those is a model-size problem. All of them are
cheaper to fix with a faster engine, which is why E0 comes first.

## E0 — native engine (completed before this document; recorded for the record)

`engine-rs/` ports the bitboard engine's play path to Rust. The gate was exactness, not speed:

- `cargo test --release` matches TS fixtures from `scripts/dumpGoldens.ts` bit-for-bit: placement
  table and Zobrist keys, RNG stream, legal moves, territory, E_i in all three phases, move
  ordering with Δsplit, the greedy ranker, playouts (including the RNG state after each), full
  searches (ranked root, visits, values, RNG state after), and five whole seeded games.
- Cross-engine matches: 40/40 (`v4.1-ultra` vs `v3.5`, 30 base iterations) and 8/8 (`v4.1-ultra`
  mirror, 300) games identical in every score; the native mirror prints exactly 0.00.
- Two V8 behaviours had to be reproduced, not assumed: `Math.exp` is fdlibm *with FMA contraction
  of the polynomial* (Node 25, arm64), and `Math.pow` is the platform libm. Probed on 250k values.

Speed is a measurement, not a gate: per-iteration cost on fixed positions fell from 145 / 125 / 94 µs
(TS) to 24.6 / 22.0 / 17.2 µs (opening / midgame / late); a `v4.1-ultra` mirror match at 300 base
iterations took 34 s of CPU against 191 s.

## Settle fix — `v4.1-ultra-settlefix` vs `v4.1-ultra`

Found while porting: `V12Search.iterate` replays a node's cached settle only while the node is
uninitialised, so on later visits a move generated for `node.turn` is applied with `position.turn`
pointing at a seat that was settled out. Instrumented on four `v4.1-ultra` self-play games this is
1.8%, 5.6%, 6.2% and 3.0% of tree descents. `search.replaySettle: true` re-applies the cache on
every descent; `false` (every existing version) is byte-identical.

- Match: 200 seeds × 4 seats, base 300 iterations, seeds 71,234,567–71,234,766 (outside the tuner's
  `g·100,000 + i` lattice and outside every training seed below), native engine.
- **Pass** if the 95% CI lower bound is above 0. A pass is a candidate only: promotion additionally
  requires a fresh, disjoint 200-seed block with the same verdict.
- A null is informative too: it would mean the corrupted tail of the tree is too rarely selected to
  matter at this budget.

## E1 — is the learned policy data-limited?

- Data: 20,000 native `v4.1-ultra` self-play games at base 300 (4,800 iterations per searched
  move), seeds 61,000,000–61,019,999, opening sampling as in the match harness (first 8 plies from
  the top 3). Each record keeps every root child with its visit count (up to 40), not a top-12.
- Split by game: games 19,000–19,999 test, 18,500–18,999 validation (checkpoint selection only),
  training on games 0…N−1.
- Arm: `conv-small` (v4.5-class: three 3×3 conv layers at width 16, footprint-pooled policy),
  20,000 steps at N = 1,000, 5,000 and 18,500; `resnet` (8 global-pooling residual blocks, width 96)
  at N = 5,000 and 18,500 with 8,000 steps.
- Metric: test policy KL(visits ‖ model) and top-1 agreement on search decisions.
- **Reading, fixed in advance:** if KL at N = 18,500 is not clearly below KL at N = 1,000 for
  `conv-small` (less than a 0.02 nat improvement), the v4 ceiling was the inputs or the trunk, not
  the data, and scaling data alone is closed. If it improves and keeps improving to 18,500, the
  v4 programme was data-starved.

## E2 — does global attention help at matched compute?

- Same data and split. Arms at roughly equal GPU time (~45–50 min each on the M4 Pro):
  `resnet` 8,000 steps, `vit-patch` (2×2 patches, d 192, 6 layers) 6,000 steps, `vit-cell`
  (400 cell tokens, d 128, 6 layers) 3,000 steps; all at N = 18,500.
- Metrics: test policy KL, top-1/top-5, value R² of the mover's final margin, ownership accuracy,
  and forward throughput (positions/s, batch 512, on the GPU).
- **Selection:** the arm with the lowest test policy KL, unless another arm is within 0.01 nats and
  at least 2× faster, in which case the faster arm. That arm goes to E3a.

## E3a — learned root prior inside the incumbent search

- Challenger: `v4.1-ultra` with the selected E2 network blended into the root PUCT prior
  (`native.prior`, same semantics as TS `netPrior`/`netPriorBlend`), served by `ml/torch/serve.py`.
  Blends 0.25 and 0.5 at temperature 1.0, no pseudo-visits.
- Champion: `v4.1-ultra`. Base 300 iterations; the challenger's network call is extra wall-clock
  that is reported, not charged against its iteration budget (the prior is one batched call per
  move, against 4,800 iterations).
- Screen: 100 seeds per blend, seeds 72,345,678 onward. **Pass** if mean ≥ +0.50 with the CI lower
  bound above 0. A passing blend then gets a fresh 200-seed confirmation on disjoint seeds.
- History says to expect a null: the v4.x root-prior channel measured +0.12 to +0.20 at best, and
  deleting the prior entirely cost only −0.12. A pass here would mean the old prior was limited by
  its training, not by how much the root prior can matter.

## What is explicitly not claimed

- Nothing here is measured against humans. All teachers and opponents are engines.
- A better offline KL is not a strength result; the repo has already seen offline gains of 4.8 pp
  pair accuracy turn into −0.27 online. Only matches count.

## Addendum

(Dated entries only, below this line.)

- **2026-10-18, settle fix screen read; confirmation fixed before it runs.** The screen block
  (seeds 71,234,567–71,234,766) measured +0.29 [0.17, 0.43]. The confirmation block is seeds
  71,334,567–71,334,766 with the same configs, budget and gate (95% CI lower bound above 0).
- **2026-10-18, settle fix confirmed.** Confirmation block measured +0.27 [0.14, 0.42]; both blocks
  pass, so `v4.1-ultra-settlefix` meets the promotion rule. E3a still uses `v4.1-ultra` as written
  above, so its result stays comparable to this preregistration.
- **2026-10-18, E3a read; E4 gate fixed before it runs.** E3a: blend 0.25 +0.18 [−0.56, 0.95],
  blend 0.5 +0.24 [−0.53, 1.03]; both null. `v4.1-ultra-settlefix` is promoted as `v4.2-ultra`.
  E4 (`ml/torch/expert_iteration.sh`, runbook `docs/E4_RUNBOOK.md`) starts from
  `resnet-g18500-s0.pt` with `v4.2-ultra` as the search. It runs 8 generations × 2,000 games at
  base 300, with 4,000 steps per generation, a replay window of 3, the 20k corpus as base data, and
  blend 0.5 at temperature 1. Generation gates use 50 seeds and keep a challenger if its mean is
  above 0; they decide the path, not the result. **E4 result:** the final network as a served
  prior of `v4.2-ultra` against plain `v4.2-ultra`, 200 seeds from 74,000,000. **Pass** if the mean
  is ≥ +0.50 with the CI lower bound above 0, then a confirmation on 200 fresh seeds from
  74,100,000 with the same verdict. If no generation is accepted, the reading is that the root
  prior channel does not respond to self-improvement at this scale, and the next experiment is
  E3b.
- **2026-10-18, E4 read; powered confirmation fixed before it runs.**
  - The E4 final measured +0.83 [0.30, 1.37], and its confirmation measured +0.41 [−0.11, 0.94].
    Under the rule above, E4 is **not confirmed**, and that verdict stands whatever happens below.
  - Why a second confirmation: at 200 seeds the minimum detectable effect (80% power) is about
    0.95, so neither 200-seed block could reliably detect the +0.50 effect the gate requires.
  - The test: the same served `ei-gen6` (`final.json`, blend 0.5, temperature 1) against plain
    `v4.2-ultra`, budget 300, on **800 seeds from 74,200,000** (74,200,000–74,200,799). This block
    is disjoint from every earlier block, and the expected minimum detectable effect is about 0.48.
    It is read on its own; it is not pooled with the earlier blocks.
  - **Pass** if the mean is ≥ +0.50 and the CI lower bound is above 0. A pass makes `ei-gen6` as
    a served prior a promotion candidate, recorded as "passed screen, failed the underpowered
    confirmation, passed the powered one".
  - If the mean is above 0 but the gate is not met, the reading is that expert iteration helps
    below the bar this programme set, and E3b is next.
  - If the mean is at or below 0, the +0.83 screen was noise.
- **2026-11-12, E3b replaced by E6; X1, E5 and E6 fixed before any of them runs.** Written on the
  Mac (M4 Pro) at `66fe52c`. The E4 games and `ei-gen6.pt` are on the PC, so everything below uses
  the 20k base corpus (`ml/data/selfplay-v41u-300`) unless a later dated entry says otherwise.
  - **Why E3b is not run.** E3b truncates the rollout and substitutes the network for the tail.
    That is the v4.7 tail-replacement design (−4.46 to −16.17), and it needs a network call on
    every iteration. E6 keeps every rollout and adds the network as a second evaluator.
  - **Exploratory measurement that motivated E6 (not preregistered, descriptive only).** On base
    games 19,000–19,999 (58,726 searched positions), linear R² for the mover's final
    `score − mean(others)`: search `root_value` 0.413, `resnet-g18500-s0` value head 0.448, both
    0.471. The net adds +0.057 [0.049, 0.067] over the search value (bootstrap by game). This is
    outcome prediction, not sibling ranking (see E14b), so it is not a strength claim.
  - **X1 — external benchmark against Pentobi.**
    - Engine: `pentobi-gtp`, game `classic`, one thread, `--noresign`, otherwise default settings
      (its opening book stays on if it has one for Classic). The release tag and
      `pentobi-gtp --version` are recorded with the results. Pentobi's seed is the game seed.
    - Bridge: `blokee-pentobi`. Blokee seats sample their first plies as the match harness does
      (first 8 plies from the top 3); Pentobi seats play what Pentobi returns.
    - **Validity gate, before any match is read:** 20 complete `v4.2-ultra` self-play games
      replayed into Pentobi with illegal moves rejected. Every move accepted, no pass
      disagreement, and the same final rank order. If the gate fails, X1 has no result.
    - Timing pilot: 10 seeds from 79,900,000, `v4.2-ultra` in one seat against three Pentobi
      level 9 seats. It sizes the run and gives ms/move; its scores are not pooled.
    - **X1a:** 1 × `v4.2-ultra` vs 3 × Pentobi level 9, seat-rotated, 100 seeds
      79,000,000–79,000,099, budget 300. **X1b:** 1 × Pentobi level 9 vs 3 × `v4.2-ultra`, same
      seeds. **Ladder:** as X1a at level 5 (40 seeds from 79,100,000) and level 7 (40 seeds from
      79,200,000). If the pilot shows 400 games would take more than 12 hours, X1a and X1b drop to
      40 seeds each and that is stated with the result.
    - Statistic: `scripts/aggregateMatches.ts` on Blokee's own scoring.
    - **"`v4.2-ultra` beats Pentobi level 9"** = X1a advantage CI lower bound above 0 and
      first-place share above 25%, with X1b's Pentobi advantage CI not lying wholly above 0.
      Levels fix simulation counts, so this is not an equal-time claim; ms/move is reported for both.
    - Later candidates play the X1a block as a secondary, ungated measurement.
  - **E5 — model v2 (offline; no strength claim).**
    - Arm `resnet2-b8w96`: the E2 trunk plus an absolute-seat one-hot in the global input, and
      heads for policy, soft policy (target^(1/4)), the four margins, a 4 × 3 utility block
      (`E[sigmoid((s − best other)/12)]`, rank fraction, P(first) with ties split), the mover's
      search `root_value`, and ownership.
    - Data and split as E1: train on base games 0–18,499, validate on 18,500–18,999, test on
      19,000–19,999. 15,000 steps at batch 512, EMA of the weights, checkpoint by validation loss.
    - Reported on test: policy KL, top-1, top-5, margin R², Brier score of each utility head, and
      the increment over `root_value` as above. E5 passes on to E6 whatever it measures; the
      larger arms (`b12w128`, `b16w160`) and the 36k-game run wait for the PC or the E4 data.
  - **E6 — the network inside the rollout search.**
    - One batched call per searched move: the root and each root child (at most 41 positions).
    - *Root prior:* blend 0.5, temperature 1 (as E3a/E4).
    - *Depth-1 policy:* each root child's own prior is blended 0.5 at temperature 1 with the
      net's, and its children are re-sorted by the blended prior.
    - *Root-child value:* `Q = (W + n_v·u) / (N + n_v)` in selection only, where
      `u = (1−β)·margin head + β·rank head` for the root seat, re-centred so the root children's
      mean `u` equals the root's current rollout mean. The move played is still chosen by real
      visits.
    - Identity gates: no `native.net` block is byte-identical to today (parity tests, 0.00
      mirror); `native.net` with depth-1 blend 0 and `n_v` 0 plays the same games as the equivalent
      `native.prior` config.
    - **Screen:** 400 seeds 76,000,000–76,000,399, budget 300, each arm against plain
      `v4.2-ultra`: P0 (root prior only), P1 (+ depth-1 policy), V64 and V512 (+ root-child value),
      PV (depth-1 policy + the better `n_v`).
    - **An arm advances** only if its seed-paired difference against P0 has a 95% CI lower bound
      above 0. Among advancing arms the one with the highest mean against `v4.2-ultra` is the
      candidate. If none advances, E6 is null: the new channels add nothing over a root prior.
    - **Confirmation and gate:** the candidate against plain `v4.2-ultra` on 800 seeds
      77,000,000–77,000,799. **Pass** if the mean is ≥ +0.50 with the CI lower bound above 0.
      Per-seat effects against a same-seed mirror (`ml/seat/seat_report.py`), network evaluations
      per move and ms/move are reported and not gated.
    - A positive mean below the bar reads as "helps, below the bar", as in E4.
  - **E7 (expert iteration with the E6 search)** runs only if an E6 arm advances, and gets its
    own dated entry before it starts.
- **2026-11-12, X1 moved from Pentobi level 9 to level 6, fixed before any level-6 game.**
  - The validity gate passed (20/20 replays, legal-move sets equal at all 1,612 plies, scores
    equal to Pentobi's minus 89; Pentobi 31.0, tag `v31.0`).
  - **Level 9 was stopped at Paul's request during the timing pilot**, after 18 of its 40 games
    (4 complete seeds). X1a and X1b at level 9 were not started. What the pilot showed is
    descriptive only, as fixed above: `v4.2-ultra` −25.10 [−32.50, −17.71] over 16 games, no first
    places, at 81 ms/move against Pentobi's 9,940 ms/move (GPU training running, 3 parallel games).
  - Why: Pentobi's level sets a simulation count. For Classic the base counts for levels 5–9 are
    667, 5,028, 69,809, 349,044 and 1,745,221 per move, scaled by `0.7·exp(0.1·i)` for a seat's
    i-th move (and by 0.2, 0.2, 0.3 on moves 0–2). `v4.2-ultra` runs 4,800 iterations per searched
    move. Level 9 is therefore a 400–1,100× simulation handicap, and level 6 is the closest level:
    5,028 base, about twice Blokee's count averaged over a game once the scaling is applied.
  - **X1-L6a:** 1 × `v4.2-ultra` vs 3 × Pentobi level 6, seat-rotated, 100 seeds
    79,000,000–79,000,099, budget 300. **X1-L6b:** 1 × Pentobi level 6 vs 3 × `v4.2-ultra`, same
    seeds. These seeds were reserved for X1a/X1b and have not been played.
  - Everything else is as in the X1 entry above: engine settings, opening book on, bridge,
    statistic, and the ladder (level 5: 40 seeds from 79,100,000; level 7: 40 seeds from
    79,200,000). The level-9 pilot and the 12-hour fallback rule no longer apply.
  - **"`v4.2-ultra` beats Pentobi level 6"** = X1-L6a advantage CI lower bound above 0 and
    first-place share above 25%, with X1-L6b's Pentobi advantage CI not lying wholly above 0.
    ms/move is reported for both engines; this is close to equal simulations, not equal time.
- **2026-11-12, PC runs fixed before they start: E5 larger arms and a confirmation of the E6
  control arm.** Written while the E6 screen was still running on the Mac (P0 complete, P1 half
  played, no value arm read).
  - **E5 on the PC (offline; no strength claim).** Arms `resnet2-b8w96`, `resnet2-b12w128` and
    `resnet2-b16w160`, each trained on base games 0–18,499 plus all eight E4 generations
    (`ml/data/expert-iteration/gen-0` … `gen-7`) as extra training runs; validation on base games
    18,500–18,999 and test on 19,000–19,999 as before. 15,000 steps at batch 512, EMA, checkpoint
    by validation loss. The PC's base corpus was regenerated there and differs from the Mac's by
    14 positions, so its metrics are compared arm against arm on the PC, not digit for digit with
    the Mac's. **Selection:** lowest validation loss; a smaller arm wins if it is within 1% and at
    least 2× faster. The selected network replaces the Mac `resnet2-b8w96` only in experiments
    that say so in advance.
  - **E6-P0 confirmation.** The screen's control arm (root prior only, blend 0.5, temperature 1,
    served from `ml/torch/results/resnet2-b8w96-g18500-s0.pt`, the Mac checkpoint) measured
    +0.88 [0.50, 1.27] over 400 seeds. It is the control, not the E6 candidate, so this is a
    separate test: the same config against plain `v4.2-ultra` on **800 seeds
    77,100,000–77,100,799**, budget 300, on the PC. The block 77,000,000–77,000,799 stays
    reserved for the screen's candidate. **Pass** if the mean is ≥ +0.50 with the CI lower bound
    above 0. It is read on its own and not pooled with the Mac screen. A pass makes "v2 network as
    a root prior" a promotion candidate over `v4.2-ultra`; it says nothing about the depth-1 or
    value channels.
  - **Exploratory, not gated:** `ei-gen6` (the E4 network, `native.prior` blend 0.5) and plain
    `v4.2-ultra`, each as the lone seat against three Pentobi level-6 seats on 100 seeds from
    79,400,000, both played on the PC, read as a seed-paired difference.
- **2026-11-13 00:05 CST, overnight runs on the Mac fixed before they are read.** S1 has three
  arms scored and E6 is on its V64 arm; neither screen has been read beyond the E6 control and
  the partial `W96` figure already recorded.
  - **S1 follow-up.** Any S1 arm whose seed-paired difference against `base` has a 95% CI lower
    bound above 0 gets a confirmation: that arm and `base`, each as the lone seat against three
    Pentobi level-6 seats, on 200 fresh seeds 79,700,000–79,700,199. **Confirmed** if the paired
    difference's CI lower bound is above 0 there. Confirmed arms are config-only candidates; they
    are reported with ms/move and are not a version by themselves.
  - **P4/P5 — the first v5.0 port: candidate generation and priors.** Mechanism: every legal move
    of the root enters the tree; each child starts with `n0` virtual visits at a value derived
    from a move prior; the prior comes from move features whose weights are fitted by us on
    Pentobi's recorded moves (multinomial logit, split by game). No Pentobi source code or weight
    table is copied. With the option off the engine is byte-identical (parity tests, 0.00 mirror).
    - Offline report: top-1 and top-5 accuracy of the fitted prior and of today's ordering at
      predicting Pentobi's move on held-out games. Not a strength claim.
    - **Screen:** arms against three Pentobi level-6 seats on 100 seeds 79,500,000–79,500,099,
      with `base` (`v4.2-ultra`) on the same seeds. Arms are fixed by the implementer before the
      first screen game and listed in the results: at least (a) full root expansion with today's
      ordering as the prior, (b) the fitted prior in today's shortlist tree, (c) both.
    - **Confirmation:** the arm with the best paired difference, and `base`, on 200 fresh seeds
      79,600,000–79,600,199. **The port is accepted for v5.0** if the paired difference's CI lower
      bound is above 0 and its ms/move is at most 1.25× base. The same arm against `v4.2-ultra`
      directly (`blokee-match`, 200 seeds from 80,000,000) is reported, not gated.
  - **N10 — re-fitting weights against Pentobi (exploratory).** A cross-entropy-method search over
    move-ordering and evaluation weights with fitness = advantage against three level-6 seats.
    Tuning seeds come from 81,000,000 upward and are never reused for validation. The best config
    is validated once on 200 fresh seeds 79,800,000–79,800,199, paired with `base`. Generation-best
    fitness is never quoted as a result.
- **2026-11-13 01:04 CST, N10 starting point and S1 confirmation arms, fixed before either runs.**
  Read so far: the S1 screen (complete) and the E6 arms P1, V64, V512 against P0. Seen but not
  read as a result: one progress line of the P4/P5 screen (arm `FULLfitI`, 220 of 400 games).
  - **S1 confirmation arms.** Two arms cleared the screen rule: `W96` (+2.03 [+0.45, +3.49]) and
    `W400open` (+1.81 [+0.38, +3.30]). Both, with `base`, play seeds 79,700,000–79,700,199 with
    the same binary as the screen. Eleven arms were screened, so the screen figures are
    selection-biased; only the confirmation is quoted as an effect.
  - **N10 starting point.** The config the tuner starts from is, in this order: the P4/P5 arm if
    it is accepted; otherwise `v4.2-ultra` with the confirmed S1 arm that has the larger
    confirmation difference; otherwise `v4.2-ultra`. Only parameters that change play in that
    starting config are tuned (a parameter whose perturbation leaves every game identical is
    dropped), at most 24 dimensions.
  - **N10 validation.** The tuned config and its starting point play seeds
    79,800,000–79,800,199; `v4.2-ultra` plays them too if it is not the starting point. The
    tuning is **kept** if the paired difference against the starting point has a CI lower bound
    above 0. One validation only: the config validated is the final generation's distribution
    mean, not the best-scoring individual.
- **2026-11-13 04:55 CST, S2 (config screen on the P4/P5 base) fixed before it runs; N10 deferred.**
  Read so far: the P4/P5 screen, its confirmation (`FULLfit` +5.32 [+4.30, +6.31] against base on
  seeds 79,600,000–199, 0.93× base ms/move: accepted) and the direct match against `v4.2-ultra`
  (+2.13 [1.55, 2.75]). The S1 confirmation had not started (a wait loop of mine never released);
  it was started at 04:48 unchanged. Both implementation agents were stopped by a usage limit from
  about 01:10 to 04:40.
  - **S2.** Base = `v4.2-ultra` + the accepted `FULLfit` candidates block. At most six
    single-change config arms, fixed by the implementer in a file before the first screen game
    after a liveness check (an arm that plays the same games as base is dropped). Intended arms:
    exploration constant (`cPuct` halved and doubled), `initVisits` 1, the opening heuristic off
    (search from the first move), the root shortlist arms that S1 flagged if they are still live
    with `rootFull`, and a rising iteration shape (Pentobi's budget curve, P11) if the native
    engine supports it. Screen: 100 seeds 82,000,000–82,000,099 against three Pentobi level-6
    seats, base on the same seeds. An arm whose paired difference against base has a CI lower
    bound above 0 goes to a confirmation with base on 200 seeds 82,100,000–82,100,199 (at most
    the two best). **Confirmed** if the CI lower bound is above 0 there and ms/move is at most
    1.25× base. Confirmed arms are reported as tuning of the port, not as a new version.
  - **N10.** The tuning window was lost to the outage. Tonight the tuner is built and
    smoke-tested, and its liveness pass and first generations may run on spare threads from the
    P4/P5 base as the starting point (resumable). The one-shot validation on 79,800,000–199 is
    **not** run tonight unless at least eight generations complete; those seeds stay unread.
- **2026-11-13 05:59 CST, X2 (where the P4/P5 config stands), fixed before it runs.** Read so far:
  the S1 confirmation (neither arm confirmed) and the S2 screen (no arm cleared; no confirmation).
  X2 is a descriptive benchmark of `engine-rs/configs/v5.0-p4-ultra.json` with no gate, on the
  pinned P4 binary, Pentobi 31.0 settings as in X1:
  - ladder: lone seat against three level-5 seats on seeds 79,100,000–79,100,099 and against three
    level-7 seats on 79,200,000–79,200,039 (the first 40 seeds of each are X1's, so `v4.2-ultra`
    is paired there);
  - reverse: one level-6 seat against three `v5.0-p4-ultra` seats on 82,200,000–82,200,099
    (X1's reverse seeds are not reused: the prior was fitted on those games);
  - compute: budget 600 and 1,200 (2× and 4× iterations) as the lone seat against level 6 on
    82,000,000–82,000,099, paired with the S2 base (budget 300) on the same seeds.
- **2026-11-13 06:25 CST, S3 (one dedicated test of `nodeShortlist` 96), fixed before it runs.**
  Read so far: all of S2 and X2. `N96` read +0.89 [−0.52, +2.33] in S1 (old base) and
  +1.38 [−0.04, +2.86] in S2 (P4/P5 base); neither cleared, and S2's rule gave it no confirmation.
  This is a new single test, not that confirmation: `v5.0-p4-ultra` with `search.nodeShortlist`
  96 against `v5.0-p4-ultra`, each as the lone seat against three Pentobi level-6 seats on 200
  fresh seeds 82,300,000–82,300,199, the two runs started together on 5 threads each so their
  ms/move are comparable. **Kept as a config change** if the paired difference has a CI lower
  bound above 0 and ms/move (own moves 3+) is at most 1.25× base; otherwise dropped.
- **2026-11-13 06:40 CST, S3 read; X2 level-7 extension fixed before it runs.** S3: `nodeShortlist`
  96 +0.30 [−0.71, +1.35], dropped. With the remaining hour, the X2 level-7 block is extended on
  new seeds 79,200,040–79,200,199 (`v5.0-p4-ultra` as the lone seat against three level-7 seats,
  same settings, moves recorded). Two uses, both descriptive: a tighter level-7 figure (reported
  for the new seeds alone and pooled with the first 40), and level 7's recorded moves as teacher
  data for a later re-fit of the move prior. The run stops at 07:35 whatever its state; only
  complete seeds are scored.
- **2026-11-13 10:04 CST, P1–P3 (rollout policy over all legal moves, incremental move lists, rank
  reward), fixed before any screen game.** Read so far: everything in the entries above. Seen but
  not read as a result: the liveness table below (2 seeds per arm, which prints advantages; noise at
  that size). Code: commit `20f6cb1` (`native.rollout`, `native.reward`, `src/move_lists.rs`); the
  arms and their values were committed in `engine-rs/scripts/p13_configs.py` in that same commit,
  before liveness or any game. Binaries pinned in `tmp/p13/bin/` (`PROVENANCE.txt`).
  - **Gates passed before this entry.** 8/8 parity tests; P2 equality test (`tests/move_lists.rs`:
    incremental lists equal a from-scratch generation as sets, no duplicates, every seat at every ply
    of 7,000 random games, with and without base lists and rollout resets, both opening rules);
    `v5.0-p4-ultra` mirror 0.00 with the new binary; the identity point `p13-ID` (`rollout.policy`
    sampled, `reward.kind` blend) vs `v5.0-p4-ultra` 0.00, 80/80 game scores equal to the old binary;
    self-play bytes equal; 8/8 bridge games move-for-move equal (`tmp/p13/identity.log`).
  - **Arms** (each `v5.0-p4-ultra` plus the block shown). P1 weights are a maximum-likelihood fit to
    Pentobi level-6 decisions at own move ≥ 3 in the X1 games (seeds 79,000,000–099; test = seeds
    ending in 4 or 9; `ml/p13_fit_rollout.py`, `ml/v5-rollout-fit.json`): test log-likelihood per
    decision uniform −4.431, size −3.875, size+local+own −3.702.
    - `P1S`: `rollout` all, `sizeWeight` 1.4347 (size-only fit), no local term.
    - `P1L`: `rollout` all, `sizeWeight` 1.3995, `localWeight` 0.7185, `localOwnExtra` 0.6515 (joint fit).
    - `P1X`: as `P1L` with `localWeight` 6.0 (one local square outweighs the whole size range, 4 × 1.3995).
    - `P3A`: `reward` rank, `qualityWeight` 0.1, `qualitySlope` 1, `lengthWeight` 0.1.
    - `P3B`: as `P3A` with `qualityWeight` 0.25. (Grid: 0.1 never overturns a rank step of 1/3,
      0.25 can at the extremes; the length weight is fixed at 0.1.)
    - `P1LP3B`: `P1L` and `P3B` together.
    P1S vs P1L separates "all legal moves, size weight only" from "plus local response".
  - **Screen:** each arm and `base` (`v5.0-p4-ultra`) as the lone seat against three Pentobi level-6
    seats (budget 300, Pentobi 31.0, book on, one thread), 100 seeds 83,000,000–83,000,099, 4 games
    per seed. Paired difference arm − base by seed, 95% percentile bootstrap.
  - **Selection:** among arms whose paired CI lower bound is above 0, the one with the largest point
    estimate. None clears → no confirmation, and the result is reported as a null.
  - **Cost:** from the clean cost run already made (`tmp/p13/cost/cost.md`: 150 positions, 2
    threads, my jobs alone on the machine; ms/move own moves 3+, arm / base): `P1S` 1.36, `P1L` 1.77,
    `P1X` 1.64, `P3A` 0.93, `P3B` 0.89, `P1LP3B` 1.67.
  - **Confirmation:** the selected arm and `base`, started together on 200 fresh seeds
    83,100,000–83,100,199. If the selected arm's clean cost ratio R is above 1.25, an equal-time arm
    (`<ARM>-ET`: `search.iterationScale` 16 / R) also plays those seeds, started with them.
    **Accepted at equal iterations** if the arm's paired CI lower bound is above 0. **Becomes the new
    base config** only if it is accepted and either R ≤ 1.25 or the equal-time arm's paired CI lower
    bound is also above 0 (then the equal-time config is the one saved).
  - **If a config becomes the new base:** it plays as one seat against three `v5.0-p4-ultra` seats
    (`blokee-match`, seat-rotated, budget 300) on 200 seeds 83,200,000–83,200,199, reported, not gated.
  - No arm, value or seed is added after the screen is read without a new dated entry.
- **2026-11-13 12:44 CST, P6/P7 (RAVE, last-good-reply) and a re-test of P3B, fixed before any screen
  game.** Read so far: everything in the entries above, including the P1–P3 screen (no arm cleared;
  P3B +0.44 [−0.92, +1.87] on 83,000,000–099). Seen but not read as a result: the liveness run
  (2 seeds per arm from 84,900,000; only its "games differ from base" column was printed: 8/8 for
  every arm). Used to set the grid (search internals, no game outcome): `p67_probe stats` on 60 X1
  positions (`tmp/p67/scratch/stats.csv`). Also seen: the P8 reuse probe on 3 of this morning's base
  games (83,000,000 / 033 / 066), to check that it reproduces the bridge's moves (42/42) and finds
  nodes. Code: commit `79bfa0b` (`native.rave`, `native.lastGoodReply`, `src/reply_table.rs`,
  `examples/p67_probe.rs`); arms and values committed in `engine-rs/scripts/p67_configs.py` in the
  same commit, before liveness or any game. Binaries pinned in `tmp/p67/bin/` (`PROVENANCE.txt`);
  pre-change reference binaries `tmp/p67/bin-before/` (= `tmp/p13/bin`, built at `20f6cb1`, whose
  engine sources equal the parent `db6676c`).
  - **Gates passed before this entry** (`tmp/p67/identity.log`): `cargo test --release` 5 + 2 + 8 + 5
    (the 5 new ones: identity points search like the base on 12 positions; AMAF weight ≥ real visits
    on every root edge, integer without decay, interior statistics only with scope "all"; the reply
    table supplies moves on both rollout paths; refusals; the reuse probe finds the played child);
    `v5.0-p4-ultra` mirror 0.00 with the new binary; the identity point `p67-ID` (`rave.weight` 0,
    `lastGoodReply.enabled` false) vs `v5.0-p4-ultra` 0.00, 80/80 game scores equal to the old
    binary; self-play bytes equal (sha256 `e834eb15…` / `f788f905…`); bridge 8/8 games equal.
  - **Design** (stated before the screen). RAVE is placement-level, with statistics kept apart from
    the real values: every path node's edges get `sum += w·v, weight += w` for placements its mover
    played at or after it in the simulation (tree or rollout), `w = 1 − distanceDecay·k/L`; selection
    uses `(1 − β)·Q + β·Q_amaf`, `β = ñ/(ñ + n + n·ñ/equivalence)`, `ñ = weight·AMAF weight`, `n` =
    child visits (+ `initVisits` 3 at the value-initialised root). Interior nodes use it too (scope
    "all"); `R6SR` measures the root-only variant. Last-good-reply is LGR-1 (key: the previous
    placement by any seat) with forgetting; "did well" = the seat's final score is the highest, ties
    included; the stored reply is played first in a rollout whenever legal (before ε, corner
    sampling and the table policy); the table is cleared at each search. Progressive history is
    unchanged (tree selection only).
  - **Arms** (each `v5.0-p4-ultra` plus the block shown; RAVE `equivalence` 100 and `distanceDecay`
    0.5 throughout; strength is the AMAF weight, chosen from the stats run so that an unvisited root
    edge with the median ~37 AMAF samples gets β ≈ 0.38 (weak) or ≈ 0.85 (strong)):
    - `P3B`: `reward` rank, `qualityWeight` 0.25, `qualitySlope` 1, `lengthWeight` 0.1 — **a
      follow-up of a null 100-seed screen arm** (the only positive point estimate this morning),
      re-tested here on fresh seeds at 4× the sample; this morning's seeds are not pooled with it.
    - `R6W`: `rave` weight 0.05, scope all. `R6S`: weight 0.5, scope all. `R6SR`: as `R6S`, root only.
    - `L7`: `lastGoodReply` enabled, forget.
    - `R6SL7`: `R6S` + `L7`. `R6SP1L`: `R6S` + `rollout` all with the P1L fit (1.3995 / 0.7185 / 0.6515).
  - **Screen:** each arm and `base` as the lone seat against three Pentobi level-6 seats (budget 300,
    Pentobi 31.0, book on, one thread), **400 seeds 84,000,000–84,000,399**, 4 games per seed, arms
    one after another on 10 threads under `caffeinate -i -s -m -w`. Paired difference arm − base by
    seed, 95% percentile bootstrap. Seven arms are read at 95% each; the confirmation is the guard
    against a false clearance.
  - **Selection:** an arm clears if its paired CI lower bound is above 0. Confirmed: the cleared arm
    with the largest point estimate. If cleared single-mechanism arms (RAVE: `R6W`/`R6S`/`R6SR`;
    LGR: `L7`; P3: `P3B`) cover two or more mechanisms, also the combination of the best cleared arm
    of each (an existing arm if one has exactly those blocks, else a new config `C-<A>+<B>`) and the
    best cleared single-mechanism arm, each if not already selected. None clears → no confirmation,
    reported as a null.
  - **Cost:** clean run already made (`tmp/p67/cost/cost.md`: 150 positions, 2 threads, nothing of
    mine running; ms/move own moves 3+, arm / base): `P3B` 0.88, `R6W` 1.03, `R6S` 1.05, `R6SR`
    1.04, `L7` 0.96, `R6SL7` 1.02, `R6SP1L` 1.91. A combination built at selection is costed the same
    way in the chain before any confirmation game.
  - **Confirmation:** base and every selected arm started together on **400 fresh seeds
    84,400,000–84,400,399**; for each selected arm with clean cost ratio R > 1.25 an equal-time arm
    (`search.iterationScale` 16 / R) plays the same seeds alongside. **Accepted** if the arm's paired CI
    lower bound is above 0. **New base config** only if accepted and either R ≤ 1.25 or its
    equal-time arm's lower bound is also above 0 (the equal-time config is then the one saved); among
    several, the largest confirmation point estimate.
  - **If a new base:** one seat against three `v5.0-p4-ultra` seats (`blokee-match`, seat-rotated,
    budget 300) on **200 seeds 84,800,000–84,800,199**, reported, not gated; the config is saved under
    `engine-rs/configs/` and the tracker's "Current v5.0 line" table updated.
  - **P8 diagnostic (descriptive, no strength claim):** after the screen, `p67_probe reuse` on 48 of
    the screen's base games (evenly spaced): at each searched decision, the visits the previous
    decision's tree holds at the position now on the board (and at the three intermediate plies), as a
    share of 4,800 and of that search's iterations. Reading: if the mean share at the next own turn is
    under 5% of the budget, building P8 is not worth it on this base (Parked).
  - Unused and unread: 83,100,000 and 83,200,000 (P1–P3); the block 84,220,000–039 (v4.2, 2026-10)
    is avoided. No arm, value or seed is added after the screen is read without a new dated entry.
- **2026-11-13 15:20 CST, P9/P10 (selection rule, P4 at interior nodes, opening rules), fixed before
  any screen game.** Read so far: everything in the entries above, including the P6/P7 confirmation
  (P3B +0.48 [−0.27, +1.23], not accepted) and the descriptive P3B first-place note (paired first
  place −2.53 pp [−4.03, −1.03] pooled over 900 seeds, more margin and fewer wins). Seen but not read
  as a result: the liveness run (2 seeds per arm from 85,900,000; only its "games differ from base"
  count was printed: 8/8 for every arm). Code: commit `484cc18` (`native.selection`,
  `native.candidates.interiorFull` / `interiorNoWidening` / `interiorInitVisits`, `native.opening`,
  `examples/p910_probe.rs`); arms in `engine-rs/scripts/p910_configs.py`. Binaries pinned in
  `tmp/p910/bin/` (`PROVENANCE.txt`, HEAD `484cc18`); pre-change reference `tmp/p910/bin-before/`
  (= `tmp/p67/bin`, built at `79bfa0b`, whose engine sources equal the parent `54b1a5f`).
  - **Gates passed before this entry** (`tmp/p910/identity.log`): `cargo test --release` 5 + 2 + 6 + 8
    + 5 (the 6 new: identity points search like the base on 12 positions; the selection cut-off at 1
    changes no choice under PUCT, under "priorLog" and with interior expansion; priorLog and interior
    expansion are live and interior nodes hold every legal move; the centre rule leaves only the most
    central root moves at own moves 0–2 and nothing changes from own move 3; the rollout rule is live
    early and inert after 31 pieces; refusals); `npm run native:build && npm run native:test`;
    `v5.0-p4-ultra` mirror 0.00 with the new binary; identity point `p910-ID` vs `v5.0-p4-ultra`
    0.00, 80/80 game scores equal to the old binary's mirror; self-play bytes equal (sha256
    `e834eb15…` / `f788f905…`, the same as P6/P7's); bridge 8/8 games move-for-move equal.
  - **Grid fixed from search internals and recorded moves only (no game outcome).** Tree shape on 47
    X1 positions (`tmp/p910/diag/`, `p910_probe shape` / `pentobi`): base mean in-tree depth 3.47
    (max 7), busy interior nodes (≥ 100 visits) keep 22 candidates and give the top child 17%;
    Pentobi level 6 (book off, subtree reuse off, same positions) 5.64 (max 23), top child of busy
    nodes 69%, top root child 52%. Grid of the "priorLog" constant {0.05, 0.1, 0.2, 0.4, 0.8, 1.6},
    alone and with P4 at interior nodes: alone, 0.1 and 0.2 bracket level 6's top-root-child share
    (58% / 46%); with interior expansion, 0.2 is the closest tree to level 6's (top root child 47%,
    half the root visits in 1.9 children as level 6, mean depth 6.1). Opening numbers from Pentobi
    level 6's own moves in the X1 games (`p910_probe opening`): at own moves 0–2 its move is at the
    smallest centre distance (our measure) in 100% of 3,600 moves, from own move 3 in under 1%; its
    moves are ≥ 90% five-square pieces while fewer than 31 pieces are on the board (88% at 31). P4 at
    interior nodes takes the base's root settings (all legal moves, fitted prior at temperature 1, no
    widening, 3 initial visits). No number is taken from Pentobi's source.
  - **Arms** (each `v5.0-p4-ultra` plus the change shown):
    - `P10A`: `selection` rule priorLog, exploration 0.2, scope all, countOffset 1, cutoff 1.
    - `P10B`: as `P10A` with exploration 0.1.
    - `P4I`: `candidates` interiorFull, interiorScorer fitted, interiorNoWidening, interiorInitVisits 3.
    - `P4IP10A`: `P4I` and `P10A` together (named combination).
    - `P9A`: `opening` centreMaxOwnMove 3, centreSlack 0, with `search.openingHeuristicMaxOwnMove` 0
      (named combination: the centre rule cannot act while the shortcut plays own moves 0–2).
    - `P9B`: `opening` rolloutMinSize 5, rolloutUntilPieces 31.
    - `O0` (my choice): `search.openingHeuristicMaxOwnMove` 0 alone, the control that separates
      searching the opening from the centre rule in `P9A`.
  - **Screen:** each arm and `base` as the lone seat against three Pentobi level-6 seats (budget 300,
    Pentobi 31.0, book on, one thread), **400 seeds 85,000,000–85,000,399**, 4 games per seed, arms
    one after another on 10 threads under `caffeinate -i -s -m -w`. Paired difference arm − base by
    seed, 95% percentile bootstrap. Reported for every arm beside it, not a gate: the paired
    first-place difference (share of the four rotations won, ties counted as first).
  - **Selection:** an arm clears if its paired advantage CI lower bound is above 0. Confirmed: the
    cleared arm with the largest point estimate. If cleared single-mechanism arms (P10: `P10A`/`P10B`;
    P4I; P9A; P9B; O0) cover two or more mechanisms, also the combination of the best cleared arm of
    each (an existing arm if one has exactly those changes, else a new config `C-<A>+<B>`) and the best
    cleared single-mechanism arm, each if not already selected. None clears → no confirmation,
    reported as a null.
  - **Cost** (clean run made, `tmp/p910/cost/`: 150 positions, 2 threads, nothing of mine running;
    ms/move, arm / base, own moves 3+): `P10A` 0.95, `P10B` 0.90, `P4I` 1.54, `P4IP10A` 1.63, `P9B`
    0.97. For the arms that search the opening the ratio is taken over own moves 0+ (base plays 0–2
    from the heuristic at almost no cost): `P9A` 1.55, `O0` 1.58. A combination built at selection
    is costed the same way in the chain before any confirmation game.
  - **Confirmation:** base and every selected arm started together on **400 fresh seeds
    85,400,000–85,400,399**; for each selected arm with clean cost ratio R > 1.25 an equal-time arm
    (`search.iterationScale` 16 / R) plays the same seeds alongside. **Accepted** if the arm's paired
    advantage CI lower bound is above 0. **New base config** only if accepted, and either R ≤ 1.25 or
    its equal-time arm's lower bound is also above 0 (the equal-time config is then the one saved),
    and its paired first-place interval does not lie entirely below 0 (if it does: reported, not
    saved, the chain stops there; the trade-off is Paul's decision). Among several, the largest
    confirmation point estimate.
  - **If a new base:** one seat against three `v5.0-p4-ultra` seats (`blokee-match`, seat-rotated,
    budget 300) on **200 seeds 85,800,000–85,800,199**, reported, not gated; the config is saved under
    `engine-rs/configs/` and the tracker's "Current v5.0 line" table updated.
  - Unused and unread, left alone: 83,100,000, 83,200,000 and 84,800,000. No arm, value or seed is
    added after the screen is read without a new dated entry.
- **2026-11-13 18:40 CST, X3 (where `v5.0-p4i-ultra` stands), fixed before any game.** Read so far:
  everything in the entries above, including the P9/P10 confirmation and direct match. X3 is X2's
  benchmark for the new base `engine-rs/configs/v5.0-p4i-ultra.json`: **descriptive, no gate; nothing
  is accepted or rejected and no config changes as a result.** Pinned binary `tmp/x3/bin/blokee-pentobi`,
  built from HEAD `9e767d7` (engine sources unchanged since `484cc18`), byte-identical to
  `tmp/p910/bin/blokee-pentobi` (sha256 `d925c533…`). Before the first X3 game, an identity check: the
  pinned binary and `tmp/p910/bin` play `v5.0-p4-ultra` (and `v5.0-p4i-ultra`) as the lone seat
  against level 6 on seeds 86,900,000–002 and must agree move for move; those games' outcomes are not
  read. Driver `engine-rs/scripts/x3-run.sh`, read-out `engine-rs/scripts/x3_report.py` (both committed
  with this entry). Settings as X2: Pentobi 31.0, Classic book on, one thread per process, budget 300,
  4 games per seed (lone seat rotated), 10 game threads, **arms strictly one after another** in the
  order below, under `caffeinate -i -s -m -w`.
  - **Level 5:** lone `v5.0-p4i-ultra` against three level-5 seats, 200 seeds 86,000,000–86,000,199;
    `v5.0-p4-ultra` on the same seeds as the paired control.
  - **Reverse:** one level-6 seat against three `v5.0-p4i-ultra` seats, 200 seeds 86,200,000–86,200,199.
  - **Compute against level 6:** lone seat, 200 seeds 86,300,000–86,300,199, three arms on the same
    seeds: `v5.0-p4i-ultra` as saved (`iterationScale` 10.383, equal time to `v5.0-p4-ultra`); the same
    with `iterationScale` 16 (equal iterations, about 1.5× the time); and with `iterationScale` 32
    (about 3× the time).
  - **Level 7:** lone `v5.0-p4i-ultra` against three level-7 seats, 200 seeds 86,100,000–86,100,199;
    `v5.0-p4-ultra` on the same seeds as the paired control.
  - **Read for every arm:** the lone seat's advantage with a 95% percentile bootstrap by seed,
    first-place share (ties count as first), ms/move for both engines (all moves and own moves 3+).
    Paired advantage and paired first-place differences by seed (95% bootstrap) for level 5 and level
    7 (`p4i` − `p4`) and for the compute arms (16 − saved, 32 − saved, 32 − 16). ms/move is quoted only
    for arms that ran with no other job of ours overlapping (the chain is sequential; the unrelated
    `serve.py` and Docker VM keep running and the load is recorded per arm).
  - Unused and unread, left alone: 83,100,000, 83,200,000 and 84,800,000. No arm or seed is added
    after any result is read without a new dated entry.
