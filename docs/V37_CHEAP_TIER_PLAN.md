# v3.7 workstream E — rebuild the cheap end of the frontier

## The observation

`hanni-3-1-nano` is the cheapest point on the published frontier and the only one still built on
v3.1-era choices:

| ms/move | Δ vs greedy | model | rollouts |
|---:|---:|---|---|
| 65 | **9.81** | `hanni-3-1-nano` | truncated at 12 plies |
| 75 | **16.03** | `hanni-3-5-lite` | full length |

`MEASURED` `docs/ALGORITHMS.md` prices full-length rollouts against 12-ply truncation at **+4.7 to
+6.9 points**. The observed nano-to-Lite gap is **6.2 points for a 13% cost saving** — squarely inside
that range, and almost certainly the same effect.

`STRUCTURAL` So the cheapest tier buys its speed with the single most expensive thing the engine can
give up. Truncation was the lever available when nano was defined; the truncation penalty was measured
afterwards, and nano was never revisited.

## The hypothesis

Buy the same speed with **fewer full-length iterations** instead. `iterationScale` already exists and
already scales below 1; no new code is required.

`ESTIMATE` At the ≈2.5 points-per-doubling rate that holds near 300 iterations:

| config | iterations | est. ms | est. Δ | against nano (65 ms / 9.81) |
|---|---:|---:|---:|---|
| `v3.5-lite` @ scale 0.70 | 210 | ~52 | ~14.7 | cheaper **and** ~5 points stronger |
| `v3.5-lite` @ scale 0.50 | 150 | ~38 | ~13.5 | cheaper **and** ~3.7 points stronger |
| `v3.5-lite` @ scale 0.35 | 105 | ~26 | ~12.2 | cheaper **and** ~2.4 points stronger |

These are extrapolations from a rate, not measurements, and the rate itself is an estimate from two
points. But the predicted margin is 2–5 points against a 13% cost difference, which is far outside
what the uncertainty in that rate can erase. The direction is not seriously in doubt; the magnitude is.

## Protocol

Run **after** workstream D, because D changes ms/move at every tier and the whole comparison here is
at matched wall clock.

1. Measure ms/move for `v3.1-nano` and for `v3.5-lite` at scales {0.70, 0.50, 0.35} using
   `scripts/benchBitboard.ts`. Pick the scale whose measured ms/move is **at or below** nano's.
2. That single config plays `v3.1-nano` at 100 seeds. One config, one block — this is a Pareto claim,
   not a sweep, and sweeping in matches is how this project has repeatedly selected noise.
3. Promotion is by the master plan's rule F (Pareto dominance): **not weaker at strictly lower measured
   cost**, or stronger at no greater cost. A candidate that is cheaper *and* several points stronger
   dominates outright and needs no equal-compute control, because there is no extra compute to control
   for.
4. If it promotes, it replaces nano as the cheapest published tier, and
   `scripts/hanniGreedyTrajectories.ts` runs for the new config.

## What this is not

`STRUCTURAL` This is not an argument that truncation is always wrong — it is an argument that
truncation is the wrong way to reach *this* cost point, given a measured penalty of 4.7–6.9 points
against a 13% saving. A truncated config could still win somewhere far cheaper than any tier currently
published, where the iteration count needed for full rollouts becomes too small to search at all.
That is a separate question and is not part of this workstream.

## Result — resolved without a match

`MEASURED` The optimisation pass (workstream D) settled this arm before any sweep was run. Re-measuring
every bitboard model against greedy after the speedup:

| model | old ms | new ms | change | Δ vs greedy |
|---|---:|---:|---:|---:|
| `hanni-3-1-nano` | 65 | **56** | **−14.3%** | 9.81 [8.63, 11.05] |
| `hanni-3-1-lite` | 85 | **52** | **−39.0%** | 14.94 [13.65, 16.29] |
| `hanni-3-5-lite` | 75 | **53** | −29.4% | 16.03 [14.68, 17.40] |

**`hanni-3-1-nano` is now strictly dominated**: `hanni-3-1-lite` is *cheaper* (52 ms against 56) and
5.13 points stronger, with intervals that do not overlap. There is no sweep to run — the cheapest tier
does not need re-tuning, it needs retiring.

`STRUCTURAL` **Why the speedup erased truncation's advantage, and this is the interesting part.** The
optimisation's largest component skips placements whose piece is no longer in hand, so its benefit is
concentrated in the *depleted-hand tail* of a rollout. A full-length playout runs to the end of the
game and spends most of its plies there; a 12-ply truncated playout never reaches it. So full rollouts
gained −39% while truncation gained only −14%, and nano's entire reason to exist — a 24% cost saving
against the 4.7–6.9-point truncation penalty — evaporated. It is now *more expensive* than the
full-rollout config it was supposed to undercut.

`ESTIMATE` The pre-registered hypothesis (buy the cheap point with fewer full-length iterations rather
than truncation) is untested and now unnecessary at this cost point: `v3.5-lite` already sits at 53 ms
at its normal budget. Scaling below 1.0 remains the right lever if a tier below ~50 ms is ever wanted,
and the reasoning above still applies to it.

### The epsilon hint did not survive a head-to-head

`MEASURED` The vs-greedy blocks read `hanni-3-1-lite` (ε=0.15) at 14.94 against `hanni-3-2-lite`
(ε=0.60) at 14.31, which looked like the promoted rollout mixture failing to transfer to the cheapest
tier. A direct match settles it: **`v3.1-lite` against `v3.2-lite` is −0.21 [−1.09, 0.67]** over 100
seeds / 400 games. Indistinguishable, and the point estimate leans the *other* way. The apparent 0.63
gap was noise between two separate seed blocks.

`STRUCTURAL` **This is a caution about the frontier chart itself, and it generalises.** Two models'
scores against greedy are not a head-to-head. They are measured on different seed blocks against a
common third opponent, so their difference carries both models' sampling error and none of the
variance reduction that seat-rotated paired play provides. The published ms/move-versus-delta chart is
the right way to see the cost/strength frontier; it is the wrong way to compare two adjacent models,
and a vertical gap on it is a hypothesis, not a result. Every promotion in this project has been
decided by paired head-to-head blocks, and that should not change because a chart makes a gap look
obvious.

## Kill condition

If the measured Δ for the chosen scale does not clear nano's 9.81 at a cost at or below 65 ms, stop
and record it. That would mean the 2.5-points-per-doubling rate is badly wrong at low iteration
counts, which is itself worth knowing and would revise the frontier reasoning in the master plan.

## Files

- `src/ai/versions/v3.ts` — configs via the existing `v31tier` factory; `iterationScale` only
- `site/src/data/models.ts`, `scripts/hanniGreedyTrajectories.ts` — only if it promotes
