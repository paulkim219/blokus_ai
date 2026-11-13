# v5.0 port P4/P5 — candidate generation and a fitted move prior

Run on the Mac (M4 Pro, 14 cores) on the night of 2026-11-12/13, unattended. Design, seeds and the
acceptance rule are the 2026-11-13 00:05 CST entry of
`research_paper/v6_native_and_learning_preregistered.md` ("P4/P5"). Outputs are under `tmp/p4/`.

## What was built

The D1 diagnostic found that on a seat's moves 3–8 the move Pentobi level 7 would play is outside
`v4.2-ultra`'s 40-move root shortlist about 55% of the time, and that Blokee's choices lean the way
its hand ordering leans (bigger piece, nearer the centre, more corners). The port replaces the
root's candidate generation, in Blokee's own terms (no Pentobi source code, constants or weight
tables were copied; the mechanism was implemented from the brief's description and the weights were
fitted here):

1. **A fitted move prior** (P5): a multinomial logit over all legal moves of a decision, on cheap
   move features, with weights fitted on Pentobi's recorded moves.
2. **Full root expansion with value-initialised children** (P4): every legal root move is a child;
   each child starts with `n0` virtual visits at `m · sqrt(p_i / p_max)` (m the root's rollout mean,
   p the prior), and the root can drop progressive widening so every child is selectable at once.

Everything sits behind `native.candidates` in a config (`engine-rs/README.md`, "Candidate generation
(P4/P5)"); with it absent or empty the engine is byte-identical to before (section "Identity gates").

## Part A — the fitted prior (offline; prediction quality, not strength)

**Data.** The 800 X1 level-6 games (`tmp/d1/x1-l6a.moves.jsonl`, `x1-l6b.moves.jsonl`; seeds
79,000,000–79,000,099, each seed played 8 times). Every decision by a Pentobi 31.0 level-6 seat:
**29,991 decisions, 6,625,675 candidate moves** (all legal moves of each decision; the label is the
move played). The brief's "about 48,000" counted all seats; Pentobi seats made 29,991 decisions. No
extra games were generated (the fit converged on this data and the time went to the matches; see
"Next").

**Split.** By game seed: seeds ending in 4 or 9 (20 of 100 seeds, all 8 games of each) are the test
set — 6,041 decisions — and nothing was tuned on them. Two choices (6 own-move bands rather than 4,
keeping the local-response features) were made by comparing test log-likelihood, so the test numbers
for the final model are very slightly optimistic; the differences involved are small (below).

**Features** (`engine-rs/src/feature_prior.rs`, 39 per move; one `PriorContext` per position, then
O(1) bitboard work per move — about 0.5 µs per move including everything, so a 1,500-move root costs
under a millisecond):

| Group | Features |
|---|---|
| Piece | one-hot of the 21 pieces (subsumes piece size) |
| Centre | mean Manhattan distance of the piece's cells from the centre (today's ordering term) and its square / 10 |
| Home corner | furthest cell's Manhattan distance from the mover's home corner; how far that is beyond the mover's furthest placed cell (`advance`) |
| Opponent corners | cells covering an open corner of any opponent / of the next seat / of the previous seat; cells orthogonally adjacent to an opponent open corner |
| Own corners | own open corners destroyed (occupied or made edge-adjacent); new own open corners split by free orthogonal neighbours after the move (0, 1, 2 — two of a new corner's four neighbours always touch the piece); new own corners that are also an opponent's open corner |
| Contact | opponent cells orthogonally / diagonally adjacent to the piece; piece cells on the board edge |
| Local response | cells on an attach point of one of the last three opponent placements, and on an orthogonal neighbour of one (not usable by that opponent) |
| Phase | separate weight vectors for own-move bands 0–2, 3–5, 6–8, 9–11, 12–14, 15+ |

**Fit** (`ml/p4_fit_prior.py`): softmax log-likelihood over each decision's legal moves, L-BFGS on
standardised columns with L2 1e-3, one weight vector per band; exported unstandardised to
`ml/v5-prior-weights.json` (the JSON carries a note of data, split and fit, and the test metrics).
All six bands converged (29–124 iterations).

**Held-out results** (`tmp/p4/fit/report.md`). Top-k counts ties by expected rank under random
tie-breaking. "Ordering score" is today's `score_moves` (size, centre, new corners, denied corners;
no split term) over all legal moves through a softmax, at the engine's temperature 6 and at the
temperature that fits the training games best. "Today's root shortlist" is the actual 40-move list
`V12Search::prepare` builds for `v4.2-ultra` (moves outside it share last place, so its "top 96" is
a random fill).

| Own moves | Scorer | Test decisions | Mean legal | Top-1 | Top-5 | Mean log-lik | In top 40 | In top 96 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 0–2 | fitted prior | 960 | 259 | 0.241 | 0.839 | −1.961 | 1.000 | 1.000 |
| 0–2 | ordering score, T 6 | 960 | 259 | 0.000 | 0.234 | −4.752 | 0.805 | 1.000 |
| 0–2 | ordering score, T 1.16 (fit) | 960 | 259 | 0.000 | 0.234 | −4.184 | 0.805 | 1.000 |
| 0–2 | today's root shortlist (40) | 960 | 259 | 0.000 | 0.224 | — | 0.805 | 0.830 |
| 0–2 | uniform | 960 | 259 | 0.008 | 0.041 | −5.192 | 0.325 | 0.563 |
| **3–8** | **fitted prior** | 1,920 | 458 | **0.150** | **0.422** | **−3.718** | **0.865** | **0.959** |
| 3–8 | ordering score, T 6 | 1,920 | 458 | 0.045 | 0.150 | −5.673 | 0.499 | 0.727 |
| 3–8 | ordering score, T 1.23 (fit) | 1,920 | 458 | 0.045 | 0.150 | −5.153 | 0.499 | 0.727 |
| 3–8 | today's root shortlist (40) | 1,920 | 458 | 0.061 | 0.185 | — | 0.549 | 0.618 |
| 3–8 | uniform | 1,920 | 458 | 0.003 | 0.013 | −6.044 | 0.106 | 0.253 |
| 9–14 | fitted prior | 1,914 | 106 | 0.224 | 0.536 | −3.071 | 0.949 | 0.994 |
| 9–14 | ordering score, T 6 | 1,914 | 106 | 0.116 | 0.329 | −4.095 | 0.790 | 0.934 |
| 9–14 | ordering score, T 1.53 (fit) | 1,914 | 106 | 0.116 | 0.329 | −3.839 | 0.790 | 0.934 |
| 9–14 | today's root shortlist (40) | 1,914 | 106 | 0.122 | 0.316 | — | 0.804 | 0.915 |
| 9–14 | uniform | 1,914 | 106 | 0.023 | 0.104 | −4.317 | 0.560 | 0.829 |
| 15+ | fitted prior | 1,247 | 13 | 0.553 | 0.885 | −1.451 | 0.999 | 1.000 |
| 15+ | ordering score, T 6 | 1,247 | 13 | 0.454 | 0.824 | −1.974 | 0.999 | 1.000 |
| 15+ | ordering score, T 1.14 (fit) | 1,247 | 13 | 0.454 | 0.824 | −1.703 | 0.999 | 1.000 |
| 15+ | today's root shortlist (40) | 1,247 | 13 | 0.445 | 0.824 | — | 0.998 | 1.000 |
| 15+ | uniform | 1,247 | 13 | 0.219 | 0.569 | −2.121 | 0.995 | 1.000 |

Reading:

- On the moves that matter (3–8), the fitted prior puts level 6's move in its top 40 **86.5%** of
  the time, against **54.9%** for today's actual shortlist (D1 measured 42–45% against level 7's
  move); top-1 rises from 6.1% to 15.0% and log-likelihood by 1.4–2.0 nats per decision. Its top
  96 holds 95.9%.
- Moves 0–2 are Pentobi's opening book, which the prior simply memorises (top 40 = 100%); this
  band is not used in play because the opening shortcut stays.
- Model choices (test log-likelihood on moves 3–8 / 9–14): 4 bands without local features −3.812 /
  −3.154; 4 bands with them −3.761 / −3.089; 6 bands with them (exported) −3.718 / −3.071.

What the weights say (full table in `tmp/p4/fit/report.md`): from move 3 on every pentomino is
preferred over every smaller piece, with X5 strongest in all bands (+3.2 to +10.9) and I5/L5/the long
pentominoes next; covering an opponent's open corner +0.66 to +0.94 per cell (but less for the next
and previous seat than the diagonal one), standing next to one +0.2 to +0.5, touching opponent pieces
edge-on +0.26 to +0.60 but corner-on −0.4 to −0.9; on moves 3–14 new own corners with no free
neighbour count against the move (−0.5 to −1.1) and those with two count for it (+0.26 to +0.52); losing own corners
−0.67 per corner on moves 3–5; the local-response terms are positive throughout. The centre term is
small after move 2 (−0.28 to +0.12 per unit), unlike today's ordering, which pulls to the centre
with weight 0.55 in the opening phase.

## Part B — engine changes

Files: `engine-rs/src/feature_prior.rs` (new: features, model, scorer), `config.rs`
(`native.candidates`, refusals in `unsupported()`), `search.rs` (root candidate path, interior fitted
shortlist, value-initialised children, no-widening switch, `set_recent`, `root_candidates`),
`engine.rs` (`Engine::set_recent`), `game.rs` (`recent_placements`; passes them before each search),
`gtp.rs` (the bridge passes them), `lib.rs`; examples `p4_features.rs` (feature dump) and
`p4_cost.rs` (cost probe); scripts `engine-rs/scripts/p4_configs.py`, `p4-screen.sh`,
`p4_report.py`, `p4_cost_report.py`; `ml/p4_fit_prior.py`, `ml/v5-prior-weights.json`;
`engine-rs/README.md` (option reference).

Options (`native.candidates`; defaults in brackets):

- `rootScorer` ["ordering"] / "fitted": which scorer orders the root and gives its prior. "fitted"
  scores *every* legal move (no size/centre funnel) and keeps the best `rootShortlist` (40) unless
  `rootFull`.
- `rootFull` [false]: every legal root move is a child.
- `rootNoWidening` [false]: no progressive widening at the root; every child is selectable from
  the first iteration, an unvisited child scoring its initial value (or the usual first-play value
  without `initVisits`) instead of being opened one per iteration.
- `initVisits` [0]: `n0` virtual visits at `v_i = m · sqrt(p_i / p_max)` for the root seat, mixed into
  Q exactly as the E6 value term is: `Q_i = (W_i + n0·v_i)/(N_i + n0)`, `v_i` alone for an unvisited
  child. Root only; the move is still chosen by real visits. With widening on, children still enter
  one per iteration on today's schedule (≈ 63 by 4,800 iterations), are visited once on entry, and
  `n0` only shades their Q — so the port's main arms switch widening off at the root, as Pentobi has
  none.
- `interiorScorer` ["ordering"] / "fitted": at interior nodes today's funnel (48 moves by size/centre)
  and shortlist size (24) are kept, but the fitted score chooses, orders and gives the prior of the
  24. (Full expansion at interior nodes was not attempted.)
- `temperature` [1]: softmax temperature over the fitted score; `model`: the fitted weights inline.
- The opening shortcut (first three own moves) and the sealed-region packer are unchanged.

**More than 64 root candidates.** `native.prior` and `native.net` send at most 64 candidates per
record (and `apply_learned_prior` would have blended only the first 64 priors); E6 also recomputes
root-child shortlists outside the tree. `unsupported()` therefore refuses `candidates` together with
`prior` or `net`. `blokee-selfplay` writes the first 64 entries of the ranked list, which is sorted by
visits: records stay well-formed, truncated to the 64 most-visited children (the `candidates` byte
is ≤ 64). `blokee-match`, the bridge and `blokee-worker` use only the chosen move. Nothing panics. Checked: 2 self-play games
with `p4-FULLfit` wrote 148 well-formed records, 73 of them at the 64-candidate cap; a `p4-FULLfit` or
`p4-SLfit` config with `native.prior` added is refused at start-up ("unsupported by the native engine:
native.candidates with native.prior or native.net").

**Local features in play.** The local-response features need the game's last three placements.
`play_game_observed` (match, self-play, worker) and the bridge pass them via `Engine::set_recent`
before each search; the search appends the tree path for interior nodes. Other callers (the TS
worker protocol has no history) get those two features as zero.

## Identity gates (every new option off)

Binaries before the change were built from `bcd2146` (clean tree) and kept in `tmp/p4/bin-before/`;
the match binaries are pinned in `tmp/p4/bin/` (`PROVENANCE.txt`, `engine.diff`). Log:
`tmp/p4/identity.log`, `tmp/p4/gate-parity.txt`.

- `cargo test --release --manifest-path engine-rs/Cargo.toml`: the 8 parity tests pass
  (`rng_matches`, `placement_table_matches`, `playouts_match`,
  `positions_legality_territory_evaluation_ordering`, `rollout_policy_table_matches`,
  `greedy_ranking_matches`, `searches_match`, `whole_games_match`; "8 passed; 0 failed").
- `v4.2-ultra` mirror with the new `blokee-match`, 20 seeds from 80,900,000 (80 games):

  ```
  v4.2-ultra vs v4.2-ultra — 80 games over 20 seeds
  Advantage (score − mean of the three v4.2-ultra seats): 0.00 [95% CI -0.00, 0.00] → not significant
  First place: 32.5% (par 25%), sole wins 18.8%
  Mean score: -10.88 (opponents -10.88), squares placed 77.94 / 89
  ```

  The identity point (`p4-ID`: `"native": {"candidates": {}}`) against `v4.2-ultra` on the same seeds
  prints the same lines (`p4-ID vs v4.2-ultra … 0.00 [95% CI -0.00, 0.00]`), and every game's scores
  (80/80, by seed and seat) equal those of the same mirror played by the binary from before the change.
- Self-play: `blokee-selfplay`, `v4.2-ultra`, 6 games from 80,950,000, one thread — `shard-00.bin`
  (222,208 bytes) and `games.jsonl` are byte-identical between the old binary, the new binary and the
  new binary with `p4-ID` (sha256 `aef1f08d…` and `1ce041d2…` for all three).
- Pentobi bridge: 2 seeds from 80,980,000 (8 games against level 6) with `v4.2-ultra` and with
  `p4-ID`: 8/8 games move-for-move equal to the old binary's (the bridge now also passes the last
  placements to the engine, which nothing reads with the option off).


## Cost

`examples/p4_cost.rs` via `engine-rs/scripts/p4-screen.sh cost 150`: 150 positions of the lone Blokee
seat in the X1 level-6 games (`tmp/d1/x1-l6a.moves.jsonl`, own moves 3–20, every k-th), each searched
by every arm in turn on the same thread with the same RNG seed, budget 300 (4,800 iterations; the
early stop on a decided root stays on, as in play). 2 threads, run at 00:26–00:28 while this screen,
the S1 and E6 screens and other load ran (load average 93–102), so absolute ms are about 2.5× an
idle machine's; the ratios are the measurement. Full table by band: `tmp/p4/cost/cost.md`.

| Config | Band | Positions | ms/move | × first | Iterations | Iterations/s | Root candidates | Children visited | Top child share | Same move as first |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | 3-8 | 65 | 228.3 | 1.00 | 4279 | 18740 | 40.0 | 40.0 | 0.26 | 1.00 |
| FULLord | 3-8 | 65 | 231.5 | 1.01 | 4008 | 17313 | 453.9 | 226.1 | 0.34 | 0.20 |
| SLfit | 3-8 | 65 | 220.5 | 0.97 | 4091 | 18554 | 40.0 | 40.0 | 0.34 | 0.20 |
| FULLfit | 3-8 | 65 | 217.5 | 0.95 | 3938 | 18107 | 453.9 | 51.1 | 0.42 | 0.28 |
| FULLfitI | 3-8 | 65 | 200.8 | 0.88 | 3590 | 17881 | 453.9 | 52.1 | 0.52 | 0.29 |
| SLfitI | 3-8 | 65 | 206.9 | 0.91 | 3830 | 18508 | 40.0 | 40.0 | 0.41 | 0.25 |
| FULLfitN10 | 3-8 | 65 | 202.9 | 0.89 | 3613 | 17806 | 453.9 | 51.1 | 0.54 | 0.26 |
| FULLfitW | 3-8 | 65 | 206.1 | 0.90 | 3795 | 18412 | 453.9 | 56.5 | 0.45 | 0.29 |
| base | all | 150 | 165.0 | 1.00 | 4235 | 25662 | 32.4 | 32.4 | 0.29 | 1.00 |
| FULLord | all | 150 | 166.1 | 1.01 | 4094 | 24642 | 229.8 | 130.1 | 0.34 | 0.48 |
| SLfit | all | 150 | 158.6 | 0.96 | 4051 | 25539 | 32.4 | 32.4 | 0.39 | 0.39 |
| FULLfit | all | 150 | 152.0 | 0.92 | 3916 | 25769 | 229.8 | 37.9 | 0.45 | 0.41 |
| FULLfitI | all | 150 | 151.7 | 0.92 | 3758 | 24775 | 229.8 | 38.8 | 0.50 | 0.40 |
| SLfitI | all | 150 | 153.0 | 0.93 | 3898 | 25475 | 32.4 | 32.4 | 0.43 | 0.37 |
| FULLfitN10 | all | 150 | 145.5 | 0.88 | 3741 | 25713 | 229.8 | 37.9 | 0.52 | 0.42 |
| FULLfitW | all | 150 | 151.0 | 0.91 | 3878 | 25683 | 229.8 | 44.0 | 0.45 | 0.44 |

Every arm costs at most what base costs: iterations per second are unchanged (scoring all legal moves
once per root is below the noise), and the arms that concentrate visits stop early slightly more
often (fewer iterations per move). The full-root arms open 230 root candidates on average (454 on
moves 3–8) but, with value initialisation, visit only about 38 (51 on moves 3–8); `FULLord`, whose
temperature-6 ordering prior is flat over hundreds of moves, visits about 130 (226). The in-match
ms/move ratio for each arm, measured on its own screen games, is in the screen table, and the
acceptance rule is applied to the confirmation's own timing.


## Part C — matches

### Arms (fixed 2026-11-13 00:16:55 CST, before any screen game)

Written to `tmp/p4/ARMS-FIXED.md` and generated by `engine-rs/scripts/p4_configs.py`. Each arm is
`v4.2-ultra` plus a `native.candidates` block (fitted model inline from `ml/v5-prior-weights.json`):

| Arm | Change | `native.candidates` |
|---|---|---|
| base | `v4.2-ultra` unchanged | — |
| FULLord | (a) all legal root moves, today's ordering as prior (T 6), no root widening, n0 3 | `rootFull`, `rootNoWidening`, `initVisits` 3, `rootScorer` ordering |
| SLfit | (b) root shortlist 40 chosen and ordered by the fitted prior; today's tree otherwise | `rootScorer` fitted |
| FULLfit | (c) all legal root moves, fitted prior, no root widening, n0 3 | `rootFull`, `rootNoWidening`, `initVisits` 3, `rootScorer` fitted |
| FULLfitI | (c) + the fitted prior chooses and orders the interior shortlist (24) | as FULLfit + `interiorScorer` fitted |
| SLfitI | (b) + the fitted prior chooses and orders the interior shortlist (24) | `rootScorer` fitted, `interiorScorer` fitted |
| FULLfitN10 | (c) with n0 10 | as FULLfit, `initVisits` 10 |
| FULLfitW | (c) with today's root widening kept | `rootFull`, `initVisits` 3, `rootScorer` fitted |

`ID` (`"candidates": {}`) is the identity point, used only in the gates. Selection rule for the
confirmation (from the preregistration): the arm with the best seed-paired difference against base.

**Liveness** (`engine-rs/scripts/p4-screen.sh live`, 2 seeds from 79,599,000, 8 games per arm): every
arm ran without failures and played 8/8 games differently from base. Not read for strength.


### Screen

100 seeds 79,500,000–79,500,099, each arm as the lone seat against three Pentobi level-6 seats, 5
threads, 00:26–01:57 (`python3 engine-rs/scripts/p4_report.py tmp/p4`). Paired Δ is arm − base on
the same seeds, 95% bootstrap interval by seed; `*` marks an interval that excludes 0.

| Arm | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) |
|---|---:|---:|---:|---:|---:|---:|---:|
| base | 100 | −10.62 [−11.79, −9.46] | 8.0% | — | 67.8 | 82.9 | 1.00 |
| FULLord | 100 | −9.56 [−10.72, −8.39] | 8.8% | +1.06 [−0.33, +2.50] | 67.2 | 82.1 | 0.99 |
| SLfit | 100 | −6.33 [−7.45, −5.24] | 13.0% | +4.29 [+2.88, +5.81] * | 66.3 | 80.5 | 0.97 |
| **FULLfit** | 100 | −4.59 [−5.80, −3.41] | 15.5% | **+6.03 [+4.43, +7.65] \*** | 64.7 | 78.2 | 0.94 |
| FULLfitI | 100 | −4.66 [−5.67, −3.60] | 17.2% | +5.96 [+4.57, +7.37] * | 66.2 | 80.0 | 0.96 |
| SLfitI | 100 | −4.93 [−6.00, −3.82] | 15.5% | +5.69 [+4.29, +7.10] * | 160.2 | 194.0 | (2.34) |
| FULLfitN10 | 100 | −5.82 [−6.95, −4.68] | 14.2% | +4.80 [+3.28, +6.35] * | 104.6 | 126.7 | (1.53) |
| FULLfitW | 100 | −4.77 [−5.85, −3.66] | 15.5% | +5.85 [+4.25, +7.47] * | 91.2 | 110.4 | (1.33) |

Every arm played all 400 games differently from base. **Timing caveat:** the last three arms ran
after 01:06, when the whole machine slowed down (the confirmation's *base* then measured 100 ms/move
against 68 here, at a low load average, so this is the machine and not the arms; probably macOS
throttling background work overnight). Their bracketed ratios are not comparable with base's; the
same-thread cost probe above gives 0.88–0.93 for all three.

Reading (screen only; seven arms on one seed block):

- **The fitted prior carries most of the gain.** It alone, inside today's 40-move shortlist tree
  (`SLfit`), is +4.29. Full expansion with today's ordering as the prior (`FULLord`) is +1.06 with
  an interval spanning 0.
- **Both together are the best arm** (`FULLfit`, +6.03), and it was selected for confirmation by
  the preregistered rule (best point estimate).
- **No sign that the variants add anything.** The fitted prior at interior nodes (`FULLfitI` +5.96,
  `SLfitI` +5.69), ten initial visits instead of three (`FULLfitN10` +4.80) and keeping root
  widening (`FULLfitW` +5.85) all sit within noise of `FULLfit`. None was confirmed, so none is
  claimed.

### Confirmation

`FULLfit` and base on 200 fresh seeds 79,600,000–79,600,199 (800 games each), 01:57–02:32
(`python3 engine-rs/scripts/p4_report.py tmp/p4 --confirm`):

| Arm | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) |
|---|---:|---:|---:|---:|---:|---:|---:|
| base | 200 | −10.25 [−11.02, −9.51] | 8.1% | — | 100.2 | 122.5 | 1.00 |
| **FULLfit** | 200 | **−4.93 [−5.74, −4.14]** | 16.2% | **+5.32 [+4.30, +6.31]** | 94.3 | 114.0 | 0.93 |

Directly against `v4.2-ultra` (reported, not gated; `blokee-match`, one `FULLfit` seat against three
`v4.2-ultra` seats, 200 seeds from 80,000,000, 800 games):

```
p4-FULLfit vs v4.2-ultra — 800 games over 200 seeds
Advantage (score − mean of the three v4.2-ultra seats): 2.13 [95% CI 1.55, 2.75] → SIGNIFICANTLY BETTER than v4.2-ultra
First place: 38.1% (par 25%), sole wins 29.9%
Mean score: -9.10 (opponents -11.24), squares placed 79.27 / 89
Per-seat advantage: blue 2.86  yellow -0.56  purple 2.90  green 3.34
```

## Verdict

**Accepted for v5.0** under the preregistered rule: the confirmation's paired difference is
+5.32 [+4.30, +6.31] (lower bound above 0) at 0.93× base ms/move (limit 1.25×). The config is saved
as `engine-rs/configs/v5.0-p4-ultra.json` (`v4.2-ultra` plus the `FULLfit` candidates block).

What it does and does not show:

- The port closes about half of the gap to Pentobi level 6 at equal compute: from −10.25 to −4.93.
  The engine still loses to level 6 (interval entirely below 0; first place 16.2% against a par of
  25%).
- Against its own ancestor the gain is +2.13, less than half the gain against Pentobi. The port
  was fitted on Pentobi's moves and judged against Pentobi, so part of the +5.32 may be specific to
  that opponent. Both numbers are real; they answer different questions.
- The prior was fitted on level-6 games from seeds 79,000,000–099; the screen and confirmation used
  other seeds, so the match results are not contaminated by the fit.
- In the direct match the yellow seat alone is not ahead (−0.56); per-seat figures at 200 seeds are
  noisy and this was not tested.

## What this implies for the next port

- The prior was the bottleneck D1 pointed at. With it in, the root visits about 38 children out of
  230 on average, so further root-width work is unlikely to pay.
- The remaining gap (about 5 points) has to come from elsewhere. Candidates, none yet measured on
  this base: rollout move choice (P1, with the same features as a rollout policy: N11), the reward
  (P3), subtree reuse (P8), the opening (P9; the fitted prior reproduces Pentobi's book moves on
  held-out games 24% top-1 / 84% top-5, and the opening shortcut is still on), and the budget
  curve (P11).
- A config-only screen of the cheap ones on this base (exploration constant, initial visits,
  opening shortcut off, budget curve) is S2: `research_paper/v5_s2_config_screen_results.md`.
- A stronger teacher for the prior (level 7 games, or more level-6 games) was not tried; the fit
  converged on 30k decisions, so more data of the same kind is unlikely to move it much, while a
  stronger teacher might.
