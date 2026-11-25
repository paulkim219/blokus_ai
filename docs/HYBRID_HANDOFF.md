# Hybrid line: handoff for a session on the PC

Written 2026-11-25 so that a Claude Code session started **on the PC** (WSL2 Ubuntu, `~/Blokee-hybrid`), with
no Mac and no memory of earlier conversations, can carry the hybrid CPU+GPU work on. Paul asked for this:
"for all the future work related to this, also upload a plan to github so that the PC can take over when
this Mac is not connected to the same internet". The operating detail (status commands, restarts, memory) is
in `docs/HYBRID_PC_RUNBOOK.md`; read both.

## Read first

1. `research_paper/v5_hybrid_cpu_gpu_plan.md`: the plan (stages H0–H6, fairness, the GPU-share idea in §4b).
2. `research_paper/v5_hybrid_preregistered.md`: every stage's gates, written before its measurements.
3. `research_paper/v5_hybrid_results.md`: what has been measured (H0, H1, and H2 once it finishes).
4. `engine-rs/README.md`, "Native-only extensions" → "Network v3": the engine's network options.
5. `docs/BENCHMARK.md`: the Pentobi benchmark and tiers (turbo = Pentobi level 6 time, pro = level 7).

## Standing rules (Paul's)

- **Model.** Opus (Claude Opus 5.5) writes the code and runs the experiments.
- **Paul decides.** Start, pause or resume runs only when Paul says (H2 is approved and running). Every stage after
  H2 needs his go-ahead. **Paul names versions**: never create a named config in `engine-rs/configs`; working
  configs live under `tmp/`.
- **Equal wall time** per move on the named machine is the comparison standard; report CPU and GPU cost too.
- **Preregister before any match**: gates, arms, seeds and N committed before the first game; development probes
  are listed in the prereg; no gate changes after a result is read. **Report nulls as nulls**, failures as failures.
- **Pentobi is GPL.** Use `~/src/pentobi-build/pentobi_gtp/pentobi-gtp` only as a subprocess. Never read, copy or
  translate its source, constants or tables; never build or edit in `~/src/pentobi*`.
- **Hands off:** `~/Blokee`, `~/Blokee-v6-discovery`, `~/Blokee-v6-replay` (read-only; copying data out is fine) and
  `~/Blokee/ml/.venv-torch`. Use `ml/.venv-hybrid` (`~/.local/bin/uv pip install --python ml/.venv-hybrid/bin/python …`).
- **Git.** Work on `hybrid-h2` (later stages: a new `hybrid-hN` branch from the previous one). Commit with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Paul approved pushing the `hybrid-*` branches to GitHub
  for this work (`git push github hybrid-hN`): no other branches, no force pushes, no data, checkpoints or ONNX
  files (all under the git-ignored `tmp/` and `ml/data/`), and no LAN addresses or secrets in committed files.

## Where things stand (2026-11-25)

| Stage | State | Where |
|---|---|---|
| H0 plumbing | done: ONNX export, Rust encoder, `ort` evaluator, identity, cost curve | results "H0" |
| H1 data + network v3 + engine interface | **done, every gate passed** (level-7 top-40 0.973 vs the fitted prior's 0.806; +0.96 nats per decision; value R² increment +0.144; parity ≤ 2.5e-5; weight-0 identity) | results "H1"; `tmp/h1/SUMMARY.txt`; network `tmp/h1/train/h1-A.pt`, ONNX `tmp/h1/onnx/h1-selected.fp32.onnx` |
| H2 network prior inside the v5 tree | **running** (`engine-rs/scripts/h2-chain.sh`, tmux `h2`), prereg in force (`051b98c`) | `tmp/h2/SUMMARY.txt`, `tmp/h2/chain.log`; results "H2" when done |
| H3–H6 | not started; need Paul | below |

The H1 data (`tmp/h1/data`, `tmp/h1/cache`) and checkpoints exist only on the PC (git-ignored).

## Resume after a Windows restart

Windows has restarted at night (about 04:40) more than once; nothing restarts by itself. Open the Ubuntu
terminal (or a Claude Code session in WSL) and:

```bash
cd ~/Blokee-hybrid
git status -sb                    # expect: on hybrid-h2
tmux ls                           # if "no server running": everything stopped
tail -5 tmp/h2/chain.log; cat tmp/h2/SUMMARY.txt
tmux new-session -d -s h2 "bash engine-rs/scripts/h2-chain.sh; exec bash"   # resumes: finished steps are skipped,
                                                                            # match steps continue seed by seed
```

Note the restart in `tmp/h2/chain.log` is automatic (each step logs its start); mention any interruption in the
write-up. If `SUMMARY.txt` says a step FAILED, read `tmp/h2/steps/<step>.log`, fix, and rerun the same command.

## H2 (running): what the chain does and what comes after it

Steps (`tmp/h2/steps/<step>.done` markers): build and pin the `ort` binaries → choose T for the interior arms
(`h2_calibrate.py probe-t`, recorded positions) → calibrate each arm to equal wall time (0.97–1.03 of the control,
one thread) → smoke games on development seeds → turbo screen (control, T-R50, T-R100, T-RI; 300 seeds vs level 6)
→ automatic turbo confirmation of the best cleared arm (800 seeds) → pro screen (control, P-R50, P-RI; 300 seeds vs
level 7) → automatic pro confirmation → read-out (`tmp/h2/SUMMARY.txt`, the "H2" section of the results file),
local commit, and `git push github hybrid-h2` if the PC has credentials. Roughly 14 h for the screens alone and up
to 35 h with both confirmations.

**When it finishes:**
1. Read `tmp/h2/SUMMARY.txt`. Check the results section reads correctly and add, by hand, any interruption or
   deviation (in a short paragraph under the generated block, not inside it).
2. Commit and push (`git push github hybrid-h2`; if it fails, see "GitHub access" below).
3. Report to Paul: per tier, the screen's paired differences, which arm (if any) confirmed, the in-match ms/move
   and network evaluations per move, and what that means for H3 (below). **A confirmed arm is a candidate for the
   tier's next version: Paul decides and names it.** Do not create or rename configs.

## After H2: decision points and next steps

Each stage below needs Paul's go-ahead and its own prereg (append to `research_paper/v5_hybrid_preregistered.md`,
commit before any game). Code status is stated plainly.

**H3: asynchronous batching and the value channel, then multithreading.** Plan: only if H2 confirms a gain at a
tier (if H2 is null at both tiers, ask Paul whether to stop the line or try H3's value channel anyway).
- Built: synchronous calls (`Evaluator::evaluate_moves`), the root and interior priors, the E6 value channel at the
  root's children (`valueVisits`; refused together with `initVisits`, which every v5 config uses).
- Not built: an evaluation queue shared by search threads and games; a "pending" node state with WU-UCT
  accounting in selection; the network value mixed into interior nodes' statistics (n_v virtual visits,
  re-centred on siblings as in E6); multithreaded search (tracker N12; needs a CPU-only control with the same
  threads); CUDA graphs or fixed batch sizes (H0: 0.5 ms vs 1.2 ms per batch-1 call) with a parity check.
- Decision for Paul: which knobs to screen (T, λ or n_v, threads) and at which tier.

**H4: self-improvement (expert iteration).** Only if H2 or H3 confirms a gain.
- Built: `blokee-selfplay --format v3` plays any config, including one with `native.net`; `train_v3.py` trains
  network v3 on v3 caches (`h1_data.py build`).
- Not built: warm start in `train_v3.py` (an `--init` option), Gumbel root sampling, the generation loop and the
  fixed-anchor scoring of checkpoints. Decision for Paul: compute budget (days of PC time) and anchors.

**H5: the browser.** `onnxruntime-web` (WebGPU, WebAssembly fallback) in the app's worker; the app runs the TS engine
and v5.x is native-only (`engine-wasm/`). Mostly Mac work; needs the Mac and Paul.

**H5b: equal-strength GPU mixes per tier** (Light / Balanced / Heavy, plan §4b) with non-inferiority tests (lower
bound above −0.5 on 800 fresh seeds) and the Auto calibration in the engine and the app. Not built.

**H6: the v5.5 decision.** Paul's call, using the plan's rule.

## Seeds

Used: H1 105,100,000–105,401,513; H2 105,490,000, 105,500,000–299, 105,590,000, 105,600,000–299,
105,700,000–799, 105,800,000–799. Reserved: 110,000,000–110,299,999 (squeeze benchmark). Before choosing new
blocks, grep `research_paper/*prereg*`, `docs/V5_TRACKER.md` and `docs/BENCHMARK.md`; 106,000,000 and up looked
free on 2026-11-25.

## GitHub access from the PC

The PC checkout has two remotes: `origin` (the PC's bare repo `~/blokee-hybrid.git`, which the Mac also uses) and
`github` (`https://github.com/paulkim219/blokus_ai.git`). On 2026-11-25 the PC had **no GitHub credentials**
(`git push --dry-run github` asked for a username; `gh` is not installed). For the PC to push, Paul must set one up,
for example:

```bash
sudo apt install gh && gh auth login        # choose GitHub.com, HTTPS, and "Login with a web browser"
gh auth setup-git                           # lets git use gh's credentials
git push --dry-run github hybrid-h2         # check
```

(or add an SSH key in GitHub's settings and switch the remote to `git@github.com:paulkim219/blokus_ai.git`). Until
then, commits stay local on the PC and someone pushes them from another machine (`git fetch` from the PC's bare
repo, then push).

## How to report to Paul

Commit the results (the chain does this for H2), push the `hybrid-*` branch to GitHub, and send Paul a short
summary: what ran, each gate or screen with its number and pass/fail (nulls as nulls), deviations, and the
decision that is now his. Keep the write-ups in `research_paper/v5_hybrid_results.md` factual and dated.
