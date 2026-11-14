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
stay 24-wide and flat (inferred cause: their first-play value is the parent mean for every unvisited
child and their priors, hand ordering at temperature 6, are close to uniform). **Interior expansion is what
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
## Screen

400 seeds 85,000,000–85,000,399, each arm as the lone seat against three Pentobi level-6 seats
(1,600 games per arm), arms one after another on 10 threads, 15:18–16:52, pinned binary
`tmp/p910/bin/blokee-pentobi`, under `caffeinate -i -s -m -w <chain pid>`. Measured
(`python3 engine-rs/scripts/p910_report.py tmp/p910`, `tmp/p910/screen.md`). Paired Δ is arm − base
on the same seeds, 95% percentile bootstrap by seed; `*` marks an interval excluding 0. No game failed
(1,600/1,600 per arm, no failure files). In-match ms/move is from a loaded machine (load 11–17); the
clean run above is the cost figure.

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ advantage vs base [95% CI] | Paired Δ first place, pp [95% CI] | ms/move all | ms/move 3+ | × base (3+, in-match) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-p4-ultra unchanged | 400 | -4.74 [-5.31, -4.16] | 17.5% | — | — | 58.7 | 71.0 | 1.00 | 0/1600 |
| P10A | P10 selection rule priorLog, exploration 0.2, all nodes, cut-off 1 | 400 | -5.51 [-6.07, -4.98] | 14.9% | -0.77 [-1.48, -0.06] * | -2.56 [-4.81, -0.19] * | 57.2 | 69.3 | 0.98 | 1586/1600 |
| P10B | P10 selection rule priorLog, exploration 0.1, all nodes, cut-off 1 | 400 | -6.23 [-6.80, -5.69] | 12.6% | -1.49 [-2.24, -0.78] * | -4.94 [-7.19, -2.75] * | 52.7 | 64.0 | 0.90 | 1594/1600 |
| P4I | P4 at interior nodes: all legal moves, fitted prior, no widening, 3 initial visits | 400 | -3.23 [-3.75, -2.68] | 18.6% | +1.51 [+0.81, +2.24] * | +1.06 [-1.31, +3.56] | 87.3 | 105.3 | 1.48 | 1599/1600 |
| P4IP10A | P4I and P10A together (exploration 0.2) | 400 | -4.25 [-4.78, -3.69] | 17.7% | +0.50 [-0.28, +1.28] | +0.19 [-2.25, +2.56] | 95.4 | 115.3 | 1.63 | 1600/1600 |
| P9A | P9A: opening searched (shortcut off) with the centre rule on own moves 0-2, slack 0 | 400 | -6.64 [-7.22, -6.04] | 14.1% | -1.90 [-2.75, -1.05] * | -3.44 [-5.75, -0.94] * | 86.4 | 76.7 | 1.08 | 1600/1600 |
| P9B | P9B: rollouts play 5-square pieces only while fewer than 31 pieces are on the board | 400 | -5.13 [-5.72, -4.55] | 15.4% | -0.39 [-1.06, +0.29] | -2.12 [-4.44, +0.31] | 59.0 | 71.5 | 1.01 | 1593/1600 |
| O0 | control for P9A: opening searched (shortcut off), no centre rule | 400 | -6.24 [-6.82, -5.69] | 15.9% | -1.50 [-2.33, -0.67] * | -1.56 [-3.81, +0.88] | 83.1 | 71.6 | 1.01 | 1600/1600 |

Selection (preregistered rule; `tmp/p910/selection.log`):

```
P10A: paired -0.773 [-1.482, -0.059] on 400 seeds; first place -2.56 pp [-4.81, -0.19] -> does not clear
P10B: paired -1.487 [-2.236, -0.776] on 400 seeds; first place -4.94 pp [-7.19, -2.75] -> does not clear
P4I: paired +1.511 [+0.814, +2.242] on 400 seeds; first place +1.06 pp [-1.31, +3.56] -> clears the screen
P4IP10A: paired +0.496 [-0.284, +1.275] on 400 seeds; first place +0.19 pp [-2.25, +2.56] -> does not clear
P9A: paired -1.899 [-2.747, -1.048] on 400 seeds; first place -3.44 pp [-5.75, -0.94] -> does not clear
P9B: paired -0.392 [-1.060, +0.288] on 400 seeds; first place -2.12 pp [-4.44, +0.31] -> does not clear
O0: paired -1.501 [-2.330, -0.673] on 400 seeds; first place -1.56 pp [-3.81, +0.88] -> does not clear
selected: P4I (cleared, largest point estimate +1.511)
```

Only one mechanism cleared, so no combination arm was built. `P4I`'s clean cost ratio is 1.54 > 1.25,
so the equal-time arm `P4I-ET` (`search.iterationScale` 16 / 1.541 = 10.383) played the confirmation
seeds alongside, as preregistered.

**Descriptive contrasts between screen arms** (post hoc, same seeds, not decisions):
`P4IP10A − P4I` −1.02 [−1.67, −0.36] (first place −0.88 pp [−3.06, +1.38]): the selection rule
costs strength on top of interior expansion too, although it makes the tree deeper (6.1 vs 4.6).
`P10B − P10A` −0.71 [−1.40, −0.01]: the more concentrated setting is the worse one. `P9A − O0`
−0.40 [−1.17, +0.38]: the centre rule adds nothing measurable to searching the opening; searching the
opening itself (`O0`) is harmful, −1.50 [−2.33, −0.67] against the heuristic.
<!-- /P910:SCREEN -->

<!-- P910:CONFIRM -->
## Confirmation

`base`, `P4I` and `P4I-ET` started together on 400 fresh seeds 85,400,000–85,400,399 (3 threads
each, 16:52–17:34, same pinned binary, under `caffeinate`). Measured
(`python3 engine-rs/scripts/p910_report.py tmp/p910 --confirm`, `tmp/p910/confirm.md`); no game failed:

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ advantage vs base [95% CI] | Paired Δ first place, pp [95% CI] | ms/move all | ms/move 3+ | × base (3+, in-match) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-p4-ultra unchanged | 400 | -4.99 [-5.57, -4.43] | 16.8% | — | — | 58.3 | 70.5 | 1.00 | 0/1600 |
| P4I | P4 at interior nodes: all legal moves, fitted prior, no widening, 3 initial visits | 400 | -3.13 [-3.67, -2.60] | 20.3% | +1.86 [+1.20, +2.54] * | +3.56 [+1.31, +5.88] * | 87.8 | 105.8 | 1.50 | 1600/1600 |
| P4I-ET | P4I at equal time: search.iterationScale 16 -> 10.383 (16 / 1.541) | 400 | -4.12 [-4.68, -3.56] | 18.6% | +0.88 [+0.18, +1.56] * | +1.81 [-0.56, +4.19] | 60.0 | 72.5 | 1.03 | 1600/1600 |

- P4I: paired +1.86 [+1.20, +2.54] -> ACCEPTED at equal iterations (lower bound > 0); first place +3.56 pp [+1.31, +5.88]; clean cost 1.54x base > 1.25; equal-time arm +0.88 [+0.18, +1.56] * HOLDS: P4I-ET: P4I-ET eligible as the new base
NEW BASE: P4I-ET

- **`P4I` is accepted at equal iterations**: +1.86 [+1.20, +2.54], first place +3.56 pp [+1.31, +5.88].
- Its clean cost is 1.54× base, so by the preregistered rule it becomes the base only through its
  equal-time arm, which holds: **`P4I-ET` +0.88 [+0.18, +1.56]**, first place +1.81 pp [−0.56, +4.19]
  (interval not entirely below 0, so the first-place condition does not block it).
- Descriptive (post hoc): `P4I-ET − P4I` on the same seeds −0.99 [−1.57, −0.37]: about half of the
  equal-iterations gain is bought with the extra time.

**Saved as the new base: the equal-time config**, `engine-rs/configs/v5.0-p4i-ultra.json` (=
`tmp/p910/configs/p910-P4I-ET.json`): `v5.0-p4-ultra` plus `native.candidates` `interiorFull` true,
`interiorScorer` "fitted", `interiorNoWidening` true, `interiorInitVisits` 3, and
`search.iterationScale` 10.383 (from 16). The equal-iterations setting (`p910-P4I`, iterationScale 16)
is the same mechanism given about 1.5× the time per move; it is recorded here and in the tracker, not
saved as a config.

Clean cost of the saved config (measured after the chain, `tmp/p910/cost-et/cost-et.md`, same 150
positions, 2 threads, nothing else of mine running; load 6–11 decaying after the chain, so absolute
ms are higher than in the first cost run): base 83.8 ms/move, `P4I` 127.4 (1.52×), **`P4I-ET` 84.4
(1.01×)** with 2,469 iterations against base's 3,916. Its tree (`tmp/p910/shape/et.md`, 47 positions):

| Config | Pos. | Simulations | Root visits | Tree depth mean / max | Root children with a visit | Root children for 50% / 90% | Top root child share | PV visits: d1 / d2 / d3 / d4 / d6 | Visits at depth 3 / 4 / 5 / 6 (share of root) | Interior nodes | Edges per interior node | Visited edges per interior node | Nodes ≥100 visits: count, edges, visited, top share | ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| p910-P4I-ET | 47 | 2550 | 2550 | 4.42 / 16 | 32 of 284 | 2.2 / 9.1 | 0.43 | 1046 / 504 / 220 / 97 / 20.2 | 85.7% / 67.6% / 45.5% / 25.2% | 937 | 232.0 | 2.5 | 12.5, 226, 15.9, 0.46 | 76 |

At equal time the tree is still deeper than base's (mean depth 4.42 vs 3.47; visits at depth 5 46%
vs 10% of the root's; busy interior nodes give the top child 46% vs 17%) on 2,550 simulations instead
of 3,963.

## Direct match

`P4I-ET` (as saved) as one seat against three `v5.0-p4-ultra` seats (`blokee-match`, seat-rotated,
budget 300) on 200 seeds 85,800,000–85,800,199 (800 games), 17:34–17:39, reported, not gated
(`tmp/p910/match/match-p910-P4I-ET.txt`):

```
Advantage (score − mean of the three v5.0-p4-ultra seats): 1.56 [95% CI 0.92, 2.25]
First place: 35.6% (par 25%), sole wins 25.8%
Mean score: -8.78 (opponents -10.33), squares placed 79.25 / 89
Per-seat advantage: blue 1.61  yellow -1.39  purple 1.44  green 4.57
```

## Verdict

**P4 at interior nodes is accepted; `v5.0-p4i-ultra` (its equal-time form) is the new base.**
Against Pentobi level 6, measured: −4.12 [−4.68, −3.56] with first place 18.6% on the confirmation
seeds, where `v5.0-p4-ultra` scored −4.99 [−5.57, −4.43] and 16.8% (paired +0.88 [+0.18, +1.56]); at
equal iterations (1.5× the time) −3.13 [−3.67, −2.60], 20.3%. Directly against `v5.0-p4-ultra`
+1.56 [0.92, 2.25], first place 35.6%.

- **P10 (selection rule): rejected at the tested settings.** priorLog 0.2 −0.77 [−1.48, −0.06], 0.1
  −1.49 [−2.24, −0.78], both with fewer wins (−2.56 / −4.94 pp); with interior expansion +0.50
  [−0.28, +1.28] against base and −1.02 [−1.67, −0.36] against interior expansion alone. The cut-off is
  exact (a speed device) and is not the issue.
- **P9 (opening rules): rejected.** The centre rule needs the opening searched; searching it is
  harmful (`O0` −1.50 [−2.33, −0.67]) and the centre rule does not repair it (`P9A` −1.90 [−2.75,
  −1.05]; `P9A − O0` −0.40, null). Large pieces early in rollouts: null, −0.39 [−1.06, +0.29], first
  place −2.12 pp [−4.44, +0.31].

Reading (inferred, not measured). The hypothesis was that Pentobi's selection rule and its interior
treatment make its tree deep and that depth is part of the gap. The measurements split it: interior
expansion with value initialisation gains (+1.9 at equal iterations, +0.9 at equal time) and deepens
the tree; the selection rule deepens it further (to Pentobi-like depth) and loses. So depth as such is
not what pays; what pays is plausibly better use of each interior visit: the fitted prior (fitted on
level 6's own moves, i.e. a model of the opponents) chooses among *all* the opponent's replies and
value initialisation lets the search ignore the bad ones, where the base's 24-move hand-ordered
shortlist with a flat first-play value spreads visits over 18 replies, often missing the one Pentobi
plays. Concentrating harder at the root (priorLog) costs strength, consistent with S2's `cPuct` 0.8
null and P6's finding that overriding the root prior's spread hurts; the more concentrated setting is
the worse one, and the rule also lowers first place.

## Caveats and things I am unsure of

- **Seven arms read at 95% each**; one cleared and it confirmed on fresh seeds at both equal
  iterations and equal time, which is what the confirmation step is for. The contrasts between arms are
  post hoc.
- **The equal-time scale comes from one clean cost run** (1.541; the second run after the chain gave
  1.52, and the saved config measured 1.01×). The in-match ratio during the confirmation was 1.03.
- **Pentobi comparison.** Book off and subtree reuse off, one seed, 47 positions; Pentobi searched
  about 7,300 simulations per position against our ~4,000, so absolute visit counts are not
  comparable, the shares are. In matches Pentobi plays with reuse and the book on.
- **Design choices another reading could change:** the interior initial value follows the node's
  running mean (Pentobi fixes it at expansion); interior nodes are still initialised on their second
  visit at every depth (Pentobi raises the expansion threshold with depth); the priorLog grid was
  chosen by matching level 6's tree shape, not by strength, and only {0.1, 0.2} were played;
  `countOffset` 1 at nodes without value initialisation; the history term was kept unchanged under
  priorLog. A different grid (larger constants, which the shape grid shows approach base) was not
  played.
- **P9A's cost** is measured over own moves 0+ because it adds three searches per game; its result
  was harmful regardless of cost.
- The in-match ms/move columns come from a loaded machine (load 11–17, Docker VM and `serve.py`
  running, not mine).
- I was cut off by a usage limit after the confirmation started (about 16:53 to 17:53); the chain ran
  unattended under `caffeinate` through confirmation and the direct match and was not disturbed. The
  clean cost and tree-shape runs of the saved config were made after the chain, at 17:53–17:58.
<!-- /P910:CONFIRM -->
