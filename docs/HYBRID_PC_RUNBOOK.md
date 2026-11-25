# Hybrid line on the PC: runbook

**Start with `docs/HYBRID_HANDOFF.md`** (current state, next steps, decision points, standing rules). This file
is the operating detail.

For a person or a Claude Code session working **on the PC** (`~/Blokee-hybrid`, WSL2 Ubuntu, Ryzen 7 9700X
8 cores / 16 threads, RTX 4080, 15 GB for WSL). The plan is `research_paper/v5_hybrid_cpu_gpu_plan.md`,
the gates are in `research_paper/v5_hybrid_preregistered.md`, results go in
`research_paper/v5_hybrid_results.md`. Written 2026-11-25, during H1.

## Standing rules

- **Paul decides.** H1 runs to its end by itself (below). **H2 matches and every stage after it need
  Paul's explicit go-ahead.** Paul names versions; do not create named configs in `engine-rs/configs`
  (working configs go under `tmp/`).
- **Pentobi is GPL.** Run `~/src/pentobi-build/pentobi_gtp/pentobi-gtp` as a subprocess only. Never read,
  copy or translate its source, constants or tables, and never build or edit anything in `~/src/pentobi*`.
  Recording the moves it plays is fine.
- **Paul's checkouts are read-only:** `~/Blokee`, `~/Blokee-v6-discovery`, `~/Blokee-v6-replay`. Copying
  data out of them is fine. Never install into `~/Blokee/ml/.venv-torch`; this checkout's venv is
  `ml/.venv-hybrid` (add packages with `~/.local/bin/uv pip install --python ml/.venv-hybrid/bin/python <pkg>`).
- **Git:** work on branch `hybrid-h1` (later stages: a new branch from it). Commit locally with the
  trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Push only when Paul says.**
  Remotes: `origin` is the PC's bare repo `~/blokee-hybrid.git` (the Mac fetches from it as
  `pc-hybrid`); `github` is `https://github.com/paulkim219/blokus_ai.git` (fetch only unless told).
- **Preregister before measuring.** Each stage's gates are written into the prereg file and committed
  before any game or gate is read; a failed gate is reported, never relaxed.
- **Non-interactive shells** need `source ~/.cargo/env`; `nvidia-smi` is `/usr/lib/wsl/lib/nvidia-smi`. The
  `ort` build and ONNX Runtime need `source engine-rs/scripts/h0-env.sh` (from the repo root).
- **Windows restarts.** Windows has restarted at night twice (about 04:40). Every long job here is
  resumable; after a restart, check status and rerun the same command (below).
- **Memory.** 15 GB. Pentobi level 8 uses about 0.6 GB per process; an eager `v5.3-pro` tree about
  0.9 GB per game. Do not train on the GPU while a data or match run is using the CPU at full width.

## Status at a glance

```bash
cd ~/Blokee-hybrid
tmux ls; tmux list-windows -t h1                 # session h1: window "data" (corpus), "after" (the H1 chain)
cat tmp/h1/data/log.txt                          # corpus stages (turbo, L7, pro, L8) and restarts
tail -c 300 tmp/h1/data/L8.stderr                # level-8 progress (games, ETA)
cat tmp/h1/after/chain.log                       # the H1 chain, step by step
cat tmp/h1/SUMMARY.txt                           # one-line state while running; the full read-out at the end
/usr/lib/wsl/lib/nvidia-smi; free -m; uptime
```

## H1: what runs and how to resume it

**Corpus** (`engine-rs/scripts/h1-data.sh`, pinned binaries `tmp/h1/bin-data`, commit `8379697`). Stages
leave `tmp/h1/data/<stage>.done`. Turbo was completed in three directories after the 2026-11-23 restart
(`tmp/h1/resume-data.sh`; `turbo`, `turbo-b`, `turbo-c`, all marked done). L7 and pro are done. L8
(`blokee-pentobi --mode pentobi-self`) resumes seed by seed from `tmp/h1/data/L8.jsonl`.

**The H1 chain** (`engine-rs/scripts/h1-after-data.sh`) waits for `tmp/h1/data/L8.done` (or "DATA DONE"
in the data log) and for the data processes to exit, then runs every preregistered H1 step. Each step
leaves `tmp/h1/after/<step>.done` and its log `tmp/h1/after/<step>.log`; a rerun skips finished steps.
Training writes `tmp/h1/train/<name>.resume.pt` after every validation (every 1,000 steps) and continues
from it.

| Step | What | Expected time (idle PC) |
|---|---|---:|
| wait | corpus done, data processes gone | — |
| build | `cargo build --release` default and `--features ort` | 3 min |
| convert-L7, convert-L8 | Pentobi moves (pilot + main) → v3 runs `tmp/h1/L7-v3`, `L8-v3` | 5 min |
| check | `h1_check_v3.py` on every run (stops the chain on any problem) | 15 min |
| cache-turbo, -pro, -L7, -L8 | `h1_data.py build` → `tmp/h1/cache/*` (old corpus already built) | 20 min |
| n11 | N11 features of the level-7 test decisions | 2 min |
| gpu-check | GPU legal mask against the records | 10 min |
| train-A, train-B | 30,000 steps each (≈ 0.15 s/step + validation) | 85 + 95 min |
| select | B only if its best validation loss is ≥ 0.5% below A's | — |
| export | ONNX fp32 / fp16 → `tmp/h1/onnx/h1-selected.*` | 1 min |
| gates | G1, G1b, G2, G3 on the test split → `tmp/h1/after/gates.json` | 15 min |
| parity | E1: engine (CPU, CUDA) and ONNX Runtime vs PyTorch, 20,000 records; v3 call latency | 20 min |
| noop | E3: the network at weight 0 inside `v5.3-turbo` plays its games | 5 min |
| report | `tmp/h1/SUMMARY.txt`, results section, `research_paper/hybrid_h1_runs/`, local commit | 1 min |

About 4.5 hours after the corpus ends.

**Resume after a Windows restart** (open the Ubuntu WSL terminal, or `ssh blokee-pc`):

```bash
cd ~/Blokee-hybrid
tmux ls 2>/dev/null || echo "no tmux: everything stopped with the restart"
# 1. Corpus not finished (no tmp/h1/data/L8.done and no "DATA DONE" in tmp/h1/data/log.txt):
echo "$(date '+%F %T') restart after Windows restart (L8 had $(wc -l < tmp/h1/data/L8.jsonl)/1500)" >> tmp/h1/data/log.txt
tmux new-session -d -s h1 -n data "bash engine-rs/scripts/h1-data.sh tmp/h1/data; exec bash"
#    (turbo, L7 and pro are skipped by their .done files; L8 continues by seed.)
# 2. The chain (always safe to start; it waits for the corpus and skips finished steps):
tmux has-session -t h1 2>/dev/null || tmux new-session -d -s h1 -n shell
tmux new-window -t h1 -n after "bash engine-rs/scripts/h1-after-data.sh; exec bash"
```

Before restarting L8, check that `tmp/h1/data/L8.jsonl` and `L8.moves.jsonl` have the same number of
lines; if the moves file has a game the results file lacks (killed between the two writes), remove that
line from the moves file first, or the converter will refuse the duplicate seed later.

If a step fails, `tmp/h1/SUMMARY.txt` names it; read `tmp/h1/after/<step>.log`, fix, and rerun the chain.
To redo a step, delete its `.done` file (and for training also `tmp/h1/train/<name>.resume.pt` if the run
must start over).

**Reading the results.** `tmp/h1/SUMMARY.txt` is the plain-text read-out: corpus, caches, training curves,
the selection, each gate with its numbers and pass/fail, parity, latency and the weight-0 check. The same
section is in `research_paper/v5_hybrid_results.md` between `<!-- H1:AUTO:BEGIN -->` and `<!-- H1:AUTO:END -->`,
committed on the PC as "Hybrid H1 results … (generated on the PC …)". The rules applied are the
prereg's (`d39275e`). Deviations to mention by hand in the write-up: the pause on 2026-11-19, the two
Windows restarts and how the turbo block was completed, and anything in `tmp/h1/after/chain.log`.

## H2: the network prior inside the v5 tree (approved 2026-11-25; running)

The prereg is in force (`research_paper/v5_hybrid_preregistered.md`, "H2", commit `051b98c`). Everything runs in
`engine-rs/scripts/h2-chain.sh` (tmux session `h2`), resumable like the H1 chain:

```bash
cat tmp/h2/SUMMARY.txt; tail tmp/h2/chain.log; ls tmp/h2/steps/*.done   # status
tail -c 300 tmp/h2/steps/screen-pro-P-RI.log                            # a running match step (bridge progress)
tmux new-session -d -s h2 "bash engine-rs/scripts/h2-chain.sh; exec bash"   # (re)start after a restart
```

Pieces: `examples/h2_cost.rs` (cost and network evaluations on recorded positions), `scripts/h2_calibrate.py`
(arm configs in `tmp/h2/configs`, T, equal-time calibration), `scripts/h2_report.py` (screen and confirmation
rules, the read-out). Match logs: `tmp/h2/games/<stage>-<tier>-<config>.jsonl` (+ `.timing.jsonl`, `.gpu.csv`).

## H3 onward (decision points; most code does not exist yet)

Each needs Paul's go-ahead and its own prereg. In plan order:

- **H3, asynchronous batching and the value channel, then multithreading** (only if H2 confirms a
  gain). To build: an evaluation queue shared by search threads and games, a node "pending" state with
  WU-UCT-style accounting in selection, network values mixed into node statistics (n_v virtual visits,
  re-centred on siblings as in E6), and multithreaded search (tracker N12) with a CPU-only control at the
  same thread count. Knobs screened against H2's winner: T, λ or n_v, thread count. H0's cost curve
  (`research_paper/hybrid_h0_runs/bench-report.md`) says one GPU sustains 15–18k positions/s; CUDA graphs
  and fixed batch sizes are the cheap speed-ups to try first, each with a parity check.
- **H4, self-improvement** (only if H2 or H3 confirms a gain): expert iteration with the hybrid search
  as the expert, Gumbel root sampling, no per-generation gate, checkpoints scored against fixed anchors
  afterwards. Reuses `blokee-selfplay --format v3` (it plays any config, including one with `native.net`)
  and `train_v3.py` (warm start would need an `--init` option, not yet written).
- **H5, browser:** `onnxruntime-web` (WebGPU, WebAssembly fallback) in the app's worker; the app runs the
  TS engine today, and v5.x is native-only (WASM build in `engine-wasm/`). Done on the Mac, not the PC.
- **H5b, equal-strength mixes per tier** (Light / Balanced / Heavy GPU) with non-inferiority tests
  (lower bound above −0.5 on 800 fresh seeds) and the Auto calibration in the engine and the app.
- **H6, the v5.5 decision:** Paul's call, using the plan's rule (stronger at equal wall time → candidate
  for the tier's next version; equal strength → the GPU setting; otherwise experimental).

## Files

| Path | What |
|---|---|
| `engine-rs/scripts/h1-data.sh`, `tmp/h1/resume-data.sh` | the corpus |
| `engine-rs/scripts/h1-after-data.sh` | the H1 chain (DRY=1: CPU steps on the pilot data, under `tmp/h1/dry`) |
| `engine-rs/scripts/h1-identity.sh` | E2 identity suite; `ONLY_NOOP=1 V3_MODEL=…` runs E3 only |
| `ml/torch/h1_data.py`, `train_v3.py`, `h1_gates.py`, `h1_parity.py`, `h1_report.py`, `onnx_export_v3.py` | caches, training, gates, parity, read-out, export |
| `tmp/h1/cache/*`, `tmp/h1/train/*`, `tmp/h1/onnx/*`, `tmp/h1/after/*` | outputs (git-ignored) |
