# S2: config screen on the P4/P5 base (v5.0-p4-ultra) against Pentobi level 6

Status: IN PROGRESS (2026-11-13). Tables below are filled by the unattended chain
(`engine-rs/scripts/s2-screen.sh chain`) as each stage finishes; a block still reading TODO has not
finished.

## Purpose

Preregistered 2026-11-13 04:55 CST in `research_paper/v6_native_and_learning_preregistered.md`
("S2"). A config-only screen of at most six single-change variants of the new base, read as the
seed-paired difference against base, then a confirmation on fresh seeds of any arm that clears the
screen. Confirmed arms are tuning of the port, not a new version.

## Base

`engine-rs/configs/v5.0-p4-ultra.json` = `v4.2-ultra` + `native.candidates` {`rootFull`,
`rootNoWidening`, `initVisits` 3, `rootScorer` "fitted", inline fitted move-prior model}. Confirmed
at +5.32 [+4.30, +6.31] against `v4.2-ultra` vs Pentobi level 6 (P4/P5, `FULLfit`).

Binary: `tmp/s2/bin/blokee-pentobi`, a copy of the pinned P4/P5 binary `tmp/p4/bin/blokee-pentobi`
(sha256 `e9263d6a08e91ae50938446f50b00e27a40c50cf60fabd270243f15174f2e4f0`; provenance in
`tmp/s2/bin/PROVENANCE.txt`). Not rebuilt.

Match settings (S1's): `--mode one-blokee --level 6 --budget 300`, Pentobi 31.0 with the Classic
opening book, one Pentobi thread; one seed = 4 games (Blokee in each seat against three Pentobi
seats). Advantage = Blokee score minus the mean of the three Pentobi scores, averaged over the
four seat rotations of a seed. Paired Δ = per-seed arm minus base, 95% percentile bootstrap over
seeds (`ml/seat/paired_report.py`).

## Arms (fixed in `tmp/s2/ARMS-FIXED.md`, 2026-11-13 05:10 CST, before the first screen game)

| Arm | Change |
|---|---|
| C08 | `search.cPuct` 1.6 → 0.8 |
| C32 | `search.cPuct` 1.6 → 3.2 |
| O0 | `search.openingHeuristicMaxOwnMove` 3 → 0 (search from the first move) |
| IV1 | `native.candidates.initVisits` 3 → 1 |
| SHAPE | `search.iterationShape` = 21·exp(0.1·i)/Σ exp(0.1·j) for a seat's own move i = 0..20 (0.308 … 2.277; sums to 21) |
| N96 | `search.nodeShortlist` 24 → 96 (in place of E30, `playoutEps` 0.6 → 0.3) |

- SHAPE is supported by the native engine: `Engine::search` multiplies the budget by
  `shape_at(iterationShape, own_moves)` for every config and `unsupported()` does not reject it, so
  the T3 fallback was not needed. Caveat: own moves 0–2 are played by the opening heuristic, so
  their multipliers (sum 1.03) are unused and the searched moves 3–20 receive about 11% more
  iterations in total than base (Σ 19.97 vs 18). Normalised as preregistered; not corrected.
- N96 replaces E30. The preregistration names "the root shortlist arms that S1 flagged if they are
  still live with `rootFull`"; they are not live (with `rootFull` + `rootNoWidening` the root keeps
  every legal move, so `rootShortlist` and root widening do nothing). `nodeShortlist` is the live
  breadth knob (interior nodes still use the ordering shortlist). In S1 it read +0.89 [−0.52, +2.33]
  at 1.10× ms/move, against E30's −1.28 [−2.74, +0.20]. E30's config was generated and live-checked
  but not screened.
- No arm dropped.

## Liveness

2 seeds from 82,900,000 (8 games per arm), compared move for move with base (`tmp/s2/live.md`):
every arm (C08, C32, O0, IV1, SHAPE, N96, and the unscreened E30) differs from base in 8/8 games.

## Screen (100 seeds 82,000,000–82,000,099; base on the same seeds)

`*` = paired CI excludes 0. ms/move is Blokee wall time per decision; "3+" is over a seat's own
moves 3 and later (the searched moves for base). Figures of arms selected for confirmation are
selection-biased (chosen as the best of six on these seeds).

<!-- S2:SCREEN -->
| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-p4-ultra unchanged | 100 | -6.03 [-7.08, -4.96] | 14.2% | — | 131.2 | 159.1 | 1.00 | 0/400 |
| C08 | search.cPuct 1.6 -> 0.8 | 100 | -5.92 [-7.18, -4.69] | 12.8% | +0.11 [-1.40, +1.53] | 65.3 | 79.2 | 0.50 | 398/400 |
| C32 | search.cPuct 1.6 -> 3.2 | 100 | -8.13 [-9.34, -6.88] | 11.2% | -2.10 [-3.53, -0.64] * | 67.5 | 82.2 | 0.52 | 399/400 |
| O0 | search.openingHeuristicMaxOwnMove 3 -> 0 (search from the first move) | 100 | -5.63 [-6.83, -4.36] | 18.8% | +0.40 [-1.19, +2.01] | 88.8 | 75.7 | 0.48 | 400/400 |
| IV1 | native.candidates.initVisits 3 -> 1 | 100 | -5.08 [-6.37, -3.81] | 18.5% | +0.95 [-0.68, +2.51] | 63.2 | 76.5 | 0.48 | 397/400 |
| SHAPE | search.iterationShape (absent = 1.0) -> 21·exp(0.1·i)/Σ, i = own move 0..20 (0.308 … 2.277) | 100 | -6.33 [-7.43, -5.24] | 14.2% | -0.31 [-1.70, +1.06] | 44.5 | 53.9 | 0.34 | 398/400 |
| N96 | search.nodeShortlist 24 -> 96 | 100 | -4.65 [-5.76, -3.53] | 15.5% | +1.38 [-0.04, +2.86] | 61.0 | 73.8 | 0.46 | 399/400 |
<!-- /S2:SCREEN -->

Selection (`s2_report.py --select`: paired CI lower bound > 0, at most two best by point estimate):

<!-- S2:SELECTION -->
C08: paired +0.110 [-1.400, +1.530] on 100 seeds -> does not clear
C32: paired -2.102 [-3.527, -0.640] on 100 seeds -> does not clear
O0: paired +0.398 [-1.189, +2.009] on 100 seeds -> does not clear
IV1: paired +0.950 [-0.676, +2.514] on 100 seeds -> does not clear
SHAPE: paired -0.306 [-1.697, +1.061] on 100 seeds -> does not clear
N96: paired +1.381 [-0.040, +2.856] on 100 seeds -> does not clear
selected (CI lower bound > 0, at most 2 best by point estimate): (none)
<!-- /S2:SELECTION -->

## Confirmation (200 seeds 82,100,000–82,100,199; base + selected arms)

Confirmed iff the paired CI lower bound > 0 and ms/move (own moves 3+) ≤ 1.25× base.

<!-- S2:CONFIRM -->
No arm cleared the screen (paired CI lower bound > 0); no confirmation run, as preregistered.
<!-- /S2:CONFIRM -->

## Verdicts

**No arm cleared the screen, so no confirmation ran and nothing changes in the config.** By the
preregistered rule (paired difference against base with a 95% CI lower bound above 0):

| Arm | Paired Δ vs base [95% CI] | Verdict |
|---|---:|---|
| C08 (`cPuct` 0.8) | +0.11 [−1.40, +1.53] | null |
| C32 (`cPuct` 3.2) | −2.10 [−3.53, −0.64] | worse (interval below 0; screen only) |
| O0 (search from move 1) | +0.40 [−1.19, +2.01] | null |
| IV1 (`initVisits` 1) | +0.95 [−0.68, +2.51] | null |
| SHAPE (rising budget curve) | −0.31 [−1.70, +1.06] | null, despite about 11% more iterations on searched moves |
| N96 (`nodeShortlist` 96) | +1.38 [−0.04, +2.86] | does not clear (lower bound −0.04) |

Reading:

- More exploration hurts; less does nothing. The exploration constant is not where the remaining
  gap is.
- Searching the first three moves is no longer harmful (in S1, on the old base, the same switch
  read −1.55 [−3.41, +0.34]), but it is not a gain either.
- Pentobi's budget curve (P11) shows nothing here. This arm is the config-only version of that
  port; a version that redistributes exactly the same total was not run.
- `N96` has now read +0.89 (S1, old base) and +1.38 (here) with both intervals touching 0. Two
  screens are not a confirmation, and its cost could not be measured tonight. It is the one arm
  worth a dedicated 200-seed test with an interleaved cost probe.
- With 100 seeds the screen detects paired effects of about 2 points; smaller real effects would
  pass unseen.

**The ms/move columns in the screen table are not usable.** Base ran first, while two other match
jobs were starting (load average about 66); the arms ran later at half that load. The apparent
0.34–0.52× ratios reflect the machine, not the configs.

## Caveats

- Timing: the machine was shared with other jobs throughout (the S1 confirmation on 5 threads and
  others; load average 9–12 on 14 cores at the start). ms/move figures are wall time under that
  load; the ratio to base is the meaningful number, and it too carries load noise as arms run
  sequentially, not interleaved.
- The screen is a filter (six arms on 100 seeds); only the confirmation is evidence.

## Reproduce

```sh
engine-rs/scripts/s2-screen.sh pin            # copies tmp/p4/bin/blokee-pentobi to tmp/s2/bin
engine-rs/scripts/s2-screen.sh live           # liveness, 2 seeds from 82,900,000
echo "C08 C32 O0 IV1 SHAPE N96" > tmp/s2/ARMS
THREADS=6 nohup engine-rs/scripts/s2-screen.sh chain > tmp/s2/chain.log 2>&1 &
python3 engine-rs/scripts/s2_report.py tmp/s2              # screen table
python3 engine-rs/scripts/s2_report.py tmp/s2 --select     # selection rule
python3 engine-rs/scripts/s2_report.py tmp/s2 --confirm    # confirmation table + verdict
```

Scripts: `engine-rs/scripts/s2-screen.sh`, `s2_configs.py`, `s2_report.py`. Outputs: `tmp/s2/`
(`screen/`, `confirm/`, `live/`, `summary.txt`, `screen.md`, `selected.txt`, `selection.log`,
`confirm.md`, `chain.log`).
