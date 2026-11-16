# Squeeze benchmark — runbook for the PC

The design and the fixed selection rules are in `docs/SQUEEZE_BENCHMARK.md`. Everything here runs on
the CPU under WSL2; the GPU is not used. Run every stage on the same machine: never pair results from
the PC with results from the Mac.

## 0. One-time setup

```bash
cd ~/Blokee                      # wherever the repo lives on the PC
git fetch origin
git checkout squeeze-benchmark
git pull --ff-only origin squeeze-benchmark

# Rust (skip if cargo already works)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source ~/.cargo/env
cargo build --release --manifest-path engine-rs/Cargo.toml
cargo test --release --manifest-path engine-rs/Cargo.toml      # every test must pass

# Pentobi's GTP engine, built from Pentobi's own source outside the repo (it is only run as a
# separate process; none of its code goes into Blokee). Same release as the Mac: v31.0.
sudo apt-get install -y build-essential cmake git
mkdir -p ~/src && cd ~/src
git clone https://github.com/enz/pentobi.git && cd pentobi && git checkout v31.0 && cd ..
cmake -S pentobi -B pentobi-build -DCMAKE_BUILD_TYPE=Release -DPENTOBI_BUILD_GUI=OFF -DPENTOBI_BUILD_GTP=ON
cmake --build pentobi-build -j"$(nproc)" --target pentobi-gtp
ls ~/src/pentobi-build/pentobi_gtp/pentobi-gtp ~/src/pentobi/opening_books/book_classic.blksgf
cd ~/Blokee
```

If cmake asks for a missing package, install the one it names and run cmake again. The runner looks
for Pentobi in the two paths above; set `PENTOBI=` and `BOOK=` if you put them elsewhere.

**Threads and memory.** `THREADS` defaults to the core count minus 2. Each thread plays one game. An
adversary at the pro budget keeps a search tree of up to about 1.5 GB, so use at most
(RAM in GB − 4) / 1.5 threads at that budget. For example, with 32 GB use at most 18 threads. WSL2
gets half the PC's RAM by default; `free -g` shows what it actually has.

## 1. Smoke test (about 2 minutes)

```bash
THREADS=4 engine-rs/scripts/squeeze-run.sh smoke
```

It plays 12 games and compares them with the Mac's (`research_paper/squeeze_runs/smoke-reference`).
"SAME GAMES" means the PC reproduces the Mac exactly. "DIFFERENT GAMES" is acceptable, because
floating-point library differences between macOS and Linux can change a rare decision, but then
results from the two machines must never be paired. Either way, commit and push the smoke folder.

## 2. Stage S1: which adversary arm (roughly 0.5–1.5 h on 16 threads)

```bash
engine-rs/scripts/squeeze-run.sh S1
git add research_paper/squeeze_runs/S1 && git commit -m "Squeeze S1: adversary arm screen" && git push origin squeeze-benchmark
```

That is 4 arms × 8 targets × 100 games. The last lines of `research_paper/squeeze_runs/S1/selection.md`
name the selected arm.

## 3. Stage S2: which budget (roughly 1.5–3 h on 16 threads)

```bash
engine-rs/scripts/squeeze-run.sh S2 <ARM from S1>          # e.g. S2 SQP
git add research_paper/squeeze_runs/S2 && git commit -m "Squeeze S2: adversary budget" && git push origin squeeze-benchmark
```

The selected arm runs at the level-6, 4× level-6 and pro budgets, 8 targets × 100 games each.
`research_paper/squeeze_runs/S2/selection.md` names the budget and gives the freeze command.

## 4. Freeze squeeze-v1

```bash
engine-rs/scripts/squeeze-run.sh freeze <ARM> <BUDGET>     # e.g. freeze SQP l6x4
git add engine-rs/configs/squeeze-v1.json engine-rs/configs/squeeze-v1-ordinary.json
git commit -m "Freeze squeeze-v1 = <ARM>-<BUDGET>" && git push origin squeeze-benchmark
```

## 5. Stage S3: the benchmark (about 1 h at the level-6 budget, 3 h at 4×, 7 h at pro, on 16 threads)

```bash
engine-rs/scripts/squeeze-run.sh S3
git add research_paper/squeeze_runs/S3 && git commit -m "Squeeze S3: benchmark scores" && git push origin squeeze-benchmark
```

That is 12 targets × 400 games, plus the two validity-check cells. `research_paper/squeeze_runs/S3/scores.md`
holds the score table and validity check 1.

## Restarting

Every stage can be restarted with the same command. Finished cells are skipped, and an unfinished cell
is deleted and played again. If a cell stops with `INCOMPLETE` or `HARD FAIL`, its log line says why.
The usual causes are Pentobi not found, or memory exhausted at too many threads.

## Time estimates

These estimates come from the Mac under load: the adversary takes about 0.1 s per move at the level-6
budget and about 1 s at pro, and it makes about 55 moves per game. The first cell of each stage prints
its pace, so check after about 10 minutes and extrapolate.
