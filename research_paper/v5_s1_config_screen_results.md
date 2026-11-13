# S1 — config-only screen of `v4.2-ultra` variants against Pentobi level 6

Run on the Mac, 2026-11-12 (first two arms) and the night of 2026-11-12/13 (the rest and the
confirmation). Exploratory by design: eleven single-knob arms on one seed block, so a false positive
or two is expected, and only the confirmation on fresh seeds is quoted as an effect. Rules: the
2026-11-13 00:05 and 01:04 CST entries of `research_paper/v6_native_and_learning_preregistered.md`.

**Outcome: nothing confirmed.** Two arms cleared the screen; on 200 fresh seeds both kept a positive
point estimate of about +1 with intervals that just include 0. The port P4/P5 has since replaced the
root shortlist these two arms widen, so neither is carried forward.

## Settings

`blokee-pentobi --mode one-blokee --level 6 --budget 300 --threads 5`: one Blokee seat against three
Pentobi 31.0 level-6 seats (Classic book on, one Pentobi thread), every seed played from all four
seats. Screen: 100 seeds from 79,300,000. Confirmation: 200 seeds from 79,700,000. One pinned binary
for both (`tmp/s1/bin/blokee-pentobi`, sha256 `4c257cda…`). Paired Δ is arm − base on the same
seeds with a 95% bootstrap interval by seed; `*` marks an interval that excludes 0. Driver
`engine-rs/scripts/s1-screen.sh`, arms `engine-rs/scripts/s1_configs.py`, table
`python3 engine-rs/scripts/s1_report.py tmp/s1`.

## Screen

| Arm | Change | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | × base ms/move (3+) |
|---|---|---:|---:|---:|---:|
| base | `v4.2-ultra` unchanged | −9.88 [−10.98, −8.78] | 8.5% | — | 1.00 |
| W96 | `rootShortlist` 40 → 96 | −7.86 [−9.05, −6.68] | 12.2% | +2.03 [+0.45, +3.49] * | 1.00 |
| W400 | `rootShortlist` 40 → 400 | −9.28 [−10.30, −8.16] | 9.0% | +0.60 [−0.84, +2.10] | 0.93 |
| W400open | `rootShortlist` 40 → 400 and `wideningInit` 8 → 400 | −8.07 [−9.18, −6.95] | 8.8% | +1.81 [+0.38, +3.30] * | 1.04 |
| N96 | `nodeShortlist` 24 → 96 | −8.99 [−10.00, −7.99] | 9.2% | +0.89 [−0.52, +2.33] | 1.10 |
| O0 | `openingHeuristicMaxOwnMove` 3 → 0 | −11.44 [−12.80, −10.08] | 7.0% | −1.55 [−3.41, +0.34] | 1.11 |
| C0 | `ordering.centrePull` → 0 in all phases | −13.10 [−14.07, −12.13] | 4.0% | −3.22 [−4.71, −1.75] * | 1.04 |
| R0 | `rankBlend` 0.35 → 0 | −8.95 [−10.19, −7.70] | 9.0% | +0.93 [−0.51, +2.38] | 1.04 |
| R100 | `rankBlend` 0.35 → 1.0 | −10.30 [−11.51, −9.16] | 8.2% | −0.42 [−1.86, +1.01] | 0.96 |
| B4 | `playoutCorners` 1 → 4 and `playoutMoveCap` 12 → 48 | −9.32 [−10.57, −8.11] | 9.8% | +0.57 [−0.96, +2.08] | 1.92 |
| E30 | `playoutEps` 0.6 → 0.3 | −11.16 [−12.35, −9.98] | 7.5% | −1.28 [−2.74, +0.20] | 1.00 |
| A140 | `aggressionScale` 1 → 1.4 | −9.72 [−10.90, −8.44] | 9.5% | +0.17 [−1.28, +1.60] | 1.00 |

Every arm changed 399–400 of its 400 games relative to base. A twelfth arm, `MAXN` (no
paranoid-when-leading switch), was dropped before the screen: it plays the same games as base,
because the switch fired at 1 of 5,377 Blokee decisions against level 6. The ms/move ratios were
taken while other jobs ran and are rough.

## Confirmation (200 fresh seeds, 79,700,000–79,700,199)

| Arm | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | Verdict |
|---|---:|---:|---:|---|
| base | −9.61 [−10.41, −8.82] | 8.2% | — | |
| W96 | −8.64 [−9.38, −7.88] | 10.2% | +0.97 [−0.06, +2.04] | not confirmed |
| W400open | −8.50 [−9.33, −7.65] | 11.9% | +1.11 [−0.07, +2.30] | not confirmed |

The confirmation's ms/move figures are not usable: base ran while two other match jobs loaded the
machine and the arms ran after one had finished (base 142 ms/move on own moves 3+, arms 77–81).

## Reading

- **A wider root is worth about +1 at most, and is not established.** Both wide-root arms halved
  from the screen (+2.0, +1.8) to the confirmation (+1.0, +1.1), the usual shrinkage after picking
  the best of eleven. The preregistered rule (interval lower bound above 0) is not met.
- **The question has moved on.** P4/P5 puts every legal move at the root with a fitted prior and
  measured +5.32 [+4.30, +6.31] on its own confirmation
  (`research_paper/v5_p4_p5_candidate_generation_results.md`). `rootShortlist` and root widening
  do nothing in that config.
- **Removing the centre pull from the old ordering costs about 3 points** (screen only, the one
  clearly negative arm). The fitted prior gives the centre a small weight after move 2, but it
  learned the rest of the ordering too, so the two facts do not conflict.
- **Nothing else moved**: reward blend, rollout breadth (at 1.9× cost), rollout greediness,
  aggression and searching from move 1 all have intervals spanning 0 on 100 seeds, where the
  minimum detectable paired effect is about 2 points.

## What each knob actually does (from the code)

(from the code; relevant when reading later results)

- **W96 / W400.** The root funnel becomes 192 / 800 moves by the size/centre score, then the orderer cuts the list to 96 / 400.
  - Progressive widening still opens at most floor(8 + 0.8·√N) root children, which is about 63 at 4,800 visits. So the extra breadth is mostly a wider funnel, which changes which top 40–63 moves get opened, plus a prior spread over more moves.
  - **W400 does not put every legal move at the root.** Legal moves exceed 400 at 25% of Blokee's searched decisions, and at 100% / 92% / 70% / 49% of decisions on own moves 3 / 4 / 5 / 6 (D1 rows).
  - The funnel (`max(rootShortlist·2, 96)`) is also used by the opening heuristic, so own moves 1–2 change too.
- **W400open.** At the root, the first ≈400 iterations each open one new child. At interior nodes `wideningAllNodes` is on and init 400 is larger than nodeShortlist 24, so progressive widening is effectively off everywhere: every interior node opens all 24 children before PUCT selects.
- **N96.** The interior funnel grows from 48 to 192, and the prior is spread over 96 moves. Interior widening still opens about 8 children at first.
- **C0.** Endgame centrePull was already 0, so the change is opening 0.55 → 0 and midgame 0.15 → 0. That one weight feeds:
  - the tier-1 funnel at the root and interior nodes;
  - the orderer score;
  - the opening-heuristic moves (own moves 0–2);
  - the rollout table policy's incumbent term (75% of the greedy score, used on 40% of rollout moves).

  The evaluation's own `phases.*.centre` weight is unchanged.
- **R0 / R100.** `objectiveShift` stays on, so the effective blend is not 0 or 1 everywhere:
  - R0: 0 when leading, min(1, deficit/20) when behind.
  - R100: 0.5 when leading, 1 when behind.
  - Base: 0.175 when leading, 0.35 + 0.65·min(1, deficit/20) when behind.
- **A140.** The aggression scale multiplies every λ. That changes the evaluation's opponent terms and also the orderer's deny-corners and split terms.
- **B4.** Each rollout draws candidates from up to 4 corners and 48 placements instead of 1 and 12. ε-random and greedy table choices then run over a larger set.
- **E30.** 70% of rollout moves come from the greedy table policy instead of 40%.
- **O0.** Moves 0–2 are searched, and the harness's top-3 sampling then applies to the search ranking.

## Files

Outputs (git-ignored): `tmp/s1/` (screen) and `tmp/s1c/` (confirmation), each with `configs/`,
`bin/PROVENANCE.txt`, `summary.txt` and one `s1-<arm>.jsonl` per arm with its moves and timings.
