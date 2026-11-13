## X1 — `v4.2-ultra` against Pentobi (external benchmark)

Run on 2026-11-12 on the M4 Pro, under the 2026-11-12 addenda: the X1 entry, then "X1 moved from
Pentobi level 9 to level 6". Every run below completed with zero hard failures (no rules
disagreement in any game).

### Setup

- **Opponent.** Pentobi 31.0 (tag `v31.0`, commit `d5374dd`, 2026-10-01), the latest release.
  - Only the GTP engine was built, as a Release build with Apple clang 21.0.0
    (`-DPENTOBI_BUILD_GUI=OFF -DPENTOBI_BUILD_GTP=ON`).
  - `pentobi-gtp --version` prints `Pentobi 31.0`.
  - Each game runs one process with
    `--game classic --level <L> --seed <game seed> --threads 1 --noresign --quiet --book book_classic.blksgf`.
  - `pentobi-gtp` will not start without `--book` or `--nobook`, so the bridge passes the Classic
    opening book from the source tree. This is the prereg's "opening book stays on".
- **Bridge.** `blokee-pentobi` (`engine-rs/src/gtp.rs`, `engine-rs/src/bin/blokee-pentobi.rs`).
  - Seats rotate as in `blokee-match`.
  - Blokee seats use `Engine::search` at budget 300 and the harness's opening sampling (top 3 for
    the first 8 plies).
  - One Pentobi process per game plays all its colours and receives every Blokee move.
  - Scores are Blokee's own. The statistic is `scripts/aggregateMatches.ts`.
- **Board mapping, discovered rather than assumed.**
  - From `all_legal` on an empty board, Pentobi's start corners are: colour 1 (Blue) a20, top-left;
    2 (Yellow) t20, top-right; 3 (Red) t1, bottom-right; 4 (Green) a1, bottom-left.
  - Pentobi's turn order runs clockwise round the board; Blokee's runs anticlockwise.
  - Four of the eight symmetries of the square put Blokee's home corners on the start corners.
    Only the **transpose** also lines up the turn order (seat *i* → colour *i*+1).
  - Mapping: Blokee blue → Blue, green → Yellow, purple → Red, yellow → Green.
  - All four 58-move first-move sets agree under it.
- **Pentobi's rules, as observed.**
  - Passes are implicit. `genmove` answers `pass` when the colour has no move, and
    `play … pass` is rejected.
  - `play` always refuses illegal moves. The `accept_illegal` switch named in the GTP doc does not
    exist in v31.0.
  - `final_score` lists colours 1–4 as squares placed, plus the bonuses Blokee also uses (+15 for
    placing all pieces, +5 more if the monomino was last). So Pentobi's points equal Blokee's
    score + 89.
  - `get_place` is not a command in v31.0.
- **Rules checks in every game.**
  - Before every decision, the bridge compares the complete legal-move sets of both engines.
  - A game hard-fails, and never reaches the JSONL, on:
    - a rejected move;
    - a pass while the other side has a move;
    - different legal sets;
    - a final score that is not exactly Blokee's + 89.
  - None of the 1,120 scored games failed.

### Validity gate — PASSED (before any match)

20 complete `v4.2-ultra` self-play games (budget 300, seeds 79,950,000–79,950,019) were replayed
into Pentobi:

- all 1,462 moves were accepted;
- all 150 passes were on positions where Pentobi also had no legal move;
- the legal-move sets were equal at all 1,612 plies, 312,772 moves compared one by one;
- every final score was equal to Pentobi's minus 89, including 3 games with bonuses (+15 once,
  +20 twice). The rank order was therefore the same in every game.

One Pentobi-vs-Pentobi game was also played through the bridge (level 9, seed 79,959,999):

- the bridge scored [−3, −4, −10, −25] (blue, green, purple, yellow);
- Pentobi's `final_score` was [86, 85, 79, 64] for the same seats;
- the ranks were identical.

Repeating a seeded run gives the same games. Log: `tmp/x1/validate.log`.

### Why level 6, and how many simulations each side runs

Pentobi's level is a simulation count (`counts_classic`, `libpentobi_mcts/Player.cpp`):

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Base simulations per move | 3 | 30 | 90 | 181 | 667 | 5,028 | 69,809 | 349,044 | 1,745,221 |

From level 4 up, the base count is multiplied by a move-number weight. Pentobi also reuses the
subtree from its previous search and stops early once the best move cannot change.

`v4.2-ultra` runs 300 × 16 = 4,800 iterations per searched move. It does not search on its first
3 own moves (opening heuristic) or in sealed regions (exact packer).

**Measured Pentobi simulations per move.** These come from Pentobi self-play games run separately
from the scored runs, without `--quiet`, parsing the `MaxCnt` and `Sim` lines Pentobi prints on
stderr. The positions are Pentobi-vs-Pentobi, not the mixed games.

| Level | Searched moves | Target `MaxCnt`, mean | New simulations (`Sim`), mean / median | Root visits incl. reused, mean |
|---|---|---|---|---|
| 5 (2 games) | 145 | 1,279 | 557 / 439 | 965 |
| 6 (4 games) | 280 | 9,378 | **3,893 / 3,269** | 7,077 |
| 7 (2 games) | 145 | 135,901 | 52,187 / 39,549 | 98,549 |

At level 6, Pentobi runs about 3,900 new simulations per searched move against Blokee's 4,800
iterations, about 0.8×. Counting the reused subtree, Pentobi's root holds about 7,100 visits per
move, about 1.5×. "Close to equal simulations" holds within a factor of about 1.5 either way.

Level 5 is about 9× *fewer* simulations than Blokee, and level 7 about 11× more. Level 9 was a
400–1,100× handicap by the source constants.

### Results (aggregateMatches output, verbatim)

**X1-L6a** — 1 × `v4.2-ultra` vs 3 × Pentobi level 6, 100 seeds 79,000,000–79,000,099, budget 300:

```
Pooled 1 logs → 100 complete seeds (400 games), seeds 79000000–79000099

v4.2-ultra vs pentobi-31.0-L6 — 400 games over 100 seeds
Advantage (score − mean of the three pentobi-31.0-L6 seats): -10.68 [95% CI -11.96, -9.41] → SIGNIFICANTLY WORSE than pentobi-31.0-L6
First place: 8.8% (par 25%), sole wins 6.8%
Mean score: -18.11 (opponents -7.43), squares placed 70.72 / 89
Per-seat advantage: blue -6.03  yellow -15.48  purple -12.47  green -8.74

Minimum detectable effect at this sample size (80% power): ~1.34
```

**X1-L6b** — 1 × Pentobi level 6 vs 3 × `v4.2-ultra`, same seeds:

```
Pooled 1 logs → 100 complete seeds (400 games), seeds 79000000–79000099

pentobi-31.0-L6 vs v4.2-ultra — 400 games over 100 seeds
Advantage (score − mean of the three v4.2-ultra seats): 5.56 [95% CI 4.59, 6.59] → SIGNIFICANTLY BETTER than v4.2-ultra
First place: 49.5% (par 25%), sole wins 37.8%
Mean score: -6.39 (opponents -11.95), squares placed 80.99 / 89
Per-seat advantage: blue 9.55  yellow 1.85  purple 4.75  green 6.07

Minimum detectable effect at this sample size (80% power): ~1.34
```

**Ladder, level 5** — 1 × `v4.2-ultra` vs 3 × Pentobi level 5, 40 seeds from 79,100,000:

```
Pooled 1 logs → 40 complete seeds (160 games), seeds 79100000–79100039

v4.2-ultra vs pentobi-31.0-L5 — 160 games over 40 seeds
Advantage (score − mean of the three pentobi-31.0-L5 seats): -2.50 [95% CI -4.01, -1.06] → SIGNIFICANTLY WORSE than pentobi-31.0-L5
First place: 23.1% (par 25%), sole wins 18.8%
Mean score: -13.53 (opponents -11.03), squares placed 75.22 / 89
Per-seat advantage: blue 3.48  yellow -7.28  purple -5.92  green -0.29

Minimum detectable effect at this sample size (80% power): ~2.12
```

**Ladder, level 7** — 1 × `v4.2-ultra` vs 3 × Pentobi level 7, 40 seeds from 79,200,000:

```
Pooled 1 logs → 40 complete seeds (160 games), seeds 79200000–79200039

v4.2-ultra vs pentobi-31.0-L7 — 160 games over 40 seeds
Advantage (score − mean of the three pentobi-31.0-L7 seats): -15.66 [95% CI -17.18, -14.10] → SIGNIFICANTLY WORSE than pentobi-31.0-L7
First place: 3.1% (par 25%), sole wins 2.5%
Mean score: -21.77 (opponents -6.11), squares placed 67.11 / 89
Per-seat advantage: blue -8.27  yellow -17.13  purple -22.90  green -14.34

Minimum detectable effect at this sample size (80% power): ~2.12
```

**Level 9, stopped partial pilot (descriptive only, not part of any test).** It covers 10 seeds
from 79,900,000; 18 of 40 games were played, which is 4 complete seeds:

```
Pooled 1 logs → 4 complete seeds (16 games), seeds 79900000–79900003

v4.2-ultra vs pentobi-31.0-L9 — 16 games over 4 seeds
Advantage (score − mean of the three pentobi-31.0-L9 seats): -25.10 [95% CI -32.50, -17.71] → SIGNIFICANTLY WORSE than pentobi-31.0-L9
First place: 0.0% (par 25%), sole wins 0.0%
Mean score: -28.19 (opponents -3.08), squares placed 60.81 / 89
Per-seat advantage: blue -17.92  yellow -31.00  purple -27.50  green -24.00

Minimum detectable effect at this sample size (80% power): ~6.70
```

### Timing (wall-clock per move, from the `.timing.jsonl` side files)

| Run | Blokee ms/move, mean / median (n) | Blokee, searched moves only (>5 ms) | Pentobi ms/move, mean / median (n) |
|---|---|---|---|
| X1-L6a | 61.8 / 64.0 (6,577) | 78.2 / 77.9 (5,191) | 54.2 / 38.4 (22,406) |
| X1-L6b | 55.0 / 53.5 (21,426) | 71.1 / 69.7 (16,547) | 72.2 / 50.9 (7,585) |
| Ladder L5 | 56.3 / 56.0 (2,802) | 72.2 / 71.5 (2,183) | 9.0 / 7.9 (8,712) |
| Ladder L7 | 63.4 / 66.2 (2,509) | 80.2 / 80.2 (1,984) | 589.4 / 337.7 (9,058) |
| L9 pilot (16 complete games) | 66 / 73 (227) | 84 (179) | 9,693 / 3,977 (928) |

The Pentobi means include opening-book moves, which take about 0 ms.

**Load conditions.**

- All runs used 5 parallel games, except the L9 pilot, which used 3.
- The E5 training run (`ml/torch/train.py`, MPS GPU) was active throughout.
- The separately run simulation-count games (up to 4 single-thread Pentobi processes) overlapped
  X1-L6a for its first few minutes.
- The E6 screen had not started.
- Load averages were about 4–8 on 14 cores.

The addendum quotes 81 vs 9,940 ms/move for the L9 pilot. Over the 16 complete-seed games the side
file gives 66 (84 over searched moves only) vs 9,693; the difference is likely just a different
selection of moves or games.

Overall, at level 6 the two engines spend about the same wall time per move: Blokee about
55–80 ms and Pentobi about 55–70 ms. Simulations are also close (above).

### Reading

- **`v4.2-ultra` does not beat Pentobi level 6. All three parts of the preregistered criterion
  fail.**
  - X1-L6a's advantage is −10.68 [−11.96, −9.41], with first place in 8.8% of games against a par
    of 25%.
  - X1-L6b's Pentobi advantage is +5.56 [4.59, 6.59], which lies wholly above 0, so it contradicts
    a Blokee win.
- At roughly equal simulations and roughly equal time per move, Pentobi level 6 is clearly
  stronger than the release engine.
- The ladder is monotone:
  - level 5: −2.50 [−4.01, −1.06]; about 9× fewer simulations than Blokee and still ahead;
  - level 6: −10.68;
  - level 7: −15.66 [−17.18, −14.10];
  - level 9 (descriptive): −25.10.
- Every Blokee result against Pentobi is a significant loss, including the level with the fewest
  simulations.
- The asymmetry between L6a (−10.7 for one Blokee seat) and L6b (+5.6 for one Pentobi seat) fits a
  multi-player effect: three engines of one kind shape the board for one another. Both point the
  same way.
- This is the first measurement of Blokee against a non-relative. It says the internal ladder
  (each version against its ancestors) has not reached the level of Pentobi's
  rollout MCTS, even at matched simulation counts. Later candidates (the best E6 arm, `ei-gen6`) play the
  X1-L6a block as a secondary measurement.
