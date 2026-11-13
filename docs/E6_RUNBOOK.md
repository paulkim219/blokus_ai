# E6 runbook

## E6 — the network inside the rollout search

E6 tests whether a network helps more as a second evaluator inside the search than as a root prior
alone. The arms, seeds and gates are fixed in the 2026-11-12 addendum of
`research_paper/v6_native_and_learning_preregistered.md`. This section covers how to run them.

### What the engine does

The engine runs `v4.2-ultra` with a `native.net` block (see `engine-rs/README.md`, "Native-only
extensions"). For each searched move it makes one batched call to `ml/torch/serve.py --protocol 2`:

- **The root record** sets the root prior: blend 0.5, temperature 1, the same as E3a/E4.
- **One record per non-terminal root child**, sent only when a child channel is on. These feed two
  channels:
  - *Depth-1 policy* (`depth1Blend`): each root child's prior is blended with the network's, and
    its moves are re-sorted by the blended prior.
  - *Root-child value* (`valueVisits` = `n_v`): the network utility enters root selection as `n_v`
    virtual visits, re-centred on the root's rollout mean.

The move played is still the most-visited one.

### Prerequisites

- The engine is built: `npm run native:build`. The parity tests pass: `npm run native:test`.
- `ml/torch/serve.py` has `--protocol 2`, and the checkpoint is a model-v2 arm (`resnet2-*`, from
  E5). The screen's model is `ml/torch/results/resnet2-b8w96-g18500-s0.pt`.
- Optional server check: start the server, then run
  `ml/.venv-torch/bin/python ml/torch/serve.py --checkpoint <ckpt> --socket <sock> --protocol 2 --selftest`.
  It must print `SELFTEST OK`.

### Identity gates (already run at implementation; rerun after any engine change)

```bash
# 1. No native.net block: parity tests, and a v4.2-ultra mirror that prints 0.00.
npm run native:test
engine-rs/target/release/blokee-match --challenger engine-rs/configs/v4.2-ultra.json \
  --champion engine-rs/configs/v4.2-ultra.json --seeds 4 --seed-base 76900000 --budget 300 --out /tmp/m.jsonl
npx tsx scripts/aggregateMatches.ts /tmp/m.jsonl

# 2. native.net (rootBlend 0.5, depth1Blend 0, valueVisits 0) == native.prior (blend 0.5, phase all,
#    pseudoVisits 0), same checkpoint, ONE thread each so server batches cannot differ.
#    Serve it twice: --protocol 1 for the prior config, --protocol 2 for the net config.
PY=ml/.venv-torch/bin/python; B=engine-rs/configs/v4.2-ultra.json
$PY ml/torch/e6_config.py $B /tmp/id-prior.json /tmp/p1.sock prior
$PY ml/torch/e6_config.py $B /tmp/id-net.json /tmp/p2.sock net
for c in prior net; do engine-rs/target/release/blokee-match --challenger /tmp/id-$c.json --champion $B \
  --seeds 4 --seed-base 76900000 --budget 300 --threads 1 --challenger-name e6-identity --out /tmp/id-$c.jsonl; done
# Every game's scores must be equal. Stricter: blokee-selfplay both configs (1 thread) and `cmp` the shards.
```

### Smoke test (about 2 minutes)

```bash
SEEDS=4 CHUNK=2 BUDGET=10 DIR=/tmp/e6-smoke SOCKET=/tmp/blokee-e6-smoke.sock \
  zsh ml/torch/e6_screen.sh <any resnet2 checkpoint>
```

It must end with `done: /tmp/e6-smoke/summary.txt`. The numbers mean nothing at budget 10.

### The screen

```bash
nohup zsh ml/torch/e6_screen.sh ml/torch/results/resnet2-b8w96-g18500-s0.pt > tmp/e6-screen.out 2>&1 &
tail -f ml/data/e6/log.txt
```

- Serves the checkpoint once with `--protocol 2`.
- Plays P0, P1, V64 and V512 against plain `v4.2-ultra` on seeds 76,000,000–76,000,399 at budget
  300, seat-rotated (1,600 games per arm), on cores − 3 threads.
- Scores each arm with `scripts/aggregateMatches.ts`, and pairs P1, V64 and V512 against P0 with
  `ml/seat/paired_report.py`.
- Then plays PV: depth-1 policy plus whichever `n_v` had the higher mean against `v4.2-ultra`
  (64 on a tie). PV is scored and paired the same way.

**Resuming.** Each arm is played in 50-seed chunks under `ml/data/e6/<arm>/`. After an
interruption, run the same command again: complete chunks are skipped and a partial chunk is
replayed.

**Overrides.** `SEEDS`, `SEED_BASE`, `BUDGET`, `CHUNK`, `THREADS`, `DIR`, `SOCKET`, `SERVE_ARGS`
and `BASE_CONFIG` can be set in the environment. Changing seeds, budget or base config changes the
experiment.

| Path under `ml/data/e6/` | Contents |
|---|---|
| `log.txt` | timeline, per-chunk cost lines, each arm's advantage, the paired results, the PV `n_v` choice |
| `e6-<arm>.json` | the arm's config (`native.net` on `v4.2-ultra`) |
| `<arm>/chunk-<seed>.jsonl`, `<arm>.jsonl` | games (per chunk, and pooled) |
| `<arm>.txt` | `aggregateMatches` summary vs `v4.2-ultra` |
| `<arm>-vs-P0.txt` | seed-paired difference against P0 with a 95% bootstrap CI |
| `pv-nv.txt`, `summary.txt`, `serve.log` | the PV `n_v`, everything in one file, server output |

### Expected cost (M4 Pro, budget 300)

Measured with a short pilot while E5 was training on the same GPU:

| Arm | Cost per move |
|---|---|
| P0 | ≈ 83 ms, 1 network position |
| Arms with child records | ≈ 140 ms, ≈ 33 positions |

The extra time is network latency; engine CPU per move is unchanged. Expect roughly 10–15 min for
P0 and 15–25 min for each of the other arms at 11 threads, so about 1.5 h in all. It is faster
with the GPU idle.

### Reading the result

```bash
cat ml/data/e6/summary.txt
```

- **An arm advances** only if its paired Δ against P0 has a 95% CI lower bound above 0
  (`ADVANCES` in `<arm>-vs-P0.txt`).
- Among the advancing arms, the candidate is the one with the highest mean against `v4.2-ultra`.
- If no arm advances, E6 is null: the new channels add nothing over a root prior.

**Confirmation** (candidate only): 800 seeds, 77,000,000–77,000,799. It passes if the mean is
≥ +0.50 and the CI lower bound is above 0.

```bash
E=ml/data/e6; ARM=<candidate>
ml/.venv-torch/bin/python ml/torch/serve.py --checkpoint <ckpt> --socket /tmp/blokee-e6-screen.sock \
  --protocol 2 > $E/serve-confirm.log 2>&1 &
engine-rs/target/release/blokee-match --challenger $E/e6-$ARM.json --champion engine-rs/configs/v4.2-ultra.json \
  --seeds 800 --seed-base 77000000 --budget 300 --threads $(( $(getconf _NPROCESSORS_ONLN) - 3 )) \
  --label e6-confirm --out $E/confirm.jsonl
kill %1; npx tsx scripts/aggregateMatches.ts $E/confirm.jsonl
# Per-seat effects against a same-seed v4.2-ultra mirror (not gated):
engine-rs/target/release/blokee-match --challenger engine-rs/configs/v4.2-ultra.json \
  --champion engine-rs/configs/v4.2-ultra.json --seeds 800 --seed-base 77000000 --budget 300 --out $E/mirror.jsonl
ml/.venv-torch/bin/python ml/seat/seat_report.py $E/confirm.jsonl $E/mirror.jsonl
```

`blokee-match` prints network evaluations per move and ms per move at the end of every run. Report
both with the result. Record the outcome in `research_paper/v6_native_and_learning_results.md`
under a dated E6 section, with nulls reported as nulls.

## Pentobi benchmark (X1)

X1 plays the release engine `v4.2-ultra` against Pentobi, the strongest open-source Blokus engine,
through Pentobi's GTP engine. Seeds, sizes, the validity gate and the meaning of "beats" are fixed
in the 2026-11-12 addenda of `research_paper/v6_native_and_learning_preregistered.md`. The second
of them, "X1 moved from Pentobi level 9 to level 6", is the current design. Level 9 was stopped
during its timing pilot. Those 16 complete games are descriptive only and are kept in
`tmp/x1/x1-pilot.jsonl`.

**Why level 6.** A Pentobi level is a simulation count (`counts_classic` in
`libpentobi_mcts/Player.cpp`). For Classic the base counts per move are:

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Base simulations | 3 | 30 | 90 | 181 | 667 | 5,028 | 69,809 | 349,044 | 1,745,221 |

From level 4 up the count is scaled by move number (`0.7·exp(0.1·i)` for a seat's i-th move;
0.2, 0.2 and 0.3 on moves 0–2). Pentobi also reuses the subtree from its previous search and stops
early once the best move cannot change. `v4.2-ultra` runs 300 × 16 = 4,800 iterations per searched
move. In four level-6 self-play games logged with Pentobi's stderr, Pentobi ran a mean of 3,893
*new* simulations per searched move (median 3,269). Its target `MaxCnt` averaged 9,378, and root
visits including reused nodes averaged 7,077. Level 6 is therefore close to equal simulations. To
repeat that measurement, run Pentobi without `--quiet` and read the `MaxCnt` and `Sim` lines it
prints on stderr.

### Build Pentobi (third-party; outside the repo)

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/enz/pentobi.git && cd pentobi && git checkout v31.0
cmake -S ~/src/pentobi -B ~/src/pentobi-build -DCMAKE_BUILD_TYPE=Release \
  -DPENTOBI_BUILD_GUI=OFF -DPENTOBI_BUILD_GTP=ON
cmake --build ~/src/pentobi-build -j 8
~/src/pentobi-build/pentobi_gtp/pentobi-gtp --version     # Pentobi 31.0
```

`pentobi-gtp` refuses to start without either `--book <file>` or `--nobook`. The bridge passes the
Classic book from the source tree, `~/src/pentobi/opening_books/book_classic.blksgf`, so Pentobi
plays with its opening book as the prereg says. Every Pentobi process runs
`--game classic --level <L> --seed <game seed> --threads 1 --noresign --quiet --book <book>`.

### What the bridge does

`engine-rs/target/release/blokee-pentobi` (source: `engine-rs/src/gtp.rs`,
`engine-rs/src/bin/blokee-pentobi.rs`):

- **Mapping, discovered at start-up.** `all_legal 1..4` on an empty board gives each Pentobi
  colour's start corner: 1 at a20 (top-left), 2 at t20 (top-right), 3 at t1 (bottom-right), 4 at
  a1 (bottom-left). Only the **transpose** puts Blokee seat *i* on colour *i*+1, with both turn
  orders lined up and every home corner on its colour's corner. So Blokee blue ↔ Pentobi 1 (Blue),
  green ↔ 2 (Yellow), purple ↔ 3 (Red), yellow ↔ 4 (Green). The bridge then requires all four
  58-move first-move sets to agree, and prints what it found on stderr.
- **Games.** Each seed is played four times with the lone challenger in each seat, as in
  `blokee-match`. One `pentobi-gtp` process per game plays every Pentobi colour (`genmove <c>`)
  and receives every Blokee move (`play <c> <move>`). Blokee seats search with `Engine::search`
  and choose with the harness's opening sampling (`game::choose_ranked`: top 3 for the first
  8 plies).
- **Rules checks.** Before every decision the full legal-move sets are compared. A game hard-fails
  if Pentobi rejects a move, either side passes while the other has a move, the legal sets differ,
  or Pentobi's `final_score` minus 89 differs from Blokee's score. Pentobi has no pass command:
  `genmove` answers `pass` when a colour has no move, and `play` refuses illegal moves (v31.0 has
  no `accept_illegal` switch). A failed game is reported on stderr and in `<out>.failures.jsonl`,
  and never written to `<out>`.
- **Output.** `<out>` is the `blokee-match` JSONL with Blokee's own scoring. Score it with
  `npx tsx scripts/aggregateMatches.ts <out>` only. Per-move wall-clock for both engines goes to
  `<out>.timing.jsonl`. Reruns skip seed/seat pairs already in `<out>`, so a run can be restarted.
  Seeded runs repeat exactly: Pentobi is single-threaded with a fixed seed and plays by simulation
  count, not by time.

### Validity gate (must pass before any match is read)

```bash
engine-rs/target/release/blokee-pentobi --validate 20 --seed-base 79950000 --level 9 \
  --budget 300 --threads 6 > tmp/x1/validate.log 2>&1
tail -1 tmp/x1/validate.log      # VALIDITY GATE PASSED: 20/20 replays agree, pentobi-vs-pentobi agrees
```

The gate replays 20 complete `v4.2-ultra` self-play games (seeds 79,950,000–79,950,019) into
Pentobi, comparing the full legal-move sets before every ply. It then plays one game with Pentobi
in all four seats (seed 79,959,999) through the bridge. Both must end with Pentobi's `final_score`
equal to Blokee's score plus 89, which also means the same rank order. If the gate fails, X1 has
no result.

### The runs

```bash
npm run native:build
nohup engine-rs/scripts/x1-run.sh > tmp/x1/queue.log 2>&1 &
cat tmp/x1/summary.txt
```

The queue runs, in order, with 5 parallel games:

| Run | Mode | Level | Seeds |
|---|---|---|---|
| `x1-l6a` (X1-L6a) | one-blokee | 6 | 100 from 79,000,000 |
| `x1-l6b` (X1-L6b) | one-pentobi | 6 | the same 100 |
| `x1-ladder-l5` | one-blokee | 5 | 40 from 79,100,000 |
| `x1-ladder-l7` | one-blokee | 7 | 40 from 79,200,000 |

Each run is scored with `aggregateMatches` into `tmp/x1/summary.txt`. The whole queue takes well
under an hour on the M4 Pro. Level 6 costs about 55 ms per Pentobi move, against about 10 s at
level 9. Use at most 5 game threads while another match job is running.

One run by hand:

```bash
engine-rs/target/release/blokee-pentobi --blokee engine-rs/configs/v4.2-ultra.json \
  --pentobi ~/src/pentobi-build/pentobi_gtp/pentobi-gtp \
  --book ~/src/pentobi/opening_books/book_classic.blksgf \
  --mode one-blokee --level 6 --seeds 100 --seed-base 79000000 --budget 300 --threads 5 \
  --label x1-l6a --out tmp/x1/x1-l6a.jsonl
```

**Reading it.** "`v4.2-ultra` beats Pentobi level 6" means X1-L6a's advantage CI lower bound is
above 0, its first-place share is above 25%, and X1-L6b's Pentobi advantage CI does not lie wholly
above 0. That is close to equal simulations, not equal time. Report ms/move for both
engines from the `.timing.jsonl` files, together with the machine load at the time.

## Running on the PC (WSL2, RTX 4080)

Gates for these runs are in the 2026-11-12 "PC runs" entry of
`research_paper/v6_native_and_learning_preregistered.md`. The PC already has the base corpus
(`ml/data/selfplay-v41u-300`) and the E4 games (`ml/data/expert-iteration/`).

### 0. Get the code and rebuild

```bash
wsl -d Ubuntu
cd ~/Blokee && source ~/.cargo/env && export PATH=$HOME/.local/bin:$PATH
git pull --ff-only origin v6-native-engine-e4
```

- If WSL cannot reach GitHub, pull in the Windows checkout (`C:\Users\paulk\Documents\Blokee`)
  and then, inside WSL, `git pull --ff-only /mnt/c/Users/paulk/Documents/Blokee v6-native-engine-e4`.

```bash
npm run native:build && npm run native:test      # 8 parity tests must pass
```

### 1. v7 seat confirmation (independent; about 2 h; needs no new code)

```bash
bash ml/seat/confirm_v7.sh > tmp/v7-confirm.out 2>&1
```

See `docs/HANDOFF_2026-10-18.md` for how to read it.

### 2. E5 larger arms on all 36k games (GPU)

```bash
PY=ml/.venv-torch/bin/python; EI=ml/data/expert-iteration
for ARM in resnet2-b8w96 resnet2-b12w128 resnet2-b16w160; do
  $PY ml/torch/train.py --arm $ARM --run ml/data/selfplay-v41u-300 \
    --extra-runs $EI/gen-0 $EI/gen-1 $EI/gen-2 $EI/gen-3 $EI/gen-4 $EI/gen-5 $EI/gen-6 $EI/gen-7 \
    --train-games 18500 --steps 15000 --batch 512 --eval-every 1000 \
    --name $ARM-g36k-s0 --out ml/torch/results > tmp/e5-$ARM.log 2>&1
done
grep -h EVAL tmp/e5-resnet2-*.log | tail -45       # validation loss per arm, per 1,000 steps
for ARM in resnet2-b8w96 resnet2-b12w128 resnet2-b16w160; do
  $PY ml/torch/fuel.py --checkpoint ml/torch/results/$ARM-g36k-s0.pt   # see --help for options
done
```

- The `.json` next to each checkpoint holds the test metrics; compare arm against arm.
- Selection: lowest validation loss; a smaller arm wins if within 1% and at least 2× faster
  (`positionsPerSecond` in the `.json`).
- Commit the selected `.pt` and all three `.json` files.

### 3. E6-P0 confirmation (800 fresh seeds)

```bash
PY=ml/.venv-torch/bin/python; mkdir -p ml/data/e6-p0-confirm; D=ml/data/e6-p0-confirm
$PY ml/torch/serve.py --checkpoint ml/torch/results/resnet2-b8w96-g18500-s0.pt \
  --socket /tmp/blokee-p0.sock --protocol 2 > $D/serve.log 2>&1 &
until [ -S /tmp/blokee-p0.sock ]; do sleep 1; done
$PY ml/torch/e6_config.py engine-rs/configs/v4.2-ultra.json $D/e6-P0.json /tmp/blokee-p0.sock net \
  rootBlend=0.5 temperature=1 depth1Blend=0 valueVisits=0
engine-rs/target/release/blokee-match --challenger $D/e6-P0.json \
  --champion engine-rs/configs/v4.2-ultra.json --seeds 800 --seed-base 77100000 --budget 300 \
  --label e6-p0-confirm --out $D/confirm.jsonl
kill %1; npx tsx scripts/aggregateMatches.ts $D/confirm.jsonl | tee $D/confirm.txt
```

Pass: mean ≥ +0.50 with the CI lower bound above 0. Use the Mac checkpoint named above, not a
PC-trained one.

### 4. Pentobi on the PC, and `ei-gen6` against level 6 (exploratory)

```bash
sudo apt install cmake g++ make            # if missing
git clone https://github.com/enz/pentobi ~/src/pentobi && git -C ~/src/pentobi checkout v31.0
cmake -S ~/src/pentobi -B ~/src/pentobi-build -DCMAKE_BUILD_TYPE=Release \
  -DPENTOBI_BUILD_GUI=OFF -DPENTOBI_BUILD_GTP=ON && cmake --build ~/src/pentobi-build -j
P=~/src/pentobi-build/pentobi_gtp/pentobi-gtp; B=~/src/pentobi/opening_books/book_classic.blksgf
engine-rs/target/release/blokee-pentobi --pentobi $P --book $B --validate 20 \
  --seed-base 79950000 --level 9 --budget 300 --threads 6      # must print VALIDITY GATE PASSED
```

Then, with `ml/data/expert-iteration/nets/ei-gen6.pt` served on protocol 1:

```bash
PY=ml/.venv-torch/bin/python; mkdir -p ml/data/x1-pc; D=ml/data/x1-pc
$PY ml/torch/serve.py --checkpoint ml/data/expert-iteration/nets/ei-gen6.pt \
  --socket /tmp/blokee-ei.sock > $D/serve.log 2>&1 &
until [ -S /tmp/blokee-ei.sock ]; do sleep 1; done
$PY ml/torch/e6_config.py engine-rs/configs/v4.2-ultra.json $D/ei-gen6.json /tmp/blokee-ei.sock prior
for ARM in base ei-gen6; do
  CFG=engine-rs/configs/v4.2-ultra.json; [ $ARM = ei-gen6 ] && CFG=$D/ei-gen6.json
  engine-rs/target/release/blokee-pentobi --blokee $CFG --pentobi $P --book $B --mode one-blokee \
    --level 6 --seeds 100 --seed-base 79400000 --budget 300 --threads 8 \
    --label pc-$ARM --out $D/pc-$ARM.jsonl
  npx tsx scripts/aggregateMatches.ts $D/pc-$ARM.jsonl | tee $D/pc-$ARM.txt
done
kill %1; $PY ml/seat/paired_report.py $D/pc-ei-gen6.jsonl $D/pc-base.jsonl --label "ei-gen6 vs base"
```

### Bringing results back

Commit summaries (`*.txt`, the `.json` metrics, the selected checkpoint), not the game logs, and
push from the Windows checkout as in `docs/HANDOFF_2026-10-18.md`. Add a dated line to the log in
`docs/V5_TRACKER.md` for each result.
