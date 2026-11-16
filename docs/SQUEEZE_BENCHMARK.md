# Squeeze benchmark — one model against three opponents whose only goal is to shut it out

Status: **built, not yet run** (proposed 2026-11-16 at Paul's request; code on branch
`squeeze-benchmark`). Runs on the PC: see `docs/SQUEEZE_RUNBOOK.md`.

## What it measures

The main benchmark (`docs/BENCHMARK.md`) asks how strong a model is against three ordinary players.
This one asks a different question: if three opponents play for nothing except keeping the model off
the board, how much does it still get down? A model that keeps its corners open, plays its big pieces
early and avoids getting walled in keeps more squares. The score is not a strength ranking, and a model
can be strong in normal play yet easy to squeeze.

## The squeeze adversary

**One frozen adversary, built from our own engine, plays all three opposing seats.** Pentobi cannot be
the adversary, because its objective cannot be changed. It can be a *target*.

- **Objective:** `native.reward.kind = "squeeze"`. The match driver sets the target seat for each game
  (`Engine::set_squeeze_target`). Each adversary seat values a finished game at
  `1 − (target's placed squares) / 89`.
- **The target inside the adversary's search:** modelled as playing for its own placed squares
  (`squares / 89`). This is the worst case for the coalition, and it is the same model for every
  target. The adversary has no model of any particular target's habits.
- **Zero-sum:** the game becomes zero-sum between two sides, the target and a coalition of three. The
  three never communicate. Each one's search treats the other two as allies, because all three hold
  the same objective.
- **Search changes in squeeze mode:**
  - Paranoid search is off, because it would make the allies play against each other.
  - The last-good-reply table counts a simulation as won by the target when the target places more
    than half its squares, and as won by the coalition otherwise.
  - Rollouts always run to the end of the game (`playoutCutoff ≥ 88`, enforced).
- **Squares, not pieces:** squares placed is the game's own score, so keeping a pentomino off the board
  counts five times as much as keeping a monomino off. Pieces placed is reported alongside.
- **Identity:** with `kind` unset, every existing config plays byte-identical games. The parity tests
  pass, and fixed-seed games of the old and new binaries match.

**Arms tested before freezing (stage S1):**

| Arm | What it adds |
|---|---|
| SQ0 | the objective only |
| SQR | rollouts that squeeze: with probability 0.5, a non-target rollout move is the sampled candidate covering the most of the target's corner cells (`squeezeRollout`) |
| SQP | a prior that squeezes: the target's pressure term is added to every non-target seat's fitted prior (`squeezePrior` 1.0, z-score units). The term is the same one as `nextPressure`, with the target in place of the next seat |
| SQRP | both |

Every adversary uses `v5.2-pro`'s search settings, with `playoutCutoff` raised to 100.
`engine-rs/scripts/squeeze_configs.py` writes the configs to `engine-rs/configs/squeeze/`.

## How the adversary is chosen without fitting it to one model

Paul asked that the adversary not be tuned against any one model. These rules were fixed before any
game was played, and `engine-rs/scripts/squeeze_report.py` applies them mechanically:

1. **A mixed development panel.** Every choice is made on eight targets, weighed equally:
   - our nano, lite, `v5.2` and pro;
   - Pentobi levels 1, 3, 5 and 7.

   Half the panel is outside our lineage, and the strength range runs from the weakest setting to the
   strongest one that is affordable. The criterion is the panel mean of the targets' squares placed,
   so no single model can drive the choice. The per-target table is printed beside it.
2. **Separate seed blocks for choosing and for scoring.** S1 uses seeds 110,000,000 and S2 uses
   110,100,000, both with 25 seeds × 4 seats per target. Scoring uses 110,200,000, which is never
   looked at during the choice.
3. **Arm (S1, at the level-6 budget).** The rule takes the arm with the lowest panel mean among the
   arms that take significantly more squares than SQ0. That means a panel difference paired by seed
   within each target, with a 95% upper bound below 0. If no arm qualifies, the choice is SQ0, the
   simplest.
4. **Budget (S2, for the chosen arm).** The candidate budgets are the level-6 reference (about 0.09 s
   per adversary move on the Mac), 4× that, and the pro tier (about 0.9 s). The rule takes the
   smallest budget whose panel mean is within 1.0 square of the pro budget's. If 4× level 6 is still
   more than a square short of pro, the read-out says that a larger adversary would squeeze harder.
5. **Frozen.** The chosen config is copied to `engine-rs/configs/squeeze-v1.json` together with the
   commit it ran on. It never changes after that. A stronger adversary later becomes `squeeze-v2`, and
   scores from different adversaries are never compared.
6. **The same adversary for every target, at a fixed iteration budget,** so the adversary's strength
   does not depend on the machine or on the target.
7. **Every target plays as it normally does.**
   - Our tiers play at their own `iterationScale`, and Pentobi at its level with its opening book.
   - The target always plays its own choice of move, opening included. Only the adversary seats sample
     their openings, as in the main benchmark, for variety.
   - Every seed is played with the target in each of the four seats, because which adversary moves
     right before the target matters.

**Known bias, reported rather than hidden:** the adversary is our engine, so its rollouts and prior
resemble how our own models play. That could make our models easier to anticipate, and so easier to
squeeze, than Pentobi. Comparing Pentobi levels with our tiers at matched time per move (nano with
level 1, lite with 3, `v5.2` with 5, pro with 7) shows whether that happens.

## Validity checks (before any score is read)

1. **It squeezes.** On the scoring seeds, `v5.2` and Pentobi level 5 also play against three ordinary
   seats: `v5.2-pro` settings at the adversary's budget. The squeeze must take clearly more than 5
   squares off `v5.2`; otherwise the adversary is too weak and the benchmark is not used. (First smoke
   test, 12 games: nano placed 61 squares against SQ0 at the level-6 budget and 69 against ordinary
   level-6 opponents. Too few games to count as a result.)
2. **Targets against known strength.** Pentobi levels 1–7 are scored. We expect, but do not require,
   stronger levels to keep more squares. A non-monotone result is reported, because resisting a
   squeeze and normal strength can genuinely differ.
3. **Legal, complete games.** Pentobi games go through the bridge's move checks, and incomplete files
   are rejected and replayed.

## Scoring (stage S3)

- **Squeeze score:** the target's mean squares placed out of 89, averaged over the four seats of each
  seed, with a 95% bootstrap interval over seeds. 100 seeds × 4 seats per target.
- **Also reported:**
  - pieces placed out of 21;
  - the share of games in which the target places all 21 pieces;
  - the ply of the target's last placement;
  - the result by seat.
- **Targets:** `v5.2-nano`, `v5.2-lite`, `v5.2`, `v5.2-l6`, `v5.2-pro`, and Pentobi levels 1–7.
  Ultra and levels 8–9 are left out for time. A new model later plays only its own cell on the same
  seeds, paired by seed with any earlier model.

## Code

| File | What |
|---|---|
| `engine-rs/src/config.rs` | `native.reward` kind `squeeze`, `squeezePrior`, `squeezeRollout`, and their validation |
| `engine-rs/src/search.rs` | `squeeze_value`; the target seat; squeeze values at every leaf type; paranoid off; last-good-reply outcome; SQ-P via `seat_pressure`, the generalised `next_pressure` |
| `engine-rs/src/playout.rs` | SQ-R |
| `engine-rs/src/engine.rs` | `Engine::set_squeeze_target` |
| `engine-rs/src/game.rs` | `opening_fixed_seat`, which lets the target play its own opening; `seat_summary` |
| `engine-rs/src/bin/blokee-match.rs` | `--squeeze`: the champion is the adversary, the challenger the target |
| `engine-rs/src/bin/blokee-pentobi.rs` | `--mode one-pentobi --squeeze`: a Pentobi target |
| `engine-rs/scripts/squeeze_configs.py`, `squeeze-run.sh`, `squeeze_report.py` | configs, the stage runner, read-outs and the selection rules |

## Options not chosen (for now)

- **Pieces objective** (fewest pieces rather than fewest squares). It would be easy to add as another
  reward kind, but it would treat a monomino the same as a pentomino.
- **A learned adversary** trained by self-play against the targets. It would be stronger eventually,
  but it is a project of its own and would have to be retrained as the targets change.
- **One shared tree for all three adversary seats.** It might coordinate them better, but it is worth
  trying only if `squeeze-v1` turns out weak.
