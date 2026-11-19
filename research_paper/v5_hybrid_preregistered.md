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
