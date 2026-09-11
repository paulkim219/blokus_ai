# Blokee

Browser-based Blokus analysis coach. Reconstruct a four-player game, replay every move, and review where your placements were best or blunders.

## Features

- Fixed Blokus layout: Blue (top-left), Yellow (top-right), Purple (bottom-right), Green (bottom-left)
- Place moves for all four players to mirror a real game
- Choose your seat color; only your moves are coached
- Suggestions toggle (off by default)
- After your move: brief **Best** or **Blunder** chip only
- With suggestions on: ghost preview + one-line tip
- Post-game timeline with jump-to-move review and recommended alternatives

## AI engine

Client-side **MCTS + heuristics** in a Web Worker:

- Corner access / mobility
- Opponent restriction
- Territory and center pressure
- Move-quality classification vs the search root

Engine versions are configs in [`src/ai/algoVersions.ts`](src/ai/algoVersions.ts); `v4` ships by
default and `v11` is the measured champion (CEM-tuned Voronoi territory, phase-scheduled weights,
PUCT with heuristic priors, root widening, exact endgame packing).

**`v12` is a second engine, not a config.** It implements
[`research_paper/blokus_ai_research_report_v3.md`](research_paper/blokus_ai_research_report_v3.md)
in [`src/ai/v12/`](src/ai/v12/): bitboards with precomputed placement masks, multi-player MCTS with
a max^n vector backup and sigmoid-margin values, Voronoi territory with a turn-order tie-break,
articulation-point Δsplit ordering, phase × seat weight vectors, and an exact packer for sealed
regions. It hangs off one field (`engine: 'v12'`), so every existing harness reaches it unchanged.
It is **unmeasured**. See [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md) for what each version changed
and what it measured.

`src/engine/` is untouched by v12 on purpose: it is the slow reference implementation the v12 move
generator is tested against.

**The historical `v3.5-*` candidate workstreams are closed.** A *committee*
([`src/ai/committee.ts`](src/ai/committee.ts)) that lets a second, independently fitted evaluation
arbitrate the root children one search left tied, and an *aggression dial*
(`aggressionScale`) that scales every opponent-directed term between "finish my own pieces"
and "cost them more than it costs me". Both ship inert — `band: 0` and `aggressionScale: 1` reproduce
`v3.1-pro-max` byte-for-byte.

The committee stopped at its pre-registered gate: pooling ranks lands *below the best single voter*
under both judges, so the layer makes contested decisions worse rather than better. The dial is
measured across its whole range and the shipped value is already the optimum — λ of 0 costs
−0.90 [−1.65, −0.11] and λ of 2.5 costs −0.60 [−1.15, −0.02], both against `v3.1-pro-max` at 200
seeds. Neither has ever played `v3.2`, and neither is a candidate. See
[`docs/ALGORITHMS.md`](docs/ALGORITHMS.md).

**The promoted `v3.5` family moves the same iteration budget to different points in a seat's 21 moves.**
`search.iterationShape` makes the formerly flat budget a curve, and a shape summing to 21
redistributes it without spending more. The promoted curve beat `v3.2-pro` by +1.20 [0.39, 1.98]
and reproduced at Pro Max by +0.80 [−0.01, 1.67]; pooling the two preregistered 100-seed blocks gives
**+1.00 [0.43, 1.58]** over 800 games. The fitted-from-probes shapes failed; the hand-authored curve
already present in the time manager was the one that survived. Fresh tier transfers also passed at
Lite (+1.18 [0.27, 2.08]) and regular (+1.23 [0.44, 2.04]). The canonical configs are `v3.5-lite`,
`v3.5`, `v3.5-pro`, and `v3.5-pro-max`; `v3.6` is reserved for the next independently measured
mechanism. See [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md).

Two online follow-ups were then tested for `v3.6-pro` against `v3.5-pro`, and neither cleared the
fresh 40-seed +0.50 gate. Fixed-pool dynamic iteration banking measured +0.36 [−0.91, 1.72]; a
phase-gated `v2-pro` one-ply selector measured −0.53 [−1.67, 0.67]. Their 100-seed blocks were not
run. No canonical `v3.6-pro` is registered; the exact experiment ids remain available for replay.

## Measuring a version

Matches are seat-rotated, seeded, and run in parallel across worker processes. The reported
statistic is the challenger's score minus the mean of the three champion seats, averaged over the
four seat rotations of each seed — a statistic whose null is exactly zero, so a mirror match must
print `0.00`.

```bash
npm run match -- --challenger v12 --champion v11 --policy greedy --seeds 400
npm run match -- --challenger v12 --champion v11 --policy mcts-bench --iterations 300 --seeds 40
npm run match -- --challenger v12 --champion v12 --policy greedy --seeds 20   # must print 0.00
```

Localise where a version loses, rather than just how much (the paper's Tier 2):

```bash
npm run oracle-loss -- --version v12 --games 8 --iterations 300 --oracle-iterations 3000
```

Tune hyperparameters with the cross-entropy method, then validate on held-out seeds:

```bash
npm run tune  -- --base v10 --champion v1  --space eval     --generations 20
npm run tune  -- --base v12 --champion v11 --space v12-eval --generations 20
npm run match -- --challenger-file tuning/tune-<id>-best.json --champion v11 --seed-base 7777777
```

**Held-out means held out.** The tuner draws generation `g`'s seeds from `g * 100_000 + i`, so any
seed base that is a multiple of 100,000 below the generation count is *not* held out — the long-used
`--seed-base 900000` overlaps generation 9. Use a base outside that lattice.

Generation-best fitness is optimistically biased by selection and must never be quoted as a result:
in the v12 tuning run the best generation reported +1.16 against v11 and the held-out validation of
that same config returned −1.12.

Fit evaluation weights by regression on self-play outcomes:

```bash
npm run collect-features -- --version v1 --games 800
npm run fit-value -- --in tuning/features-<id>.jsonl --base v10 --late-only
```

## The full crosstable

Every version against every other, one challenger against three clones of an opponent:

```bash
npm run matrix -- --seeds 100 --iterations 300 --workers 8
npm run matrix:render -- selfplay-results/matrix.json selfplay-results/matrix-report.html
```

Cells are played cheapest-first and written to `matrix.json` the moment each lands, so an
interrupted run leaves a usable partial matrix. Re-running skips any cell that already has at least
the requested seed count — which is also how to fill the remaining cells at lower precision when
there is not time to play them all in full: run again with a smaller `--seeds`. The renderer notches
the reduced-precision cells so a reader can see which measurements are the less certain ones.

The diagonal is never played. A mirror match cancels to exactly zero by construction, so it is
filled in as the harness's own validity check.

## The learned evaluation (v4)

`v4` replaces the hand-written leaf evaluation with a network distilled from v2-pro and v3.1 search.
**It does not beat either of them** — see `docs/ALGORITHMS.md` for the measurements and the
diagnosis. The pipeline is kept because the diagnosis is reusable, not because the model is.

```bash
# 1. Export sibling groups: one search node's candidate children with the teacher's values.
npm run export-training -- --teachers v2-pro,v3.1 --games 400 --iterations 300 --top-k 12

# 2. Train (TensorFlow, in ml/.venv). Shards from parallel exports merge with disjoint groups.
npm run train-v4 -- --data ml/data/train,ml/data/train-8200000 --out ml/v4-weights.json

# 3. Play it.
npm run match -- --challenger v4-prior --champion v3.1 --seeds 100 --iterations 300
```

Two diagnostics worth running before trusting any distillation result:

```bash
# How consistent is the target? v3.1 at 300 iterations picks the same best move only 25.8% of
# the time when the same position is searched twice — which caps what any student can score.
npm run teacher-noise -- --version v3.1 --games 5 --iterations 300

# Is the ceiling the features or the task? Trains an MLP, a convnet on the raw board, and both.
npx tsx scripts/exportTraining.ts --games 60 --iterations 300 --planes --out ml/data/planes
ml/.venv/bin/python ml/probe_spatial.py --data ml/data/planes
```

TensorFlow lives in an isolated venv (`ml/.venv`) on purpose: the system install crashes on import
because its protobuf 6.x is incompatible with TF 2.20's C++ static initialisers.

## Development

```bash
npm install
npm run dev
```

Other commands:

```bash
npm run build
npm test
npm run preview
```

## Usage

1. Start a session and pick your color.
2. On each turn, select a piece from the active tray, rotate/flip if needed, and click the board to place it.
3. Enter opponent moves the same way as turns advance Blue → Green → Purple → Yellow.
4. Click a piece to open the manipulator: flip/rotate, set the pin on a square, then click the matching board square.
5. Toggle suggestions when you want live recommended placements.
6. End the game to open the timeline and inspect flagged moves.

## Live sync

Blokee cannot read other Chrome tabs by itself. Use the bundled extension to mirror a live game (Board Game Arena or [blokee.mattle.online](https://blokee.mattle.online)):

1. `npm run dev` and open Blokee.
2. Load [`extension/`](extension/) as an unpacked Chrome extension (see [`extension/README.md`](extension/README.md)).
3. Open the live Blokus tab and turn **Live sync** on under the win-odds bar.

Remote placements (and passes when the active seat advances) are applied automatically. Classic / BGA red maps to Blokee purple.

## Live CPU eval

Supervised 1-human vs 3-CPU games on mattle (headed Playwright — not a unit test):

```bash
npm run live-cpu-eval:install   # once
npm run live-cpu-eval -- --manual-lobby
```

Create a 3-CPU game in the opened window. The script detects your seat and prints each suggestion as an ASCII grid (`#` = covered squares).

Coordinates: **x is column** (0 = left, Blue’s corner), **y is row** (0 = top, Blue’s corner). `(7,4)` means column 7, row 4. If you write (row, column), that same square is `(4,7)`.

```bash
npm run selfplay -- --hero mcts-short --opponents greedy --games 50
```
