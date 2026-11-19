# Hybrid CPU + GPU model line: research and plan

Written 2026-11-19 at Paul's request ("combining the capabilities of both the CPU and GPU ... by the time we get to v5.5
we can switch over to this architecture, or at least have this model line be something they can choose"). Nothing here
is built or run yet. Gates below are proposals; each stage gets its own preregistration before any game, as usual.

Working name in this document: **the hybrid line**. Paul names versions.

## 1. The idea in one paragraph

Keep what makes v5 strong (the CPU rollout tree search with RAVE, interior expansion, rank reward and the interior cap)
and add a neural network that runs on the GPU **alongside** it, never in its way. CPU threads walk the tree and play
rollouts exactly as today. When a node becomes interesting (enough visits), its position is queued for the GPU, which
evaluates many positions from many threads or games in one batch. The answer upgrades that node in place: a much
better move prior (which also decides which children the interior cap lets in) and a value estimate that is mixed with
the rollout average. The search never waits for the GPU; until a node's answer arrives it uses the hand-feature prior
it has today. This is the shape AlphaGo used (CPU rollouts, GPU networks, asynchronous, values mixed half and half),
rebuilt on our engine and our evidence.

## 2. What our own experiments already say

| Finding | Evidence | What it means for the hybrid |
|---|---|---|
| A network prior at the root is a real gain | E6-P0, old v4 tree: **+0.83 [0.56, 1.09]** vs `v4.2-ultra`, 800 seeds, 1 network call per move | The network's policy is worth more than a v5 tuning step, and that was with one call per move |
| Deeper network channels look positive but are unproven | E6, 400 seeds, paired vs root-prior control: depth-1 policy +0.35 [−0.19, +0.89], root-child value +0.12 / +0.27, both +0.40 [−0.13, +0.92] | Point estimates all positive and ordered as expected; the screen was too small. The hybrid uses them at many nodes, not one level |
| The network sees outcome information the rollouts miss | Offline, 58,726 positions: margin R² net 0.448 vs 4,800-iteration search value 0.413; utility head adds +0.072 over the search | A value channel has fuel; it has never been used beyond the root's children |
| **Replacing** rollouts with a value fails | v4.6 / v4.7: −4.5 to −16 (tiny nets, 24–400 games) | Mix, never replace |
| Move generation is v5's biggest weakness | D1: on own moves 3–8 Pentobi L7's move is inside Blokee's 40-move shortlist only 42–45% of the time | The prior decides which moves get looked at, especially now that the interior cap keeps only floor(a + b·√N) children |
| Hand-feature priors have hit their capacity | N11: a prior re-fitted on 125,729 L7 decisions scores the same on training and held-out data (capacity-limited), screen null. N19: mobility features helped offline but cost 15× in the interior (−8.03 at equal time) | More features on the CPU are too slow; a network carries far more capacity, and a GPU makes it cheap per node if batched |
| v5 scales worse than Pentobi at high budgets | 9× iterations add only 1.5 plies of mean depth; pro ≈ L6.9, ultra ≈ L8.2 (loose) | A better prior and value at interior nodes is the classic fix for a search that spreads too thin |
| The network is data-limited, not size-limited | E5 on the PC: `b8w96`, `b12w128`, `b16w160` reach the same validation loss on 36k games; `b8w96` trains at 19.2k positions/s | Start small (1.6M parameters) and spend effort on data |
| Plumbing limits | Today's network runs in a Python server over a Unix socket; records carry at most 64 candidates, so the net cannot be combined with the v5 root, which holds every legal move | Both have to be rebuilt (stage H0, H1) |

## 3. What the literature says

- **AlphaGo (Silver et al. 2016):** asynchronous policy and value MCTS. Rollouts on CPUs, networks on GPUs, a leaf's
  value is λ·(network value) + (1 − λ)·(rollout result) with λ = 0.5, and the policy network's prior replaces a cheap
  placeholder prior when it arrives. This is the closest existing design to what Paul describes.
- **AlphaZero and KataGo:** many search threads feed one GPU, with virtual loss to keep the threads apart. Throughput
  depends on keeping batches full: one user report for KataGo shows going from 5 to 32 search threads raised the
  average batch from 1.6 to 10.6 positions and visits per second from 533 to 1,796 (forum figures, indicative only).
- **WU-UCT (Liu et al., ICLR 2020):** counts evaluations that are in flight ("unobserved") and corrects selection for
  them, which parallelises MCTS with near-linear speed-up. It is a better-founded alternative to plain virtual loss
  for our asynchronous network calls.
- **Gumbel AlphaZero (Danihelka et al., ICLR 2022):** samples root moves without replacement and splits the budget by
  sequential halving. It keeps improving the policy with very few simulations (as few as 2 in their Go tests), which
  suits our cheap tiers (nano, lite) and self-play training.
- **Multiplayer AlphaZero (Petosa and Balch, 2019):** the value head predicts one value per player and each player
  backs up its own entry. Our E5 network already has per-seat margin, rank and first-place heads.
- **AlphaBlokus (Blokus Duo, two players, 14×14):** pure AlphaZero, no rollouts, 8M-parameter ResNet, about 700k
  self-play games on rented RTX 5090s. Against Pentobi at equal time per move it scored 0.315 against level 9
  (author's estimate: about 375 Elo short), and 20% wins against level 6 at 400 simulations. This is the strongest
  public evidence that a network-only engine is expensive to bring up to Pentobi, and it is on the easier two-player
  board. It supports keeping rollouts.
- **Searchless chess (Ruoss et al., 2024):** a 270M-parameter transformer distilled from about 15 billion
  Stockfish-labelled positions plays at grandmaster level with no search. Distillation works at enormous data scale;
  not a near-term route for us (tracker item V6-A).

**Running the network.**
- **ONNX Runtime.** The `ort` Rust crate runs an ONNX model in-process with CUDA or TensorRT on the PC, and CoreML or CPU on
  the Mac. `onnxruntime-web` runs the same file in the browser, with WebGPU or a WebAssembly CPU fallback. The ONNX
  Runtime docs note that for very small models WebAssembly can match or beat WebGPU, because of the CPU–GPU round
  trip, so batching matters in the browser too.
- **Burn.** A Rust framework whose `wgpu` backend runs on Metal, Vulkan, DirectX and WebGPU from one codebase, including
  compiled to WebAssembly. It could serve native and browser alike, but it is less proven for this.
- **Recommendation.** ONNX as the single model format; `ort` for native; `onnxruntime-web` for the browser. Burn
  stays a fallback, if H0 shows `ort` cannot meet latency on the Mac.

## 4. Proposed architecture

**One process, no Python at play time.** Training stays in PyTorch (`ml/torch/`); each checkpoint is exported to ONNX
and loaded by the Rust engine through an `Evaluator` trait (implementations: `ort` CUDA, `ort` CoreML, `ort` CPU, and
"none" = today's engine). The Unix-socket server stays for old experiments only.

**Search (CPU) and evaluation (GPU) run concurrently.**
1. Search threads descend, expand and roll out as today. A node gets its hand-feature prior and child values at
   expansion, exactly as now.
2. When a node reaches T visits (T is a tuning knob; AlphaGo used an expansion threshold), its position goes into the
   evaluation queue and the node is marked pending. Selection treats pending evaluations as WU-UCT does.
3. The evaluator thread collects positions from every search thread (and, in matches and self-play, from every game
   in the process) and runs them as one batch when the batch is full or a short deadline passes.
4. On return:
   - **Prior.** The node's prior is replaced by a blend of the network and hand priors. The interior cap re-sorts
     the window, so the network decides which children are admitted from then on.
   - **Value.** The node's value gets the network's per-seat utility as n_v virtual visits, mixed with the rollout
     statistics. The re-centring is the one used in E6, so only differences between siblings enter.
5. Rollouts keep using the cheap hand-feature policy. A network call per rollout move would be far too slow, since
   a rollout iteration costs about 20 µs on one core.

**Network v3.**
- **Policy over every legal move.** A fixed head of 91 piece-orientations × 400 anchor cells, masked to legal
  moves, replaces the 64 slots.
- **Value heads.** Per-seat value heads (margin, rank, first) as in E5, plus ownership as an auxiliary target.
- **Size and precision.** Start at `b8w96` in fp16.
- **Inputs.** Seat-relative, with the absolute seat as input.

**Identity and determinism.**
- **Identity.** With the evaluator set to "none" the engine must be byte-identical to the v5.x config it extends:
  parity tests, a mirror at 0.00, and identical bridge games.
- **Determinism.** Asynchronous batching makes games depend on timing, so they won't replay exactly. A synchronous
  mode (each call waits, batch of one thread) gives reproducible games for identity and debugging. Seed pairing for
  experiments still works, because seeds fix openings and Pentobi's seeds.

## 4b. The player chooses the GPU share (Paul, 2026-11-19)

Paul: "have the user choose whether to involve the GPU and by how much. This dynamic balance between CPU and GPU will
ensure that people with different hardware can still have the performance of the different tiers they want."

**A tier means a strength, not a machine.** Today a tier is a fixed amount of work: `iterationScale` was calibrated
once against Pentobi's time on the Mac. Its strength is the same on any computer; a slow computer only takes longer per
move. The hybrid keeps that principle. A tier has several **mixes** of equal strength, each a fixed amount of work:

| Mix | CPU work | GPU work | Who it suits |
|---|---|---|---|
| CPU only | the tier's v5.x config, unchanged | none | no GPU, or the player wants the GPU free |
| Light GPU | fewer iterations | network prior at the root and the busiest nodes (large T) | integrated or older GPUs |
| Balanced | fewer still | prior and value from a moderate T | most discrete GPUs, Apple silicon |
| Heavy GPU | the fewest | small T, large batches | strong GPUs (a 4080) |

**What the player sees.**
- **The tier.** As today.
- **A GPU setting.** Off / Auto / a slider from light to heavy.
- **Auto.** A one-off calibration of a few seconds on first use, repeatable from settings. It times this machine's CPU
  iterations and GPU evaluations at a few batch sizes, then picks the mix that is fastest per move here. The slider
  lets the player override it, for example to keep the GPU free or to save battery.
- **Strength stays put.** Whatever the setting, the strength stays at the tier's level; only time per move, and which
  chip does the work, changes.

**How mixes are made equal in strength.** This is the experimental work this adds.
- **Calibration.** For each tier, start from the CPU-only config. For each GPU mix, lower the iteration count until
  the mix is no stronger than the CPU config.
- **Measurement.** Each mix is a fixed config, measured against the same Pentobi level and against the CPU-only
  config on the same seeds.
- **Rule for offering a mix (non-inferiority).** A mix is offered for a tier only if its paired difference against the
  CPU-only config has a lower bound above an agreed margin (proposal: −0.5 points) on 800 fresh seeds. A mix that is
  clearly stronger is a candidate for a new version, not a new mix.
- **Time.** Recorded for both machines (Mac and PC), so Auto has measured defaults to start from.
- **Fewer mixes if needed.** If full equal-strength calibration proves too costly, ship fewer mixes. Every tier keeps
  CPU-only, and the most useful second option is probably Balanced.

**Consequences for the engine.**
- **One setting.** A mix is a single dial: the threshold T and the iteration count move together along the tier's
  table.
- **Graceful failure.** If the GPU is missing, busy or slower than calibrated, the engine falls back to CPU-only for
  that move. That is the fail-safe.

## 5. How it is compared (fairness)

- **Equal wall time stays the standard.** It is set per move, on a named machine, as for every tier today. The hybrid
  uses a GPU and Pentobi does not, so every result also reports CPU core-seconds per move, GPU milliseconds per move
  and, where measurable, energy (`powermetrics` on the Mac, `nvidia-smi` on the PC).
- **The promotion test is against the same-tier v5.x on the same machine, at equal wall time.** It uses the usual
  rule: paired Δ lower bound > 0 and the first-place Δ upper bound ≥ 0, on 800 fresh seeds after a screen.
- **Keep GPU and multithreading apart.** Today's tiers search on one CPU thread. The first hybrid arms use **one
  search thread plus the GPU**, so any gain is the network's. Multithreaded arms (tracker item N12, never tested even
  without a network) come later and get a CPU-only control with the same thread count.
- **The benchmark score against Pentobi levels is reported alongside, with the hardware named.**

## 6. Stages and gates

The stages use different hardware from the v5.4 rollout work: the GPU, and the PC. So H0–H2 can run in parallel with
v5.4 and give a v5.5 decision.

| Stage | What | Where | Rough size | Gate to go on |
|---|---|---|---|---|
| **H0** | Plumbing: export `resnet2-b8w96-g36k` to ONNX; `Evaluator` trait with `ort` (CUDA on the PC, CoreML and CPU on the Mac); throughput and latency for batches of 1–512; parity with PyTorch | Mac + PC | 2–4 days of work, minutes of runs | Outputs match PyTorch to 1e-3; engine with evaluator "none" is byte-identical; a measured cost curve (µs per position by batch size, both machines) |
| **H1** | Data and network v3 | PC (GPU training, CPU self-play) | 1–2 weeks wall | See below |
| **H2** | Network prior inside the v5 tree, synchronous, 1 search thread | Mac and PC | screen 300 seeds per tier, about the cost of a pro screen | Screen at turbo and pro vs `v5.3-turbo` / `v5.3-pro` at equal wall time, then confirmation on 800 fresh seeds |
| **H3** | Asynchronous batching and the value channel; then multithreading | PC first | one screen per knob | T, λ (or n_v) and thread count screened against H2's winner; multithreaded arms against a CPU-only control with the same threads |
| **H4** | Self-improvement: expert iteration with the hybrid search as expert, Gumbel root sampling, no per-generation gate, checkpoints scored against fixed anchors afterwards | PC | days per generation set | Only if H2 or H3 has a confirmed gain |
| **H5** | Browser: `onnxruntime-web` (WebGPU, WebAssembly fallback) in the app's worker; tiers re-timed for the browser; the app offers the hybrid only where it is faster than the CPU tier it replaces | Mac (Chrome, Safari) | about a week of work | Same decisions as native in synchronous mode (up to float tolerance); measured ms per move per tier |
| **H5b** | Equal-strength mixes per tier (section 4b): Light, Balanced and Heavy configs, each tested for non-inferiority against CPU-only; the Auto calibration in the engine and the app | PC (matches), Mac + PC (timing) | about one confirmation per mix per tier | Non-inferiority (lower bound above the agreed margin, 800 fresh seeds); Auto picks the measured-fastest mix on both machines |
| **H6** | v5.5 decision | — | — | Paul's call, using the rule below |

**H1 in detail:**
- **Record format v3.** Every legal move's visit count, plus root values for all four seats.
- **Self-play.** About 20k games from `v5.3-turbo` on the PC's CPU cores. The rate will be measured first; today's
  36k games come from the old v4 engine.
- **Pentobi data.** L7 and L8 decisions from bridge games, as N11 did. These are games played by running its binary;
  nothing is taken from its source.
- **Training.** Network v3 trained on the 4080.
- **Offline gates:**
  - on own moves 3–8, L7's move is in the network's top 40 clearly more often than the 42–45% today;
  - the network beats the v5.3 fitted prior on held-out log-likelihood of L7 moves;
  - the margin R² increment over the search value is at least E5's.

**Decision rule for v5.5 (proposal):**
- **Stronger at equal wall time.** If the hybrid beats a tier's v5.x at equal wall time on the reference machine, by
  the confirmation rule, it is a candidate for that tier's next version.
- **Equal strength.** A tier gets the GPU setting (section 4b) once at least one GPU mix passes non-inferiority. CPU-only
  always stays available.
- **Stays experimental** if no mix passes at any tier.
- **Nano and lite** may differ: one GPU round trip is a large share of 1.7–2.5 ms. There, a network-only move (one
  forward pass, or a few Gumbel simulations; tracker N9) is the arm to try.

## 7. Back-of-envelope cost

These are estimates only; H0 replaces them with measurements.

**Training throughput.** The 4080 trains `b8w96` at about 19k positions/s, forward and backward at batch 512.
Inference in fp16 should be several times that. The Mac's GPU is much slower.

**Pro (≈ 1 s per move, about 45k iterations).**
- One network call per 16 iterations is about 2,800 positions per move. On the 4080 that is a few tens of
  milliseconds of GPU time, a small share of the move.
- On the Mac the share is larger; H0 will say how much.

**Turbo (72 ms per move, about 3.6k iterations).**
- One call per 16 iterations is about 225 positions in a handful of batches.
- Each round trip has a fixed cost, about 0.1–1 ms by GPU and runtime, so batching across games matters there.

**Ultra.** The network could also let the cap shrink trees. That would help memory, which today limits how many ultra
games fit on a machine.

## 8. Risks

| Risk | What we do about it |
|---|---|
| GPU round trips cost more than the search time they save at small budgets | Measure in H0; use the hybrid only from the tier where it pays; network-only arm at nano/lite |
| The network does not beat the fitted prior inside the v5 tree (the root-prior gain was measured in the old tree) | H2 is the direct test; if null, H3/H4 are not run |
| Not enough data | v5.3 self-play on the PC plus Pentobi L7/L8 decisions; keep the network small |
| Asynchronous games are not reproducible | Synchronous mode for identity tests; seeds still pair the experiments |
| Browser: WebGPU missing or slower than WebAssembly for a small network | WebAssembly fallback; the app only offers the hybrid where measured faster |
| Fairness against Pentobi (more hardware) | Promotion is against our own same-tier v5.x on the same machine; Pentobi scores are reported with the hardware named and with CPU and GPU time |

## 9. Decisions

- 2026-11-19, Paul: **the PC runs this work** (H0 on both machines, H1 onward on the PC).
- 2026-11-19, Paul: **the player chooses whether and how much to use the GPU** (section 4b). This adds stage H5b, the
  equal-strength mixes and the Auto calibration, before the v5.5 decision.
- Open: the name for the line (a placeholder is fine until H2).

## Sources

- Silver et al. 2016, *Mastering the game of Go with deep neural networks and tree search*:
  https://www.cs.princeton.edu/courses/archive/spring16/cos598F/Google-go-nature16.pdf
- Liu et al. 2020, *Watch the Unobserved: a simple approach to parallelizing MCTS*: https://arxiv.org/abs/1810.11755
- Danihelka et al. 2022, *Policy improvement by planning with Gumbel*:
  https://mlanthology.org/iclr/2022/danihelka2022iclr-policy
- Petosa and Balch 2019, *Multiplayer AlphaZero*: https://arxiv.org/abs/1910.13012
- KataGo paper: https://arxiv.org/abs/1902.10565; thread and batch figures from
  https://www.lifein19x19.com/viewtopic.php?p=254875 (forum, indicative)
- AlphaBlokus: https://github.com/HenryTBCassidy/AlphaBlokus
- Ruoss et al. 2024, *Grandmaster-level chess without search*: https://arxiv.org/abs/2402.04494
- ONNX Runtime Web, WebGPU: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html and
  https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html
- `ort` crate: https://docs.rs/crate/ort/latest
- Burn: https://github.com/burn-rs/burn
- Our own results: `research_paper/v6_native_and_learning_results.md` (E3a–E6), `docs/V5_TRACKER.md` (D1, N1, N2,
  N9, N11, N12, N19, V6-A to V6-C), `research_paper/v5_high_budget_results.md`.
