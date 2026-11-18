# Run the v6 opponent-information pilot on the PC

This is Stage 1 of the [v6 opponent-inference plan](../research_paper/v6_opponent_inference_plan.md). It measures the score a planner can gain from knowing three opponents' actual policies in a controlled Blokus league. It runs locally on CPU, generates its own midgames and uses the checked-in v5.2-Pro config and rollout table. Dependencies are Git, Python 3 and the Rust stable toolchain used for the native engine (tested with Rust 1.99). Use a WSL2 Linux shell on Windows. The first Cargo build may download the locked crates.

## First run

In the PC's existing Blokee clone, use a separate worktree to keep any current experiment on its own branch. Run these once:

```bash
git fetch origin codex/v6-opponent-replay
git worktree add --detach ../Blokee-v6-replay FETCH_HEAD
cd ../Blokee-v6-replay
python3 engine-rs/scripts/v6_opponent_replay.py --smoke --homogeneous
python3 engine-rs/scripts/v6_opponent_replay.py --smoke
python3 engine-rs/scripts/v6_opponent_replay.py --workers 2
```

The driver builds the release example. The homogeneous control must finish four rotations with identical per-candidate planning values, zero changed decisions and exactly zero paired gain. The mixed smoke verifies the ordinary path using small budgets. Default pilot output is under `tmp/v6-replay/pilot/`. Look for 32/32 completed seed blocks and `summary.json`. Progress prints after each completed block. Two workers is a conservative starting point for concurrent Pro searches; use one if WSL is memory constrained.

Rerun the same pilot command in this worktree after an interruption. A seed is saved by atomic rename after all four rotations finish. Partial seed blocks are recomputed. The driver checks the revision, release binary, config, learned table and experiment settings before resuming. Worker count may change. Use a different `--out` for an intentionally different experiment. For a wall-time estimate on your PC, run one full-budget block with `--seeds 1 --seed-base 146990100 --workers 1 --out tmp/v6-replay/timing`.

## What is paired

- **League.** The controlled opponents are three stochastic policies built from v5's fitted placement prior. The denial, frontier and center profiles respectively add +2.0 to opponent corners covered, +2.0 to new corners with two free neighbors, or −0.8 to distance from the center in each move band. Each samples a softmax over all legal moves. The three actual types are drawn independently and uniformly, then rotated with the hero across seats. In the homogeneous control both planners know that every opponent uses denial. These are authored experimental opponents.
- **Roots.** Each seed schedules one decision at the same own turn (9–14) in four games, one for each hero seat. The actual lineup generates the midgame; the hero plays the unmodified fitted policy in the prefix. Each root is reconstructed identically for both planners. The native v5.2-Pro search at budget 300 proposes up to four common candidate moves. The JSON record saves the full prefix (native placement IDs, −1 for pass), actual types, both choices and candidate estimates. Forced and unavailable decisions remain in the denominator with zero difference.
- **Choice.** For each candidate, the privileged planner plays 32 continuations with the true three policies. The generic planner knows the league distribution and draws three independent types once per continuation. Both use the same number of terminal continuations, common random numbers across arms and candidates, and the same unmodified fitted policy for later hero turns. The privileged planner learns the types, never the opponents' future random draws. The experiment matches continuation counts; it does not establish a wall-clock strength result for a deployed player.
- **Evaluation.** After each planner chooses, the selected moves are replayed to terminal against the *actual* three policies on 64 fresh paired continuations. Equal choices have zero difference by construction. Each outcome is hero score less the mean of the three other scores. The reported delta subtracts the generic planner's margin from the privileged planner's margin.
- **Readout.** `mean_paired_margin_gain` includes every scheduled decision. `changed_fraction` and `mean_gain_when_changed` show how often knowledge affected the choice and whether those changes paid. The percentile interval uses 2,000 bootstrap resamples of complete four-seat seed blocks. One block produces no interval. This estimates the effect of changing one sampled midgame decision; it does not sum gains over an entire game.
- **Interpretation.** A positive pilot motivates testing whether the observable history can recover that information against unseen opponents. A wide interval is inconclusive. A negative result can reflect candidate quality, finite planning samples, or small opportunity in this league. This runner neither trains an observer nor establishes a Pro/Ultra win against Pentobi. The prediction, intervention and promotion experiments are later stages of the plan.

The default pilot uses fresh development seeds starting at 146,000,000. The smoke output is for execution checks only. For sensitivity checks, the CLI supports `--planning`, `--evaluation`, `--seed-base`, `--seeds` and `--out`. Freeze these and a fresh block before a confirmation.
