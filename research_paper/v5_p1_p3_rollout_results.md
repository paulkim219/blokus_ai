# v5.0 ports P1–P3 — rollout move choice, incremental move lists, rank reward

Run on the Mac (M4 Pro, 14 cores) on 2026-11-13. Design, seeds and rules are the 2026-11-13 10:04
CST entry of `research_paper/v6_native_and_learning_preregistered.md` ("P1–P3"). Outputs are under
`tmp/p13/` (git-ignored). Base: `engine-rs/configs/v5.0-p4-ultra.json` (port P4/P5).

Why: on the P4/P5 base, more iterations saturate (a second doubling +0.11 [−1.19, +1.33], X2) and the
search knobs screened in S2/S3 are null, so what is left is what each simulation returns — the
rollout policy and the reward. Every rollout already plays to the end of the game (`playoutCutoff` 84
is never reached), so `features::evaluate` and the `phases.*` weights play no part here.

## What was built

All of it is behind two new native-only config blocks; absent, the engine is byte-identical (see
"Identity gates"). Pentobi's source was read to understand the mechanisms; no code, table or constant
was copied. Every number below is a config value chosen from our own measurement (a fit, or the
preregistered grid). Option reference: `engine-rs/README.md`, "Rollout policy and reward (P1–P3)".

**P2 — incremental legal-move lists** (`engine-rs/src/move_lists.rs`). Per seat, the full list of
legal placements, kept through a rollout:

- placements by other seats go into a per-seat pending mask and are removed in one pass when that
  seat's moves are next needed (a placement stays legal unless it overlaps a newly occupied cell);
- the mover's own placement removes that piece's placements and those that now touch its colour
  edge-on, and adds the placements covering one of its *new* open corners (skipping any that also
  cover an already-open corner or an earlier new corner, which are already listed);
- base lists: the search generates all four lists once at its root (`Playout::set_base`); a seat's
  list in a rollout is derived from the base the first time it is needed (filter by what has been
  placed since, add placements at corners that are new since), guarded by a check that the position
  holds every base piece by colour and no base hand piece has come back;
- list entries are packed (`u64`: id, piece, bounding-box origin, five 5-bit rows), so every per-move
  test is a few shifts against a 24-row copy of a mask, streaming through the list.

**P1 — rollout move choice over all legal moves** (`engine-rs/src/playout.rs`, `play_all_moves`,
`local_squares`). With `native.rollout.policy` "all", each rollout move is drawn from the mover's
whole legal list with weight

    exp(sizeWeight · size + localWeight · (local + localOwnExtra · localOwn))

where `local` counts the move's squares on the local set — the corners opened by opponents'
placements made since the mover's own last placement (game history, then tree path, then rollout)
that the opponent can still use, plus their empty orthogonal neighbours not forbidden to that
opponent — and `localOwn` those of them that are also the mover's own open corners. Weights are a
180-entry table built once per config. `playoutEps`, `playoutMoveCap`, `playoutCorners` and the
table policy are unused on this path.

**P3 — rank reward plus quality bonus** (`engine-rs/src/backup.rs`, `RankReward`; wired in
`search.rs` `leaf_value`). With `native.reward.kind` "rank" every finished game is worth, for seat i,

    v_i = rank_i + qualityWeight · tanh(qualitySlope · z_i) − lengthWeight · (rank_i − ½) · tanh(qualitySlope · z_len)

`rank_i` = fraction of opponents beaten, ties half (the existing `rank_from`); `z_i` = seat i's score
minus the mean of the other three, standardised by that seat's running mean and deviation over this
search's simulations (cleared at each search; each sample added before it is standardised); `z_len`
= game length in placements, standardised the same way. It replaces the value on all three
finished-game paths (rollout end, terminal tree node, all seats sealed — the last without the length
term, since the packer does not report a piece count). The old reward stays on the truncated-rollout
path, which is never reached at cutoff 84.

**Config options.** `native.rollout`: `policy` ("sampled" | "all"), `sizeWeight`, `localWeight`,
`localOwnExtra`. `native.reward`: `kind` ("blend" | "rank"), `qualityWeight`, `qualitySlope`,
`lengthWeight`. Both blocks use `deny_unknown_fields`. `unsupported()` refuses unknown policy/kind,
non-finite or out-of-range weights (|w| ≤ 20), `qualitySlope` ≤ 0, and reward "rank" together with
`native.net` (its value channel mixes the old reward's scale into Q) or `leafMaterialBlend` > 0.

Files: `src/move_lists.rs` (new), `src/playout.rs`, `src/backup.rs`, `src/search.rs`,
`src/config.rs`, `src/lib.rs`, `tests/move_lists.rs` (new), `examples/p13_rollout_fit.rs` (new),
`ml/p13_fit_rollout.py`, `ml/v5-rollout-fit.json`, `engine-rs/scripts/p13_configs.py`,
`p13-run.sh`, `p13_report.py`, `engine-rs/README.md`.

## Gates

**P2 equality test** (`engine-rs/tests/move_lists.rs`, measured): 7,000 random games (1,000 seeds ×
seven modes: lists kept from the start or asked for lazily; with base lists set at random earlier
positions and rollout-style resets; both opening rules), 353,280 placements, **1,118,389 list
comparisons, every one equal** to `Position::generate_moves` as a set, with no duplicates. The test
is not vacuous: on the final code, each of four deliberate mutations (dropping the old-corner skip,
the earlier-new-corner skip, its bookkeeping, or the "seat has not moved" shortcut) makes it fail;
on an earlier version of the module, so did dropping the piece filter or one corner bit. A second test runs 1,200 "all" rollouts from random
positions with a base at a random ancestor: each reaches the end of the game and restores the
position exactly; in a debug build every rollout move is also asserted legal.

**Identity gates** (measured; `tmp/p13/identity.log`, `tmp/p13/gate-tests.txt`). Old binaries built
from `6b04dd4` (the commit before the change) in a separate worktree (`tmp/p13/bin-before/`); new
binaries from `20f6cb1`, pinned in `tmp/p13/bin/` (`PROVENANCE.txt`).

- `cargo test --release`: the 8 parity tests pass (plus 4 unit tests and the 2 new tests).
- `v5.0-p4-ultra` mirror with the new `blokee-match`, 20 seeds from 80,900,000 (80 games):
  `Advantage (score − mean of the three v5.0-p4-ultra seats): 0.00 [95% CI -0.00, 0.00]`.
- Identity point `p13-ID` (`"rollout": {"policy": "sampled"}, "reward": {"kind": "blend"}`) vs
  `v5.0-p4-ultra`, same seeds: `0.00 [95% CI -0.00, 0.00]`; 80/80 games have every seat's score equal
  to the old binary's mirror (as does the new binary's own mirror).
- Self-play (`blokee-selfplay`, 6 games from 80,950,000, one thread): `shard-00.bin` and
  `games.jsonl` byte-identical between the old binary, the new binary, and the new binary with
  `p13-ID` (sha256 `e834eb15…` / `f788f905…`).
- Pentobi bridge, 2 seeds from 80,980,000 (8 games vs level 6): new binary and `p13-ID` 8/8 games
  move-for-move equal to the old binary.

## P1 weights: a fit on Pentobi's decisions (offline)

`examples/p13_rollout_fit.rs` replays the 800 X1 level-6 games (`tmp/d1/x1-l6{a,b}.moves.jsonl`,
seeds 79,000,000–099) and, for each of the 25,191 Pentobi level-6 decisions at own move ≥ 3 (the book
moves 0–2 left out), counts the legal moves by (size, local, localOwn) with the same
`local_squares` the rollout uses. `ml/p13_fit_rollout.py` fits the softmax log-likelihood (L-BFGS);
test set = seeds ending in 4 or 9 (5,081 decisions), as in the P4 fit. Measured:

| Model | Weights | Train ll / decision | Test ll / decision |
|---|---|---:|---:|
| uniform | — | −4.421 | −4.431 |
| size | 1.4347 | −3.882 | −3.875 |
| size + local | 1.3897, 0.8060 | −3.711 | −3.704 |
| **size + local + own** | **1.3995, 0.7185, 0.4681** (→ `localOwnExtra` 0.6515) | −3.706 | **−3.702** |
| one weight per size + local + own (reference only) | sizes 2–5: 0.74, 1.45, 3.09, 4.97; 0.70, 0.49 | −3.676 | −3.662 |

Descriptive: where a local move existed, level 6 played one 53.7% of the time on own moves 3–8
(local moves were 21% of the legal moves), 39.6% on moves 9–14, 57.4% on 15+. The fitted local
weight is moderate (a five-square local move is about e^3.6 ≈ 36× a non-local move of the same
size); `P1X` tests a much steeper one.

## Cost (clean run)

`p13-run.sh cost 150` = `examples/p4_cost.rs` on 150 positions of the lone Blokee seat in the X1
level-6 games (own moves 3–20), every arm in turn on the same thread with the same RNG seed, budget
300, 2 threads, run at 10:00–10:01 with none of my jobs running (the machine's own background load —
a Docker VM using about one core — was present; load average 6.9–7.3 on 14 cores). Measured,
`tmp/p13/cost/cost.md`:

| Config | ms/move moves 3–8 | ms/move 9–14 | ms/move 15+ | ms/move all (3+) | × base (all) | Iterations/s (all) |
|---|---:|---:|---:|---:|---:|---:|
| base | 96.0 | 55.3 | 20.2 | 69.4 | 1.00 | 56,425 |
| ID | 96.2 | 54.6 | 17.7 | 69.0 | 0.99 | 56,799 |
| P1S | 165.6 | 46.0 | 12.2 | 94.5 | 1.36 | 39,415 |
| P1L | 222.0 | 54.2 | 14.3 | 122.9 | 1.77 | 31,105 |
| P1X | 203.5 | 52.6 | 13.3 | 114.1 | 1.64 | 32,827 |
| P3A | 88.0 | 53.0 | 16.7 | 64.5 | 0.93 | 57,713 |
| P3B | 85.5 | 48.8 | 16.1 | 61.5 | 0.89 | 57,742 |
| P1LP3B | 211.6 | 48.7 | 12.1 | 115.6 | 1.67 | 31,041 |

The all-moves rollout costs 1.4–1.8× per move overall and 1.7–2.3× on moves 3–8, where lists are
longest; it is cheaper than base late in the game. A first version that generated lists from scratch
and filtered by full board masks cost 2.8–3.4×; base lists and packed entries brought it here. The P3
arms are slightly *cheaper*, because they stop early more often (the early stop on a decided root
fires sooner when visits concentrate). These ratios were fixed in the preregistration before the
screen and decide whether an equal-time arm is needed.

## Screen

<!-- P13:SCREEN -->
100 seeds 83,000,000–83,000,099, each arm as the lone seat against three Pentobi level-6 seats
(400 games per arm), 10 threads, 10:04–12:18, pinned binary `tmp/p13/bin/blokee-pentobi`
(`python3 engine-rs/scripts/p13_report.py tmp/p13`). Measured. Paired Δ is arm − base on the same
seeds, 95% percentile bootstrap by seed; `*` would mark an interval excluding 0 (none does).

| Arm | Change | Seeds | Advantage vs L6 [95% CI] | First place | Paired Δ vs base [95% CI] | ms/move all | ms/move 3+ | × base (3+) | Games ≠ base |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | v5.0-p4-ultra unchanged | 100 | -4.60 [-5.76, -3.46] | 17.5% | — | 75.9 | 91.8 | 1.00 | 0/400 |
| P1S | rollout over all legal moves, size weight only (fitted 1.4347) | 100 | -4.89 [-6.16, -3.59] | 17.0% | -0.30 [-1.85, +1.29] | 146.1 | 176.9 | 1.93 | 400/400 |
| P1L | rollout over all legal moves, size + local response (fitted 1.3995 / 0.7185 / own ×0.6515) | 100 | -4.68 [-5.80, -3.54] | 18.8% | -0.09 [-1.38, +1.29] | 100.4 | 121.4 | 1.32 | 400/400 |
| P1X | rollout over all legal moves, size + steep local response (local 6.0; size and own as fitted) | 100 | -5.08 [-6.17, -4.03] | 16.5% | -0.48 [-2.02, +0.96] | 95.0 | 114.9 | 1.25 | 400/400 |
| P3A | rank reward + quality bonus 0.1 (tanh of the standardised margin), length 0.1 | 100 | -5.08 [-6.27, -3.81] | 16.2% | -0.49 [-1.97, +1.07] | 53.2 | 64.3 | 0.70 | 398/400 |
| P3B | rank reward + quality bonus 0.25 (tanh of the standardised margin), length 0.1 | 100 | -4.16 [-5.23, -3.09] | 14.8% | +0.44 [-0.92, +1.87] | 51.1 | 61.6 | 0.67 | 400/400 |
| P1LP3B | P1L and P3B together | 100 | -4.54 [-5.64, -3.43] | 12.2% | +0.06 [-1.50, +1.59] | 90.1 | 108.7 | 1.19 | 400/400 |

No game failed (no failure files, no HARD lines). Every arm played every game differently from base
except `P3A` (398/400).

**In-match ms/move columns are not a cost measurement.** Between about 10:05 and 11:55 the Mac kept
entering system sleep ("Maintenance Sleep", `pmset -g log`), which stalled the bridge for minutes at
a time: `base` took 34 minutes and `P1S` 85 minutes for 400 games, against 3 minutes for each later
arm once a `caffeinate -i -s -m -w <chain pid>` was started at 11:55. `base` and `P1S` ran mostly in
that period and the later arms on an awake machine under load 14–31, so the "× base" column compares
unlike conditions. The cost figures that count are the clean run above (preregistered).
<!-- /P13:SCREEN -->

## Confirmation

<!-- P13:CONFIRM -->
Not run. Selection rule (preregistered): among arms whose paired CI lower bound is above 0, the best
point estimate. Read-out (`tmp/p13/selection.log`):

```
P1S: paired -0.297 [-1.855, +1.286] on 100 seeds -> does not clear
P1L: paired -0.086 [-1.383, +1.291] on 100 seeds -> does not clear
P1X: paired -0.484 [-2.020, +0.963] on 100 seeds -> does not clear
P3A: paired -0.485 [-1.972, +1.074] on 100 seeds -> does not clear
P3B: paired +0.438 [-0.921, +1.867] on 100 seeds -> does not clear
P1LP3B: paired +0.060 [-1.498, +1.591] on 100 seeds -> does not clear
selected (CI lower bound > 0, best point estimate): (none)
```

The confirmation seeds 83,100,000–199 and the direct-match seeds 83,200,000–199 are unread. No
equal-time arm was needed or played.
<!-- /P13:CONFIRM -->

## Verdict

**Null. Nothing accepted; `v5.0-p4-ultra` stays the base.** No arm's paired difference against base
has a 95% interval above 0 on the screen, so under the preregistered rule there is no confirmation.

What the screen does and does not show (100 seeds, six arms; intervals about ±1.4–1.6):

- **P1 (rollout over all legal moves) does not help at equal iterations.** Size only −0.30
  [−1.85, +1.29]; size + fitted local response −0.09 [−1.38, +1.29]; steep local response −0.48
  [−2.02, +0.96]. The local term does not separate from size only (P1L − P1S ≈ +0.2, well inside the
  noise). And P1 costs 1.36–1.77× per move in the clean run, so at equal time it would start behind.
  Effects smaller than about 1.5 points either way are not excluded.
- **P3 (rank reward + quality bonus) is null at both grid points:** 0.1 → −0.49 [−1.97, +1.07];
  0.25 → +0.44 [−0.92, +1.87]. It is slightly cheaper (0.89–0.93× in the clean run, from earlier
  stops), which is not a gain in strength.
- **Together** (P1L + P3B): +0.06 [−1.50, +1.59].
- The screen's base, −4.60 [−5.76, −3.46], agrees with the P4/P5 confirmation's −4.93.

Reading, inferred rather than measured: with the P4/P5 prior choosing which root children get
visits, neither a more Pentobi-like rollout nor a rank-based reward changes the move the search
settles on often enough to show at 400 games. Together with X2 (more iterations saturate) and S2/S3
(search knobs null), the remaining ~5-point gap to level 6 does not look like it lives in the
rollout or the reward as ported here.

## Caveats and things I am unsure of

- **Imitation is not simulation balancing.** The P1 weights are a likelihood fit to the moves level 6
  *plays after searching*; a rollout policy that gives better values need not imitate strong moves.
  `P1X` covers one much steeper local weight; other shapes (per-piece weights, phase-dependent weights,
  Pentobi's early-game piece restriction) were not tried.
- **Design choices that differ from a literal reading of the brief:** the margin in the quality bonus
  is own score minus the *mean* opponent (not the best); statistics are per seat and per search;
  the length term is left out when the packer solved a region; the local set uses placements since
  the mover's own last placement, and "neighbours" are orthogonal neighbours not forbidden to the
  opponent who opened the corner (the same definition as the P4/P5 prior's local features). These
  were fixed before any game and are documented in the README; I do not think a different reading
  would turn a null into a gain, but that is untested.
- **P3 values beyond the two-point grid** (larger bonus, no length term, rank only) were not screened.
- The clean cost run had a Docker VM using about one core in the background (not my process).
- Liveness (2 seeds per arm, seeds 83,900,000–901) printed advantages before the prereg was
  committed; the arms and values had been committed (`20f6cb1`) before liveness ran.

## Next

P1–P3 are recorded as tested and not added. If rollouts are revisited, the more promising
directions are a rollout policy fitted for value accuracy (simulation balancing, N11) or reusing the
P4/P5 move features inside rollouts, and making the all-moves rollout cheaper (it is now 1.4–1.8×).
The other open ports are P6 (RAVE), P7 (last-good-reply), P8 (subtree reuse) and P9 (opening).
