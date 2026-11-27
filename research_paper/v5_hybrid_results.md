# Hybrid line: results

Plan: `research_paper/v5_hybrid_cpu_gpu_plan.md`. Gates: `research_paper/v5_hybrid_preregistered.md`.

## H0: plumbing and measurement (2026-11-19)

**Verdict.** G1, G2 and G3a–G3d pass; G4 is measured. No games against Pentobi, no strength claims.

### Setup

- **Branch.** `hybrid-h0`, from `v5-high-budget` at `5b57f48`. Gates committed before any measurement
  (`67748488`, amended for TF32 in `ac379041`, also before any measurement).
- **Machine.** The PC: WSL2 Ubuntu, Ryzen 7 9700X (8 cores, 16 threads), RTX 4080 16 GB (driver 610.88,
  CUDA UMD 13.3). Windows is set never to sleep or hibernate on AC power (`powercfg`, read only), so long runs
  are safe. The Mac was not used for builds or runs.
- **Software.** Rust 1.99.1. `ort` `=2.0.0-rc.15` (features `std`, `load-dynamic`, `cuda`, `api-31`) behind the
  engine's cargo feature `ort`, off by default. ONNX Runtime 1.31.1 from the `onnxruntime-gpu==1.31.1` wheel
  (its CUDA 13 build), loaded at run time; CUDA 13.0 and cuDNN 9.24.0.43 from the `torch==2.14.1+cu130` wheels.
  Python side: `ml/.venv-hybrid` (separate from `ml/.venv-torch`) with torch 2.14.1+cu130, numpy 2.5.4,
  onnx 1.23.2, onnxruntime-gpu 1.31.1, onnxscript 0.7.2 (installed, not used).
- **Network.** `ml/torch/results/resnet2-b8w96-g36k-s0.pt` (sha256 `31f1b371…`, identical on the Mac and the PC).
  Exported by `ml/torch/onnx_export.py` with opset 17 through PyTorch's TorchScript exporter (`dynamo=False`;
  PyTorch warns that it is deprecated, and it works in 2.14.1). Inputs are the encoder's six tensors, outputs are
  protocol 2's 64 logits (0 on padding) and 12 utilities. fp32 file 6,340,146 bytes (`a94ecfd3…`), fp16 file
  3,196,632 bytes (`7a85d458…`; half-precision network, float32 inputs and outputs). The ONNX files are under
  `ml/data/onnx/` (ignored by git; regenerate with the exporter).
- **Test records.** All 72,630 records of games 19,000–19,999 of `ml/data/selfplay-v41u-300` (70,990 with at
  least two candidates; movers 18,183 / 18,334 / 18,257 / 17,856 by seat).

### What was built

| File | What |
|---|---|
| `ml/torch/onnx_export.py` | Checkpoint → `<out>.fp32.onnx`, `<out>.fp16.onnx` and a manifest |
| `engine-rs/src/net_features.rs` | Rust port of `features.py`: board planes, hands, footprints, pieces, mask, seat from the 512-byte request record. Bitboard version (`push_record`) and the cell-by-cell transcription it is tested against (`push_record_reference`) |
| `engine-rs/src/evaluator.rs` | `Evaluator` trait. Socket implementation (`NetClient`, unchanged code) and `ort` implementation (devices `cuda`, `cpu`, and `coreml` behind the feature `ort-coreml`, written and type-checked on Linux, not built or measured on the Mac). Engines in one process with the same options share one session |
| `native.net.evaluator` | Config key (`net.rs`, `search.rs`, `config.rs`). Absent: the socket path as before. Present: the E6 call (root prior, and child records if a child channel is on) runs in-process. A default build refuses such a config at engine creation |
| `engine-rs/examples/h0_encode.rs`, `h0_e2e.rs`, `h0_bench.rs` | Encoder dump (G2), socket-against-in-process comparison (G3d), cost curve (G4) |
| `engine-rs/tests/h0_features.rs` | Bitboard encoder equals the reference on every position of 40 random games, from all four points of view (over 10,000 encodings; the test asserts that floor) |
| `engine-rs/scripts/h0-identity.sh`, `h0-e2e.sh`, `h0-divergence.sh`, `h0-bench.sh`, `h0-env.sh`, `h0_bench_report.py` | The runs below |
| `ml/torch/onnx_parity.py`, `h0_encoding_parity.py`, `h0_profile.py` | G1, G2, and the exploratory profile |

### G1: ONNX against PyTorch (pass)

Reference: the checkpoint in PyTorch, fp32 on the CPU, through `serve.py`'s own `Batcher.infer`. All 72,630 test
records; logits include padding slots; top-1 over records with at least two candidates.

| Run | Logits max abs | Logits p99.9 | Utilities max abs | Utilities p99.9 | Top-1 agreement |
|---|---|---|---|---|---|
| **ONNX fp32, ORT CPU** (gated) | **4.3e-6** | 2.4e-6 | **1.4e-6** | 7.5e-7 | 100% |
| **ONNX fp32, ORT CUDA, TF32 off** (gated) | **4.8e-6** | 2.4e-6 | **1.8e-6** | 8.3e-7 | 100% |
| ONNX fp32, ORT CUDA, TF32 on (ORT's default) | 5.8e-3 | 2.8e-3 | 2.3e-3 | 9.7e-4 | 99.95% |
| ONNX fp16, ORT CUDA | 1.0e-2 | 5.2e-3 | 3.5e-3 | 1.7e-3 | 99.72% |
| ONNX fp16, ORT CPU | 7.6e-3 | 3.5e-3 | 2.1e-3 | 1.1e-3 | 99.92% |
| PyTorch fp32 on CUDA as `serve.py` runs it (cuDNN TF32 on) | 2.5e-3 | 1.3e-3 | 9.6e-4 | 5.1e-4 | 99.97% |

- **Gate.** Both gated rows are about 200 times inside 1e-3. No padding slot is non-zero in any run.
- **TF32.** ORT's CUDA provider turns TF32 on by default; the evaluator turns it off unless a config asks
  (`tf32: true`). Today's socket server is itself TF32 (PyTorch's default for cuDNN convolutions), at 2.5e-3.
- **fp16.** About 1e-2 on logits at worst, and the top move changes on 0.3% of positions.

### G2: Rust encoding against Python (pass)

`ml/torch/h0_encoding_parity.py` encodes the 72,630 test records with `features.Encoder` (CPU) and with
`examples/h0_encode`, and compares the raw bytes of all six inputs.

| Input | Elements compared | Mismatches |
|---|---|---|
| planes (13×20×20 f32) | 377,676,000 | 0 |
| hands (4×21 f32) | 6,100,920 | 0 |
| footprint (64×5 i64) | 23,241,600 | 0 |
| pieces (64 i64) | 4,648,320 | 0 |
| mask (64 bool) | 4,648,320 | 0 |
| seat (i64) | 72,630 | 0 |

Encoding cost: 1.92 µs per record on one core (best of 5 passes over the 72,630 records). The first,
cell-by-cell version also matched exactly but cost 17.7 µs (measured while other jobs loaded the CPU); it is kept as
the test reference.

### G3: identity (pass)

Three binaries: **base** (`5b57f48`, the parent), **new** (this branch, default features) and **ort** (this
branch, `--features ort`), all built on the PC from commit `0cbd55a` for new and ort. Log:
`research_paper/hybrid_h0_runs/identity-log.txt`.

- **G3a, tests.** `cargo test --release`: base 36 passed, new 37 passed, ort 37 passed, 0 failed in each (the
  extra test is `h0_features`). The 8 parity tests pass in all three on the PC.
- **G3c, against the parent (one thread).**
  - `blokee-selfplay`, 4 games from 80,950,000, `v4.2-ultra` and `v5.3-turbo`: `shard-00.bin` and
    `games.jsonl` byte-identical between base, new and ort (sha256 `4a24f908…` / `6210cc1a…` for v4.2-ultra,
    `44f24a92…` / `a4d94228…` for v5.3-turbo).
  - `blokee-match`, `v5.3-turbo` against `v5.2-turbo`, 2 seeds from 80,900,000 (8 games): every line identical
    except `challengerSeconds`.
  - `examples/s4_identity`, 180 positions of `x1-l6a.moves.jsonl` × the eight v5.2/v5.3 tier configs (1,440
    lines, complete root results with the exact bits of every value): byte-identical (`54dbaa2a…`).
- **G3b, mirrors** (new and ort binaries alike):

  ```
  v5.3-turbo vs v5.3-turbo — 80 games over 20 seeds
  Advantage (score − mean of the three v5.3-turbo seats): -0.00 [95% CI -0.00, 0.00] → not significant
  v4.2-ultra vs v4.2-ultra — 16 games over 4 seeds
  Advantage (score − mean of the three v4.2-ultra seats): 0.00 [95% CI 0.00, 0.00] → not significant
  ```

- **G3d, socket against in-process.** Config: `v4.2-ultra` plus E6's root prior (`rootBlend` 0.5,
  temperature 1, no child channels), once with `socket`, once with `evaluator`. Positions: 2,000 test records with
  at least two candidates, decoded into engine `Position`s and re-encoded with `encode_request`, sent in calls
  of 1 (E6's root call) and of 41.

  | Pair | Batch | Logits max abs | Utilities max abs | Root prior max abs | Top-1 |
  |---|---|---|---|---|---|
  | **socket (server on CPU) vs ort CPU** (gated) | 1 | **3.8e-6** | **1.5e-6** | 8.3e-7 | 100% |
  | **socket (server on CPU) vs ort CPU** (gated) | 41 | **3.8e-6** | **1.1e-6** | 7.7e-7 | 100% |
  | socket (server on CUDA, defaults) vs ort CUDA | 1 | 2.0e-3 | 8.6e-4 | 3.9e-4 | 99.95% |
  | socket (server on CUDA, defaults) vs ort CUDA | 41 | 2.0e-3 | 6.9e-4 | 3.4e-4 | 99.95% |
  | socket (server on CUDA, defaults) vs ort CUDA, TF32 on | 1 | 4.0e-3 | 1.1e-3 | 4.8e-4 | 100% |
  | socket (server on CUDA, defaults) vs ort CUDA, TF32 on | 41 | 4.3e-3 | 1.6e-3 | 7.4e-4 | 100% |

  **Whole games** (4 seeds × 4 seats against `v4.2-ultra`, budget 300, one thread):
  - They are not identical across paths: socket (CPU server) vs ort CPU, 8 of 16 games differ; ort CPU vs ort
    CUDA, 8 of 16; socket (CUDA server) vs ort CUDA, 16 of 16.
  - Each path is deterministic: ort CPU, ort CUDA and the socket with the CPU server each replay their own 16
    games exactly.
  - Where the paths part (self-play, 2 games, socket with the CPU server against ort CPU):
    - The first 26 and 19 decisions are identical, visit for visit.
    - At the first differing decision both paths choose the same move, but the root visits differ and so
      does the iteration count (4,800 against 4,608 and 3,456 against 3,392). `v4.2-ultra` stops its search
      early by a visit-margin rule.
    - So a root-prior difference of under 1e-6 flips a near-tied selection step, and the game drifts from
      there.
  - Game identity between two numerically different backends is therefore not achievable at this precision.
    Synchronous mode with one backend is reproducible.
  - **Sharing a session.** Four match threads sharing one ort CUDA session played their 16 games without error.
  - **Engine cost per move in these games** (one thread, `v4.2-ultra` at budget 300, one network call per
    searched move): socket with the CPU server 65.5 ms, ort CPU 77.7 ms, socket with the CUDA server 63.8 ms,
    ort CUDA 58.6 ms. Wall time, all decisions.

### G4: cost curve (measured)

`engine-rs/scripts/h0-bench.sh`, 12:00–12:19 on the PC. Nothing else ran: load average under 1 at the CPU
configurations, GPU idle at 1,124–1,141 MiB (the Windows desktop) between configurations. Each configuration
is a fresh process. Each (mode, batch) makes one cold call, then 3 warm-up calls, then at least 50 calls and at
least 1 s; the medians are below. Positions are 4,096 test records with at least two candidates, decoded into
engine `Position`s.

- `device` mode times the network alone: inputs on the GPU, outputs left there.
- `host` adds the host-to-device copies.
- `e2e` adds `encode_request` and the Rust encoder, starting from `Position`s: the in-process evaluator's own
  path.
- For the socket, `e2e` is the engine's client path; the server encodes in Python.

Full tables, with 10th–90th percentiles and every mode: `research_paper/hybrid_h0_runs/bench-report.md`. Raw
rows: `bench-rows.csv`.

**End to end, median ms per call / positions per second** (synchronous, one calling thread):

| Batch | ort CUDA fp32 | ort CUDA fp16 | ort CUDA fp32 TF32 | ort CPU 8 thr | ort CPU 16 thr | ort CPU 1 thr | socket (serve.py, CUDA, wait 2 ms) | socket, wait 0 |
|---|---|---|---|---|---|---|---|---|
| 1 | 1.22 / 821 | 1.49 / 670 | 1.42 / 706 | 1.56 / 640 | 1.49 / 670 | 3.98 / 251 | 5.11 / 196 | 2.50 / 399 |
| 2 | 1.27 / 1,574 | 1.53 / 1,307 | 1.41 / 1,423 | 2.90 / 690 | 2.63 / 760 | 7.98 / 251 | 4.94 / 405 | 2.61 / 767 |
| 4 | 1.25 / 3,209 | 1.58 / 2,538 | 1.51 / 2,651 | 5.11 / 784 | 4.08 / 980 | 15.8 / 254 | 5.00 / 800 | 2.65 / 1,507 |
| 8 | 1.42 / 5,652 | 1.66 / 4,830 | 1.54 / 5,208 | 9.75 / 820 | 7.40 / 1,082 | 31.6 / 253 | 5.11 / 1,567 | 2.63 / 3,037 |
| 16 | 1.88 / 8,501 | 1.84 / 8,676 | 2.27 / 7,056 | 19.0 / 844 | 13.7 / 1,168 | 63.0 / 254 | 5.97 / 2,680 | 2.85 / 5,620 |
| 32 | 2.50 / 12,781 | 2.50 / 12,819 | 3.15 / 10,159 | 37.0 / 865 | 26.9 / 1,192 | 126 / 254 | 7.49 / 4,272 | 4.37 / 7,319 |
| 64 | 4.22 / 15,160 | 3.90 / 16,428 | 4.36 / 14,685 | 76.1 / 841 | 58.6 / 1,092 | 265 / 242 | 8.24 / 7,763 | 5.02 / 12,758 |
| 128 | 8.40 / 15,232 | 7.45 / 17,184 | 7.99 / 16,016 | 182 / 703 | 148 / 865 | 573 / 223 | 10.7 / 11,910 | 8.65 / 14,791 |
| 256 | 20.4 / 12,551 | 16.1 / 15,927 | 17.6 / 14,542 | 434 / 590 | 368 / 695 | 1,190 / 215 | 20.2 / 12,647 | 17.9 / 14,290 |
| 512 | 46.1 / 11,109 | 38.3 / 13,361 | 43.4 / 11,796 | 953 / 537 | 868 / 590 | 2,524 / 203 | 41.9 / 12,233 | 40.6 / 12,612 |

**Reading.**
- **Fixed cost on CUDA.** A call costs about 1.2 ms (fp32) to 1.5 ms (fp16) whatever the batch up to 8, and the
  `device` mode is the same at those batches (fp32 batch 1: 1.23 ms). So the fixed cost is the network's own
  launch and synchronisation, not copies or encoding. That is about 60 rollout iterations (at 20 µs each) per
  synchronous call.
- **Best rate.** Batch 64–128 gives 55–66 µs per position (15–18k positions/s), and larger batches are slower
  per position on this machine. That is about 3 rollout iterations of GPU time per position.
- **Copies and encoding.** They add 1–5% end to end. At batch 512 fp32: `device` 44.1 ms, `host` 45.0 ms
  (copies +0.9 ms), `e2e` 46.1 ms (encoding +1.1 ms, about 2 µs per position). The encoder alone is 1.9 µs per
  record (G2).
- **fp16 and TF32.** fp16 is slower than fp32 below batch 16 and 8–21% faster from batch 64 up. TF32 is no
  faster than strict fp32 below batch 64.
- **CPU provider.** 640–1,190 positions/s with 8–16 threads, 1.5–1.6 ms for a batch-1 call and
  4.0 ms on one thread. That is a single root call at the slower tiers at most, and it competes with the search
  for cores.
- **Socket.** The in-process CUDA path is 4.2× faster than today's socket at batch 1 (5.11 ms, mostly
  `serve.py`'s 2 ms batching wait) and 2.0× faster than the socket with the wait at 0 (2.50 ms). At batch 128
  and above the two converge, because the network dominates.

**Warm-up.**
- **Process setup.** Library load plus session creation: ort CUDA 233–304 ms (304 ms for the first process
  after idle, which includes CUDA initialisation); ort CPU 33–59 ms.
- **First call on CUDA.** The first call at batch 1 takes 194–358 ms (fp32 226, TF32 194, fp16 358). Each later
  new batch shape costs 13–36 ms once (fp16 batch 64: 91 ms; batch 512: 40–51 ms), which is cuDNN's
  algorithm search per input shape.
- **CPU provider.** The first call costs about the same as a normal one.
- **Implication.** A search that calls the network with many different batch sizes pays this once per shape
  and per process. Padding to a few fixed sizes avoids it.

**GPU memory** (nvidia-smi totals sampled every 100 ms; WSL2 gives no per-process figures):

| Process | Peak above idle |
|---|---|
| ort CUDA fp32 (batches up to 512) | +770 MiB |
| ort CUDA fp32, TF32 on | +772 MiB |
| ort CUDA fp16 | +1,288 MiB |
| socket server (CUDA), wait 2 ms | +996 MiB |
| socket server (CUDA), wait 0 | +1,686 MiB |

Idle is 1,124–1,141 MiB (the desktop), and the server's CUDA context alone is about 322 MiB. ONNX Runtime's
arena grows in powers of two and keeps its peak.

### Exploratory: where the GPU time goes (not a gate)

`ml/torch/h0_profile.py` (`hybrid_h0_runs/profile.json`), GPU-resident inputs, median of 50 calls, ms per call:

| Runtime | b1 | b16 | b64 | b128 | b256 |
|---|---|---|---|---|---|
| ORT fp32 (default, as in G4) | 1.26 | 1.81 | 4.17 | 7.94 | 19.4 |
| ORT fp32, CUDA graphs | **0.51** | 1.39 | 3.77 | 7.54 | 19.1 |
| ORT fp32, NHWC | 1.78 | 2.50 | 5.89 | 10.4 | 22.9 |
| ORT fp16 (default) | 1.42 | 1.73 | 3.58 | 7.05 | 15.1 |
| ORT fp16, CUDA graphs | 0.83 | 1.17 | 3.21 | 6.64 | 14.7 |
| ORT fp16, NHWC (8 memcpy nodes inserted) | 1.68 | 4.35 | 10.5 | 18.0 | 35.6 |
| PyTorch fp32, TF32 convolutions (serve.py) | 1.52 | 1.81 | 3.35 | 6.31 | 15.0 |
| PyTorch fp32 strict | 1.66 | 1.50 | 3.12 | 6.61 | 17.1 |
| **PyTorch fp16** | 1.76 | 1.86 | 2.74 | **3.82** | **7.21** |

- **Placement.** ONNX Runtime places 152 (fp32) or 156 (fp16) nodes on CUDA and 16 shape nodes on the CPU.
- **CUDA graphs** cut the fixed cost by 60% at batch 1 (0.51 ms). ONNX Runtime warns that the CPU shape nodes
  make graph capture safe only when shapes repeat. The graph outputs were not checked against G1 here.
- **fp16.** PyTorch fp16 runs this network at 35.5k positions/s at batch 256, twice ORT fp16's rate. So ORT's
  fp16 path leaves about 2× on the table at large batches; TensorRT or a re-export are the candidates.
- **Rate is a property of the network.** PyTorch fp32 is no faster than ORT fp32. E5's recorded forward rate
  for this network was 19.2k positions/s at batch 512.

### Deviations

- **CoreML (Mac).** The CoreML provider is written behind `ort-coreml` and type-checks on Linux. It is not
  built or measured on the Mac (Mac memory constraint, as instructed). The plan's Mac cost curve is still open.
- **Socket fp16.** `serve.py` has no fp16 option and was not changed, so the socket path is fp32 only: null for
  fp16.
- **Exporter.** The TorchScript exporter (`dynamo=False`), deprecated in PyTorch, was used. The dynamo exporter
  was not tried.
- **Identity games.** Self-play and `blokee-match` were used, not bridge games against Pentobi. Pentobi was not
  run in H0.
- **Runs repeated.** Two runs were repeated and the first attempts discarded:
  - A first identity run used binaries built before the encoder was switched to bitboards; it is kept as
    `tmp/h0/identity-dryrun` on the PC. All results above come from binaries built at `0cbd55a`.
  - A first G3d attempt failed because `h0-env.sh` read the calling script's `$1`; it was fixed in `b8bffd7`
    and re-run.
- **Prereg amendment.** The gates were amended once, before any measurement (`ac379041`), to gate the CUDA
  provider with TF32 off.
- **Whole games across backends (G3d).** They are not identical; reported as a fact, as preregistered.

### What H1 (and H2/H3) need next

1. **Engine plumbing still missing.**
   - `native.reward` "rank", which every v5.x config uses, is refused together with `native.net`. H2 must lift
     that, with the value channel's scale handled.
   - The 64-candidate record limits the network to the first 64 moves of a root that holds every legal move.
     That is network v3's job (the plan's 91 × 400 policy head).
2. **Calls per move at the tiers** (synchronous, one search thread, ort CUDA fp32, end to end; a rollout
   iteration is about 20 µs):

   | Tier (time per move) | One batch-1 call (1.2 ms) | E6 root + 40 children (batch 41, about 3.0 ms interpolated) | Calls of 1 within 10% of the move | Batch-64 calls (4.2 ms) within 10% |
   |---|---|---|---|---|
   | nano / lite (1.7–2.5 ms) | 50–70% of the move | over 100% | none | none |
   | turbo (72 ms) | 1.7% | 4.1% | about 6 | 1–2 (128 positions) |
   | pro (about 1 s) | 0.12% | 0.3% | about 80 | about 24 (1,500 positions) |
   | ultra (about 17 s) | — | — | about 1,400 | about 400 (26k positions, one per about 33 iterations) |

3. **Recommendation from the cost curve.**
   - **Turbo.** The root, or root plus children in one call, is affordable. Per-node calls are not.
   - **Pro.** Synchronous calls are affordable for the root, the root's children and a few dozen of the busiest
     nodes.
   - **Ultra.** It is the only tier where synchronous per-node calls look affordable at scale: about 1,400
     single calls, or batches covering one position per 30–40 iterations.
   - **Nano and lite.** Even one CUDA call costs half the move, so they stay CPU-only or become network-only
     moves, as the plan says.
   - **Asynchronous (H3).** One GPU sustains about 15–18k positions/s (55–66 µs per position, about 3
     iterations), and the search thread pays only about 2 µs of encoding per position. With one search thread
     the GPU could evaluate roughly one node in every 3–4 iterations without stalling the search. That makes
     per-node priors plausible from pro upward, and possibly turbo, if calls overlap the search.
4. **Cheap speed-ups to try before H2, each with a G1-style parity check.**
   - CUDA graphs with fixed batch sizes (0.5 ms at batch 1).
   - A faster fp16 path: PyTorch shows 2× at batch 256 (TensorRT or a re-export).
   - Padding to a few fixed batch sizes, to avoid the per-shape warm-up.
5. **The Mac half of H0** (CoreML and CPU cost curve) is still to measure once the Mac is free.

### Reproducing

On the PC, from the repo root:
- `source engine-rs/scripts/h0-env.sh`, then build with `cargo build --release` and with
  `CARGO_TARGET_DIR=engine-rs/target-ort cargo build --release --features ort`.
- `ml/torch/onnx_export.py`, `onnx_parity.py` and `h0_encoding_parity.py`.
- `engine-rs/scripts/h0-identity.sh`, `h0-e2e.sh`, `h0-divergence.sh` and `h0-bench.sh`, then
  `h0_bench_report.py`.

Logs and summaries are in `research_paper/hybrid_h0_runs/`.

## H1: data, network v3 and the engine interface (2026-11-19; in progress)

Gates: `research_paper/v5_hybrid_preregistered.md`, "H1" (committed `d39275e`, before training and before
any gate was read).

### What was built

| Commit | What |
|---|---|
| `8379697` | Record format v3 (`engine-rs/src/record_v3.rs`, `blokee-selfplay --format v3`); `blokee-pentobi --mode pentobi-self` (Pentobi in all four seats, one process per game); `examples/h1_moves_v3.rs` (Pentobi moves → v3 records, one-hot); Python readers `ml/torch/records_v3.py`, `h1_check_v3.py`; the policy index `ml/torch/policy_index.py` |
| `675b655` | Network v3 (`model.ResNet3`), `h1_data.py` (caches, GPU board encoder and legal mask), `train_v3.py`, `h1_gates.py`, `onnx_export_v3.py`, `h1_parity.py`; engine: `net_v3.rs` policy table, `Inputs::push_board`, `Evaluator::evaluate_moves` (format v3), the config changes (rank reward with `native.net`, v3 with `native.candidates` / RAVE / priorLog); scripts `h1-pilot.sh`, `h1-data.sh`, `h1-identity.sh`; `examples/h1_v3_eval.rs` |
| `bb59d03` | Interior network prior (`native.net.interiorVisits`, v3 only) and the weight-0 network identity check |
| `d39275e` | H1 preregistration |

**Record format v3.** Per decision: the position, the mover, every legal move with its real root
visits and root prior, the root's mean value for all four seats and real visit count, iterations, and
the game's final scores. `initVisits` (root, 3 in v5.3) and `interiorInitVisits` (1) are virtual
visits: `select` mixes them into Q, `backup` never adds them to `child_visits` or `visits`, so nothing
is subtracted; the reader checks that each search record's visits sum to its root's visits (all
records pass). Variable length (296-byte header + 10 bytes per legal move); about 190 KB per turbo
game. Moves the root does not hold (none with `rootFull`) would be listed with 0 visits.

**Policy indexing.** 91 piece-orientations × the top-left corner of the placement's bounding box, in
the mover's frame (the board rotated so the mover's home corner is cell 0). 30,433 of the 36,400 slots
are placements. The engine's table (`net_v3.rs`) equals Python's element for element.

**Legal mask on the GPU.** Training recomputes the mover's legal placements from the encoded planes
(empty cells, not edge-adjacent to own stones, touching an own open corner or the home corner, piece in
hand). On the pilot records it equals the engine's legal sets exactly (every record of the L7 pilot,
3,000 turbo records, as sets).

### Pilot (2026-11-19, 15:02–15:19; measured)

`engine-rs/scripts/h1-pilot.sh`, binaries `8379697` pinned in `tmp/h1/bin-data`, nothing else running.

| Source | Games | Parallel | Wall | Rate | Peak memory (system) | Records/game |
|---|---:|---:|---:|---:|---:|---:|
| `v5.3-turbo` self-play | 160 | 16 threads | 193 s | ≈ 2,990 games/h | 3.3 GB | 72.0 (59.5 searched) |
| `v5.3-pro` self-play, lazy layout | 32 | 16 threads | 414 s | ≈ 280 games/h | 6.0 GB | 72.1 (59.7 searched) |
| Pentobi level 7 (one process per game) | 32 | 16 games | 153 s | ≈ 750 games/h | 4.9 GB | 72.4 decisions |
| Pentobi level 8 (the same) | 14 | 14 games | 261 s | ≈ 190 games/h | 9.8 GB | 73.0 decisions |

- Searched records: mean 228.5 legal moves at turbo (max 838) with 83.4 of them visited, 5,798
  iterations; at pro 224.8 legal, 153.1 visited, 51,725 iterations.
- Pentobi moves: 931 ms (level 7) and 3,149 ms (level 8) per move on average under this load. The 32
  level-7 games are all distinct from ply 8 on.
- `v5.3-pro` eager and lazy wrote byte-identical v3 shards on 2 games.

### Corpus collection

`engine-rs/scripts/h1-data.sh` started 2026-11-19 15:20 (binaries `8379697`; log `tmp/h1/data/log.txt`).

- **Pause and restart.** At Paul's request the run was paused at 20:08 on 2026-11-19 (SIGSTOP), at
  about 15,876 of 22,000 turbo games. The PC restarted while paused and the paused processes were lost.
  On 2026-11-23 the coordinator resumed (`tmp/h1/resume-data.sh`): `turbo/` kept 15,876 games (game
  indices 0–15,876 except 15,875, which was in flight; a partial last line of `games.jsonl` was removed,
  the original kept as `games.jsonl.pre-resume`); the missing preregistered seeds were played as
  `turbo-b/` (indices 15,877–21,999, 6,123 games, seed base 105,116,037) and `turbo-c/` (index 15,875,
  seed 105,116,035). A game is determined by its seed: game 1 of `turbo-b` reproduced the lost game
  exactly. Records of indices 15,877–15,880 also sit in `turbo/`'s shards without a `games.jsonl` line
  and are skipped by the readers.
- **Level 7** (6,000 games) finished 2026-11-23 18:42; **pro** (2,400 games) 2026-11-24 03:15 (513 min).
- **Level 8.** Windows restarted at about 04:40 on 2026-11-24 with 327 of 1,500 games done; the run was
  restarted at 10:15 and the bridge resumed by seed (old stderr `L8.stderr.pre-restart`). In this run the
  bridge's running mean for a level-8 move was 7.5 s at 00:31 and 11.9 s at 00:37 on 2026-11-25, against
  3.1 s in the pilot (in-match timing under the same 14-process load; not investigated).
- Everything after the corpus runs by itself on the PC: `engine-rs/scripts/h1-after-data.sh`
  (`docs/HYBRID_PC_RUNBOOK.md`); its read-out is generated below.

### Identity with the network off (H1-E2, measured 15:45–16:20 while the corpus ran)

`engine-rs/scripts/h1-identity.sh tmp/h1/identity`, binaries built from `d39275e`, base `~/Blokee-h0-base`
(`5b57f48`). Every check passed:

- H0's whole G3 suite again, 0 FAIL lines: self-play shards and `games.jsonl` identical for
  `v4.2-ultra` (`4a24f908…` / `6210cc1a…`) and `v5.3-turbo` (`44f24a92…` / `a4d94228…`), the same
  hashes as in H0; `blokee-match` 8 games identical; `s4_identity` 1,440 lines identical
  (`54dbaa2a…`); mirrors `v5.3-turbo` −0.00 [−0.00, 0.00] and `v4.2-ultra` 0.00 [0.00, 0.00], default and
  `ort` builds.
- `--format v2` spelled out: shard, `games.jsonl` and `meta.json` identical to base, both configs,
  both builds. `--format v3`: the same games (scores and iterations per game).
- `blokee-pentobi --mode one-blokee` at level 1 (1 seed × 4 rotations, per-seat processes): results
  and moves identical to base, both builds.
- `cargo test --release`: 39 passed, 0 failed in the default and `ort` builds (after `4ac57b9`; the
  script's own test step did not find `cargo` in the tmux shell and was re-run by hand). One test was
  changed with the rule it checks: `tests/lazy.rs` `lazy_is_refused_with_the_network` now asserts that
  the lazy layout is refused with `depth1Blend` > 0, a v2 network is still refused with the v5
  candidates, and a v3 root-prior network is accepted.

### Engine interface, smoke checks (not the gate; the gate uses the selected network)

With a 400-step smoke network trained on the pilot data:
- ONNX against PyTorch (2,000 pilot records): fp32 ORT CPU and CUDA (TF32 off) max abs 1.3e-5 on all
  logits, 3.7e-6 on utilities; the engine's path (Rust encoder, table, ORT) 1.0e-5 (CPU) and 3.3e-5
  (CUDA) on legal-move logits; the tables equal; `evaluate_moves` equals the raw outputs bit for bit.
- Inside `v5.3-turbo` (1 seed × 4 rotations each, functional only): root prior 1.0 call per searched
  move; with `depth1Blend` 0.5, 228 positions per move and no depth-1 shortlist mismatch; with
  `interiorVisits` 200, about 10 interior calls per move.
- At `rootBlend` 0 the v3 network inside `v5.3-turbo` played the same 8 games as `v5.3-turbo` (H1-E3's
  check, smoke network).

<!-- H1:AUTO:BEGIN -->
### H1 read-out (generated by `ml/torch/h1_report.py` from `tmp/h1/after`)

**Corpus as read** (`h1_check_v3.py`; every check passed unless listed):

| Run | Games | Records | Search records (mean legal / visited / iterations) | Teacher records (mean legal) | Problems |
|---|---:|---:|---|---|---|
| `tmp/h1/pilot/turbo` | 160 | 11,526 | 9,528 (228.5 / 83.4 / 5798) | – | none |
| `tmp/h1/data/turbo` | 15,876 | 1,145,680 | 945,441 (227.8 / 82.9 / 5801) | – | none |
| `tmp/h1/data/turbo-b` | 6,123 | 441,714 | 364,467 (227.9 / 83.0 / 5800) | – | none |
| `tmp/h1/data/turbo-c` | 1 | 75 | 63 (228.9 / 82.7 / 5721) | – | none |
| `tmp/h1/pilot/pro` | 32 | 2,308 | 1,911 (224.8 / 153.1 / 51725) | – | none |
| `tmp/h1/data/pro` | 2,400 | 173,474 | 143,458 (224.8 / 153.1 / 52035) | – | none |
| `tmp/h1/L7-v3` | 6,032 | 438,482 | – | 438,482 (210.8) | none |
| `tmp/h1/L8-v3` | 1,514 | 109,937 | – | 109,937 (211.1) | none |

**Training caches** (`h1_data.py build`; games by split train / validation / test):

| Cache | Kind | Games | Records | Policy entries | Split games |
|---|---|---:|---:|---:|---|
| `tmp/h1/cache/L7` | teacher | 6,032 | 438,482 | 438,482 | 4,826 / 603 / 603 |
| `tmp/h1/cache/L8` | teacher | 1,514 | 109,937 | 109,937 | 1,212 / 151 / 151 |
| `tmp/h1/cache/old` | old | 36,000 | 2,615,623 | 0 | 36,000 / 0 / 0 |
| `tmp/h1/cache/pro` | selfplay | 2,432 | 175,782 | 22,260,829 | 1,946 / 243 / 243 |
| `tmp/h1/cache/turbo` | selfplay | 22,160 | 1,598,995 | 109,375,963 | 17,728 / 2,216 / 2,216 |

**Training** (30,000 steps, batch 512, EMA weights validated every 1,000 steps):

| Arm | Best step | Best val loss | Val visits CE / top-1 | Val teacher CE / top-1 / top-40 | Val margin R² | Minutes |
|---|---:|---:|---|---|---:|---:|
| A | 17,000 | 6.0342 | 2.765 / 0.434 | 2.126 / 0.378 / 0.984 | 0.598 | 78 |
| B | 20,000 | 6.0404 | 2.767 / 0.438 | 2.129 / 0.372 / 0.984 | 0.594 | 78 |

Validation loss by step:

| Step | A | B |
|---:|---:|---:|
| 3,000 | 6.3291 | 6.4043 |
| 6,000 | 6.1686 | 6.2302 |
| 9,000 | 6.0941 | 6.1415 |
| 12,000 | 6.0560 | 6.0884 |
| 15,000 | 6.0347 | 6.0599 |
| 17,000 | 6.0342 | 6.0494 |
| 18,000 | 6.0357 | 6.0457 |
| 20,000 | 6.0478 | 6.0404 |
| 21,000 | 6.0551 | 6.0434 |
| 24,000 | 6.0848 | 6.0487 |
| 27,000 | 6.1175 | 6.0632 |
| 30,000 | 6.1305 | 6.0671 |

**Selection:** arm A (`tmp/h1/train/h1-A.pt`). Best validation loss A 6.0342 (step 17000), B 6.0404 (step 20000); B is selected only if lower than A's by at least 0.5% (threshold 6.0041).

**Offline gates** (test split; `h1_gates.py`; bootstrap over games):

| Gate | Measured | Rule | Result |
|---|---|---|---|
| H1-G1 | network top-40 at own moves 3–8: 0.973 [+0.970, +0.975] (14,472 decisions, 603 games) | ≥ 0.55 and lower bound > 0.45 | **pass** |
| H1-G1b | fitted prior 0.806; network − prior +0.166 [+0.160, +0.173] | lower bound > 0 | **pass** |
| H1-G2 | log-likelihood own moves 3+: network -2.292, prior -3.252, difference +0.960 [+0.943, +0.976] (35,790 decisions) | lower bound > 0 | **pass** |
| H1-G3 | R² root value 0.534, network 0.671, both 0.678; increment +0.144 [+0.136, +0.152] (129,456 positions, 2216 games) | ≥ +0.061 | **pass** |

By band, level-7 test decisions, teacher head (gated):

| Own moves | Decisions | Net log-lik | Prior log-lik | Difference [95% CI] | Net top-40 | Prior top-40 | Difference [95% CI] |
|---|---:|---:|---:|---|---:|---:|---|
| 0-2 | 7,236 | -1.199 | -1.970 | +0.771 [+0.744, +0.797] | 1.000 | 1.000 | +0.000 [+0.000, +0.000] |
| 3-8 | 14,472 | -2.597 | -4.060 | +1.463 [+1.430, +1.494] | 0.973 | 0.806 | +0.166 [+0.160, +0.173] |
| 9-14 | 14,221 | -2.438 | -3.214 | +0.776 [+0.750, +0.800] | 0.987 | 0.925 | +0.062 [+0.057, +0.066] |
| 15+ | 7,097 | -1.376 | -1.678 | +0.302 [+0.279, +0.324] | 1.000 | 1.000 | +0.000 [+0.000, +0.001] |
| 3+ | 35,790 | -2.292 | -3.252 | +0.960 [+0.943, +0.976] | 0.984 | 0.892 | +0.092 [+0.089, +0.095] |

By band, level-7 test decisions, visits head (reported, not gated):

| Own moves | Decisions | Net log-lik | Prior log-lik | Difference [95% CI] | Net top-40 | Prior top-40 | Difference [95% CI] |
|---|---:|---:|---:|---|---:|---:|---|
| 0-2 | 7,236 | -3.402 | -1.970 | -1.432 [-1.466, -1.400] | 0.937 | 1.000 | -0.063 [-0.068, -0.057] |
| 3-8 | 14,472 | -3.571 | -4.060 | +0.489 [+0.458, +0.524] | 0.797 | 0.806 | -0.010 [-0.018, -0.001] |
| 9-14 | 14,221 | -2.586 | -3.214 | +0.628 [+0.606, +0.647] | 0.978 | 0.925 | +0.053 [+0.049, +0.057] |
| 15+ | 7,097 | -1.469 | -1.678 | +0.210 [+0.191, +0.229] | 1.000 | 1.000 | +0.000 [-0.000, +0.001] |
| 3+ | 35,790 | -2.763 | -3.252 | +0.489 [+0.474, +0.504] | 0.909 | 0.892 | +0.017 [+0.014, +0.021] |

G3 on the `v5.3-pro` test games (reported, not gated): R² root 0.567, network 0.694, both 0.702, increment +0.134 [+0.115, +0.152] (14,194 positions, 243 games).

**H1-E1, parity** (20,000 records of `tmp/h1/data/turbo`, file order; reference PyTorch fp32 on the CPU):

| Path | Logits, all slots: max abs (p99.9) | Logits, legal moves: max abs (p99.9) | Utilities: max abs (p99.9) | Top-1 (teacher) |
|---|---|---|---|---:|
| ONNX fp32 CPU (gated) | 1.0e-05 (3.3e-06) | 8.6e-06 (4.3e-06) | 1.3e-06 (6.9e-07) | 1.0000 |
| ONNX fp32 CUDA tf32=0 (gated) | 2.3e-05 (3.8e-06) | 1.5e-05 (4.8e-06) | 1.4e-06 (7.2e-07) | 1.0000 |
| ONNX fp32 CUDA tf32=1 | 1.3e-02 (4.6e-03) | 1.2e-02 (5.0e-03) | 1.6e-03 (8.1e-04) | 0.9994 |
| ONNX fp16 CUDA tf32=0 | 4.0e-02 (1.0e-02) | 2.2e-02 (1.2e-02) | 4.3e-03 (2.4e-03) | 0.9992 |
| ONNX fp16 CPU | 2.1e-02 (7.0e-03) | 1.5e-02 (7.2e-03) | 3.1e-03 (2.0e-03) | 0.9993 |
| engine `rust-cpu` (gated) | – | 8.6e-06 (4.3e-06) | 1.3e-06 (6.9e-07) | 1.0000 |
| engine `rust-cuda` (gated) | – | 2.5e-05 (1.1e-05) | 3.4e-06 (1.7e-06) | 1.0000 |

Training-time encoder equals `features.Encoder.board`: True. Engine policy table equals `policy_index.py`: True. `evaluate_moves` equal to the raw session outputs bit for bit: asserted by `examples/h1_v3_eval.rs` (the step fails otherwise).

**v3 call latency** (one position with its legal moves, synchronous, as the search calls it; PC otherwise idle):

- rust-cpu: batch-1 evaluate_moves latency over 980 calls: median 1.375 ms, p10 1.299, p90 1.614
- rust-cuda: batch-1 evaluate_moves latency over 980 calls: median 1.268 ms, p10 1.195, p90 1.449

**H1-E3, network at weight 0:** H1 v3 network at weight 0 inside v5.3-turbo: same 16 games as v5.3-turbo

**Verdicts:** H1-G1 **pass**; H1-G1b **pass**; H1-G2 **pass**; H1-G3 **pass**; H1-E1 **pass**; H1-E3 **pass**. H1-E2 (identity with the network off) passed on 2026-11-19, above.

<!-- H1:AUTO:END -->

## H2: the network-v3 prior inside the v5 tree

<!-- H2:AUTO:BEGIN -->
### H2 read-out (generated by `engine-rs/scripts/h2_report.py`)

**Development steps** (recorded positions only, no games):

- `interiorVisits` for turbo: **T = 512** (smallest T with at most 1 + 8 network evaluations per searched move). Evaluations per searched move by T: T 64: 39.0, T 128: 19.4, T 256: 10.3, T 512: 5.8, T 1024: 3.4, T 2048: 2.2, T 4096: 1.0, T 8192: 1.0, T 16384: 1.0.
- `interiorVisits` for pro: **T = 1024** (smallest T with at most 1 + 40 network evaluations per searched move). Evaluations per searched move by T: T 64: 304.0, T 128: 154.9, T 256: 80.4, T 512: 43.6, T 1024: 24.2, T 2048: 14.1, T 4096: 8.1, T 8192: 4.7, T 16384: 2.8.

| Arm | T | iterationScale | Control ms | Arm ms | Ratio | Network evaluations / searched move | Rounds |
|---|---:|---:|---:|---:|---:|---:|---:|
| T-R50 | – | 24.185 | 122.3 | 122.1 | 0.998 | 1.0 | 2 |
| T-R100 | – | 24.316 | 122.6 | 123.6 | 1.008 | 1.0 | 2 |
| T-RI | 512 | 19.202 | 121.7 | 121.8 | 1.001 | 4.6 | 2 |
| P-R50 | – | 239.172 | 1180.4 | 1204.2 | 1.020 | 1.0 | 1 |
| P-RI | 1024 | 208.802 | 1180.0 | 1186.3 | 1.005 | 21.5 | 2 |

**turbo screen** (lone seat vs three Pentobi level 6 seats, paired with `v5.3-turbo` on the same seeds and seats):

| Arm | Games | Control adv. | Arm adv. | Paired Δ [95% CI] | First place control / arm | First Δ [95% CI] | ms/move control / arm | Cleared |
|---|---:|---|---|---|---|---|---|---|
| T-R50 | 1,200 | +0.95 [+0.25, +1.68] | +2.54 [+1.85, +3.31] | **+1.58 [+0.70, +2.50]** | 0.216 / 0.251 | +0.036 [+0.005, +0.065] | 170 / 177 | yes |
| T-R100 | 1,200 | +0.95 [+0.25, +1.68] | +3.42 [+2.69, +4.17] | **+2.47 [+1.52, +3.43]** | 0.216 / 0.271 | +0.056 [+0.024, +0.087] | 170 / 177 | yes |
| T-RI | 1,200 | +0.95 [+0.25, +1.68] | +2.86 [+2.20, +3.52] | **+1.91 [+1.02, +2.78]** | 0.216 / 0.260 | +0.044 [+0.018, +0.070] | 170 / 181 | yes |

Selected for confirmation: T-R100.

**turbo confirmation** (T-R100, 3,200 games on fresh seeds): paired Δ **+2.57 [+2.03, +3.16]**, first place Δ +0.045 [+0.026, +0.062]; control +0.85, arm +3.43 against level 6; ms/move 177 / 177. **Pass** (rule: Δ lower bound > 0 and first-place Δ upper bound ≥ 0). A candidate for the tier's next version; Paul decides and names it.

**pro screen** (lone seat vs three Pentobi level 7 seats, paired with `v5.3-pro` on the same seeds and seats):

| Arm | Games | Control adv. | Arm adv. | Paired Δ [95% CI] | First place control / arm | First Δ [95% CI] | ms/move control / arm | Cleared |
|---|---:|---|---|---|---|---|---|---|
| P-R50 | 1,200 | -1.16 [-1.95, -0.39] | -0.48 [-1.24, +0.23] | **+0.69 [-0.15, +1.51]** | 0.182 / 0.187 | +0.006 [-0.020, +0.031] | 1308 / 1313 | no |
| P-RI | 1,200 | -1.16 [-1.95, -0.39] | +0.89 [+0.22, +1.57] | **+2.06 [+1.16, +3.02]** | 0.182 / 0.209 | +0.028 [+0.001, +0.054] | 1308 / 1284 | yes |

Selected for confirmation: P-RI.

**pro confirmation** (P-RI, 3,200 games on fresh seeds): paired Δ **+2.09 [+1.58, +2.58]**, first place Δ +0.029 [+0.014, +0.044]; control -1.30, arm +0.79 against level 7; ms/move 1306 / 1286. **Pass** (rule: Δ lower bound > 0 and first-place Δ upper bound ≥ 0). A candidate for the tier's next version; Paul decides and names it.

GPU power and utilisation during each run (`nvidia-smi`, every 5 s, whole GPU incl. the desktop): confirm-pro-P-RI: 6 W, 15% utilisation; confirm-pro-control: 4 W, 0% utilisation; confirm-turbo-T-R100: 5 W, 12% utilisation; confirm-turbo-control: 4 W, 0% utilisation; screen-pro-P-R50: 4 W, 1% utilisation; screen-pro-P-RI: 6 W, 15% utilisation; screen-pro-control: 4 W, 0% utilisation; screen-turbo-T-R100: 6 W, 12% utilisation; screen-turbo-T-R50: 6 W, 12% utilisation; screen-turbo-T-RI: 11 W, 30% utilisation; screen-turbo-control: 4 W, 0% utilisation; smoke-pro-P-R50: 7 W, 1% utilisation; smoke-pro-P-RI: 8 W, 6% utilisation; smoke-turbo-T-R100: 26 W, 2% utilisation; smoke-turbo-T-R50: 19 W, 0% utilisation; smoke-turbo-T-RI: 33 W, 3% utilisation.

<!-- H2:AUTO:END -->
