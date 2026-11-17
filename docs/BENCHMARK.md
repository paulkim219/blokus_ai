# Blokee benchmark: break-even Pentobi level

Accepted by Paul on 2026-11-16. It was designed in rounds 6–7 of the v5 line (`research_paper/v5_1_candidates_results.md`, "Round 6, Stage 3" and "Round 7, D").

## Definition

- **Anchors.** Pentobi 31.0 at levels 1–9 are fixed anchors. Opening book on, one thread, and one `pentobi-gtp` process per Pentobi seat, seeded from the game seed and the seat.
- **Match.** One lone seat of the engine plays against three seats of one anchor level. Budget 300, four seat rotations per seed. The advantage is the lone seat's score minus the mean of the other three. Its 95% interval is a bootstrap over seeds.
- **Score.** The score is the level at which the engine's lone-seat advantage crosses zero. It is interpolated linearly between the two bracketing anchors. It is reported as a decimal with a 95% interval: 2,000 bootstrap replicates, resampling seeds within each anchor match.
- **Second axis.** The engine's ms/move, averaged over each seat's own moves from its fifth on (index ≥ 4), as measured in the matches. The score only means something together with the time it took.
- **Tiers.** A tier is defined by Pentobi's time per move on this Mac (M4 Pro), measured in round 6, moves 5+:

  | Tier | Pentobi level | Pentobi ms/move |
  |---|---:|---:|
  | nano | 1 | 1.7 |
  | lite | 3 | 2.5 |
  | base | 5 | 10.6 |
  | turbo | 6 | 72 |
  | pro | 7 | 903 |
  | ultra | 9 | 17,069 |

  Each Blokee tier sets `iterationScale` so that its time per move matches its level. Equal wall time per move is the standard.

## Anchors each tier plays

Play at least the two levels that bracket the engine's expected score. When the score lands near an anchor, add the next level on either side. Seeds per anchor: at least 200, except 100 at levels 6–7 and whatever fits at level 9.

| Engine | Anchors played for v5.2 |
|---|---|
| nano | 1, 2, 3, 4 |
| lite | 2, 3, 4 |
| base (`v5.2`) | 4, 5, 6 |
| turbo (Pentobi level 6; `v5.2-turbo`) | 5, 6, 7 |
| pro | 6, 7 |
| ultra | 9 only (8 not played) |

## How to run it for a new engine

```bash
export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH
cd engine-rs && cargo build --release && cd ..
# pin the binary so later builds cannot change a running benchmark
mkdir -p tmp/bench/bin-<name> && cp engine-rs/target/release/blokee-pentobi tmp/bench/bin-<name>/
# lone seat vs three seats of each anchor level; seeds per level = seed-base + 10,000 * level
caffeinate -i -s -m engine-rs/scripts/bench.sh engine-rs/configs/<config>.json <name> "4 5 6" 200 <seed-base> 10 tmp/bench/bin-<name>
# read-out: the v5.2 table and the Pentobi ladder, plus the new engine
python3 engine-rs/scripts/v53_report.py --bench tmp/v53 --engine <name> tmp/bench/<name>
```

- Use an unplayed seed block, and record it in the tracker.
- Ultra searches use about 8 GB each, so run at most 3 threads.
- Rough times with 10 game threads: 200 seeds against level 4–5 take a few minutes; 100 seeds against level 7 at the pro tier take about 45 minutes; level 9 takes about 4 hours per 24 seeds at 3 threads.

The Pentobi ladder (lone level k against three of level k ± 1, `blokee-pentobi --mode pentobi-ladder --lone-level A --level B`) is already played for k = 1…7. Its logs are `tmp/v53/S3/ladder-*.jsonl`.

## Current table

Turbo (Pentobi level 6) was the "l6 reference" until Paul named it on 2026-11-16; its config was `v5.2-l6.json`, and its raw logs keep the old file names (`tmp/v53/S3/l6-vs-L*.jsonl`).

Regenerated on 2026-11-16 from the raw logs (`tmp/v53/S2/`, `tmp/v53/S3/`, `tmp/v52/S1/pooled/lone-TM.jsonl`) with `python3 engine-rs/scripts/v53_report.py --bench tmp/v53`. The output is identical to round 7's draft read-out except for the names `v5.2` (the base tier, formerly `v5.2-base`) and `v5.2-turbo` (formerly `v5.2-l6`).

| Engine | ms/move (own moves 5+) | Advantage vs anchors played | Score [95% CI] |
|---|---:|---|---:|
| `v5.2-nano` | 1.9 | L1 +6.30; L2 +2.19; L3 −0.41 [−1.06, +0.23]; L4 −4.64 | **2.84 [2.65, 3.04]** |
| `v5.2-lite` | 2.8 | L2 +5.22; L3 +1.61 [+1.11, +2.14]; L4 −2.33 | **3.41 [3.31, 3.52]** |
| `v5.2` | 13.0 | L4 +3.89; L5 +0.33 [−0.20, +0.85]; L6 −4.89 | **5.06 [4.95, 5.15]** |
| `v5.2-turbo` (turbo, Pentobi level 6) | 77.5 | L5 +5.02; L6 +0.31 [−0.10, +0.74]; L7 −4.28 | **6.07 [5.98, 6.16]** |
| `v5.2-pro` | 773.0 | L6 +4.10; L7 −2.02 [−3.14, −0.84] | **6.67 [6.53, 6.83]** |
| `v5.2-ultra` | 15,288 | L9 −4.14 [−8.55, +0.68] (11 seeds) | not bracketed (below level 9) |
| Pentobi L2 | | L1 +3.68; L3 −3.73 | 1.99 [1.89, 2.09] |
| Pentobi L3 | | L2 +3.83; L4 −4.20 | 2.95 [2.87, 3.04] |
| Pentobi L4 | | L3 +5.36; L5 −4.87 | 4.05 [3.97, 4.13] |
| Pentobi L5 | | L4 +5.19; L6 −6.87 | 4.86 [4.77, 4.95] |
| Pentobi L6 | | L5 +7.69; L7 −7.05 | 6.04 [5.95, 6.15] |

Round 8 (named v5.3 on 2026-11-16: `v5.3.json` and `v5.3-turbo.json`, byte copies of `v5.3-cand*.json`; interior cap W1A; their own-level anchor is the 800-seed confirmation block, the others are 200 seeds, 100 at level 7; `tmp/v55/bench.md`):

| Engine | ms/move (own moves 5+) | Advantage vs anchors played | Score [95% CI] |
|---|---:|---|---:|
| `v5.3` (base; recorded as `v5.3-cand`) | 21.6* | L4 +4.95; L5 +0.77 [+0.38, +1.17]; L6 −4.08 | **5.16 [5.08, 5.24]** |
| `v5.3-turbo` (recorded as `v5.3-cand-turbo`) | 176.3* | L5 +6.48; L6 +0.83 [+0.39, +1.25]; L7 −4.63 | **6.15 [6.08, 6.23]** |

\* In-match times under heavier load (18 game threads on 14 cores) than the v5.2 rows; by clean single-thread cost the candidates are time-matched to their v5.2 tier.

Round 9 (2026-11-17; interior cap W1C, floor(2 + 0.5·√N), accepted at nano and lite; not yet named by Paul; their own-level anchor is the 800-seed confirmation block, the others are 200 seeds; `tmp/bench/v5.3-cand-{nano,lite}/bench.md`):

| Engine | ms/move (own moves 5+) | Advantage vs anchors played | Score [95% CI] |
|---|---:|---|---:|
| `v5.3-cand-nano` | 1.8 | L1 +7.39; L2 +3.30; L3 +0.04 [−0.65, +0.71]; L4 −4.14 | **3.01 [2.84, 3.15]** |
| `v5.3-cand-lite` | 3.0 | L2 +6.65; L3 +2.32 [+1.95, +2.69]; L4 −2.04 | **3.53 [3.44, 3.64]** |

Pentobi's own levels read back within 0.15 of their number, which checks that the method is consistent. The full intervals per anchor are in `tmp/v53/S3/bench.md`.

## Known limits

- **A level is worth more points higher up.** One level is worth +3.7 points between levels 1 and 2, but +8.2 between 6 and 7. Linear interpolation in level is therefore approximate. Interpolating in log simulations would give slightly different decimals.
- **Coarse near levels 8–9.** Few seeds fit there, and level 9 alone takes about 17 s per move. Level 8 has not been played as an anchor.
- **No anchor above level 9.** An engine stronger than level 9 cannot be scored.
- **The times are specific to this Mac** (M4 Pro, one thread per Pentobi process). On another machine, the tiers' `iterationScale` values must be re-calibrated against Pentobi's time there.
- **Load matters.** In-match times under 10-game load differ from clean single-thread times (for example, the ultra tier ran about 20% under level 9's time in its match). Calibrate on a quiet machine.
