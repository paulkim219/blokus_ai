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

## PC follow-up: choosing and discovering moves

From the PC's WSL Blokee clone, create a fresh detached worktree for the follow-up. This works when the earlier pilot worktree already exists and keeps both sets of outputs available. Run these commands in order:

```bash
git fetch origin codex/v6-opponent-replay
git worktree add --detach ../Blokee-v6-discovery FETCH_HEAD
cd ../Blokee-v6-discovery
python3 engine-rs/scripts/v6_opponent_replay.py --followup --smoke --homogeneous
python3 engine-rs/scripts/v6_opponent_replay.py --followup --smoke
python3 engine-rs/scripts/v6_opponent_replay.py --followup --workers 2
```

For an existing follow-up worktree at this revision, start with the Python commands. Use the same final command to resume. Outputs go under `tmp/v6-replay-followup/pilot/`. The completed run has 32 seed files (147,000,000–147,000,031), a manifest and a summary. Copy that directory to retain or share the raw evidence. This CPU diagnostic generates its own games. Timing a separate development block on the PC is possible with `--followup --seeds 1 --seed-base 147990200 --workers 1 --out tmp/v6-discovery-timing`. Run separately from time-sensitive benchmarks.

### Fixed protocol

Use the original pilot’s v5.2-Pro candidate generator and league to isolate what changed. Each of the 128 scheduled decisions receives five planners: a generic population prior, an independent repeat of that prior, exact opponent policies (oracle), a Bayesian estimate from observable moves, and the same three estimates assigned cyclically to the wrong opponent seats. The Bayesian observer starts from the league prior and updates the acting seat using the probability its candidate policies assigned to the chosen placement among all legal alternatives at that turn. The observer knows the three possible synthetic strategies. Synthetic likelihoods make this a favorable case for inference. A pass supplies no preference evidence. Only the oracle and the independent scoring simulator receive the actual identities. In homogeneous mode the known prior is a point mass for all arms.

1. Generate up to four native candidates. Outside this shortlist, take up to eight legal moves ranked by the fitted population prior. Each planner nominates one outside move using 16 terminal samples per available move. Record the union of the native moves and all nominees. This tests discovery within a bounded candidate set.
2. Score the pooled candidates at 32 and 128 continuations per planner. The first 32 draws are a prefix of the 128. All planners except the independent generic repeat share their random draws. Nomination, ranking, and final scoring use distinct streams. The available list for each comparison is set before using final scores.
3. Evaluate **every pooled candidate** against the actual three policies with 64 fresh paired terminal draws per move. Measure final score minus the opponents’ mean score. Report changes over all scheduled decisions, including passes and forced moves. The 95% intervals resample complete four-seat seed blocks. Multiple secondary intervals are descriptive.

### Reading summary.json

- Start with `budgets["128"].exact_information_base`, the primary comparison. It measures how much exact information buys on the same native shortlist. Compare with `sampling_noise_base` at each budget to see how often two independent generic runs disagree. The signed noise gain is centered on zero in expectation. The field `extra_exact_information_gain_high_minus_low_base` gives the paired budget interaction.
- For discovery, `oracle_own_vs_generic_nomination` holds the selector fixed and changes which extra move it may use. `exact_information_own` compares each planner with its own nominee. `exact_information_pool` gives both access to every nominee, including the oracle’s, to isolate choice on a common list.
- For attainable gain in this league, compare `observable_history_own` and `correct_vs_wrong_history_own`. The repeat planner deliberately samples independently even in homogeneous smoke. Generic, oracle, history and wrong-history must agree exactly in that smoke on the same list.
- Treat the 32 blocks as a development screen. Compare margins and confidence intervals as well as changed decisions. A promising comparison needs fresh seeds and opponents before tuning a playing tier. Full-game Pro or Ultra strength, GPU training and wall-clock parity are separate experiments.

The [architecture proposal](../research_paper/v6_opponent_inference_plan.md#after-the-first-pc-pilot) describes the subsequent model and match experiments.
