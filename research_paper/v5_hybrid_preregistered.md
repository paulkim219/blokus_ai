# Hybrid line: preregistered gates

Each stage of `research_paper/v5_hybrid_cpu_gpu_plan.md` gets its gates written here before it is measured.
Results go in `research_paper/v5_hybrid_results.md`.

## H0: plumbing and measurement (written 2026-11-19, before any H0 measurement)

Branch `hybrid-h0`, from `v5-high-budget` at `5b57f48`. Built and run on the PC (WSL2 Ubuntu, Ryzen 7 9700X,
RTX 4080). No games against Pentobi and no strength claims in H0.

**Network.** `ml/torch/results/resnet2-b8w96-g36k-s0.pt` (E5's selected network; sha256 `31f1b371…`, the same
file on the Mac and the PC).

**Test records.** Every record of the test games of `ml/data/selfplay-v41u-300` (games 19,000–19,999, the
test split `train.py` used), read as `serve.py` reads them.

### Gates

| # | Gate | Pass |
|---|---|---|
| G1 | ONNX export, fp32, all protocol-2 outputs (64 logits by candidate slot, 0 on padding; 12 utilities) | Max abs difference ≤ 1e-3 against PyTorch fp32 on the CPU (no TF32), on logits and on utilities separately, on every test record. Checked with ONNX Runtime's CPU provider and its CUDA provider with TF32 off (fp32 means fp32). The CUDA provider with TF32 on (its default) is reported, not gated. |
| G1h | Same, fp16 export | Reported, not gated (max and 99.9th percentile abs difference, top-1 agreement) |
| G2 | Rust feature encoding against `ml/torch/features.py` | All six model inputs (planes, hands, footprints, piece ids, mask, seat) equal, element for element, on every test record (at least a few thousand). Tolerance: none (the inputs are 0/1 floats and integers). |
| G3a | Identity, parity tests | `cargo test --release` passes, in the default build and in the build with the `ort` feature |
| G3b | Identity, mirror | A mirror match prints 0.00 [−0.00, 0.00] with the new binary (default build and `ort` build) |
| G3c | Identity, against the parent commit | With no new config keys, the new binaries (default and `ort`) produce byte-identical `blokee-selfplay` output (shard and `games.jsonl`) and identical `blokee-match` games (every seat's score by seed) to binaries built from `5b57f48`, on fixed seeds, one thread; and `examples/s4_identity` dumps are byte-identical on recorded positions |
| G3d | End to end, socket against in-process | A `native.net` root-prior config run once through `serve.py --protocol 2` and once through the in-process evaluator on the same positions: per-position outputs within 1e-3 when both run exact fp32 (server on the CPU, `ort` CPU provider). The CUDA pair (server under its defaults, `ort` CUDA) is reported, not gated, because PyTorch's default cuDNN convolutions use TF32. Whether whole games stay identical is reported as a fact. |
| G4 | Cost curve | Measured, no pass mark: µs per position and positions per second at batch 1, 2, 4, …, 512; fp32 and fp16; `ort` CUDA, `ort` CPU (threads stated) and the `serve.py` socket; network only, and end to end from Rust positions (encoding and host-device copies included). Also first-call warm-up and GPU memory. |

### Rules

- **What H0 passes.** G1, G2, G3a–G3d pass and G4 is measured. If a gate fails, the report says so and why;
  no gate is relaxed after the measurement.
- **Timing.** The PC runs nothing else heavy during G4 (checked with `ps` and `nvidia-smi` before and after).
  Each batch size runs a warm-up, then repeats for at least 1 s or 50 calls, whichever is longer; the median
  call time is reported, with the 10th and 90th percentiles.
- **Determinism.** H0 has no asynchronous search; every network call is synchronous.
- **Evaluator off.** With no `native.net.evaluator` key (or no `native.net` block), the engine takes exactly
  the code paths it took before.

## H1: data, network v3 and the engine interface (written 2026-11-19, before training and before any gate is read)

Branch `hybrid-h1`, from `hybrid-h0` at `ed144ea`. Everything runs on the PC (WSL2 Ubuntu, Ryzen 7 9700X
8 cores / 16 threads, RTX 4080, 15 GB for WSL). No games against Pentobi are scored and no strength is
claimed in H1; the Pentobi games below are data.

**What was done before this was written.** Record format v3, the Pentobi self-play mode, the network-v3
code, the training, gate and parity scripts and the engine's v3 evaluator were written and smoke-tested;
the pilot ran (below) and the main data collection started at 15:20 with the sizes and seeds below.
Smoke runs (a 400-step network on the pilot data) were used only to debug: training read train and
validation games, the gate script was dry-run on the **validation** split, and the parity script read
pilot records (a numerical check, not a quality metric). No test-split metric of any network was
computed.

### Data

**Record format v3** (`engine-rs/src/record_v3.rs`; `blokee-selfplay --format v3`): per decision, the
position (bitboards, hands, last pieces), the mover, **every legal move** with its **real** root visits
and root prior, the root's mean backed-up value for all four seats, the root's real visit count, the
iterations and the game's final scores. `initVisits` / `interiorInitVisits` are virtual: they enter
selection's Q only and are never added to `child_visits` or a node's visits (`V12Search::select`,
`backup`), so the stored visits need no correction; they sum to the root's visits, which the reader
checks. Pentobi decisions are the same format with visits 1 on the move played (source 4, `teacher` =
level), converted from `blokee-pentobi --moves-out` by `examples/h1_moves_v3.rs`.

**Pilot** (`engine-rs/scripts/h1-pilot.sh`, binaries `8379697` pinned in `tmp/h1/bin-data`; 15:02–15:19):

| Source | Games | Parallel | Wall | Rate | Peak memory (system) |
|---|---:|---:|---:|---:|---:|
| `v5.3-turbo` self-play | 160 | 16 threads | 193 s | ≈ 2,990 games/h | 3.3 GB |
| `v5.3-pro` self-play, lazy layout | 32 | 16 threads | 414 s | ≈ 280 games/h | 6.0 GB |
| Pentobi level 7, all four seats, one process per game | 32 | 16 games | 153 s | ≈ 750 games/h | 4.9 GB |
| Pentobi level 8, the same | 14 | 14 games | 261 s | ≈ 190 games/h | 9.8 GB |

The pro config is `v5.3-pro.json` from `v6-native-engine-e4` (sha256 `81b25794…`, byte-identical to the
Mac's `tmp/v57/pro/configs/W1D-ET.json`) with `interiorCap.lazy` true (`8ce4228c…`); eager and lazy
wrote byte-identical v3 shards on 2 games. `v5.3-turbo.json` is `924fcaf1…`. Pentobi 31.0, opening
book `book_classic.blksgf` on, one thread, seeded with the game seed.

**Corpus** (`engine-rs/scripts/h1-data.sh`, same pinned binaries; projected ≈ 31 h in total, under the 48 h
limit, so no hand-back):

| Source | Seeds | Games | Projected |
|---|---|---:|---:|
| `v5.3-turbo` self-play, budget 300, first 8 plies from the top 3 (`blokee-selfplay` defaults) | 105,100,000–105,122,159 (pilot 105,100,000–159) | 22,160 | 7.4 h |
| Pentobi level 7 self-play | 105,300,000–105,306,031 (pilot –031) | 6,032 | 8.0 h |
| `v5.3-pro` self-play (lazy), budget 300, as turbo | 105,200,000–105,202,431 (pilot –031) | 2,432 | 8.6 h |
| Pentobi level 8 self-play | 105,400,000–105,401,513 (pilot –013) | 1,514 | 7.9 h |

Pilot games are part of the corpus (same binaries, configs and seed blocks). If a run fails or must be
cut, the report says so; games already written are kept.

**Old corpus (arm B only).** `~/Blokee/ml/data/selfplay-v41u-300` and `expert-iteration/gen-0`…`gen-7`
(36,000 games, v2 records, read only): positions with value, utility and ownership targets; no policy.

**Splits, by game seed, for every corpus:** last digit 9 → test, 8 → validation, else training. The old
corpus is training only. Test games are read by `ml/torch/h1_gates.py` only, once, on the selected
network.

### Network v3 and training

- **Architecture** `resnet3-b8w96` (`ml/torch/model.py`, `ResNet3`, 1,665,900 parameters): E5's `b8w96`
  trunk (13 planes in the mover's frame, four relative hands, the absolute seat); value MLP as E5
  (margins, 4 × 3 utilities, search value); ownership as a 1×1 convolution; **two policy heads over all
  placements**, each a (91, 20, 20) map: 91 piece-orientations × the top-left corner of the placement's
  bounding box in the mover's frame (`ml/torch/policy_index.py`; 30,433 of the 36,400 slots are
  placements). Head 0 (`policy`) trains on the v5.3 searches' root visits, head 1 (`teacher`) on
  Pentobi's moves (levels 7 and 8 pooled).
- **Losses** (`ml/torch/train_v3.py`): policy heads: cross-entropy over the **legal moves only** (log-softmax
  over the legal mask, recomputed on the GPU from the board and checked equal to the engine's legal
  sets), on search records (head 0) or teacher records (head 1) with at least 2 legal moves; margins
  MSE (units of 20 squares); utility margin and rank BCE, first cross-entropy; search value 2 × Huber
  (δ 0.5) on the mover's root value (reward units); ownership cross-entropy. Weights: policy 1, teacher
  1, margins 1, margin 0.5, rank 0.5, first 0.25, search 2, ownership 0.25. Each head's loss is the mean
  over the rows that carry its target.
- **Training:** AdamW, lr 1e-3, cosine with 500 warm-up steps, weight decay 0.01, batch 512, gradient
  clip 1, EMA 0.999 (evaluated and saved), fp32 (PyTorch's default TF32 convolutions), seed 0,
  **30,000 steps**, validation every 1,000 steps.
- **Validation set:** every record of the validation games of the new corpora, pooled and subsampled
  uniformly to 40,000 records (seed 0). Validation loss = the training loss's weighted sum of per-head
  means on it.
- **Arms:** **A**, the four new corpora, batches drawn uniformly over their training records; **B**, the
  same with 25% of every batch (128 records) from the old corpus (value, utility and ownership only).
- **Selection:** within an arm, the EMA checkpoint with the lowest validation loss. Between arms, B is
  selected only if its best validation loss is lower than A's by at least 0.5%; otherwise A. The
  selected network is exported with `ml/torch/onnx_export_v3.py`.

### Offline gates (test split; `ml/torch/h1_gates.py`)

| # | Gate | Pass |
|---|---|---|
| H1-G1 | Pentobi level 7's move in the network's top 40 (teacher head; legal moves; ties in expectation as N11) on held-out level-7 decisions at a seat's own moves 3–8 (3 to 8 pieces already placed), ≥ 2 legal moves | Rate ≥ 0.55 and its 95% bootstrap lower bound (resampling games) > 0.45, the upper end of D1's 42–45% |
| H1-G1b | The same rate against v5.3's fitted prior (`ml/v5-prior-weights.json`, the bands every v5.3 config carries; N11's tooling) on the same decisions | Paired difference network − prior: 95% bootstrap lower bound > 0 |
| H1-G2 | Mean log-likelihood of level 7's move per decision, own moves 3+, network (teacher head, temperature 1, softmax over the legal moves) against the fitted prior (temperature 1, as N11 scores it) on the same decisions | Paired difference: 95% bootstrap lower bound > 0 |
| H1-G3 | On held-out `v5.3-turbo` self-play games, searched records with ≥ 2 legal moves: R² increment of the network's mover margin head over the search's root value (the root's mean value for the mover) for the mover's final `score − mean(others)`, linear with intercept, as `ml/torch/fuel.py` | Point estimate ≥ +0.061 (E5's margin-head increment); 95% interval by game (300 resamples) reported |

- Bootstrap: 2,000 resamples of whole games (seeds), seed 0, for G1, G1b and G2.
- **G1 versus G1b.** D1's 42–45% is the rate of the v4.2 engine's 40-move ordering shortlist. N11 measured
  v5.3's fitted prior at 0.804 top-40 on held-out level-7 moves 3–8 (in Blokee-vs-Pentobi games), so G1
  as written is a low bar; G1b, against the prior the network would replace, is the informative one.
  Both are reported.
- Reported, not gated: the same tables by band (0–2, 3–8, 9–14, 15+, 3+); the visits head (head 0) on
  G1/G2; G3 on the `v5.3-pro` test games; validation curves of both arms.

### Engine interface (built and parity-tested only; no matches)

| # | Gate | Pass |
|---|---|---|
| H1-E1 | Network-v3 ONNX export (fp32) against PyTorch fp32 on the CPU (no TF32), 20,000 records in file order of a v3 run (`ml/torch/h1_parity.py`): ONNX Runtime CPU and CUDA (TF32 off), all 36,400 logits of both heads and the 12 utilities; the engine's path (`examples/h1_v3_eval.rs`: Rust encoder, `net_v3.rs` table, ONNX Runtime from Rust, CPU and CUDA with TF32 off) on every legal move's logits and the utilities | Max abs difference ≤ 1e-3 in each; the engine's policy table equals `policy_index.py` element for element; `evaluate_moves` equals the raw session outputs bit for bit; the training-time board encoder equals `features.Encoder.board` exactly. fp16 and TF32 reported |
| H1-E2 | Identity with the network off (`engine-rs/scripts/h1-identity.sh` against the parent build `~/Blokee-h0-base`) | H0's whole G3 suite passes again (self-play shards and `games.jsonl` byte-identical for `v4.2-ultra` and `v5.3-turbo`, `blokee-match` games identical, `s4_identity` dumps identical, mirrors 0.00); `--format v2` spelled out is byte-identical; `--format v3` plays the same games; `blokee-pentobi` one-blokee at level 1 plays identical games; `cargo test --release` passes in the default and `ort` builds |
| H1-E3 | Network on at weight 0: the selected network at `rootBlend` 0 inside `v5.3-turbo` (ort build, CUDA) | Plays exactly `v5.3-turbo`'s games (4 seeds × 4 rotations, every field but timing and names) |

**Config changes** (no behaviour change without `native.net`): `native.reward` "rank" is allowed with
`native.net` (the value channel then uses the rank head, clamped to the rank reward's range); a v3
network may run with `native.candidates`, and without `valueVisits` with `native.rave` and
`native.selection`; `valueVisits` is refused with `initVisits`; `interiorVisits` (interior prior, v3 only)
is new. `engine-rs/README.md`, "Network v3".

### Rules

- What H1 passes is reported gate by gate; a failed gate is reported with its numbers, nulls as nulls,
  and no gate is changed after it is read.
- If the corpus has to be cut (time or a failure), training uses what was collected and the report says so.
