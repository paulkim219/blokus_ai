# v5.0 ports P9–P10 — selection rule, P4 at interior nodes, opening rules; tree-shape diagnostic

Run on the Mac (M4 Pro, 14 cores) on 2026-11-13. Design, seeds and rules are the "P9/P10" entry of
`research_paper/v6_native_and_learning_preregistered.md`, commit `d6927e9` (committed 15:18:42; the
entry's heading says 15:20, my estimate when writing it; the first screen game started 15:18:56).
Outputs are under `tmp/p910/` (git-ignored). Base: `engine-rs/configs/v5.0-p4-ultra.json`.

Why: P8's diagnostic showed our tree is about one move deep (of ~4,000 iterations the chosen root
move holds ~1,540 visits, the reply ~170, the position at our next turn ~11), while Pentobi level 6
carries about 45% of its root visits into the next search. The hypothesis under test (Paul's,
untested before this run): Pentobi's selection rule and its treatment of interior nodes (every legal
move expanded and value-initialised at every node) make its tree deep, and depth is part of the
remaining gap. Earlier `cPuct` tests kept our PUCT formula, so they did not cover this.

## Tree-shape diagnostic (step 0; search internals only, no game outcome)

`examples/p910_probe.rs`, 48 positions of the lone Blokee seat in the X1 level-6 games (own moves
3–20, evenly spaced, the same sampling as `p67_probe stats`); one position (pos 28) has a single
legal move and Pentobi does not search it, so it is left out for every config (47 positions).
Our configs search at budget 300 with the same RNG seed as `p4_cost`. Pentobi level 6 is driven
only through GTP (`pentobi-gtp` 31.0, one thread, `--nobook`, `param reuse_subtree 0`, seed 1): the
game is replayed with `play`, then `genmove` for the lone seat's colour, then `save_tree` dumps the
tree (visits per node) and the engine's log gives `Sim`, `Vst` and the in-tree depth `Dp`. Pentobi
was not modified or rebuilt. Measured, `tmp/p910/shape/arms.md` (arms) and `tmp/p910/diag/` (grid):

<!-- P910:SHAPE -->
**Arms** (`tmp/p910/shape/arms.md`):

| Config | Pos. | Simulations | Root visits | Tree depth mean / max | Root children with a visit | Root children for 50% / 90% | Top root child share | PV visits: d1 / d2 / d3 / d4 / d6 | Visits at depth 3 / 4 / 5 / 6 (share of root) | Interior nodes | Edges per interior node | Visited edges per interior node | Nodes ≥100 visits: count, edges, visited, top share | ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pentobi-L6 | 47 | 7295 | 7295 | 5.64 / 23 | 50 of 245 | 1.9 / 11.7 | 0.52 | 3751 / 1867 / 1174 / 773 / 231.6 | 91.0% / 80.9% / 64.3% / 45.5% | 975 | 153.4 | 2.0 | 60.1, 94, 6.0, 0.69 | 95 |
| p910-base | 47 | 3963 | 3963 | 3.47 / 7 | 35 of 284 | 2.2 / 9.4 | 0.41 | 1548 / 375 / 69 / 13 / 0.5 | 87.2% / 52.1% / 9.9% / 1.2% | 965 | 21.0 | 3.9 | 12.0, 22, 18.0, 0.17 | 73 |
| p910-P10A | 47 | 3794 | 3794 | 3.57 / 7 | 22 of 284 | 1.9 / 7.9 | 0.46 | 1652 / 427 / 92 / 17 / 0.9 | 88.8% / 56.4% / 13.4% / 1.7% | 888 | 20.9 | 4.0 | 12.6, 22, 17.8, 0.21 | 68 |
| p910-P10B | 47 | 3524 | 3524 | 3.93 / 8 | 19 of 284 | 1.5 / 5.1 | 0.58 | 1898 / 782 / 264 / 78 / 4.3 | 90.3% / 66.4% / 29.4% / 8.1% | 814 | 20.6 | 4.1 | 12.9, 22, 18.0, 0.28 | 62 |
| p910-P4I | 47 | 3815 | 3815 | 4.64 / 16 | 36 of 284 | 1.9 / 8.7 | 0.46 | 1667 / 829 / 370 / 160 / 34.2 | 87.7% / 72.2% / 51.1% / 30.0% | 1380 | 231.8 | 2.6 | 18.6, 219, 17.1, 0.46 | 116 |
| p910-P4IP10A | 47 | 3840 | 3840 | 6.09 / 22 | 21 of 284 | 1.9 / 7.1 | 0.47 | 1685 / 936 / 484 / 276 / 77.8 | 91.8% / 84.2% / 72.5% / 57.2% | 1650 | 230.7 | 2.2 | 26.4, 243, 8.5, 0.58 | 130 |
| p910-P9A | 47 | 3963 | 3963 | 3.47 / 7 | 35 of 284 | 2.2 / 9.4 | 0.41 | 1548 / 375 / 69 / 13 / 0.5 | 87.2% / 52.1% / 9.9% / 1.2% | 965 | 21.0 | 3.9 | 12.0, 22, 18.0, 0.17 | 72 |
| p910-P9B | 47 | 3893 | 3893 | 3.49 / 7 | 34 of 284 | 2.0 / 9.0 | 0.43 | 1615 / 398 / 75 / 14 / 0.5 | 87.3% / 53.0% / 10.4% / 1.2% | 945 | 20.9 | 3.9 | 11.8, 22, 18.1, 0.18 | 68 |
| p910-O0 | 47 | 3963 | 3963 | 3.47 / 7 | 35 of 284 | 2.2 / 9.4 | 0.41 | 1548 / 375 / 69 / 13 / 0.5 | 87.2% / 52.1% / 9.9% / 1.2% | 965 | 21.0 | 3.9 | 12.0, 22, 18.0, 0.17 | 71 |

**Grid of the priorLog constant** (`tmp/p910/diag/grid.md`; `S` = priorLog alone, `IS` = with
interior expansion, `CUT` = PUCT with the exact cut-off):

| Config | Pos. | Simulations | Root visits | Tree depth mean / max | Root children with a visit | Root children for 50% / 90% | Top root child share | PV visits: d1 / d2 / d3 / d4 / d6 | Visits at depth 3 / 4 / 5 / 6 (share of root) | Interior nodes | Edges per interior node | Visited edges per interior node | Nodes ≥100 visits: count, edges, visited, top share | ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| p910g-P4I | 47 | 3815 | 3815 | 4.64 / 16 | 36 of 284 | 1.9 / 8.7 | 0.46 | 1667 / 829 / 370 / 160 / 34.2 | 87.7% / 72.2% / 51.1% / 30.0% | 1380 | 231.8 | 2.6 | 18.6, 219, 17.1, 0.46 | 112 |
| p910g-S0.05 | 47 | 3346 | 3346 | 4.30 / 11 | 15 of 284 | 1.4 / 3.5 | 0.66 | 2050 / 998 / 450 / 188 / 21.0 | 91.7% / 74.4% / 42.5% / 17.7% | 761 | 20.5 | 4.1 | 14.5, 22, 18.2, 0.36 | 57 |
| p910g-S0.1 | 47 | 3524 | 3524 | 3.93 / 8 | 19 of 284 | 1.5 / 5.1 | 0.58 | 1898 / 782 / 264 / 78 / 4.3 | 90.3% / 66.4% / 29.4% / 8.1% | 814 | 20.6 | 4.1 | 12.9, 22, 18.0, 0.28 | 60 |
| p910g-S0.2 | 47 | 3794 | 3794 | 3.57 / 7 | 22 of 284 | 1.9 / 7.9 | 0.46 | 1652 / 427 / 92 / 17 / 0.9 | 88.8% / 56.4% / 13.4% / 1.7% | 888 | 20.9 | 4.0 | 12.6, 22, 17.8, 0.21 | 66 |
| p910g-S0.4 | 47 | 4172 | 4172 | 3.34 / 7 | 28 of 284 | 3.1 / 11.6 | 0.33 | 1310 / 189 / 28 / 5 / 0.3 | 87.0% / 45.1% / 4.6% / 0.6% | 1000 | 21.2 | 4.0 | 12.1, 22, 18.0, 0.14 | 75 |
| p910g-S0.8 | 47 | 4327 | 4327 | 3.22 / 6 | 38 of 284 | 4.0 / 16.3 | 0.28 | 1136 / 108 / 12 / 2 / 0.1 | 84.9% / 36.8% / 2.6% / 0.4% | 1065 | 21.4 | 3.9 | 11.9, 22, 18.2, 0.11 | 80 |
| p910g-S1.6 | 47 | 4349 | 4349 | 3.15 / 6 | 49 of 284 | 4.7 / 20.6 | 0.26 | 1072 / 87 / 9 / 2 / 0.1 | 82.9% / 33.3% / 2.2% / 0.4% | 1118 | 21.6 | 3.7 | 11.6, 22, 18.0, 0.10 | 80 |
| p910g-IS0.05 | 47 | 3581 | 3581 | 9.53 / 36 | 12 of 284 | 1.5 / 3.5 | 0.62 | 2039 / 1635 / 1196 / 907 / 461.5 | 94.2% / 92.0% / 88.3% / 83.1% | 1595 | 185.3 | 2.0 | 47.7, 233, 5.4, 0.75 | 112 |
| p910g-IS0.1 | 47 | 3579 | 3579 | 7.66 / 31 | 17 of 284 | 1.5 / 4.6 | 0.58 | 1933 / 1314 / 846 / 569 / 260.1 | 93.1% / 88.9% / 82.3% / 72.9% | 1587 | 206.9 | 2.1 | 34.9, 246, 6.5, 0.69 | 115 |
| p910g-IS0.2 | 47 | 3840 | 3840 | 6.09 / 22 | 21 of 284 | 1.9 / 7.1 | 0.47 | 1685 / 936 / 484 / 276 / 77.8 | 91.8% / 84.2% / 72.5% / 57.2% | 1650 | 230.7 | 2.2 | 26.4, 243, 8.5, 0.58 | 127 |
| p910g-IS0.4 | 47 | 4065 | 4065 | 5.18 / 20 | 29 of 284 | 2.6 / 10.6 | 0.37 | 1430 / 600 / 288 / 133 / 34.2 | 89.8% / 77.5% / 60.1% / 41.1% | 1714 | 237.6 | 2.2 | 21.9, 249, 11.0, 0.49 | 133 |
| p910g-IS0.8 | 47 | 4278 | 4278 | 4.69 / 17 | 39 of 284 | 3.5 / 15.5 | 0.30 | 1224 / 438 / 179 / 82 / 21.3 | 87.7% / 71.2% / 50.3% / 30.9% | 1807 | 240.6 | 2.2 | 19.0, 252, 13.7, 0.43 | 139 |
| p910g-IS1.6 | 47 | 4353 | 4353 | 4.45 / 17 | 51 of 284 | 4.4 / 20.2 | 0.27 | 1104 / 363 / 142 / 66 / 17.0 | 86.0% / 66.9% / 44.7% / 26.1% | 1878 | 243.2 | 2.2 | 17.4, 253, 16.0, 0.40 | 143 |
| p910g-CUT | 47 | 3963 | 3963 | 3.47 / 7 | 35 of 284 | 2.2 / 9.4 | 0.41 | 1548 / 375 / 69 / 13 / 0.5 | 87.2% / 52.1% / 9.9% / 1.2% | 965 | 21.0 | 3.9 | 12.0, 22, 18.0, 0.17 | 70 |

Reading (measured unless marked). The base tree is shallow and flat below the root: mean depth 3.5,
never deeper than 7, visits at depth 5 are 10% of the root's, and an interior node with ≥ 100 visits
spreads them over 18 of its 22 candidates with 17% on the top one. Level 6's tree is deeper (mean
5.6, up to 23; 64% of the root's visits reach depth 5) because its busy interior nodes concentrate:
of 94 candidates they visit 6 and give the top one 69%. **The selection rule alone barely deepens our
tree** (P10A depth 3.6, P10B 3.9): it concentrates the root (top child 46% / 58%) but interior nodes
stay 24-wide and flat, since their first-play value is the parent mean for every unvisited child and
their priors (hand ordering at temperature 6) are nearly uniform. **Interior expansion is what
deepens it** (P4I 4.6, depth 5 at 51%; busy nodes' top child 46%), because value initialisation gives
low-prior children a low starting value. **Together** (P4IP10A) the tree is about as deep as level
6's (6.1 mean, max 22; 72% at depth 5; PV 1,685 / 936 / 484 / 276 against level 6's 3,751 / 1,867 /
1,174 / 773 from about twice as many simulations). P9A and O0 change only own moves 0–2 and P9B only
the rollouts, so their trees at own moves 3+ are the base's (P9B within noise).
<!-- /P910:SHAPE -->

Definitions. *Tree depth*: edges descended in the tree part of one simulation (ours: path length
including the newly created leaf edge; Pentobi: `Dp`, its in-tree length including the expanded
child), mean over the search and maximum. *PV visits*: visits of the nodes along the most-visited
line. *Visits at depth d*: sum of the visits of the nodes at depth d (a transposed node counted once,
at its smallest depth), as a share of the root's. *Interior node*: an initialised non-root node with
moves (ours) / an expanded non-root node (Pentobi); *edges* = candidate children (ours: the move list;
Pentobi: children created), *visited* = children with at least one visit. *Nodes ≥ 100 visits*: the
interior nodes the search actually works in, with their mean edges, visited edges and the top child's
share of their edge visits.

Caveats on the comparison. Pentobi searched about 7,300 simulations per position here against our
~4,000 (its level-6 budget at these positions with the book and reuse off), so its absolute visit
counts are higher; the shares and the per-node shape are the comparable columns. Pentobi creates all
children at expansion, so its "edges per interior node" counts every expanded node, many of which
were visited once or twice.

## What was built

All behind new native-only config options; with the options absent (or at their identity points)
the engine is byte-identical (see "Identity gates"). Pentobi's source was read to understand the
mechanisms (`SearchBase.h` `select_child`, `play_in_tree`; `PriorKnowledge.h` `gen_children`;
`State.cpp` `get_is_piece_considered`); no code or constant was copied, every number is a config
value chosen from our own measurements. Option reference: `engine-rs/README.md`, "Selection rule,
interior expansion and opening rules (P9/P10)". Code: commit `484cc18`.

**P10 — selection rule (`native.selection`: `rule`, `exploration`, `scope`, `countOffset`,
`cutoff`; `search.rs` `select`).** With `rule` `"priorLog"` a child's score is

```
score_i = Q_i + exploration · p_i · sqrt(N) · ln(N + 1) / (n_i + k) + h_i
```

N the node's real visits, n_i the edge's visits, p_i the node's prior, k = `initVisits` at a
value-initialised root, `interiorInitVisits` at a value-initialised interior node and `countOffset`
elsewhere; Q_i (value-initialised mix, first-play value or child mean) and the progressive-history
term h_i are formed exactly as before. `scope` "all" / "root" / "interior" (PUCT elsewhere). The
move choice (most visits) and the early stop are unchanged.

*The cut-off.* `cutoff` c > 0 skips a child when `Q_i + c·B ≤` the best score found so far, with B
the largest exploration term the node can give (p_max over the smallest denominator, times the
exploration factor) plus the largest history term (|historyWeight| × the reward's range). At c = 1
the skip is exact: a skipped child cannot beat the best, so no choice changes, only time. This is
also how I read Pentobi's cut-off (its bound uses the largest possible prior over the smallest
initial count), i.e. it is a speed device, not something that shapes the tree. Tested: c = 1 gives
identical searches under PUCT, under "priorLog" and with interior expansion (`tests/p910.rs`), and
the grid's `CUT` config (PUCT + cut-off) left exactly the base's tree.

**P4 at interior nodes (`native.candidates`: `interiorFull`, `interiorNoWidening`,
`interiorInitVisits`; `search.rs` `shortlist`, `initialise_node`, `select`).** *What already
existed:* `interiorScorer` "fitted", which lets the fitted model choose and order the 24-move interior
shortlist out of the size/centre funnel (48 moves). *What was missing:* (1) every legal move at an
interior node (`interiorFull`: no funnel, no `nodeShortlist` cap; all legal moves scored by the
fitted model, sorted, softmax prior at `temperature`); (2) no progressive widening there
(`interiorNoWidening`: every child selectable at once); (3) value initialisation of interior children
(`interiorInitVisits` n0: `Q_i = (W_i + n0·v_i)/(n_i + n0)`, `v_i = m·sqrt(p_i/p_max)`, m the node's
current mean for its mover, as the root does with the root mean; an unvisited child scores v_i). Like
the root, the initial value follows the node's running mean (Pentobi fixes it at expansion).

**P9 — opening rules (`native.opening`).** (a) `centreMaxOwnMove` K, `centreSlack` d: at any searched
node (root or interior) whose mover has placed fewer than K pieces, only moves with centre distance
≤ the smallest + d are candidates. (b) `rolloutMinSize` S, `rolloutUntilPieces` M: in the "sampled"
rollout, while fewer than M pieces are on the board, the mover's corner sampling considers only its
pieces of ≥ S squares (all of them if that finds no move).

*Interaction with the opening shortcut.* `openingHeuristicMaxOwnMove` 3 (all v5 configs) plays each
seat's own moves 0–2 from the size/centre heuristic before any search, so with the shortcut on and K
≤ 3 the centre rule never acts (no searched root or interior node has a mover below own move 3 when
our root is at own move ≥ 3). The `P9A` arm therefore turns the shortcut off and applies the rule to
the searched opening (a named combination), and `O0` (shortcut off alone) is the control. Pentobi
plays these moves from its opening book in the matches; the centre rule is what its search does
without a book. The rollout rule (b) is independent of the shortcut: rollouts from our first searched
move start with about 12 pieces on the board, below M.

**Diagnostics.** `examples/p910_probe.rs` (`shape`, `pentobi`, `opening`), `Engine::tree_shape`
(`search.rs` `TreeShape`), `Gtp::spawn_logged` (keeps the engine's log), and in-tree depth counters
in `iterate` (read only).

**Refused in `unsupported()`:** unknown rule or scope; `exploration`, `countOffset` ≤ 0; `cutoff`
outside [0, 1]; `interiorFull` without the fitted interior scorer; negative `interiorInitVisits`;
"priorLog" or a cut-off with `rave`, `net` or `prior`; `interiorInitVisits` with `rave` (RAVE's β
counts only the root's virtual visits); negative opening numbers; `rolloutMinSize` > 5; the rollout
rule with `rollout` "all" or `lastGoodReply` (both bypass it). `selection` and `opening` refuse
unknown keys.

## Grid (fixed before any game; preregistration)

- **priorLog constant.** Grid {0.05, 0.1, 0.2, 0.4, 0.8, 1.6}, alone and with interior expansion
  (`tmp/p910/diag/shape-grid.csv`). Alone, 0.1 and 0.2 bracket level 6's top-root-child share (58%
  and 46% against 52%) → `P10B` 0.1, `P10A` 0.2. With interior expansion, 0.2 gives the tree closest
  to level 6's (top root child 47% vs 52%; half the root visits in 1.9 children in both; PV share
  44 / 24 / 13 / 7% vs 51 / 26 / 16 / 11%; mean depth 6.1 vs 5.6) → the combination uses 0.2.
  `countOffset` 1 (PUCT's 1 + n), `cutoff` 1 (exact).
- **Interior expansion** takes the base's root settings: all legal moves, fitted prior at temperature
  1, no widening, 3 initial visits.
- **Opening numbers** from Pentobi level 6's own moves in the X1 games (`p910_probe opening`,
  `tmp/p910/scratch/opening.txt`): at own moves 0–2 its move has the smallest centre distance among
  its legal moves (our measure) in 1,200 / 1,200 cases each; at own move 3 in 0.7%. So K = 3, d = 0.
  Its moves are 5-square pieces in ≥ 90% of cases at every board count up to 30 pieces (91% at 28–30)
  and 88% at 31 → S = 5, M = 31.

## Identity gates

Measured (`tmp/p910/identity.log`). Reference binaries `tmp/p910/bin-before/` = `tmp/p67/bin`, built
at `79bfa0b`; the engine sources are identical at `54b1a5f`, the parent of this change. New binaries
from `484cc18`, pinned in `tmp/p910/bin/` (`PROVENANCE.txt`).

- `cargo test --release`: 5 unit, 2 move-list, **8 parity**, 5 RAVE/LGR, 6 new in `tests/p910.rs`
  (identity points search exactly like the base on 12 positions; the cut-off at 1 changes no choice in
  four settings; priorLog and interior expansion are live and interior nodes hold every legal move;
  the centre rule keeps only the most central moves at own moves 0–2 and is inert from own move 3; the
  rollout rule is live early and inert after 31 pieces; refusals). `npm run native:build && npm run
  native:test` pass.
- `v5.0-p4-ultra` mirror with the new `blokee-match`, 20 seeds from 80,900,000: `0.00 [-0.00, 0.00]`.
- Identity point `p910-ID` (selection puct, cut-off 0; interior keys off; opening numbers 0) vs
  `v5.0-p4-ultra`: `0.00 [-0.00, 0.00]`; 80/80 games have every seat's score equal to the old
  binary's mirror (as does the new binary's own mirror).
- Self-play, 6 games from 80,950,000: `shard-00.bin` and `games.jsonl` byte-identical across the old
  binary, the new binary and `p910-ID` (sha256 `e834eb15…` / `f788f905…`, the same as P6/P7's).
- Pentobi bridge, 2 seeds from 80,980,000: new binary and `p910-ID` 8/8 games move-for-move equal to
  the old binary.

## Cost (clean run)

`p910-run.sh cost 150`: `examples/p4_cost.rs` on 150 positions of the lone Blokee seat in the X1
level-6 games (own moves 3+), every arm in turn on the same thread with the same RNG seed, budget 300,
2 threads, 15:15–15:16 with nothing of mine running (the Docker VM and `serve.py` were; load 4.1–4.9).
The arms that search the opening were also costed over own moves 0+ (`P4_COST_MIN_OWN=0`, 115
positions), where base plays moves 0–2 from the heuristic. Measured, `tmp/p910/cost/`:

| Config | ms/move (3+) | × base (3+) | × base (0+) | Iterations | Root children visited |
|---|---:|---:|---:|---:|---:|
| base | 70.2 | 1.00 | 1.00 | 3,916 | 37.9 |
| ID | 70.2 | 1.00 | | 3,916 | 37.9 |
| P10A | 66.5 | 0.95 | | 3,798 | 22.8 |
| P10B | 63.6 | 0.90 | | 3,635 | 18.3 |
| P4I | 108.3 | 1.54 | | 3,748 | 38.0 |
| P4IP10A | 114.3 | 1.63 | | 3,693 | 21.0 |
| P9A | 70.0 | 1.00 | **1.55** | 3,916 | 37.9 |
| P9B | 67.8 | 0.97 | | 3,868 | 37.9 |
| O0 | 69.4 | 0.99 | **1.58** | 3,916 | 37.9 |

The decision ratio for `P9A` and `O0` is the 0+ one. Interior expansion costs about 1.5–1.6× (every
interior node scores all its legal moves with the fitted model and selection scans them); the
priorLog arms are cheaper because more concentrated trees stop early more often (fewer iterations).

<!-- P910:SCREEN -->
<!-- /P910:SCREEN -->

<!-- P910:CONFIRM -->
<!-- /P910:CONFIRM -->
