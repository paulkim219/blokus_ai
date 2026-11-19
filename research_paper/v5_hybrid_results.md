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
