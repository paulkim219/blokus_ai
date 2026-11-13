# blokee — native engine

A Rust port of the bitboard engine (`src/ai/bitboard/`) for offline work: matches, tuning and
self-play data. The TS engine remains the reference and the browser engine; this crate's first
contract is to make **exactly** the decisions the TS engine makes, so native workers drop into the
existing harness without changing any number it reports.

## What is ported

| TS | Rust |
|---|---|
| `src/ai/rng.ts` | `rng.rs` — mulberry32, same stream |
| `bitboard.ts`, `placements.ts`, `zobrist.ts`, `seats.ts`, `position.ts` | `bitboard.rs`, `placements.rs`, `position.rs` |
| `territory.ts`, `regions.ts`, `features.ts` | `territory.rs`, `regions.rs`, `features.rs` |
| `ordering.ts`, `backup.ts` | `ordering.rs`, `backup.rs` |
| `playout.ts`, `rolloutPolicy.ts` | `playout.rs`, `rollout_policy.rs` |
| `packer.ts` | `packer.rs` |
| `mcts.ts` (`V12Search`) | `search.rs` |
| `index.ts` (`searchBestMoveV12`, `rankMovesGreedyV12`), `openingSelect.ts` (heuristic) | `engine.rs` |
| `src/ai/selfplay.ts` (`playSeatedGame`) | `game.rs` |
| `scripts/tournamentWorker.ts` | `bin/blokee-worker.rs` |

Not ported, and **rejected** rather than ignored when a config asks for them
(`BitboardParams::unsupported`): learned leaf/prior networks from TS (`netPath`, `pooledNetPath`),
opening books, `treeReuse`, root ensembles, root audits, piece feasibility, iteration banking, root
grouping, sequential halving, RAVE, variance tuning, MAST and implicit max^n. 119 of the 196
registered bitboard versions use none of these — including every release and champion (v3.1, v3.2,
v3.5, v3.7, the v4.1 family); `cargo run --release --example support_report` lists the rest.

Stays in TS: the UI and browser worker, the legacy object engine (`src/engine`, `src/ai/mcts.ts`),
the version registry, and the harness's orchestration and statistics.

## Exactness

`cargo test --release` checks fixtures written by `scripts/dumpGoldens.ts` (regenerate with
`npm run native:goldens`) bit-for-bit: tables and hashes, the RNG stream, legal moves, territory,
E_i, ordering, the greedy ranker, playouts, full searches and whole seeded games. Floats are
compared with `==`.

Two V8 behaviours are reproduced explicitly in `jsmath.rs`: `Math.exp` is V8's fdlibm port **as
clang compiles it on arm64** (the polynomial is FMA-contracted), and `Math.pow` is the platform's
libm. Parity therefore holds between the two engines on the same machine, which is the same
guarantee the TS engine already gives across processes.

## Speed (M4 Pro)

| | TS | native |
|---|---:|---:|
| µs / iteration, `v4.1-ultra` params, opening / midgame / late | 145 / 125 / 94 | 24.6 / 22.0 / 17.2 |
| `v4.1-ultra` mirror, 8 games at base 300, CPU seconds | 191 | 34 |
| `v4.1-ultra` self-play at base 300, games per hour | ≈780 (8 workers) | ≈8,800 (11 threads) |

The two changes that mattered beyond the port itself, both decision-identical:

- the rollout's legality test runs on an 11×11 window around the drawn corner, packed into a u128,
  against a few hundred translation-invariant shapes instead of 13-word board masks;
- the territory BFS expands whole layers as 7×u64 bitboards.

## Binaries

```bash
cargo build --release --manifest-path engine-rs/Cargo.toml     # npm run native:build

# Harness workers: any script built on scripts/lib/pool.ts.
npm run match -- --native --challenger v4.1-ultra --champion v3.5 --iterations 300 --seeds 100
BLOKEE_NATIVE=1 npm run matrix -- ...

# Native-only matches (configs with `native` extensions), scored by the TS statistic.
engine-rs/target/release/blokee-match --challenger a.json --champion engine-rs/configs/v4.1-ultra.json \
  --seeds 100 --seed-base 72345678 --budget 300 --out selfplay-results/m.jsonl
npm run aggregate -- selfplay-results/m.jsonl

# Self-play training data (512-byte records; layout in <out>/meta.json, reader in ml/torch/records.py).
engine-rs/target/release/blokee-selfplay --config engine-rs/configs/v4.1-ultra.json \
  --games 20000 --budget 300 --threads 11 --seed-base 61000000 --out ml/data/selfplay-v41u-300

# External benchmark against Pentobi's GTP engine (X1; build and gate in docs/E6_RUNBOOK.md).
engine-rs/target/release/blokee-pentobi --blokee engine-rs/configs/v4.2-ultra.json \
  --pentobi ~/src/pentobi-build/pentobi_gtp/pentobi-gtp --mode one-blokee --level 9 \
  --seeds 100 --seed-base 79000000 --budget 300 --threads 5 --label x1a --out tmp/x1/x1a.jsonl

# Placement geometry for the Python trainers.
engine-rs/target/release/blokee-tables > ml/data/placements.json
```

`engine-rs/configs/` holds every bitboard version resolved by the TS registry
(`scripts/exportResolvedConfigs.ts`). Regenerate it whenever a version changes; never edit it.

## Native-only extensions

A config may carry a `native` block that the TS engine never sees, so such a config can only be
played natively:

```json
"native": { "prior": { "socket": "/tmp/blokee-prior.sock", "blend": 0.5, "temperature": 1.0,
                       "phase": "all", "pseudoVisits": 0 } }
```

`prior` blends a learned policy, served by `ml/torch/serve.py`, into the root PUCT prior with the
semantics of TS `netPrior`/`netPriorBlend`/`rootPriorPseudoVisits`.

`net` (experiment E6; a config carries `prior` or `net`, never both) puts a model-v2 network,
served by `ml/torch/serve.py --protocol 2`, inside the search as a second evaluator. Every rollout
is kept:

```json
"native": { "net": { "socket": "/tmp/blokee-e6.sock", "rootBlend": 0.5, "temperature": 1.0,
                     "depth1Blend": 0.0, "depth1Temperature": 1.0, "valueVisits": 0.0 } }
```

- One batched call per searched move (`net.rs`, pipelined): the root, and when either child
  channel is on, every non-terminal root child. Roots with fewer than two moves are not sent.
- `rootBlend`/`temperature`: the root prior, with the same arithmetic as `prior` (no re-sort).
  With both child channels at 0 this is exactly `prior` with phase `all` and no pseudo-visits.
- `depth1Blend`: when a root child's node is initialised, the network's policy is blended into its
  prior and its moves are stably re-sorted by the blended prior, so widening opens them in that order.
- `valueVisits` (`n_v`): in root selection only, `Q_i = (W_i + n_v·u'_i) / (N_i + n_v)`, where
  `u_i = (1−β)·margin + β·rank` for the root seat (β the search's rank blend) and
  `u'_i = clamp(root mean + u_i − mean_j u_j, 0, 1)`. Backup, widening and the move choice (by real
  visits) are unchanged.
- `blokee-match` logs the challenger's searched moves, network positions and seconds per game
  (`challengerSearches`, `challengerNetEvals`, `challengerSeconds`) and prints evaluations/move.

### Candidate generation (P4/P5, the first v5.0 port)

`candidates` changes which root moves enter the tree, the prior they get, and the value a root child
starts with. Every key is optional; absent (or `{}`) plays exactly as before (parity tests, a 0.00
mirror and byte-identical self-play; `research_paper/v5_p4_p5_candidate_generation_results.md`).

```json
"native": { "candidates": { "rootScorer": "fitted", "rootFull": true, "rootNoWidening": true,
                            "initVisits": 3, "interiorScorer": "ordering", "temperature": 1.0,
                            "model": { "features": [...], "bands": [...] } } }
```

- `rootScorer`: `"ordering"` (default: today's hand ordering) or `"fitted"` (the move-feature prior
  in `model`, `feature_prior.rs`). With `"fitted"` the root no longer goes through today's
  size/centre funnel: every legal move is scored, and the best `rootShortlist` (40) are kept unless
  `rootFull`. Priors are the scorer's softmax over the kept moves, at `temperature` for the fitted
  score and at `priorTemp` for the ordering score.
- `rootFull`: every legal root move becomes a child, sorted best first by the root scorer. With
  `"ordering"` every legal move gets today's ordering score (the split term's budget of 24 goes to
  the moves the size/centre tier ranks highest, as today).
- `rootNoWidening`: no progressive widening at the root. Every root child is selectable from the
  first iteration: an unvisited child is scored with its initial value (below) or, without
  `initVisits`, with the usual first-play value (the root mean minus `fpuReduction`), instead of being
  opened one per iteration in prior order. Interior nodes keep today's widening.
- `initVisits` (`n0`, 0 = off): value-initialised root children. In root selection only,
  `Q_i = (W_i + n0·v_i) / (N_i + n0)` with `v_i = m · sqrt(p_i / p_max)`, `m` the root's current
  rollout mean for the root seat (0.5 before the first visit) and `p` the root prior; an unvisited
  child scores `v_i`. This is the E6 `valueVisits` mixing with a prior-derived value. The virtual
  visits never count towards the move choice (real visits) or backup. **With widening on**, children
  still enter one per iteration on today's schedule (`wideningInit` + `wideningGrowth`·sqrt(N), about
  63 children by 4,800 iterations) and are visited once on entry; `n0` then only shades their Q.
  Pentobi has no widening, so the port's main arms set `rootNoWidening`.
- `interiorScorer`: `"ordering"` (default) or `"fitted"`. With `"fitted"` an interior node keeps
  today's size/centre funnel (`max(2·nodeShortlist, 48)` moves) and today's shortlist size
  (`nodeShortlist`, 24), but the fitted score chooses and orders the shortlist and gives its prior
  (softmax at `temperature`). The local-response features see the game's last placements followed by
  the moves on the tree path.
- `model`: the fitted model, inline (`ml/v5-prior-weights.json`: `features` must equal the engine's
  feature layout, one weight vector per own-move band). Fitted by `ml/p4_fit_prior.py` on features
  dumped by `examples/p4_features.rs`, which calls the same `PriorContext::features` the search does.
- The local-response features (`local_attach`, `local_near`) need the game's last three placements.
  `game::play_game_observed` (blokee-match, blokee-selfplay, blokee-worker) and the Pentobi bridge pass them with
  `Engine::set_recent` before each search; any other caller gets them as zero.
- The opening shortcut (heuristic first three own moves) and the sealed-region packer are unchanged.
- Refused in `unsupported()`: `candidates` together with `prior` or `net` (their records hold at most
  64 root candidates and E6 recomputes root-child shortlists outside the tree), unknown scorer names,
  a fitted scorer without a model, a model whose feature list does not match, negative `initVisits`,
  non-positive `temperature`.
- More than 64 root candidates elsewhere: `blokee-selfplay` keeps the 64 most-visited root children
  of a decision (its record has 64 slots and `ranked` is sorted by visits), so records stay
  well-formed but are truncated; `blokee-match`, the bridge and the worker only read the chosen move.

### Rollout policy and reward (P1–P3)

`rollout` and `reward` change what each simulation plays and what it returns. Absent (or
`{"policy": "sampled"}` / `{"kind": "blend"}`) plays exactly as before (parity tests, a 0.00 mirror;
`research_paper/v5_p1_p3_rollout_results.md`). Both blocks refuse unknown keys.

```json
"native": { "rollout": { "policy": "all", "sizeWeight": 1.3995, "localWeight": 0.7185, "localOwnExtra": 0.6515 },
            "reward":  { "kind": "rank", "qualityWeight": 0.25, "qualitySlope": 1.0, "lengthWeight": 0.1 } }
```

- `rollout.policy`: `"sampled"` (default; today: one random own corner, at most `playoutMoveCap`
  placements, uniform `playoutEps` of the time, else the table policy) or `"all"`: the mover's whole
  legal-move list, sampled with weight `exp(sizeWeight·size + localWeight·(local + localOwnExtra·localOwn))`.
  `playoutEps`, `playoutMoveCap`, `playoutCorners` and the table policy are then unused;
  `playoutCutoff` still applies.
- Local squares (`playout::local_squares`): for each opponent placement made since the mover's own
  last placement (the game's last placements, then the tree path, then the rollout), the corners it
  opened that the opponent can still use, plus their empty orthogonal neighbours not forbidden to
  that opponent. `local` counts the move's squares on that set, `localOwn` those that are also the
  mover's own open corners.
- The legal-move lists are incremental (P2, `move_lists.rs`): generated once per search at the root,
  derived from there the first time a seat moves in a rollout, then updated after every placement.
  `tests/move_lists.rs` checks them against a from-scratch generation at every ply of 7,000 random games.
- `reward.kind`: `"blend"` (default; today: `(1 − β)·sigmoid(margin over the best opponent /
  sigmoidScale) + β·rank`, β = `rankBlend` shifted by the lead) or `"rank"`:
  `v_i = rank_i + qualityWeight·tanh(qualitySlope·z_i) − lengthWeight·(rank_i − ½)·tanh(qualitySlope·z_len)`.
  `rank_i` is the fraction of opponents seat i beats (ties count half); `z_i` is i's score minus the
  mean of the other three, standardised by the running mean and deviation of that quantity over this
  search's simulations (cleared at each search, each sample added before it is standardised); `z_len`
  is the game length in placements standardised the same way. It replaces the value of every finished
  game (rollout end, terminal tree node, all seats sealed; the length term is left out where the
  packer solved a region, as its piece count is unknown). The truncated-rollout evaluation path
  (never reached at `playoutCutoff` 84) keeps the old value.
- Refused in `unsupported()`: unknown policy or kind, non-finite or out-of-range weights,
  `qualitySlope` ≤ 0, `reward` kind `"rank"` with `native.net` (its value channel uses the old
  reward's scale) or with `leafMaterialBlend` > 0.
