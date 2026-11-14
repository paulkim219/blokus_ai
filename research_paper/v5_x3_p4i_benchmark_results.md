# X3 — where `v5.0-p4i-ultra` stands against Pentobi

Run on the Mac, 2026-11-13 18:41–20:44 CST. Descriptive benchmark of the new base
`engine-rs/configs/v5.0-p4i-ultra.json` (`v5.0-p4-ultra` plus P4 at interior nodes, at equal time),
**no gate: nothing is accepted or rejected and no config changes as a result.** Design: the 18:40 CST
"X3" entry of 2026-11-13 in `research_paper/v6_native_and_learning_preregistered.md` (commit
`8a90a5d`, committed 18:40:54; the first X3 game started 18:41:37). Pentobi 31.0, Classic book on,
one thread per process; budget 300; every seed played from all four seats (lone seat rotated);
intervals are 95% percentile bootstrap by seed. Driver `engine-rs/scripts/x3-run.sh`, read-out
`python3 engine-rs/scripts/x3_report.py tmp/x3` (outputs `tmp/x3/`, git-ignored; `report.md`,
`summary.txt` has `aggregateMatches` for every arm). No game failed in any arm.

**Binary and identity check.** `tmp/x3/bin/blokee-pentobi` was built from HEAD `9e767d7` (engine
sources unchanged since `484cc18`; the build was a no-op) and is byte-identical to
`tmp/p910/bin/blokee-pentobi` (sha256 `d925c533…`, `tmp/x3/bin/PROVENANCE.txt`). Before the first X3
game, both binaries played `v5.0-p4-ultra` and `v5.0-p4i-ultra` as the lone seat against level 6 on
seeds 86,900,000–002 (12 games each, outcomes not read): **12/12 and 12/12 games equal move for
move and in score** (`tmp/x3/identity.log`).

**Timing.** The arms ran strictly one after another on 10 game threads, under `caffeinate -i -s -m
-w <chain pid>`; no other job of mine overlapped any arm. Running alongside, not mine: the Docker VM
(about half a core) and `serve.py` (idle). The load average of 11–14 during the arms is the arm's
own 10 concurrent games. So the ms/move below are unconfounded by overlap but are in-match figures
under that load, not clean single-position cost runs. "3+" = a seat's own moves 3 and later (Blokee
plays 0–2 from the opening heuristic; Pentobi mostly from its book).

## Ladder: one Blokee seat against three Pentobi seats

<!-- X3:LADDER -->
| Opponent | Seeds | `v5.0-p4i-ultra` | First place | `v5.0-p4-ultra`, same seeds | First place | Paired Δ advantage | Paired Δ first place |
|---|---:|---:|---:|---:|---:|---:|---:|
| Level 5 | 200 (86,000,000–199) | **+0.75 [−0.02, +1.48]** | 31.0% | −0.77 [−1.59, +0.09] | 26.6% | **+1.52 [+0.54, +2.46]** | +4.38 pp [+0.38, +8.25] |
| Level 7 | 200 (86,100,000–199) | **−9.72 [−10.54, −8.87]** | 10.0% | −9.99 [−10.95, −9.09] | 10.5% | +0.28 [−0.79, +1.32] | −0.50 pp [−3.12, +2.00] |

ms/move (measured, in-match, all / 3+): level 5: `v5.0-p4i-ultra` 56.8 / 68.1, `v5.0-p4-ultra` 55.4 /
66.6; Pentobi level 5 9.5 / 9.3 and 9.4 / 9.2. Level 7: `v5.0-p4i-ultra` 62.0 / 75.7, `v5.0-p4-ultra`
60.7 / 74.2; Pentobi level 7 591.2 / 651.4 and 587.9 / 647.5. The level-7 arms ran 19:12–19:58 and
19:58–20:43; their games' moves are recorded (`tmp/x3/x3-l7-*.moves.jsonl`) as further level-7
teacher data.

- **Level 5: the gain shows.** +1.52 [+0.54, +2.46] paired, with more wins (+4.4 pp); the config is now
  slightly ahead of level 5 on these seeds (+0.75, interval just touching 0; first place 31%).
- **Level 7: no measurable gain.** +0.28 [−0.79, +1.32] paired, first place unchanged. Both configs
  lose by about 10 (X2 read −10.90 for `v5.0-p4-ultra` on other seeds). Against level 6 the same
  change gave +0.88 [+0.18, +1.56] at equal time (P9/P10 confirmation), so a gain of that size at
  level 7 is not excluded by this interval; a gain like level 5's (+1.5) is near its upper end.
<!-- /X3:LADDER -->

## Reverse: one Pentobi level-6 seat against three `v5.0-p4i-ultra` seats

| Field | Seeds | Pentobi's advantage | Pentobi first place |
|---|---:|---:|---:|
| three `v5.0-p4i-ultra` (X3) | 200 (86,200,000–199) | **+3.66 [+2.91, +4.43]** | 41.5% |
| three `v5.0-p4-ultra` (X2) | 100 (82,200,000–099) | +5.86 [+4.89, +6.90] | 48.3% |
| three `v4.2-ultra` (X1) | 100 (79,000,000–099) | +5.56 [+4.59, +6.59] | 49.5% |

ms/move (measured): Blokee seats 56.1 all / 67.3 (3+), Pentobi level 6 75.9 / 81.9.

The rows are on different seeds, so the comparison is not paired. With that said, X3's interval lies
entirely below X2's (4.43 < 4.89): unlike the P4/P5 port, **P4 at interior nodes appears to make
Blokee a harder field for a lone Pentobi** (by about 2 points; Pentobi still wins 41.5% of games
against par 25%).

## Compute: more iterations against level 6

Lone seat against three level-6 seats, the same 200 seeds 86,300,000–199 for all three arms.

| Arm | `iterationScale` | Blokee ms/move all / 3+ | × saved (3+) | Advantage vs L6 | First place |
|---|---:|---:|---:|---:|---:|
| `v5.0-p4i-ultra` as saved (equal time to `v5.0-p4-ultra`) | 10.383 | 60.3 / 72.9 | 1.00 | **−4.39 [−5.25, −3.57]** | 17.2% |
| equal iterations | 16 | 88.2 / 106.4 | 1.46 | −3.64 [−4.41, −2.89] | 18.1% |
| about 3× time | 32 | 167.9 / 202.1 | 2.77 | **−1.62 [−2.42, −0.82]** | 25.0% |

Pentobi level 6 in these arms: 55.4 / 60.8, 54.8 / 60.2, 54.9 / 60.3 ms/move (all / 3+).

| Paired (same seeds) | Δ advantage | Δ first place |
|---|---:|---:|
| 16 − saved | +0.75 [−0.23, +1.68] | +0.88 pp [−2.50, +4.12] |
| 32 − saved | **+2.77 [+1.69, +3.84]** | +7.75 pp [+4.38, +11.12] |
| 32 − 16 | **+2.02 [+1.04, +3.04]** | +6.88 pp [+3.00, +10.62] |

**Compute now pays.** Doubling the iterations from 16 to 32 adds +2.0 [+1.0, +3.0], and at about
2.8× its saved time per move the config is −1.6 behind level 6 with first place at par (25.0%). In
X2 the old config's doubling (budget 300 → 600, the same 4,800 → 9,600 nominal iterations) gave
+1.25 [−0.07, +2.57] and the next one +0.11. Different seeds and configs, so this is not a paired
comparison; but it is the opposite of X2's "compute does not close the gap". The 16 − saved step
(+0.75, interval spans 0) is consistent with the P9/P10 confirmation's equal-iterations minus
equal-time difference (+0.99 [+0.37, +1.57] on other seeds).

Inferred, not measured: interior expansion with value initialisation lets extra iterations go
deeper (P9/P10 tree shape), where the old config spread them over a flat 24-move shortlist; that
would explain why the same doubling is worth more here. Note the cost: at `iterationScale` 32
Blokee spends 202 ms per searched move against level 6's 60, i.e. about 3.3× Pentobi's time, and is
still behind.

## Summary

| Match (lone seat first) | Seeds | Result | First place |
|---|---:|---:|---:|
| `v5.0-p4i-ultra` vs 3 × level 5 | 200 | +0.75 [−0.02, +1.48]; paired vs `v5.0-p4-ultra` +1.52 [+0.54, +2.46] | 31.0% (paired +4.38 pp [+0.38, +8.25]) |
| `v5.0-p4i-ultra` vs 3 × level 6 (compute block, as saved) | 200 | −4.39 [−5.25, −3.57] | 17.2% |
| same at `iterationScale` 16 / 32 | 200 | −3.64 [−4.41, −2.89] / −1.62 [−2.42, −0.82] | 18.1% / 25.0% |
| level 6 vs 3 × `v5.0-p4i-ultra` | 200 | +3.66 [+2.91, +4.43] for Pentobi | 41.5% |
| `v5.0-p4i-ultra` vs 3 × level 7 | 200 | −9.72 [−10.54, −8.87]; paired vs `v5.0-p4-ultra` +0.28 [−0.79, +1.32] | 10.0% (paired −0.50 pp [−3.12, +2.00]) |

Reading (inferred). P4 at interior nodes, at equal time, helps clearly against level 5, by about +0.9
against level 6 (P9/P10), not measurably against level 7, and makes Blokee a harder field for a lone
level-6 seat. More time per move now converts into strength (+2.8 for 2.8× the time against level 6),
which X2 did not show for the old config. The configs remain about 4 points behind level 6 at equal
time and about 10 behind level 7.

## Caveats

- Descriptive benchmark, many intervals read: no figure here is a decision.
- Reverse and cross-run comparisons with X1/X2 are on different seeds and not paired.
- ms/move are in-match under each arm's own 10-game load, not clean cost runs; Blokee's ms in the
  reverse arm is the mean over its three seats.
