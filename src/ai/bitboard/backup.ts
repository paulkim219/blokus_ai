/**
 * What gets backed up (§2.2, §5).
 *
 * The tree carries a four-component vector, one per seat, and every node's mover selects on its own
 * component — max^n. The components themselves are *not* win indicators: Shibahara and Kotani
 * showed that in a scoring game a sigmoid of the final score margin sharpens Monte-Carlo estimates
 * over a pure win/loss signal, and §5 adds that rank and margin can conflict, so the value is a
 * blend the caller controls:
 *
 *     v_i = (1 − β)·σ( (s_i − max_{j≠i} s_j) / scale ) + β·rank_i
 *
 * β = 0 optimises margin (right when leading, "to avoid speculative blocks"); β = 1 optimises rank
 * (right when trailing badly, "since only outcomes among the leaders matter").
 */

import { SEAT_COUNT } from './seats';

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Margin of each seat against the others, collapsed either to their best or to their mean.
 *
 * This is not a detail. `max` asks "am I beating the leader"; `mean` asks "how far above the field
 * am I". The tournament promotes on `score − mean(other three)` (`scripts/lib/stats.ts`), and the
 * legacy engine's rollout value uses the mean, so `max` optimises a different quantity than the one
 * that decides whether a version ships.
 */
export function marginsFrom(
  scores: Float64Array,
  out: Float64Array,
  aggregation: OpponentAggregation = 'max',
): Float64Array {
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    let reference: number;
    if (aggregation === 'mean') {
      let total = 0;
      for (let other = 0; other < SEAT_COUNT; other += 1) {
        if (other !== seat) {
          total += scores[other];
        }
      }
      reference = total / (SEAT_COUNT - 1);
    } else {
      reference = -Infinity;
      for (let other = 0; other < SEAT_COUNT; other += 1) {
        if (other !== seat && scores[other] > reference) {
          reference = scores[other];
        }
      }
    }
    out[seat] = scores[seat] - reference;
  }
  return out;
}

export type OpponentAggregation = 'mean' | 'max';

/** Share of opponents this seat is beating: 1 for a clear first, 0 for a clear last. */
export function rankFrom(scores: Float64Array, out: Float64Array): Float64Array {
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    let beaten = 0;
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other === seat) {
        continue;
      }
      if (scores[seat] > scores[other]) {
        beaten += 1;
      } else if (scores[seat] === scores[other]) {
        beaten += 0.5;
      }
    }
    out[seat] = beaten / (SEAT_COUNT - 1);
  }
  return out;
}

const marginScratch = new Float64Array(SEAT_COUNT);
const rankScratch = new Float64Array(SEAT_COUNT);

/**
 * Value vector from a set of per-seat scores. `scale` is in the units of `scores`: squares at a
 * terminal node, E units at a truncated one.
 */
export function valueVector(
  scores: Float64Array,
  scale: number,
  rankBlend: number,
  out: Float64Array,
  aggregation: OpponentAggregation = 'max',
): Float64Array {
  marginsFrom(scores, marginScratch, aggregation);
  rankFrom(scores, rankScratch);
  const beta = Math.max(0, Math.min(1, rankBlend));
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const margin = sigmoid(marginScratch[seat] / Math.max(1e-6, scale));
    out[seat] = (1 - beta) * margin + beta * rankScratch[seat];
  }
  return out;
}

/**
 * Value vector when each input is already `score_i - mean(score_j, j != i)`.
 *
 * Mean margins are a positive affine transform of the underlying scores, so they preserve rank.
 * Applying `marginsFrom` again is not an identity (and becomes especially distorted when the
 * configured aggregation is `max`), which was the original learned evaluator's contract bug.
 */
export function valueVectorFromMeanMargins(
  margins: Float64Array,
  scale: number,
  rankBlend: number,
  out: Float64Array,
): Float64Array {
  rankFrom(margins, rankScratch);
  const beta = Math.max(0, Math.min(1, rankBlend));
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const margin = sigmoid(margins[seat] / Math.max(1e-6, scale));
    out[seat] = (1 - beta) * margin + beta * rankScratch[seat];
  }
  return out;
}

/** Squashed margin only, for blending two value sources that live on different scales. */
export function marginValue(
  scores: Float64Array,
  scale: number,
  out: Float64Array,
  aggregation: OpponentAggregation = 'max',
): Float64Array {
  marginsFrom(scores, marginScratch, aggregation);
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    out[seat] = sigmoid(marginScratch[seat] / Math.max(1e-6, scale));
  }
  return out;
}

/**
 * §5's per-seat objective choice: favour rank when trailing badly, margin when leading. The lead is
 * measured in squares against the best opponent, so it is meaningful before the game ends.
 *
 * Note what the trailing branch does with its own base: `objectiveBlend(0, −20) = 1.0`. A base of
 * zero is the operator saying "optimise margin, never rank", and the shift overrides it into *pure*
 * rank as soon as the agent is 20 squares behind. `enabled = false` is the only way to actually
 * turn the mechanism off.
 */
export function objectiveBlend(base: number, leadInSquares: number, enabled = true): number {
  if (!enabled) {
    return base;
  }
  if (leadInSquares >= 0) {
    // Leading: margin matters, rank is already secured — damp the rank component.
    return base * 0.5;
  }
  // Trailing: the further behind, the more only the ranking matters.
  const deficit = Math.min(1, -leadInSquares / 20);
  return base + (1 - base) * deficit;
}
