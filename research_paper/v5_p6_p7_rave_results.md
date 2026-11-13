# v5.0 ports P6–P7 — RAVE, last-good-reply; P3B re-test; P8 reuse diagnostic

Run on the Mac (M4 Pro, 14 cores) on 2026-11-13. Design, seeds and rules are the 2026-11-13 12:44
CST entry of `research_paper/v6_native_and_learning_preregistered.md` ("P6/P7"), commit `e89cb9b`.
Outputs are under `tmp/p67/` (git-ignored). Base: `engine-rs/configs/v5.0-p4-ultra.json`.

Why: on the P4/P5 base more iterations saturate, the search knobs are null and the P1–P3 rollout and
reward ports were null, so the open question is how much the search learns from each simulation.
With several hundred root children and about 4,000 iterations, most root children get no real
visit (base, own moves 3–8: about 51 of 454 root children visited, clean cost run below). RAVE and
reply tables are the two Pentobi mechanisms aimed at that.

## What was built

All of it is behind two new native-only config blocks; absent (or at their identity points) the
engine is byte-identical (see "Identity gates"). Pentobi's source was read to understand the two
mechanisms; no code or constant was copied. The RAVE schedule is Silver's minimum-error form from the
literature and LGR is Drake's last-good-reply with Baier & Drake's forgetting; every number is a
config value chosen from our own grid. Option reference: `engine-rs/README.md`, "RAVE and
last-good-reply (P6/P7)". Code: commit `79bfa0b`.

**P6 — RAVE (`native.rave`: `weight`, `equivalence`, `distanceDecay`, `scope`).**

- *Storage.* Each tree node with RAVE on keeps, per child edge, `(Σ w·v, Σ w)` (`Node::amaf` in
  `src/search.rs`), separate from the real visits and values (unlike Pentobi, which adds RAVE updates
  into the child's own value with a weight).
- *Update* (`V12Search::update_amaf`, called in `iterate` right after `backup`). The simulation's
  placements are listed in order as (seat, placement): the tree path (from the path's `Undo` records),
  then the rollout (`Playout::played`, from the rollout's step list). For each path node i, every
  child edge whose placement was played by the node's mover at simulation index j ≥ i gets
  `w = 1 − distanceDecay·(j − i)/(L − i)` (L = simulation length) and `v` = the simulation's value
  for the node's Q component (the mover; the root seat when the search is paranoid). The edge taken
  at the node counts with j = i. A placement occupies its cells, so it occurs at most once per
  simulation and "first play" needs no bookkeeping. The root (hundreds of edges) is matched through a
  placement → edge table built in `prepare`; interior nodes (≤ 24 edges) by scanning their edges
  against a per-simulation stamp array.
- *Selection* (`select`). After Q is formed exactly as before (value-initialised root mix, first-play
  value or child mean), an edge with AMAF weight > 0 gets `Q ← (1 − β)·Q + β·Q_amaf`,
  `β = ñ / (ñ + n + n·ñ/equivalence)`, `ñ = weight × Σw`, `n` = the child's visits plus `initVisits`
  (3) at the value-initialised root (so n = 0 for an unvisited interior child: its AMAF mean replaces
  the first-play value). The exploration term, the history term, the final choice (visits) and the
  early stop are unchanged.
- *Interior nodes: decided yes* (scope "all" in the main arms), because the same per-simulation
  update serves them at almost no cost (≤ 24 edges per path node) and opponent nodes in the
  principal line are visited only tens to hundreds of times. `scope` "root" is the alternative, and
  arm `R6SR` measures it.
- *Placement-level*, on the fully expanded P4/P5 root, unlike the earlier piece-level attempt in the
  40-move tree.

**P7 — last-good-reply (`native.lastGoodReply`: `enabled`, `forget`).** `src/reply_table.rs`:
per seat, previous placement → reply (LGR-1; the previous placement is the one just before, by any
seat, passes skipped; for the first move of a simulation it is the game's last placement before the
root). After every simulation that ends in a known final score (rollout to the end, terminal tree
node, all seats sealed; not the never-reached truncated path), each placement in it, tree part and
rollout, is stored as its seat's reply if that seat's final score is the highest (ties included);
with `forget`, a stored reply equal to a non-winner's is deleted. In a rollout (`Playout::run`, both
the "sampled" and the "all" path) the stored reply to the previous placement is played whenever it is
legal, before anything else. The table is cleared at each search.

*Interaction with the existing terms.* `historyWeight` (progressive history) acts only in tree
selection and learns from every backed-up tree edge; LGR does not touch it, but changes the rollout
values it learns from. `playoutTableBlend` (the learned table blended into the size/centre ordering)
and `playoutEps` (60% uniform) choose among the ≤ 12 placements at one random corner; when a stored
reply is legal LGR pre-empts both, and the corner sampling. Measured on 60 X1 positions
(`p67_probe stats`, base search): the table supplied 8.7% of rollout moves at own moves 3–8, 13.3% at
9–14 and 18.6% at 15+.

**Diagnostics** (`examples/p67_probe.rs`, read-only accessors `V12Search::node_visits`,
`root_edge_stats`, `reply_stats`, `Engine::reuse_probe`): AMAF coverage and reply-table supply rate
(`stats`), and the P8 reuse measurement (`reuse`).

**Refused in `unsupported()`:** negative or non-finite `weight`, `equivalence` ≤ 0,
`distanceDecay` outside [0, 1], unknown `scope`, RAVE with `native.net` or `native.prior` (both add
counts to the root's Q or decision), and either option with `opponentPolicy` "brs" (it moves the turn
in the tree, so a node's mover is not the seat the statistics credit). Both blocks refuse unknown keys.

## Gates

Measured (`tmp/p67/identity.log`). Reference binaries: `tmp/p13/bin`, built at `20f6cb1`; the engine
sources are identical at `db6676c`, the parent of this change (checked with `git diff` in
`p67-run.sh before`). New binaries from `79bfa0b`, pinned in `tmp/p67/bin/` (`PROVENANCE.txt`).

- `cargo test --release`: 5 unit (4 + the reply-table rules), 2 move-list, **8 parity**, 5 new in
  `tests/rave_lgr.rs`: identity points search exactly like the base on 12 positions; with RAVE on,
  every root edge's AMAF weight ≥ its real visits, integer weights without decay, interior statistics
  only with scope "all"; the reply table supplies moves on both rollout paths; refusals; the reuse
  probe finds the played child with at least the edge's visits. The new tests also pass in a debug
  build (debug assertions: every path move is by the node's mover, every rollout move legal).
  `npm run native:build && npm run native:test` pass.
- `v5.0-p4-ultra` mirror with the new `blokee-match`, 20 seeds from 80,900,000:
  `0.00 [95% CI -0.00, 0.00]`.
- Identity point `p67-ID` (`rave.weight` 0, `lastGoodReply.enabled` false) vs `v5.0-p4-ultra`:
  `0.00 [-0.00, 0.00]`; 80/80 games have every seat's score equal to the old binary's mirror (as does
  the new binary's own mirror).
- Self-play, 6 games from 80,950,000: `shard-00.bin` and `games.jsonl` byte-identical across the old
  binary, the new binary and `p67-ID` (sha256 `e834eb15…` / `f788f905…`, the same as P1–P3's).
- Pentobi bridge, 2 seeds from 80,980,000: new binary and `p67-ID` 8/8 games move-for-move equal to
  the old binary.

## Cost (clean run)

`p67-run.sh cost 150`: `examples/p4_cost.rs` on 150 positions of the lone Blokee seat in the X1
level-6 games (own moves 3–20), every arm in turn on the same thread with the same RNG seed, budget
300, 2 threads, 12:41–12:42 with nothing of mine running (the Docker VM and `serve.py` were; load
4.6–5.0). Measured, `tmp/p67/cost/cost.md`:

| Config | ms/move 3–8 | ms/move 9–14 | ms/move 15+ | ms/move all (3+) | × base (all) | Root children visited (3–8) |
|---|---:|---:|---:|---:|---:|---:|
| base | 98.9 | 56.4 | 20.4 | 71.2 | 1.00 | 51.1 of 453.9 |
| ID | 98.9 | 55.0 | 17.9 | 70.3 | 0.99 | 51.1 |
| P3B | 87.3 | 49.6 | 16.4 | 62.6 | 0.88 | 53.5 |
| R6W | 101.7 | 58.3 | 20.4 | 73.3 | 1.03 | 59.6 |
| R6S | 103.4 | 59.7 | 19.4 | 74.6 | 1.05 | 87.7 |
| R6SR | 102.7 | 59.7 | 18.6 | 74.2 | 1.04 | 87.2 |
| L7 | 95.7 | 54.1 | 17.7 | 68.5 | 0.96 | 50.9 |
| R6SL7 | 102.2 | 56.9 | 18.4 | 72.7 | 1.02 | 87.9 |
| R6SP1L | 246.6 | 59.3 | 14.6 | 136.0 | 1.91 | 109.9 |

RAVE costs 3–5% per move; LGR saves 4% (a stored legal reply skips the corner sampling); with the
all-moves rollout the arm costs 1.91×. These ratios were fixed in the preregistration and decide
whether an equal-time arm is needed (only `R6SP1L` would need one).

<!-- P67:SCREEN -->
## Screen

400 seeds 84,000,000–84,000,399, each arm as the lone seat against three Pentobi level-6 seats
(1,600 games per arm), arms one after another on 10 threads, 12:44–14:14, pinned binary
`tmp/p67/bin/blokee-pentobi`, under `caffeinate -i -s -m -w <chain pid>` (`pmset -g log`: no sleep
after 11:50; every arm took 11 minutes, `R6SP1L` 13). Measured
(`python3 engine-rs/scripts/p67_report.py tmp/p67`). Paired Δ is arm − base on the same seeds, 95%
percentile bootstrap by seed; `*` marks an interval excluding 0. No game failed (1,600/1,600 per arm,
no failure files, no HARD lines). In-match ms/move columns are from runs on a loaded machine (load
11–14) and are not the cost measurement; the clean run above is.

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-p4-ultra unchanged | 400 | -4.86 [-5.45, -4.26] | 17.2% | — | 57.4 | 69.4 | 1.00 | 0/1600 |
| P3B | P3B re-test: rank reward + quality bonus 0.25, length 0.1 (as screened 2026-11-13 on 83,000,000) | 400 | -3.99 [-4.52, -3.46] | 15.8% | +0.86 [+0.13, +1.58] * | 51.9 | 62.7 | 0.90 | 1599/1600 |
| R6W | RAVE weak: AMAF weight 0.05, equivalence 100, distance decay 0.5, all nodes | 400 | -5.20 [-5.78, -4.62] | 15.8% | -0.34 [-1.05, +0.36] | 60.3 | 73.0 | 1.05 | 1592/1600 |
| R6S | RAVE strong: AMAF weight 0.5, equivalence 100, distance decay 0.5, all nodes | 400 | -5.96 [-6.56, -5.35] | 14.0% | -1.10 [-1.81, -0.37] * | 63.9 | 77.5 | 1.12 | 1590/1600 |
| R6SR | RAVE strong at the root only (AMAF weight 0.5, equivalence 100, decay 0.5) | 400 | -5.12 [-5.73, -4.49] | 15.6% | -0.26 [-0.99, +0.45] | 62.9 | 76.1 | 1.10 | 1590/1600 |
| L7 | last-good-reply (LGR-1, previous placement, with forgetting) | 400 | -5.29 [-5.85, -4.73] | 17.0% | -0.43 [-1.14, +0.28] | 56.2 | 68.0 | 0.98 | 1591/1600 |
| R6SL7 | R6S and L7 together | 400 | -5.34 [-5.91, -4.77] | 16.5% | -0.48 [-1.20, +0.23] | 61.8 | 74.8 | 1.08 | 1594/1600 |
| R6SP1L | R6S with the all-legal-moves rollout (P1L fitted weights 1.3995 / 0.7185 / 0.6515) | 400 | -4.74 [-5.36, -4.11] | 19.5% | +0.12 [-0.60, +0.85] | 108.4 | 131.0 | 1.89 | 1600/1600 |

Selection (preregistered rule; `tmp/p67/selection.log`):

```
P3B: paired +0.865 [+0.125, +1.578] on 400 seeds -> clears the screen
R6W: paired -0.345 [-1.047, +0.365] on 400 seeds -> does not clear
R6S: paired -1.097 [-1.814, -0.368] on 400 seeds -> does not clear
R6SR: paired -0.264 [-0.994, +0.449] on 400 seeds -> does not clear
L7: paired -0.428 [-1.143, +0.284] on 400 seeds -> does not clear
R6SL7: paired -0.483 [-1.198, +0.231] on 400 seeds -> does not clear
R6SP1L: paired +0.121 [-0.601, +0.851] on 400 seeds -> does not clear
selected: P3B (cleared, largest point estimate +0.865)
```

Only one mechanism cleared, so no combination arm was built. `P3B`'s clean cost ratio is 0.88, so
no equal-time arm was needed.

**Descriptive contrasts between arms** (post hoc, not preregistered, selection-biased because `R6S`
is the worst arm; same seeds, `ml/seat/paired_report.py`): `R6SR − R6S` +0.83 [+0.16, +1.52] (RAVE
at interior nodes costs strength at this weight); `R6SP1L − R6S` +1.22 [+0.48, +1.96] (with the
all-legal-moves rollout the strong RAVE arm is back at base level); `R6SL7 − R6S` +0.61
[−0.09, +1.29]; `R6S − R6W` −0.75 [−1.43, −0.11].
<!-- /P67:SCREEN -->

<!-- P67:CONFIRM -->
## Confirmation

`P3B` and `base` started together on 400 fresh seeds 84,400,000–84,400,399 (5 threads each,
14:15–14:36, same pinned binary, under `caffeinate`). Measured
(`python3 engine-rs/scripts/p67_report.py tmp/p67 --confirm`, `tmp/p67/confirm.md`); no game failed:

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-p4-ultra unchanged | 400 | -4.73 [-5.28, -4.16] | 17.6% | — | 57.0 | 69.0 | 1.00 | 0/1600 |
| P3B | P3B re-test: rank reward + quality bonus 0.25, length 0.1 (as screened 2026-11-13 on 83,000,000) | 400 | -4.25 [-4.84, -3.65] | 14.1% | +0.48 [-0.27, +1.23] | 51.4 | 62.0 | 0.90 | 1600/1600 |

- P3B: paired +0.48 [-0.27, +1.23] -> not accepted (lower bound <= 0); clean cost 0.88x base
NEW BASE: (none)

**Not accepted**: the paired lower bound is below 0. No config becomes the new base, so the direct
match on 84,800,000–199 was not played (those seeds are unread) and no config was saved.

Descriptive only (post hoc, not a decision; it pools the screen that selected the arm, so it is
biased upward): `P3B − base` by block was +0.44 [−0.92, +1.87] (100 seeds, 83,000,000, this
morning), +0.86 [+0.13, +1.58] (400, screen), +0.48 [−0.27, +1.23] (400, confirmation); all 900
seeds pooled +0.65 [+0.19, +1.14]; the two fresh 84M blocks +0.67 [+0.15, +1.18]. Every block's point
estimate is positive and the arm is 10–12% cheaper per move, so a small gain (of order +0.5) is
plausible but is not established under the rule. Settling it would need a new dated entry with a
larger fresh-seed confirmation (at the confirmation's own estimate, about 800–1,000 seeds).
<!-- /P67:CONFIRM -->

## Verdict

**Nothing accepted; `v5.0-p4-ultra` stays the base.**

- **P6 RAVE: rejected at the tested settings.** Strong RAVE at every node is harmful,
  −1.10 [−1.81, −0.37] (`R6S`); weak RAVE −0.34 [−1.05, +0.36] and strong RAVE at the root only
  −0.26 [−0.99, +0.45] are null; with last-good-reply −0.48 [−1.20, +0.23]; with the all-legal-moves
  rollout +0.12 [−0.60, +0.85] at 1.91× the cost. No RAVE arm has a positive point estimate except
  the one that costs 1.9×.
- **P7 last-good-reply: null**, −0.43 [−1.14, +0.28] (`L7`), 0.96× cost.
- **P3B: cleared the screen, not confirmed** (+0.86 then +0.48 [−0.27, +1.23]).
- **P8 subtree reuse: parked.** Reuse would carry over 0.23% of the budget (0.00% on moves 4–8).

Reading (inferred, not measured): on this base the root prior from the P4/P5 fit decides which root
children are worth visits, and the AMAF statistics, gathered from rollouts that play a random corner
60% of the time, are a worse guide than that prior. At β ≈ 0.85 they override it and the search
spreads visits over 88 instead of 51 root children at moves 3–8 (clean run), which costs strength;
at β ≈ 0.38 the effect is too small to see. The descriptive contrasts point the same way: interior
RAVE was the more harmful part (`R6SR − R6S` +0.83), and better rollouts (all legal moves, size and
local weights) removed the harm (`R6SP1L − R6S` +1.22), consistent with AMAF quality being limited
by the rollout policy. Last-good-reply changes 9–19% of rollout moves and does not move the result.

## Caveats and things I am unsure of

- **One value of `equivalence` (100) and `distanceDecay` (0.5)**; strength was varied only through
  the AMAF weight (0.05, 0.5). The grid was set from search internals (AMAF counts on 60 positions),
  not from outcomes. Values between the two, or RAVE with the root's initial-visit count raised so
  that AMAF cannot override the prior so quickly, were not tried.
- **Design choices that another reading could change:** RAVE statistics are kept apart and blended
  (Pentobi adds them into the child's value); the edge taken at a node also gets its AMAF update
  (k = 0); `n` in β includes the 3 initial visits at the root; LGR is LGR-1 only (no two-move key),
  "did well" = highest final score (ties count), and the table is cleared each search. I do not
  think a different reading would turn the strong-RAVE harm into a gain, but that is untested.
- **Multiple arms.** Seven arms were read at 95% each; one cleared and did not confirm, which is
  what the confirmation step is for. The descriptive contrasts above are post hoc.
- **P8 caveat.** The probe looks nodes up by position hash, which misses a next-turn position that
  the tree reached only through a seat being marked out (a pass); that happens late in games and
  can only understate the late-game share, which is small either way. The probe reproduced
  630/630 searched moves, so the trees measured are the ones played.
- The in-match ms/move columns come from a loaded machine (load 11–14, Docker VM and `serve.py`
  running, not mine); the clean cost run is the cost figure.
- I was cut off by a usage limit from about 12:58 to 13:27; the chain ran unattended under
  `caffeinate` and was not disturbed. The P8 probe ran at 13:27, during the screen.

## Next

P6, P7 and P8 are recorded as tested (rejected, null, parked). The one open item from this run is
whether P3B's small positive effect is real, which needs a new preregistered, larger fresh-seed test.
Remaining ports: P9 (opening rules and book), P10 (selection formula), and the section-B ideas.


## P8 — what subtree reuse would carry over (diagnostic, no strength claim)

`p67-run.sh reuse 48` (13:27–13:28, during the screen; the probe uses iteration budgets, so the
screen's load does not change its numbers). 48 of the screen's base games (seeds 84,000,000–399,
evenly spaced), replayed by `p67_probe reuse` with the bridge's RNG discipline: **630/630 searched
moves reproduced the recorded move**, so the trees measured are the ones the engine actually built.
At each searched decision whose previous decision was also a search: the visits that the previous
tree holds at the positions along the line actually played (after the own move, then after each
opponent), the last being the position the engine now faces. Measured, `tmp/p67/reuse/reuse.md`:

| Own moves | Decisions | Previous search's iterations | Depth 1 (after own move) | Depth 2 | Depth 3 | **Depth 4 = next own turn** | Share of 4,800 | Decisions with > 0 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4–8 | 240 | 3,950 | 1,517 | 60.1 | 1.00 | 0.01 | 0.000% | 2 | 1 |
| 9–14 | 282 | 3,977 | 1,475 | 180.2 | 14.8 | 1.08 | 0.022% | 65 | 54 |
| 15+ | 108 | 3,916 | 1,782 | 379.1 | 112.5 | 61.2 | 1.28% | 84 | 482 |
| all | 630 | 3,956 | 1,544 | 168.5 | 26.3 | **11.0** | **0.23%** | 151 | 482 |

The tree follows the own move (about 40% of the iterations) and the first opponent's reply only
thinly; by the third opponent's move almost nothing is left. Reuse would carry over 0.23% of the
budget on average (0.00% on moves 4–8, where decisions matter most; 1.3% late in the game). Under the
preregistered reading (under 5% → not worth building), **P8 is parked on this base.** Reading
(inferred): the interior shortlist (24, progressive widening) and three Pentobi replies that are often
outside it make the four-ply line almost never present; reuse would matter only with much deeper
trees or pondering (N13), which needs it.
