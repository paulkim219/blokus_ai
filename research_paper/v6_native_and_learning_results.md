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
