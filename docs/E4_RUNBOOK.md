# E4 runbook — expert iteration on another machine

E4 is the open bet left by v6 (`research_paper/v6_native_and_learning_results.md`). Raising the
learned prior's accuracy did not move the root prior channel (E3a: +0.18 and +0.24, null). E4 tests
whether *training the network on its own search's results* does better. The search here is
`v4.2-ultra` with the network as its root prior.

The gate is fixed in advance in the addendum of `research_paper/v6_native_and_learning_preregistered.md`.

## What one run does

`ml/torch/expert_iteration.sh <start.pt> resnet [generations=8] [games=2000]` runs one loop per
generation `k`:

1. **Self-play.** Serve the current network (`ml/torch/serve.py`), then play `games` native
   self-play games with `v4.2-ultra` + `native.prior` (blend 0.5, temperature 1).
   - Seeds are `62,000,000 + k·100,000 + i`.
   - Each game records every root child's visit count and the final scores.
2. **Train.** Warm-start the next network from the current one. Train it for `STEPS` (default 4,000)
   on this generation, the previous `REPLAY` (default 3) generations, and the 20k-game base corpus
   (`BASE_RUN`).
3. **Gate.** Play the next network against the current one, both served, over `GATE_SEEDS` (50)
   seat-rotated seeds, using seeds `73,000,000 + k·1,000`.
   - The next network is kept only if its advantage is above 0.
   - A rejected generation's games still enter the replay window.

After the last generation, the final network (served) plays **plain `v4.2-ultra`** over
`FINAL_SEEDS` (200) seeds from 74,000,000. That match, not the gates, is the E4 result.

Everything is written to `ml/data/expert-iteration/`:

| Path | Contents |
|---|---|
| `log.txt` | timeline, gate verdicts, final verdict |
| `gen-<k>/` | the generation's self-play records |
| `nets/ei-gen<k>.pt` (+ `.json`) | checkpoints and their offline metrics |
| `gate-<k>.jsonl` | gate games |
| `final.jsonl`, `final.txt` | final match and its scored summary |
| `train.log`, `serve.log` | process output |

## Expected cost

The M4 Pro (14 cores, MPS) measured these per generation at the defaults:

| Stage | M4 Pro estimate |
|---|---|
| 2,000 self-play games, base 300 | 15–22 min (5,500–8,800 games/h without a prior; the prior added no measurable time in E3a) |
| 4,000 ResNet steps, batch 256 | ≈21 min (0.31 s/step), plus about 1 min loading data |
| 50-seed gate (200 games) | ≈4 min |

That is about 45 minutes per generation, or **about 6 hours for 8**, plus about 13 minutes for the
final match.

On another machine:
- Self-play scales with core count: `THREADS` defaults to cores − 1.
- Training scales with the GPU. A recent NVIDIA card should be several times faster than MPS for
  this ResNet.

## 1. Prerequisites on the PC

- **Linux, WSL2 (Ubuntu) or macOS.** Native Windows will not work, because the engine and the prior
  server talk over a Unix socket.
  - On Windows, install WSL2 and clone the repo *inside* the Linux filesystem (`~/…`, not `/mnt/c`).
    Data loading over `/mnt/c` is very slow.
- `git`, `zsh`, `bc`, `build-essential` (e.g. `sudo apt install git zsh bc build-essential`).
- Rust stable: <https://rustup.rs>. Results were produced with rustc 1.99.1.
- Node 22+: the harness's statistic (`scripts/aggregateMatches.ts`) runs under `tsx`.
- Python 3.12.
- For NVIDIA, a CUDA driver. Under WSL2, the Windows NVIDIA driver is enough; check that
  `nvidia-smi` works inside WSL.

## 2. Clone and set up

```bash
git clone https://github.com/paulkim219/blokus_ai.git Blokee && cd Blokee
git checkout v6-native-engine-e4

# NVIDIA only, BEFORE setup: install the CUDA build of torch into the venv.
python3.12 -m venv ml/.venv-torch
ml/.venv-torch/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128   # pick yours on pytorch.org

zsh ml/torch/setup_machine.sh
```

The setup script:
- builds the engine;
- runs the parity tests;
- creates the venv if it is missing;
- writes `ml/data/placements.json`;
- reports which device torch found.

It must print `torch … on cuda` (or `mps`). If it prints `cpu`, stop and fix the torch install.

### Parity on another platform

The parity fixtures were recorded on macOS arm64. `Math.pow` is the platform's libm there, and the
port reproduces it with the platform's `powf`. On x86-64 Linux, glibc may round a few `pow` results
differently, so a float comparison in `cargo test` can fail by one ulp.

That does **not** affect E4: E4 never compares against the TS engine. It does mean games played on
the PC are not bit-identical to the same seeds played on the Mac. Results are still valid; just
don't mix "identical replay" claims across machines.

## 3. Bring the base corpus and the starting network

The starting network `ml/torch/results/resnet-g18500-s0.pt` is in git (the E2 winner, 6 MB). The
20k-game base corpus is not: it is 789 MB and `ml/data/` is ignored. Pick one of these:

```bash
# (a) copy it from the Mac (fastest). From the PC:
rsync -av --progress paulkim@<mac-host>:Blokee/ml/data/selfplay-v41u-300 ml/data/
#     or from the Mac: tar czf - -C ml/data selfplay-v41u-300 | ssh <pc> 'tar xzf - -C ~/Blokee/ml/data'

# (b) regenerate it on the PC (same seeds; ~3.6 h on the M4 Pro, scales with cores):
engine-rs/target/release/blokee-selfplay --config engine-rs/configs/v4.1-ultra.json \
  --games 20000 --budget 300 --seed-base 61000000 --out ml/data/selfplay-v41u-300

# (c) skip it: E4 then trains only on its own generations (weaker early generations).
export BASE_RUN=
```

## 4. Smoke test (about 1 minute)

```bash
DIR=/tmp/ei-smoke BASE_RUN= BUDGET=10 STEPS=20 GATE_SEEDS=2 FINAL_SEEDS=2 TEST_GAMES=10 VAL_GAMES=5 \
  zsh ml/torch/expert_iteration.sh ml/torch/results/resnet-g18500-s0.pt resnet 1 40
```

It must end with a `final match: Advantage …` line. Its numbers mean nothing at 10 iterations.

## 5. The real run

```bash
nohup zsh ml/torch/expert_iteration.sh ml/torch/results/resnet-g18500-s0.pt resnet 8 2000 \
  > tmp/e4.out 2>&1 &
tail -f ml/data/expert-iteration/log.txt
```

These settings can be overridden through the environment, all with the defaults shown:

| Setting | Default |
|---|---|
| `BUDGET` | 300 |
| `STEPS` | 4000 |
| `REPLAY` | 3 |
| `GATE_SEEDS` | 50 |
| `FINAL_SEEDS` | 200 |
| `BLEND` | 0.5 |
| `TEMPERATURE` | 1.0 |
| `THREADS` | cores − 1 |
| `BASE_CONFIG` | `engine-rs/configs/v4.2-ultra.json` |
| `BASE_RUN` | `ml/data/selfplay-v41u-300` |
| `DIR` | `ml/data/expert-iteration` |
| `PY` | `ml/.venv-torch/bin/python` |

**Changing any of them changes the experiment.** The preregistered gate is for the defaults; write
an addendum first if you change one.

### Resuming after an interruption

Find the last completed generation in `log.txt`, along with the network it accepted (`accepted
ei-gen<n>`, or the start network if none was). Then resume from the first incomplete generation `k`:

```bash
rm -rf ml/data/expert-iteration/gen-<k>        # a half-written generation
RESUME=<k> nohup zsh ml/torch/expert_iteration.sh ml/data/expert-iteration/nets/ei-gen<n>.pt resnet 8 2000 \
  > tmp/e4.out 2>&1 &
```

## 6. Reading the result

```bash
grep -E "gate|accepted|rejected|final" ml/data/expert-iteration/log.txt
cat ml/data/expert-iteration/final.txt
```

- **Pass:** `final.txt` shows a mean ≥ +0.50 with the CI lower bound above 0. A pass is a
  candidate only: confirm it on the fresh block fixed in the preregistration (seeds from 74,100,000).
  `final.json` is the served-network config the final match used:
  ```bash
  E=ml/data/expert-iteration
  ml/.venv-torch/bin/python ml/torch/serve.py --checkpoint <final network from log.txt> \
    --socket /tmp/blokee-ei-a.sock > $E/serve-confirm.log 2>&1 &
  engine-rs/target/release/blokee-match --challenger $E/final.json --champion engine-rs/configs/v4.2-ultra.json \
    --seeds 200 --seed-base 74100000 --budget 300 --label e4-confirm --out $E/confirm.jsonl
  kill %1; npx tsx scripts/aggregateMatches.ts $E/confirm.jsonl
  ```
- **Null:** if no generation was accepted, the prior channel doesn't respond to self-improvement at
  this scale either. The next step is E3b (the network as an n-step value), not more E4.

Record the outcome in `research_paper/v6_native_and_learning_results.md`, under a dated E4 section.
Then commit the logs' summary, not the data.

## Moving the Claude Code session to the PC

Claude Code keeps sessions locally, as JSONL transcripts under `~/.claude/projects/<encoded
path>/`. The encoded path is the project's absolute path with every `/` replaced by `-`. To continue
this exact conversation on the PC:

```bash
# On the Mac
scp ~/.claude/projects/-Users-paulkim-Blokee/95ab50ed-3a69-4c5d-a0e9-f34fc4bd4f3e.jsonl <pc>:/tmp/
# Optional: the project memory directory
scp -r ~/.claude/projects/-Users-paulkim-Blokee/memory <pc>:/tmp/claude-memory

# On the PC, if the clone is /home/<you>/Blokee:
mkdir -p ~/.claude/projects/-home-<you>-Blokee
mv /tmp/95ab50ed-3a69-4c5d-a0e9-f34fc4bd4f3e.jsonl ~/.claude/projects/-home-<you>-Blokee/
cd ~/Blokee && claude --resume        # pick the session from the list
```

The transcript refers to Mac paths (`/Users/paulkim/Blokee/…`). The resumed session has to be told
the repo now lives somewhere else.

A fresh session works just as well, because everything it needs is in the repo: start `claude` in
the clone and say *"read docs/E4_RUNBOOK.md and research_paper/v6_* and run E4"*.
