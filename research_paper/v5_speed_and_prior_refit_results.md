# v5.0 — a faster interior-expansion search (S4), subtree reuse re-measured (P8), the move prior re-fitted on level-7 games (N11), and a config screen on the final base (S5)

Run on the Mac (M4 Pro, 14 cores) on the night of 2026-11-13/14. Designs, seeds and rules are the
dated "S4", "N11" and "S5" entries of `research_paper/v6_native_and_learning_preregistered.md`.
Outputs are under `tmp/s4/`, `tmp/n11/`, `tmp/s5/` (git-ignored). Running alongside throughout, not
mine: a Docker VM (about 0.7–0.8 of a core) and an idle `serve.py` (PID 17508); left alone.

## Stage 1 — S4: the interior-expansion search made faster, with identical output

### Profile before any change (measured)

`sample` (1 ms) on `p4_cost` searching 400 X1 level-6 positions (own moves 3+, budget 300) with
`v5.0-p4i-ultra` on one thread; release build with debug info, plus a scratch copy with the hot
functions marked `#[inline(never)]` so that selection, the scorer and the rollout are attributed
separately (`tmp/s4/profile-before.md`, raw samples `tmp/s4/sample-*.txt`). Share of the search thread:

| Part | Share |
|---|---:|
| Rollout (`Playout::run`) | 42.7% |
| — of which the corner/cover-list sampling (`sample_moves`), incl. listing corners 4.3% | 38.1% |
| — of which apply/undo | 3.8% |
| Interior-node initialisation (`initialise_node` → `shortlist`) | 41.4% |
| — fitted-prior scoring of every legal move (`PriorModel::score`: features 14.5%, dot product 6.5%) | 21.0% |
| — sorting the moves (`sort_by_score`) | 7.4% |
| — `PriorContext::new` (almost all `dilate_orthogonal` → `shift_into` rebuilding two column masks from 400 `set_bit` calls on every shift) | 6.6% |
| — move generation at the node (`generate_moves`) | 5.1% |
| — softmax (`exp`) | 0.9% |
| — allocation / free / memset | ~1% |
| Selection over the edges (`select`) | 9.3% |
| Leaf endgame gate (full territory refresh: distance maps, Voronoi partition, regions) | ~4.7% |
| Rest (descent, backup, node lookup, settle) | ~7% |

### What was changed (all decision-identical; engine commit `7a1f3ad`)

1. **Scorer** (`feature_prior.rs`): features 0–22 depend only on the placement, so their partial sum
   is precomputed per band and placement (the same additions in the same order, so the same bits);
   the remaining terms are added in the original order, zero terms skipped as before; the board words
   visited are limited to those the placement's cells and haloes touch. The old scorer is kept as
   `score_reference`; `tests/s4.rs` checks the two bit for bit on every legal move of every position
   of 60 random games (>100,000 moves), with and without the recent-placement features.
2. **Sort** (`ordering.rs`): `sort_by_score` sorts packed integer keys (score descending with −0.0 =
   +0.0 as `partial_cmp` has them, placement id, original index); the same permutation as the stable
   comparator sort (NaN falls back to the old code). Checked against the reference on 2,000 random
   arrays with ties and signed zeros.
3. **`shift_into`**: the two column masks are built once.
4. **Selection** (`search.rs`, only when no RAVE, `native.selection`, network or learned prior is
   configured and `cPuct` ≥ 0): edges whose child exists are scored exactly as before; edges never
   descended are scored from stored per-edge factors (`1.0·cPuct·p_i`, `sqrt(p_i/p_max)`, computed with
   the same arithmetic, and `x / 1.0 = x`), visited in prior order, and the scan stops once a bound on
   all remaining untouched edges (largest remaining ratio and prior, history term at the end of its
   observed range, plus a 1e-9 relative margin) is below the best score. The argmax with the lowest
   index on ties is the same as the full scan's. A debug assertion compares every stored-factor score
   with the original expression (passed on the identity dump in a debug build).
5. **Leaf endgame gate**: `compute_reach` floods only each seat's reach (what `is_sealed` and the
   packer read); every other reader of the search's evaluation context refreshes it first.
6. **Rollout**: the first corner is drawn as the n-th set bit of the corner mask (the same draw as
   indexing the ascending corner list), with its 11×11 windows read directly from the masks; the list
   and full board rows are built only if another corner is needed, with the drawn corner swapped to
   the end exactly as before. The cover-list scans (rollout and move generation) iterate the pieces in
   hand by bit and stop at the limit at the same entry.

Tried and dropped (no measurable gain): counting the scorer's cell-based features from a packed
per-cell table (the scorer is bound by loading the placement masks, not by the popcounts).

Not included because they would change results (proposals, not built): lazy or partial sorting of
interior moves (tie order and the selection scan order would change); scoring only a prefix of the
legal moves at interior nodes; a cheaper approximate exp in the softmax; caching interior move lists
across transpositions with a different generation order.

### Identity (measured; `tmp/s4/identity.log`)

Pre-change binaries `tmp/s4/bin-before` (byte-identical to the P9/P10 and X3 pins); new binaries
`tmp/s4/bin` built from `7a1f3ad` (`PROVENANCE.txt`). For each of `v5.0-p4i-ultra`, `v5.0-p4-ultra`
and `v4.2-ultra`:

- **Complete search output**, `examples/s4_identity.rs`: 300 positions (every seat, own moves 0+;
  150 from the X1 level-6 games, 150 from the X3 level-7 games), every config at budget 300 with a
  fixed RNG seed, engines reused across positions; every ranked root move with its visits and the
  exact bits of its value, the iteration count and the RNG state after the search: **900/900 lines
  byte-identical** (738 tree searches; the rest are opening-heuristic or packer decisions).
- **Mirror** (`blokee-match`, 20 seeds from 80,900,000): 0.00 [−0.00, 0.00] for all three, and
  **80/80 games** with every seat's score equal to the old binary's mirror.
- **Self-play** (6 games from 80,950,000, one thread): `shard-00.bin` and `games.jsonl`
  **byte-identical** (sha256 `53aea890…`/`85610fff…`, `e834eb15…`/`f788f905…` — the same as
  P6/P7's and P9/P10's for `v5.0-p4-ultra` — and `aef1f08d…`/`1ce041d2…`, the same as P4/P5's for
  `v4.2-ultra`).
- **Pentobi bridge** (2 seeds from 80,980,000, level 6): **8/8 games move for move** for all three.
- `cargo test --release`: 28/28 (the 26 before plus the two in `tests/s4.rs`); `npm run native:build
  && npm run native:test` pass.

### Cost (measured, clean)

`engine-rs/scripts/s4-run.sh cost`: `p4_cost`, 150 positions (X1, lone Blokee seat, own moves 3+),
2 threads, budget 300, old and new binary alternating over two rounds, 21:57–21:58, nothing of mine
running (load 2.9–4.0, the Docker VM included). `tmp/s4/cost/cost.md`:

| Config | ms/move before (rounds) | ms/move after (rounds) | before | after | after / before | throughput | iterations | same moves and iterations |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `v5.0-p4i-ultra` | 67.2 / 69.1 | 44.3 / 45.3 | 68.2 | 44.8 | **0.658** | +52% | 2,469 | yes |
| `v5.0-p4-ultra` | 66.1 / 67.9 | 56.7 / 57.5 | 67.0 | 57.1 | 0.852 | +17% | 3,916 | yes |
| `v4.2-ultra` | 69.2 / 71.1 | 59.5 / 60.8 | 70.2 | 60.1 | 0.857 | +17% | 4,235 | yes |

Interior expansion's own overhead (scoring, sorting and selecting over every legal move) was most
of what was removed, so `v5.0-p4i-ultra` gains most; the rollout changes give the older configs
their ~15%.

**Re-timing.** New-binary `v5.0-p4i-ultra` at `iterationScale` 15–17 against the old binary's
`v5.0-p4i-ultra`, alternating (`tmp/s4/cost/calib-*`): a linear fit crosses 1.00 at 16.05. At 16,
three alternating rounds (`verify-*`): 1.009 / 0.985 / 0.992, **0.995×** overall (70.5 vs 70.9 ms).
Fixed before any game: `iterationScale` **16**, nothing else changed (`S4T`, to be saved as
`v5.0-s4-ultra`). This is the P9/P10 `P4I` setting (equal iterations to `v5.0-p4-ultra`), which on
the old binary cost 1.54× and now costs what the equal-time config cost. Its equal-time property
holds on binaries from `7a1f3ad` on; on an older binary it plays the same moves, 1.5× slower.

### Confirmation (measured)

`S4T` (`v5.0-p4i-ultra` at `iterationScale` 16) and `base` (`v5.0-p4i-ultra` unchanged), both on the
new binary, started together (5 threads each) as the lone seat against three Pentobi level-6 seats on
**400 fresh seeds 87,000,000–87,000,399**, 22:01–22:24, under `caffeinate -i -s -m -w`; prereg commit
`459993f` (22:01:13; the first game started 22:01:13 from the same command, after the commit). No game
failed. `python3 engine-rs/scripts/s4_report.py --confirm tmp/s4` (`tmp/s4/confirm.md`):

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ advantage vs base [95% CI] | Paired Δ first place, pp [95% CI] | ms/move all | ms/move 3+ | × base (3+, in-match) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-p4i-ultra unchanged (new binary) | 400 | -4.61 [-5.18, -4.01] | 17.5% | — | — | 43.2 | 52.2 | 1.00 | 0/1600 |
| S4T | re-timed: iterationScale from S4 calibration | 400 | -3.31 [-3.92, -2.71] | 18.5% | +1.30 [+0.62, +2.00] * | +1.00 [-1.31, +3.38] | 63.5 | 76.6 | 1.47 | 1594/1600 |

- S4T: paired +1.30 [+0.62, +2.00] on 400 seeds; first place +1.00 pp [-1.31, +3.38]
**VERDICT: ACCEPTED** (lower bound > 0, first-place interval not entirely below 0) → new base

- **Accepted under the preregistered rule**: paired **+1.30 [+0.62, +2.00]**, first place +1.00 pp
  [−1.31, +3.38] (interval not entirely below 0). Saved as **`engine-rs/configs/v5.0-s4-ultra.json`**
  (= `tmp/s4/configs/S4T.json`: `v5.0-p4i-ultra` with `search.iterationScale` 16).
- Against level 6 at equal time to the previous base: **−3.31 [−3.92, −2.71]**, first place 18.5%,
  where `v5.0-p4i-ultra` scored −4.61 [−5.18, −4.01] and 17.5% on the same seeds.
- In-match ms/move (own moves 3+, both arms sharing the machine, load ~12): `S4T` 76.6, `base` on the
  new binary 52.2 (1.47×). For comparison only (other seeds, other load, old binary): `v5.0-p4i-ultra`
  in X3's compute block 72.9. The decision ratio is the clean one (0.995× the old base).
- Consistency (descriptive): X3 measured the same 16 − 10.383 contrast at +0.75 [−0.23, +1.68] on
  200 seeds and P9/P10's equal-iterations minus equal-time at +0.99 [+0.37, +1.57]; +1.30 is in line.

<!-- S4:CONFIRM -->

## Stage 2 — P8 re-measured: how much would subtree reuse carry now? (diagnostic only)

`examples/p67_probe.rs reuse` (unchanged, P8's probe) on 48 of X3's games of `v5.0-p4i-ultra` as
saved against three level-6 seats (`tmp/x3/x3-c-et.moves.jsonl`, seeds from 86,300,000; every
16th game in (seed, seat) order), replaying each game with the bridge's RNG discipline and
asking, before each of the lone seat's decisions, how many visits the tree of its previous decision
holds at the position now on the board (found by hash). **674/674** searched decisions after ply 8
reproduced the recorded move. Measured (`tmp/s4/reuse/reuse.md`; budget 300 × 10.383 = 3,115):

| Own moves | Decisions | Prev. iterations | Visits after own move (d1) | d2 | d3 | **At the next own turn (d4)** | **share of the 3,115 budget** | share of prev. iterations | decisions with > 0 | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4–8 | 240 | 2,450 | 1,098 | 143.9 | 16.2 | 2.40 | **0.077%** | 0.107% | 39 | 62 |
| 9–14 | 287 | 2,583 | 976 | 184.0 | 25.5 | 2.69 | **0.086%** | 0.106% | 72 | 90 |
| 15+ | 147 | 2,515 | 1,123 | 346.9 | 105.6 | 83.5 | **2.68%** | 3.57% | 83 | 945 |
| all | 674 | 2,521 | 1,052 | 205.2 | 39.7 | 20.2 | **0.65%** | 0.86% | 194 | 945 |

On the old tree P8 measured 11 visits at the next own turn, 0.23% of 4,800. Interior expansion
deepens the line (about 1,050 → 205 → 40 → 20 visits along the moves actually played, against
~1,540 → 170 → 26 → 11 before), so reuse would now carry about **0.65%** of the budget — almost all
of it in the endgame (2.7% on own moves 15+), and under 0.1% where the game is decided (moves 4–14).
**It does not clear the 5% line** of the earlier preregistration; P8 stays parked. Not measured:
the share at the S4 base's 4,800 iterations (expected similar), or with Pentobi-style tree
concentration.

## Stage 3 — N11: the move prior re-fitted on level-7 games

### Data (measured)

Level-7 moves recorded on this Mac: `tmp/x2/x2-l7ext.moves.jsonl` (640 games, seeds 79,200,040–199)
and `tmp/x3/x3-l7-p4.moves.jsonl` / `x3-l7-p4i.moves.jsonl` (800 games each, both on seeds
86,100,000–199): one Blokee seat and three Pentobi 31.0 level-7 seats per game, book on.
**125,729 level-7 decisions** (26.6M candidate moves), 360 distinct seeds; level-6 data as before:
29,991 decisions (X1, seeds 79,000,000–099). Features from `examples/n11_features.rs` in a compact
format (placement id + the 16 position-dependent features as bytes; the static features rebuilt from
a placement table) with the engine's reference `PriorContext::features`; the rebuilt level-6 matrix
equals P4/P5's dump on all 6,625,675 rows. Split by seed as P4/P5: seeds ending in 4 or 9 held out
(level 7: 25,103 decisions; level 6: 6,041, exactly P4/P5's test set). Because the two X3 files share
seeds, a seed's games are always on the same side.

### Fit (offline; no game outcome used)

`ml/n11_fit_prior.py` (P4/P5's model and fit: multinomial logit over all legal moves, 39 features,
one weight vector per own-move band, L2 1e-3 on standardised columns, L-BFGS; every band
converged). Models: **current** (`ml/v5-prior-weights.json`, level 6); **(a) L7**: 6 bands,
level-7 training decisions; **(b) pooled**: 6 bands, level 6 + level 7; then, because the held-out
numbers pointed at capacity (train and held-out log-likelihood equal to within 0.01, and 4× the data
moving them by only 0.03 nats), **(c) pooled-fine**: one band per own move from 3 to 14 (no engine
change; the model JSON carries any bands), and an offline-only diagnostic **L7-interact** (the 14
count features also multiplied by piece size and squared; would need an engine change, not played).
Measured (`tmp/n11/fit/report.md`), held-out decisions; log-lik is the mean per decision:

Held-out level-7 decisions (log-lik / top-1 / top-10 / top-40; train log-lik in brackets for 3+):

| Model | Own moves 3–8 | 9–14 | 15+ | **3+ (all searched)** | 0–2 (book; not used in play) |
|---|---|---|---|---|---|
| current (level 6) | -4.028 / 0.138 / 0.512 / 0.804 | -3.217 / 0.196 / 0.667 / 0.930 | -1.542 / 0.524 / 0.952 / 1.000 | **-3.131 / 0.251 / 0.675 / 0.898** [-3.133] | -2.007 / 0.257 / 0.973 / 1.000 |
| (a) L7 | -3.994 / 0.137 / 0.517 / 0.808 | -3.199 / 0.198 / 0.671 / 0.931 | -1.517 / 0.526 / 0.952 / 1.000 | **-3.105 / 0.252 / 0.679 / 0.900** [-3.105] | -1.972 / 0.257 / 0.973 / 1.000 |
| (b) pooled | -3.994 / 0.137 / 0.516 / 0.808 | -3.200 / 0.197 / 0.671 / 0.931 | -1.517 / 0.525 / 0.953 / 1.000 | **-3.105 / 0.252 / 0.679 / 0.900** [-3.106] | -1.973 / 0.257 / 0.973 / 1.000 |
| (c) pooled-fine | -3.957 / 0.142 / 0.526 / 0.810 | -3.192 / 0.200 / 0.672 / 0.931 | -1.517 / 0.525 / 0.953 / 1.000 | **-3.088 / 0.255 / 0.682 / 0.901** [-3.087] | -1.973 / 0.257 / 0.973 / 1.000 |
| L7-fine (not played) | -3.958 / 0.140 / 0.526 / 0.808 | -3.192 / 0.200 / 0.671 / 0.930 | -1.517 / 0.526 / 0.952 / 1.000 | **-3.088 / 0.254 / 0.682 / 0.900** [-3.085] | -1.972 / 0.257 / 0.973 / 1.000 |
| L7-interact (diagnostic, not playable) | -3.952 / 0.145 / 0.526 / 0.812 | -3.159 / 0.201 / 0.676 / 0.934 | -1.478 / 0.535 / 0.957 / 1.000 | **-3.065 / 0.259 / 0.685 / 0.903** [-3.063] | -1.943 / 0.257 / 0.968 / 1.000 |

Decisions (3+): 21,071, mean legal moves 204; uniform 3+: -4.391 / 0.062 / 0.281 / 0.506.

Held-out level-6 decisions (log-lik / top-1 / top-10 / top-40; train log-lik in brackets for 3+):

| Model | Own moves 3–8 | 9–14 | 15+ | **3+ (all searched)** | 0–2 (book; not used in play) |
|---|---|---|---|---|---|
| current (level 6) | -3.718 / 0.150 / 0.590 / 0.865 | -3.071 / 0.224 / 0.710 / 0.949 | -1.451 / 0.553 / 0.955 / 0.999 | **-2.918 / 0.277 / 0.724 / 0.930** [-2.934] | -1.961 / 0.241 / 0.997 / 1.000 |
| (a) L7 | -3.758 / 0.139 / 0.584 / 0.865 | -3.075 / 0.229 / 0.722 / 0.949 | -1.446 / 0.554 / 0.959 / 0.999 | **-2.933 / 0.274 / 0.728 / 0.930** [-2.960] | -1.994 / 0.241 / 0.997 / 1.000 |
| (b) pooled | -3.743 / 0.145 / 0.586 / 0.866 | -3.071 / 0.227 / 0.722 / 0.950 | -1.443 / 0.555 / 0.957 / 0.999 | **-2.926 / 0.276 / 0.728 / 0.930** [-2.951] | -1.980 / 0.241 / 0.997 / 1.000 |
| (c) pooled-fine | -3.718 / 0.146 / 0.595 / 0.863 | -3.063 / 0.227 / 0.720 / 0.949 | -1.443 / 0.555 / 0.957 / 0.999 | **-2.913 / 0.277 / 0.731 / 0.929** [-2.939] | -1.980 / 0.241 / 0.997 / 1.000 |
| L7-fine (not played) | -3.734 / 0.142 / 0.591 / 0.863 | -3.067 / 0.226 / 0.721 / 0.950 | -1.446 / 0.554 / 0.959 / 0.999 | **-2.921 / 0.275 / 0.730 / 0.929** [-2.952] | -1.994 / 0.241 / 0.997 / 1.000 |
| L7-interact (diagnostic, not playable) | -3.726 / 0.145 / 0.588 / 0.867 | -3.038 / 0.222 / 0.728 / 0.952 | -1.403 / 0.561 / 0.964 / 0.999 | **-2.897 / 0.276 / 0.733 / 0.932** [-2.919] | -1.970 / 0.241 / 0.998 / 1.000 |

Decisions (3+): 5,081, mean legal moves 216; uniform 3+: -4.431 / 0.064 / 0.277 / 0.495.


Reading (measured unless marked):

- **The level-6 prior already transfers to level 7.** Fitted on level-6 games only, it scores
  held-out level-7 decisions at −3.131 nats (own moves 3+) against −3.105 for a model fitted on 4×
  as many level-7 decisions: 0.026 nats per decision, top-40 0.898 → 0.900, top-1 0.251 → 0.252.
  Where the gap to level 7 opens (own moves 3–8) the gain is 0.034 nats and top-10 0.512 → 0.517.
- **Pooling costs nothing at level 7** ((b) = (a) on level 7) and costs less at level 6 than (a)
  (−2.926 vs −2.933 against −2.918): the two teachers play similarly enough that one model fits both.
- **The model is capacity-limited, not data-limited**: train and held-out log-likelihood agree to
  within 0.01 for every fitted model, and 4× the data moves held-out likelihood by 0.03. More bands
  (one per own move 3–14) add 0.017 at level 7 (−3.088) and are the only fit not worse than current
  at level 6 (−2.913); the interaction diagnostic adds another 0.023 (−3.065), still a small step.
- For scale (inferred): P4/P5's prior gained 1.4–2.0 nats per decision over the old ordering on
  moves 3–8 and was worth +4.3 to +6 points; the differences here are 1–3% of that.
- **Arms for the screen**: (a) `L7`, (b) `pooled`, (c) `pooled-fine` (playable with no engine
  change). `L7-fine` is dropped as a near-duplicate of (c) (equal at level 7, worse at level 6); the
  interaction model is not played (it would need new engine features behind a config, and its
  offline gain is too small to justify the change). Weights: `ml/n11-prior-weights-L7.json`,
  `-pooled.json`, `-pooled-fine.json` (same JSON shape as `ml/v5-prior-weights.json`).

<!-- N11:OFFLINE -->

### Screen (measured)

Prereg: the 22:26 CST "N11" entry (commit `ff3ff1a`, 22:26:0x; the chain started 22:26:02 from the
same command). Base `v5.0-s4-ultra`; each arm the base with only `native.candidates.model` replaced.
400 seeds 87,100,000–87,100,399, lone seat against three level-6 seats, base then each arm one after
another on 10 threads (22:26–23:10), pinned `tmp/s4/bin`, under `caffeinate`. No game failed.
`python3 engine-rs/scripts/chain_report.py tmp/n11 --screen` (`tmp/n11/screen.md`):

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ advantage vs base [95% CI] | Paired Δ first place, pp [95% CI] | ms/move all | ms/move 3+ | × base (3+, in-match) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-s4-ultra.json unchanged | 400 | -3.38 [-3.91, -2.82] | 18.7% | — | — | 58.8 | 71.0 | 1.00 | 0/1600 |
| L7 | (a) prior re-fitted on level-7 decisions only (6 bands, 39 features) | 400 | -3.12 [-3.70, -2.56] | 18.9% | +0.26 [-0.48, +0.98] | +0.25 [-2.06, +2.56] | 58.6 | 70.8 | 1.00 | 1596/1600 |
| pooled | (b) prior re-fitted on level-6 and level-7 decisions pooled (6 bands) | 400 | -3.12 [-3.70, -2.53] | 20.0% | +0.26 [-0.48, +0.99] | +1.31 [-1.31, +3.88] | 58.4 | 70.4 | 0.99 | 1597/1600 |
| pooledfine | (c) pooled, one band per own move 3-14 (14 bands) | 400 | -3.06 [-3.63, -2.48] | 19.9% | +0.31 [-0.41, +1.04] | +1.25 [-1.19, +3.69] | 58.5 | 70.6 | 0.99 | 1595/1600 |

```
L7: paired +0.260 [-0.477, +0.978] on 400 seeds; first place +0.25 pp [-2.06, +2.56] -> does not clear
pooled: paired +0.256 [-0.482, +0.990] on 400 seeds; first place +1.31 pp [-1.31, +3.88] -> does not clear
pooledfine: paired +0.311 [-0.406, +1.035] on 400 seeds; first place +1.25 pp [-1.19, +3.69] -> does not clear
selected: (none) -- no arm's paired CI lower bound is above 0
```

**N11 is a null at this screen.** All three re-fitted priors point the same small way (+0.26 to
+0.31, first place +0.25 to +1.31 pp) and none has a lower bound above 0, so — as preregistered — no
confirmation was run and no level-7 benchmark (that was only for an accepted arm); seeds
87,200,000 and 87,300,000 are unused and unread. `v5.0-s4-ultra` stays the base and is the base of
S5. In-match ms/move is unchanged (0.99–1.00×): the scorer's cost does not depend on the weights.

Reading (inferred): the offline gains were 0.02–0.04 nats per decision on level-7 moves, against the
1.4–2.0 that P4/P5's prior added; a playing effect of that size would be a few tenths of a point,
which is what the screen shows and what 400 seeds cannot resolve (interval half-width ≈ 0.73). The
level-6 prior is already close to what this feature set can say about level 7; a better prior would
need a richer model (the interaction diagnostic gained another 0.02 nats only) or a different
teacher signal (e.g. level-7 visit distributions rather than its single chosen move).

<!-- N11:SCREEN -->

## Stage 4 — S5: config-only screen on the final base

Prereg: the 22:26 CST "S5" entry (commit `ff3ff1a`). The final base after Stages 1 and 3 is
`v5.0-s4-ultra` (N11 accepted nothing), chosen by the driver (`tmp/s5/FINAL_BASE`). Seven arms, each
the base plus one existing option (all loaded and searched, none refused by `unsupported()`, none
dropped). 400 seeds 87,400,000–87,400,399, base then each arm one after another on 10 threads,
23:10–00:38, pinned `tmp/s4/bin`, under `caffeinate` (master pid chain). No game failed. Measured
(`tmp/s5/screen.md`):

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ advantage vs base [95% CI] | Paired Δ first place, pp [95% CI] | ms/move all | ms/move 3+ | × base (3+, in-match) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-s4-ultra.json unchanged | 400 | -2.92 [-3.50, -2.34] | 21.3% | — | — | 58.4 | 70.4 | 1.00 | 0/1600 |
| IIV1 | native.candidates.interiorInitVisits 1 (base 3) | 400 | -2.43 [-3.02, -1.84] | 21.0% | +0.49 [-0.20, +1.20] | -0.31 [-2.94, +2.25] | 59.0 | 71.0 | 1.01 | 1596/1600 |
| IIV6 | native.candidates.interiorInitVisits 6 (base 3) | 400 | -3.57 [-4.14, -2.97] | 19.1% | -0.65 [-1.37, +0.08] | -2.25 [-4.62, +0.12] | 58.3 | 70.5 | 1.00 | 1597/1600 |
| T07 | native.candidates.temperature 0.7 (base 1; root and interior prior) | 400 | -4.74 [-5.30, -4.21] | 15.6% | -1.82 [-2.50, -1.15] * | -5.69 [-8.00, -3.38] * | 60.5 | 73.2 | 1.04 | 1597/1600 |
| T14 | native.candidates.temperature 1.4 (base 1; root and interior prior) | 400 | -2.65 [-3.26, -2.04] | 21.9% | +0.27 [-0.44, +1.00] | +0.56 [-2.12, +3.19] | 56.7 | 68.4 | 0.97 | 1598/1600 |
| C08 | search.cPuct 0.8 (base 1.6) | 400 | -3.49 [-4.01, -2.96] | 16.6% | -0.57 [-1.25, +0.13] | -4.75 [-7.31, -2.12] * | 55.7 | 67.2 | 0.95 | 1600/1600 |
| SHAPE | search.iterationShape x1.5 on own moves 3-8, x0.6423 on 9+ (same expected iterations per game) | 400 | -3.20 [-3.73, -2.66] | 20.5% | -0.27 [-0.90, +0.38] | -0.81 [-3.31, +1.81] | 71.7 | 86.4 | 1.23 | 1594/1600 |
| RB07 | search.rankBlend 0.7 (base 0.35) | 400 | -3.40 [-3.98, -2.84] | 19.0% | -0.48 [-1.21, +0.23] | -2.31 [-4.81, +0.12] | 58.1 | 70.1 | 1.00 | 1599/1600 |

```
IIV1: paired +0.490 [-0.198, +1.205] on 400 seeds; first place -0.31 pp [-2.94, +2.25] -> does not clear
IIV6: paired -0.650 [-1.369, +0.079] on 400 seeds; first place -2.25 pp [-4.62, +0.12] -> does not clear
T07: paired -1.821 [-2.504, -1.152] on 400 seeds; first place -5.69 pp [-8.00, -3.38] -> does not clear
T14: paired +0.267 [-0.444, +1.001] on 400 seeds; first place +0.56 pp [-2.12, +3.19] -> does not clear
C08: paired -0.569 [-1.245, +0.133] on 400 seeds; first place -4.75 pp [-7.31, -2.12] -> does not clear
SHAPE: paired -0.274 [-0.904, +0.379] on 400 seeds; first place -0.81 pp [-3.31, +1.81] -> does not clear
RB07: paired -0.480 [-1.214, +0.228] on 400 seeds; first place -2.31 pp [-4.81, +0.12] -> does not clear
selected: (none) -- no arm's paired CI lower bound is above 0
```

**S5 is a null: no arm clears, so no cost run and no confirmation** (seeds 87,500,000 unused and
unread); `v5.0-s4-ultra` stays the base.

- **Sharper prior (temperature 0.7) is clearly harmful**: −1.82 [−2.50, −1.15], first place −5.69 pp
  [−8.00, −3.38]. The flatter prior (1.4) is null (+0.27 [−0.44, +1.00]).
- **interiorInitVisits**: 1 points up (+0.49 [−0.20, +1.20], first place −0.31 pp), 6 points down
  (−0.65 [−1.37, +0.08]); neither clears. Read together with T07/T14 (descriptive, post hoc): the
  directions that anchor interior children less to the prior are the ones that do not lose.
- **cPuct 0.8**: −0.57 [−1.25, +0.13], and fewer wins: first place **−4.75 pp [−7.31, −2.12]**.
- **rankBlend 0.7**: −0.48 [−1.21, +0.23], first place −2.31 pp [−4.81, +0.12]: more weight on rank
  did not buy wins.
- **Budget shape (N14)**: −0.27 [−0.90, +0.38]. It did not keep time equal in play: Blokee spent
  1,259 ms per game against base's 1,025 (1.23×; 86.4 vs 70.4 ms per searched move). The nominal
  shape assumed equal cost per iteration and no early stops; early moves have more legal moves and stop
  early less often. So it had more compute than base and still did not gain.
- The base's own −2.92 [−3.50, −2.34] on these seeds (first place 21.3%) agrees with −3.31 (S4
  confirmation) and −3.38 (N11 screen) on other seeds.

Twelve arms were read in Stages 3–4 at 95% each; one clear harm (T07) and one clear first-place loss
(C08), no gain.

<!-- S5 -->

## Summary

| Stage | Result |
|---|---|
| 1 — S4 speed | Interior-expansion search 1.52× faster (68.2 → 44.8 ms/move clean), identical output for all three configs. Re-timed base `v5.0-s4-ultra` (`iterationScale` 16, 0.995× the old time) **accepted: +1.30 [+0.62, +2.00]** vs `v5.0-p4i-ultra`; −3.31 vs level 6 |
| 2 — P8 reuse | 0.65% of the budget (2.7% on own moves 15+): below 5%, parked |
| 3 — N11 prior re-fit | Offline +0.026 to +0.043 nats per level-7 decision; screen +0.26 / +0.26 / +0.31, none clears: **null** |
| 4 — S5 config screen | None clears; temperature 0.7 harmful (−1.82), cPuct 0.8 −4.75 pp first place: **null** |

Commits: `aee012d` (identity dump example), `7a1f3ad` (engine), `459993f` (S4 prereg), `1a42ec6`
(S4 results), `ff3ff1a` (N11 and S5 prereg, scripts, weights), `c14effa` (N11 results), and this one.
