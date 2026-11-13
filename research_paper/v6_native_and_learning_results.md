# v6 — native engine, scaled self-play data, and learned priors: results

Measured 2026-10-18 against the gates fixed in `v6_native_and_learning_preregistered.md`. Every
match here is played by the native engine (`engine-rs/`), which makes the same decisions as the TS
engine bit for bit; scores come from the TS statistic (`scripts/aggregateMatches.ts`).

## Scoreboard

| Experiment | Measured | Gate | Verdict |
|---|---|---|---|
| E0 native engine | parity on all fixtures, 40/40 and 8/8 identical cross-engine games, mirror 0.00; 5.1–5.9× per iteration | exactness | **pass** |
| Settle fix, screen | +0.29 [0.17, 0.43], 200 seeds | CI lower bound > 0 | **pass** |
| Settle fix, confirmation | +0.27 [0.14, 0.42], 200 fresh seeds | same verdict | **pass — promotable** |
| E1 data scaling, `conv-small` | KL 0.494 → 0.488 from 1k to 18.5k games | ≥ 0.02 nat improvement | **closed: not data-limited** |
| E2 architecture | `resnet` KL 0.338; `vit-patch` 0.464; `vit-cell` 0.545 | lowest KL | **`resnet` selected** |
| E3a root prior, blend 0.25 | +0.18 [−0.56, 0.95], 100 seeds | mean ≥ +0.50, CI lower > 0 | **null** |
| E3a root prior, blend 0.5 | +0.24 [−0.53, 1.03], 100 seeds | same | **null** |
| E4 expert iteration, final | +0.83 [0.30, 1.37], 200 seeds | mean ≥ +0.50, CI lower > 0 | **pass — candidate** |
| E4 expert iteration, confirmation | +0.41 [−0.11, 0.94], 200 fresh seeds | same verdict | **fail — not confirmed** |
| E4 powered confirmation (addendum) | +0.39 [0.14, 0.65], 800 fresh seeds | mean ≥ +0.50, CI lower > 0 | **real but below the bar** |

## E0 — the native engine

Per-iteration cost on the benchmark's fixed positions (`v4.1-ultra` params, M4 Pro, one thread):

| Phase | TS µs | native µs | speed-up |
|---|---:|---:|---:|
| opening | 145 | 24.6 | 5.9× |
| midgame | 125 | 22.0 | 5.7× |
| late | 94 | 17.2 | 5.5× |

Data production went from ≈780 to 5,500–8,800 `v4.1-ultra` games per hour. The lower figure is the
full 20k run, which shared the CPU with other work for part of its 3.6 hours. The 20,000-game E1
corpus (1,450,867 positions; 1,199,301 searched with every root child's visit count) would have
taken about 26 hours in TS.

## The settle bug and its fix

`V12Search.iterate` (TS, and the faithful port) replays a node's cached seat-settling only while
the node is uninitialised. On a later visit, a move generated for `node.turn` is applied while
`position.turn` still points at a seat that was settled out, so part of the tree describes
positions that cannot occur. `search.replaySettle: true` re-applies the cache on every descent.

`v4.1-ultra-settlefix` (registered in `src/ai/versions/v4.ts`; the TS and native engines agree on
it) beats `v4.1-ultra` by +0.29 [0.17, 0.43] and +0.27 [0.14, 0.42] on two disjoint 200-seed blocks.
Its CI is far tighter than E3a's because the two engines share almost every decision, so seats are
strongly paired. The effect is small but real. It is a bug fix rather than a tuned parameter, so it
should transfer to every version built on `V12Search`; only `v4.1-ultra` was measured.

## E1 — the v4 ceiling was the trunk, not the data

Test split: games 19,000–19,999 (32,351 searched positions with a policy target).

| Arm | Train games | Params | Policy KL | Top-1 | Top-5 | Value R² | Ownership |
|---|---:|---:|---:|---:|---:|---:|---:|
| conv-small | 1,000 | 13k | 0.494 | 36.1% | 76.6% | 0.273 | 69.3% |
| conv-small | 5,000 | 13k | 0.488 | 36.5% | 77.0% | 0.280 | 69.4% |
| conv-small | 18,500 | 13k | 0.488 | 36.6% | 77.3% | 0.277 | 69.4% |
| resnet | 5,000 | 1.56M | 0.366 | 46.1% | 86.3% | 0.333 | 72.5% |
| resnet | 18,500 | 1.56M | **0.338** | **48.1%** | **87.8%** | **0.397** | **72.8%** |

Under the preregistered reading, scaling data for the v4-class model is closed: 18.5× more games
buy 0.006 nats. The same data is clearly *not* exhausted for a larger trunk. The ResNet gains 0.028
nats and 0.064 R² from 5k to 18.5k, so it remains data-hungry at this scale.

## E2 — attention lost at matched compute

| Arm | Params | Steps | GPU min | Policy KL | Top-1 | Value R² | Train pos/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| resnet (w96, 8 blocks, global pooling) | 1.56M | 8,000 | 98 | **0.338** | **48.1%** | **0.397** | 1,352 |
| vit-patch (2×2, d192, 6 layers) | 2.80M | 6,000 | 113 | 0.464 | 38.3% | 0.345 | 909 |
| vit-cell (400 tokens, d128, 6 layers) | 1.31M | 3,000 | 105 | 0.545 | 33.5% | 0.281 | 1,336 |

Every arm got about the same wall clock; the preregistration estimated 45–50 minutes and the real
cost was about twice that. Within that budget the transformers saw 2.7–5.3× fewer samples than the
ResNet and were still improving when they stopped, so this is a matched-compute result, not a claim
about their asymptote. On this hardware, at this data size, the convolutional inductive bias wins.
Global context is still needed: the 13k-parameter 3×3 trunk is far behind both. The ResNet's
global-pooling blocks supply that context more cheaply than attention does.

## E3a — a much better prior moves the root channel by about the same amount

The ResNet agrees with the 4,800-iteration search's chosen move 48% of the time and puts it in its
top five 88% of the time. Yet blending it into `v4.1-ultra`'s root prior measured +0.18 and +0.24. That is the same band as
every earlier root-prior result (+0.12 to +0.20). Prediction quality was not the limiting factor:
at 4,800 iterations per move the root's visit distribution is decided by the rollouts, and the
prior only reorders the first few hundred visits. The network is called once per searched move (the
server averaged 35 calls/s across 10 match threads), and the matches took no longer than prior-free
ones.

## E4 — expert iteration (2026-10-18): screen passes, confirmation does not

Run as preregistered in the addendum, with every default in `docs/E4_RUNBOOK.md`. It started from
`resnet-g18500-s0.pt` with `v4.2-ultra` as the search: 8 generations × 2,000 self-play games at
base 300, 4,000 steps per generation, a replay window of 3, the 20k corpus as base data, and blend
0.5 at temperature 1.

**Machine.** WSL2 Ubuntu 26.04, x86-64, 16 threads (15 used), RTX 4080 with CUDA (torch
2.14.1+cu130), rustc 1.99.1.
- All 8 parity tests pass on x86-64.
- The base corpus was regenerated here with the runbook's command (step 3b, 182 min). It has
  1,450,853 positions, against 1,450,867 on the Mac, so these games are not bit-identical to the
  Mac's. This is the cross-platform caveat in the runbook; no "identical replay" claim crosses
  machines.
- Each generation took about 26 minutes (the Mac estimate was about 45). E4 ran 17:53–21:40.

| Gen | Gate (50 seeds) | Kept | Test KL* | Top-1* |
|---:|---|---|---:|---:|
| 0 → ei-gen1 | +0.11 [−0.72, 0.96] | yes | 0.252 | 60.1% |
| 1 → ei-gen2 | +0.55 [−0.64, 1.80] | yes | 0.246 | 59.0% |
| 2 → ei-gen3 | +0.54 [−0.60, 1.81] | yes | 0.240 | 61.6% |
| 3 → ei-gen4 | +0.18 [−0.82, 1.31] | yes | 0.228 | 61.0% |
| 4 → ei-gen5 | +0.32 [−0.64, 1.30] | yes | 0.225 | 63.2% |
| 5 → ei-gen6 | +0.19 [−0.85, 1.24] | yes | 0.226 | 62.0% |
| 6 → ei-gen7 | −0.09 [−0.89, 0.72] | no | 0.230 | 61.4% |
| 7 → ei-gen8 | −0.94 [−1.89, 0.10] | no | 0.227 | 62.0% |

\* On each generation's own held-out self-play games. These are not comparable to E1/E2's test
split, and only loosely comparable across generations, because the targets move with the network.

No gate was individually significant. As fixed in advance, the gates only set the path: six
generations were kept, and the last two were rejected, so the final network is `ei-gen6`.

**Result.** `ei-gen6` was served as the root prior of `v4.2-ultra` against plain `v4.2-ultra`.

| Block | Seeds | Advantage | First place | Verdict |
|---|---|---|---:|---|
| Final (screen) | 74,000,000–74,000,199 | **+0.83 [0.30, 1.37]** | 30.9% | pass |
| Confirmation | 74,100,000–74,100,199 | **+0.41 [−0.11, 0.94]** | 28.2% | fail |
| Pooled, *not preregistered* | both, 400 seeds | +0.62 [0.25, 1.00] | 29.6% | descriptive only |

Under the preregistered rule E4 does **not** pass, because the confirmation block must reach the
same verdict. It is not the preregistered null either: that reading required that no generation be
accepted, and six were.

Readings, separated from the verdict:
- **The screen estimate shrank on fresh seeds**, from +0.83 to +0.41. That is what a
  winner's-curse screen looks like, and it is why the confirmation rule exists.
- **The test cannot resolve its own threshold.** At 200 seeds the minimum detectable effect is
  about 0.95. That is nearly twice the +0.50 gate, so a true effect of about +0.5 would fail a
  200-seed block more often than not.
- **The effect is probably real but smaller than the gate.** The pooled 400 seeds put the effect at
  roughly +0.6, with a lower bound of +0.25. E3a's +0.24 is in the same range, but it was measured
  against `v4.1-ultra`, not `v4.2-ultra`, so the two numbers are not directly comparable.
- **The yellow seat loses in both blocks**, at −1.83 and −1.82, while the other three seats gain
  between +0.5 and +2.0. This is worth explaining before the next run.
- **The gates trend downward after gen 4,** but every gate CI spans 0. This is consistent with,
  though not evidence for, the loop plateauing at 2,000 games per generation.

**Powered confirmation (addendum, fixed and pushed before it ran).** The addendum fixed the test
before it ran:
- the same served `ei-gen6` against plain `v4.2-ultra`;
- 800 fresh seeds, 74,200,000–74,200,799;
- an expected minimum detectable effect of 0.47.

It measured **+0.39 [0.14, 0.65]**, with first place 30.6% against a par of 25%. The mean is above
0 but below +0.50, which is the outcome the addendum labelled "expert iteration helps below the bar
this programme set, and E3b is next". E4 is therefore not promoted.

This 800-seed block is the best estimate of the effect, and it agrees with the 200-seed
confirmation (+0.41). The +0.83 screen was the high draw.

Expert iteration did move the root prior, which E3a's better offline prior had not. The result is
about +0.4 against `v4.2-ultra`, with a lower bound well above 0.

The yellow seat is negative again, at −1.97, so it has now lost in all three blocks. **This is turn
order, not the prior.** A `v4.2-ultra` mirror on the same 800 seeds (`ml/seat/results/`) puts each
seat's own effect at:

| Seat (turn order) | Mirror advantage | Mirror win share | E4 minus mirror, advantage | E4 minus mirror, win share |
|---|---|---:|---|---|
| blue (1st) | +0.01 | 27.4% | **+1.12 [0.32, 1.94]** | **+5.4 pp [1.3, 9.5]** |
| green (2nd) | +2.01 | 33.5% | −0.19 [−0.95, 0.56] | +0.3 pp |
| purple (3rd) | +0.30 | 24.5% | +0.28 [−0.39, 0.96] | +1.3 pp |
| yellow (4th) | −2.32 | 14.7% | +0.35 [−0.24, 0.96] | +0.5 pp |

Two findings come out of this:
- **E4 is neutral in yellow**, not harmful. Its gain is concentrated in blue.
- **Turn order is a large effect here.** This is the first measurement of the first-mover question
  that v4 report §5 left open. The best seat is second, not first, and the last seat wins less than
  half as often as the second.

Both comparisons are paired by seed, and neither was preregistered.

Artefacts are in `ml/torch/results/e4/`: `log.txt`, `final.txt`, `confirm.txt`, `confirm2.txt`, and every
generation's offline metrics (`ei-gen*.json`). The games and checkpoints stay on the PC under
`ml/data/expert-iteration/` (621 MB).

## What this says about the next step

1. **Promote the settle fix.** Done 2026-10-18: registered as the release `v4.2-ultra`, whose
   resolved config is identical to `v4.1-ultra-settlefix` (a native mirror between them prints 0.00).
2. **Use the network where it changes the search's value, not its root ordering.** E3b (n-step
   hybrid: a rollout for k plies, then the net's value) and E4 (expert iteration, where the search
   targets improve the network) remain open. Both are built (`ml/torch/expert_iteration.sh`).
   The ResNet's forward pass ran at 2–4k positions/s on MPS, while a full rollout iteration costs
   ≈20 µs on one core. E3b/E3c therefore need far fewer simulations per move, with leaves batched
   across concurrent games.
3. **The transformer question is not settled, only deferred.** The comparison should be re-run
   once E4 has produced ten times more data, which is the regime in which attention usually wins.

## Artefacts

- Data: `ml/data/selfplay-v41u-300/` (seeds 61,000,000–61,019,999).
- Checkpoints and metrics: `ml/torch/results/*.pt`, `*.json`.
- Matches: `selfplay-results/match-native-settlefix-200.jsonl`,
  `match-native-settlefix-confirm-200.jsonl`, `match-native-e3a-blend-{0.25,0.5}.jsonl`.

## 2026-11-12 — X1 (Pentobi), E5 (model v2), E6 (in progress)

Gates for everything here are in the 2026-11-12 entries of the preregistration. Run on the Mac
(M4 Pro). The v5 ledger is `docs/V5_TRACKER.md`.

### X1 — `v4.2-ultra` does not beat Pentobi at equal compute

Full write-up: `v5_x1_pentobi_benchmark_results.md`. Pentobi 31.0 through `blokee-pentobi`; the
validity gate passed (20/20 replays, legal-move sets equal at all 1,612 plies, scores equal to
Pentobi's minus 89), and all 1,120 scored games ran with no rules disagreement.

| Match | Advantage | First place | Pentobi ms/move |
|---|---|---:|---:|
| 1 × `v4.2-ultra` vs 3 × level 5 (40 seeds) | −2.50 [−4.01, −1.06] | 23.1% | 9 |
| 1 × `v4.2-ultra` vs 3 × level 6 (100 seeds) | **−10.68 [−11.96, −9.41]** | 8.8% | 54 |
| 1 × level 6 vs 3 × `v4.2-ultra` (same seeds) | +5.56 [4.59, 6.59] for Pentobi | 49.5% | 72 |
| 1 × `v4.2-ultra` vs 3 × level 7 (40 seeds) | −15.66 [−17.18, −14.10] | 3.1% | 590 |
| level 9, stopped after 16 games (descriptive) | −25.10 [−32.50, −17.71] | 0% | ≈9,900 |

`v4.2-ultra` spends about 62 ms and 4,800 iterations per move. Level 6 runs about 3,900 new
simulations per move (7,100 at the root with its reused subtree), measured on 4 Pentobi self-play
games, so level 6 is the equal-compute opponent. Under the preregistered rule `v4.2-ultra` does
not beat it: all three parts fail.

D1 (`v5_d1_game_anatomy.md`, descriptive) locates the gap: squares are level through round 9 while
territory and legal moves fall behind from rounds 4–5; on a seat's moves 3–8 the move Pentobi
level 7 would play is inside Blokee's 40-move root shortlist only 42–45% of the time.

### E5 — model v2 (offline; prediction quality only)

`resnet2-b8w96` (1.57M parameters): the E2 trunk with an absolute-seat input and heads for policy,
soft policy, margins, a 4 × 3 utility block, the search's `root_value`, and ownership. Trained as
preregistered on base games 0–18,499; 15,000 steps at batch 512 took 2.9 h on MPS. Loss weights:
policy 1, soft policy 1, margins 1, utility margin 0.5, rank 0.5, first 0.25, search value 2
(Huber), ownership 0.25.

| Test (base games 19,000–19,999) | `resnet` (E2) | `resnet2-b8w96` |
|---|---:|---:|
| Policy KL | 0.338 | 0.336 |
| Top-1 / top-5 | 48.1% / 87.8% | 48.4% / 87.8% |
| Margin R² (mover) | 0.397 | 0.406 |
| Ownership accuracy | 72.8% | 72.7% |
| Search-value R² | – | 0.872 |
| Brier skill, mover: margin / rank / first | – | 0.366 / 0.378 / 0.328 |

- Validation loss was lowest at step 6,000 (7.2148) and rose to 7.2895 by step 15,000, so the
  saved checkpoint is the step-6,000 one. On this corpus the arm stops benefiting after about a
  third of the run.
- The soft-policy target is nearly uniform on this corpus (every candidate has visits; 0.036 nats
  from uniform), so that head carries little.
- Increment over the search's own `root_value` (linear R², 58,726 positions, bootstrap by game):
  margin head +0.061 [0.051, 0.070] on `score − mean(others)`; utility-margin head
  +0.072 [0.057, 0.085] on `score − best other`, against +0.035 [0.028, 0.042] for the margin
  head on that target. The search-value head adds almost nothing (+0.004), as expected of a head
  trained to reproduce that value.
- `ml/torch/fuel.py` reproduces the addendum's table for `resnet-g18500-s0` (0.413 / 0.448 / 0.471).

### E6 — the network inside the rollout search (screen in progress)

Implemented as preregistered (`engine-rs/src/net.rs`, `search.rs`; `docs/E6_RUNBOOK.md`).
Identity gates pass: with no `native.net` block the 8 parity tests pass, a mirror scores 0.00 and
self-play shards are byte-identical to the previous binary; `native.net` with both new channels
off plays the same 16 games as the equivalent `native.prior` config on the real protocol-2 server.

Screen (400 seeds from 76,000,000, 7 threads, shared machine), so far:

| Arm | Advantage vs `v4.2-ultra` | First place | Net positions / move | ms/move |
|---|---|---:|---:|---:|
| P0 (root prior only) | **+0.88 [0.50, 1.27]** | 31.0% | 1.0 | 81 |
| P1, V64, V512, PV | not yet read | | | |

P0 is the control. Its 800-seed confirmation on the PC is fixed in the preregistration (seeds
from 77,100,000). The screen was paused for about 8.5 hours at Paul's request and resumed; the
driver replays only incomplete chunks.

### E6-P0 confirmation (PC, 2026-11-13)

The preregistered control confirmation, read on its own and not pooled with the Mac screen.
Mac checkpoint `resnet2-b8w96-g18500-s0`, root prior only (blend 0.5, temperature 1, depth-1 blend
0, value visits 0), 800 seeds from 77,100,000, budget 300, 14 threads. 29.5 minutes.

**+0.83 [0.56, 1.09]**, first place 31.8% (sole wins 23.7%). The mean is above +0.50 and the
interval sits above 0, so the gate passes. The v2 network as a root prior is a promotion
candidate over `v4.2-ultra`. This says nothing about the depth-1 or value channels.

The challenger used 1.0 network evaluation per searched move and 136 ms/move of wall time.
Per-seat advantage: blue +1.36, green +2.36, purple +1.27, yellow −1.66.

### E5 larger arms (PC, 2026-11-13)

Three arms, each 15,000 steps at batch 512 on base games 0–18,499 plus E4 generations 0–7.
Validation on base games 18,500–18,999. Selection was lowest validation loss, with a smaller arm
winning a tie within 1% when it is at least twice as fast.

| Arm | Val loss | Best step | Test KL | Top-1 | Margin R² | pos/s | Time |
|---|---:|---:|---:|---:|---:|---:|---:|
| `resnet2-b8w96` | **7.171** | 11,000 | 0.322 | 49.9% | 0.422 | 19,214 | 37 min |
| `resnet2-b12w128` | 7.172 | 9,000 | 0.320 | 50.1% | 0.420 | 7,999 | 69 min |
| `resnet2-b16w160` | 7.172 | 8,000 | 0.319 | 50.2% | 0.422 | 3,190 | 2 h 31 min |

`resnet2-b8w96-g36k-s0` is selected. It has the lowest validation loss and is 2.4× and 6.0×
faster than the two larger arms. On the fuel table the margin head adds +0.075, +0.074 and
+0.075 R² over the search value on `score − mean(others)`, so width bought no extra signal.
These metrics are compared arm against arm on the PC corpus. The selected network does not
replace the Mac checkpoint in the E6-P0 confirmation above.

### Pentobi level 6, `ei-gen6` (PC, 2026-11-13, exploratory)

Not gated. Pentobi 31.0, opening book on, one thread per process. Validity gate passed: 20/20
replays and the pentobi-vs-pentobi game agree. Then each of `v4.2-ultra` and `ei-gen6` (E4's
final network, `native.prior` blend 0.5, protocol 1) played as the lone seat against three
level-6 seats, 100 seeds from 79,400,000, budget 300, 8 game threads. About 4 minutes per arm.

| Arm | Advantage vs level 6 | First place | Blokee ms/move | Pentobi ms/move |
|---|---|---:|---:|---:|
| `v4.2-ultra` | −9.99 [−11.05, −8.85] | 7.8% | 82 | 60 |
| `ei-gen6` | −9.58 [−10.75, −8.43] | 7.5% | 93 | 61 |

Seed-paired difference, `ei-gen6` minus base: **+0.41 [−1.00, +1.75]**. The interval includes 0,
so this does not advance. Both arms remain about 10 points behind level 6, in line with the Mac
level-6 baseline of −10.68 [−11.96, −9.41].
