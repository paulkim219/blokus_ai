# Squeeze benchmark — one model against three opponents whose only goal is to shut it out

Status: **planned** (proposed 2026-11-16 at Paul's request; nothing built yet). Runs on the PC.

## What it measures

The main benchmark (`docs/BENCHMARK.md`) asks how strong a model is against three ordinary players.
This one asks something different: when three opponents play for nothing except keeping the model
off the board, how much does it still get down? A model that keeps its corners open, plays its big
pieces early and avoids getting walled in will keep more squares. The score is not a strength
ranking, and a model can be strong in normal play and still be easy to squeeze.

## The squeeze adversary

**One frozen adversary, built from our own engine, plays all three opposing seats.** Pentobi can't
be the adversary because its objective can't be changed, but it can be a *target* (see below).

1. **Objective.** A new reward kind `native.reward.kind = "squeeze"`, with the target seat passed in
   by the match driver for each game. Each adversary seat's value for a finished game is
   `1 − (target's placed squares) / 89`. Inside the adversary's tree, the target is modelled as
   playing for its own placed squares (`squares / 89`), the worst case for the adversaries. The game
   becomes zero-sum between two sides: the target against a coalition of three. The existing
   per-seat value vectors back this up unchanged.
2. **Squares, not pieces.** The objective counts squares placed (the game's score), so a pentomino
   kept off the board counts five times as much as a monomino. Pieces placed is reported beside it.
   A pieces-objective variant is listed below as an option.
3. **Coordination without communication.** All three adversaries run the same objective, so each
   one's search treats the other two as allies. They need no shared plan for that, and they keep no
   tree between moves.
4. **Identity.** With `kind` unset, the engine is byte-identical to today (parity tests and fixed-seed
   scores), as for every other option.

**Two improvements, each tested as its own arm against the plain version above:**

- **SQ-R, rollouts that squeeze.** Today's rollout policy has every seat play normally, so the
  rollouts underestimate what the coalition can do. In SQ-R the adversary seats' rollout moves are
  biased towards moves that occupy or block the target's attach corners (a cheap bitboard count).
- **SQ-P, prior that squeezes.** The same corner-blocking count is added as a feature of the
  in-tree prior for adversary seats.

An arm is kept only if it takes more squares off the target than the plain version (paired by seed,
lower bound above 0).

**Adversary compute.** The adversary's budget is fixed and independent of the target. To choose it,
play one fixed target (`v5.2`) against the adversary at the `v5.2-l6`, `v5.2-pro` and 4× pro
budgets on 100 seeds, and freeze the smallest budget whose squeeze is within 1 square of the
largest. Binary and config are then frozen as **`squeeze-v1`** and never changed. A stronger
adversary later becomes `squeeze-v2`; scores from different adversaries are not compared.

## Validity checks (before any score is read)

1. **It squeezes.** On the same seeds, `v5.2` against three `squeeze-v1` seats must place clearly
   fewer squares than `v5.2` against three ordinary `v5.2` seats. If the drop is under about 5
   squares, the adversary is too weak and the benchmark is not used.
2. **Targets line up with known strength.** Pentobi levels 1, 3, 5 and 7, and our nano, lite,
   `v5.2` and pro, are each played as targets. Stronger players are expected, though not required,
   to keep more squares. A non-monotone result is reported, not hidden, because squeeze resistance
   and strength can genuinely differ.
3. **Legal and complete games.** Every game is replayed through the rules checker, the same check the
   Pentobi bridge already uses.

## Scoring

- **Squeeze score:** the target's mean placed squares out of 89, with a 95% bootstrap interval over
  seeds.
- **Also reported:**
  - mean pieces placed out of 21;
  - the share of games in which the target places all 21 pieces;
  - the mean move number of the target's last placement.
- **Seats:** every seed is played with the target in each of the four seats. The target's seat
  relative to the turn order matters: which adversary moves right before it.
- **Comparing models:** paired by seed on the same block, as in the main benchmark.
- **Target compute:** each target plays at its own tier's settings: our tiers at their
  `iterationScale`, Pentobi at its level. The adversary never changes.
- **Size:** 100 seeds × 4 seats = 400 games per target, on a fresh seed block from 110,000,000.

## Running it on the PC

- Everything is CPU-bound in the native engine; the GPU is not used.
- Build on the PC with `cargo build --release` under WSL2. Our engine is deterministic for a
  given seed and iteration count, so PC results for our models should match the Mac's (checked on
  20 seeds before the first real run).
- Pentobi targets need `pentobi-gtp` built on the PC from Pentobi's source, outside the repo, the
  same way as on the Mac. It is only run as a separate process, and none of its code enters this
  repo.
- **Estimated cost** (from Mac timings): an adversary at the pro budget takes about 0.9 s per move
  and makes about 60 moves per game, so about 1 minute per game per thread. 400 games per target
  then take about 25–40 minutes on 12–16 threads.
- **Memory:** a pro-budget tree uses about 1.5 GB. Size the thread count to the PC's RAM: with
  32 GB, at most about 16 threads.
- A runbook, `docs/SQUEEZE_RUNBOOK.md`, gets written with the code, in the style of
  `E4_RUNBOOK.md`. Each run commits and pushes its results.

## Build order

1. Engine: the squeeze reward kind with an identity check, and the SQ-R and SQ-P options, off by
   default.
2. Match drivers: `blokee-match` and `blokee-pentobi` get a squeeze mode. It puts the target in one
   seat and `squeeze-v1` in the other three, passes the target seat to the adversary, and writes
   both squares and pieces to the JSONL.
3. On the Mac, short runs only: the identity check, check 1 on 20 seeds, and a timing check.
4. On the PC: choose the adversary budget, run the SQ-R and SQ-P arms, freeze `squeeze-v1`, then run
   checks 1–3 and the target table.

Steps 1–3 are built on their own branch (`squeeze-benchmark`) in a separate worktree, so they never
touch the binary a running Mac round is using. They are merged after that round ends.

## Options not chosen (for now)

- **Pieces objective** (fewest pieces rather than fewest squares). It is easy to add as a second
  reward kind if Paul prefers it, but it treats a monomino the same as a pentomino.
- **A learned adversary** trained by self-play against the target. It would be stronger in the long
  run, but it is a project in itself and would have to be retrained whenever the targets change.
- **One shared tree for all three adversary seats.** It might coordinate them better, but each seat
  searching on its own already gets most of the benefit. It is worth trying only if `squeeze-v1`
  turns out weak.
