# X2 — where the P4/P5 config stands against Pentobi

Run on the Mac, 2026-11-13 05:59–06:25 CST. Descriptive benchmark of
`engine-rs/configs/v5.0-p4-ultra.json` (`v4.2-ultra` plus the accepted P4/P5 port), no gate. Design:
the 05:59 CST entry of 2026-11-13 in `research_paper/v6_native_and_learning_preregistered.md`.
Pentobi 31.0, Classic book on, one thread; pinned binary `tmp/x2/bin/blokee-pentobi` (the P4 pin);
driver `engine-rs/scripts/x2-run.sh`; outputs `tmp/x2/`. Every seed is played from all four seats;
intervals are 95% bootstrap by seed.

## Ladder: one Blokee seat against three Pentobi seats

| Opponent | Seeds | `v5.0-p4-ultra` | First place | `v4.2-ultra` (X1) | Paired Δ on shared seeds |
|---|---:|---:|---:|---:|---:|
| Level 5 (≈560 simulations, 10 ms/move) | 100 | **−0.32 [−1.51, +0.84]** | 26.5% | −2.50 [−4.01, −1.06] (40 seeds) | +2.50 [+0.09, +4.99] (40 seeds) |
| Level 6 (≈3,900 simulations, equal compute) | 200 | **−4.93 [−5.74, −4.14]** | 16.2% | −10.25 [−11.02, −9.51] | +5.32 [+4.30, +6.31] (P4/P5 confirmation) |
| Level 7 (≈52,000 simulations, 740 ms/move here) | 40 | **−10.32 [−12.95, −7.87]** | 8.8% | −15.66 [−17.18, −14.10] | +5.34 [+2.31, +8.33] (40 seeds) |
| Level 7, extension on new seeds 79,200,040–199 | 160 | −11.04 [−12.10, −10.00] | 8.1% | not played | — |
| Level 7, all 200 seeds pooled | 200 | **−10.90 [−11.88, −9.94]** | 8.3% | | |

The level-6 row is the P4/P5 confirmation, repeated for reference. The level-5 and level-7 rows use
X1's ladder seeds (79,100,000 and 79,200,000), so the first 40 of each pair with `v4.2-ultra`.

The level-7 extension was added at 06:40 (preregistered then) and ran to 07:24. Its 640 games also
record every level-7 move (`tmp/x2/x2-l7ext.moves.jsonl`, git-ignored), kept as teacher data for a
later re-fit of the move prior on a stronger teacher than level 6.

- The config is now **level with Pentobi level 5** (interval spans 0, first place at par). Level 5
  uses about a seventh of the compute.
- It gains about 5 points on `v4.2-ultra` against levels 6 and 7 alike, so the gain is not specific
  to the level whose games the prior was fitted on.

## Reverse: one Pentobi level-6 seat against three Blokee seats

| Field | Seeds | Pentobi's advantage | Pentobi first place |
|---|---:|---:|---:|
| three `v5.0-p4-ultra` | 100 (82,200,000–099) | **+5.86 [+4.89, +6.90]** | 48.3% |
| three `v4.2-ultra` (X1) | 100 (79,000,000–099) | +5.56 [+4.59, +6.59] | 49.5% |

**The port did not make Blokee a harder field for Pentobi.** A lone Pentobi wins about half its
games against three copies of either config. The two rows use different seeds, so the difference
between them (+0.3) is not a paired estimate; the point is that there is no sign of the 5-point
gain here. One reading: as a lone seat the new config stops losing ground to three strong
neighbours, but three copies of it do not punish a stronger player any better than before. This
was not investigated further.

## Compute: more iterations against level 6

Lone seat against three level-6 seats on seeds 82,000,000–099; budget 300 is the S2 base on the
same seeds.

| Budget | Iterations | ms/move | Advantage vs L6 | Paired Δ vs budget 300 |
|---|---:|---:|---:|---:|
| 300 (standard) | 4,800 | — (S2 timing unusable) | −6.03 [−7.07, −4.96] | — |
| 600 | 9,600 | 121 | −4.78 [−5.94, −3.56] | +1.25 [−0.07, +2.57] |
| 1,200 | 19,200 | 242 | −4.67 [−5.86, −3.50] | +1.36 [+0.07, +2.60] |

Budget 1,200 against budget 600, paired: +0.11 [−1.19, +1.33].

**Compute does not close the gap.** The first doubling is worth about +1.3, in line with what a
doubling was worth for the old engine against itself; the second adds nothing measurable. At four
times the compute of level 6 the config still loses by about 4.7. The 100-seed intervals are wide
(a second doubling worth up to +1.3 is not excluded), but a search that kept converting
simulations into strength would not look like this.

## What this says about the next step

- The remaining gap is not about which root moves are considered (P4/P5, S1, S2) nor about how
  many simulations are run (this file). What is left is the quality of each simulation's result:
  the rollout policy (P1) and the reward (P3). That is now the first candidate for the next port.
- For distillation (N8): a high-budget run of this engine is not a much stronger teacher than the
  standard one. Pentobi levels 7–9 are.
