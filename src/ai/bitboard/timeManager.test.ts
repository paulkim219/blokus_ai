/**
 * The shape helpers, which are the only part of the allocation experiment that is pure arithmetic.
 *
 * `shapeAt` runs once per move on the search's hot path and `normaliseShape` is what makes a
 * candidate budget-neutral; a bug in either would show up as a strength result rather than as a
 * failure, which is the reason to test them directly.
 */

import { describe, expect, it } from 'vitest';
import {
  OWN_MOVES,
  iterationsAfterProbe,
  normaliseShape,
  planMove,
  shapeAt,
} from './timeManager';
import { DEFAULT_BITBOARD_PARAMS, withOverrides } from './config';

describe('iteration shape helpers', () => {
  it('reproduces a flat budget when no shape is set', () => {
    for (let k = 0; k < OWN_MOVES; k += 1) {
      expect(shapeAt(undefined, k)).toBe(1);
      expect(shapeAt([], k)).toBe(1);
    }
  });

  it('repeats the last entry rather than falling back to 1', () => {
    // A seat still searches after its shape runs out; falling back to 1 there would hand the tail
    // of the game budget the shape was fitted to take away.
    const shape = [2, 1, 0.5];
    expect(shapeAt(shape, 2)).toBe(0.5);
    expect(shapeAt(shape, 3)).toBe(0.5);
    expect(shapeAt(shape, 99)).toBe(0.5);
  });

  it('clamps a negative own-move index to the first entry', () => {
    expect(shapeAt([1.7, 1], -1)).toBe(1.7);
  });

  it('ignores non-positive and non-finite entries', () => {
    // Zero iterations at a move is not an allocation, it is a resignation; a fitted shape that
    // produced one should degrade to flat rather than silently stop searching.
    expect(shapeAt([0, 1], 0)).toBe(1);
    expect(shapeAt([Number.NaN, 1], 0)).toBe(1);
  });

  it('normalises any shape to exactly a flat per-game budget', () => {
    for (const shape of [[2, 2, 2], [0.5], [3, 1, 1, 1, 5, 2]]) {
      const normalised = normaliseShape(shape);
      expect(normalised).toHaveLength(OWN_MOVES);
      expect(normalised.reduce((sum, value) => sum + value, 0)).toBeCloseTo(OWN_MOVES, 9);
    }
  });

  it('preserves the ratios it was given', () => {
    const normalised = normaliseShape([2, 1, 1]);
    expect(normalised[0] / normalised[1]).toBeCloseTo(2, 9);
    // The tail repeats, so entries 1..20 are all the same weight.
    expect(normalised[20]).toBeCloseTo(normalised[1], 9);
  });

  it('degrades a degenerate shape to flat instead of dividing by zero', () => {
    expect(normaliseShape([0, 0, 0])).toEqual(Array.from({ length: OWN_MOVES }, () => 1));
  });
});

describe('iteration banking', () => {
  it('releases more of a fixed pool when the root is contested', () => {
    const contested = iterationsAfterProbe(DEFAULT_BITBOARD_PARAMS, 1000, 200, 0.51, 0.5);
    const decided = iterationsAfterProbe(DEFAULT_BITBOARD_PARAMS, 1000, 200, 0.7, 0.5);
    expect(contested).toBeGreaterThan(decided);
    expect(contested).toBeLessThanOrEqual(1000);
    expect(decided).toBeGreaterThanOrEqual(200);
  });

  it('never spends more iterations than have entered the pool', () => {
    expect(iterationsAfterProbe(DEFAULT_BITBOARD_PARAMS, 313, 400, 0.5, 0.5)).toBe(313);
  });
});

describe('planMove', () => {
  const flatBudget = 1000;

  it('applies the hand-authored curve when no shape is fitted', () => {
    // The report's guess: own moves 1-5 cheap, the middle expensive. Unmeasured, but it is what the
    // browser has always done and nothing here should change that silently.
    const early = planMove(DEFAULT_BITBOARD_PARAMS, flatBudget, 'opening', 0).budgetMs;
    const middle = planMove(DEFAULT_BITBOARD_PARAMS, flatBudget, 'midgame', 7).budgetMs;
    expect(early).toBeLessThan(middle);
  });

  it('prefers a fitted shape over the guess, on the clock path too', () => {
    // Otherwise a promoted shape would win its matches on the iteration path and then not ship:
    // the UI runs on a wall-clock budget, where only `planMove` is consulted.
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: { iterationShape: [3, ...Array.from({ length: 20 }, () => 0.9) ] },
    });
    expect(planMove(params, flatBudget, 'opening', 0).budgetMs).toBe(3000);
    expect(planMove(params, flatBudget, 'midgame', 7).budgetMs).toBeCloseTo(900, 9);
  });

  it('does not multiply the phase curve into a fitted shape', () => {
    // A shape is fitted against a flat baseline over the 21 moves. Layering PHASE_SHAPE on top
    // would ship a curve nobody measured, and phase boundaries move with the board.
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: { iterationShape: Array.from({ length: 21 }, () => 1) },
    });
    for (const phase of ['opening', 'midgame', 'endgame'] as const) {
      expect(planMove(params, flatBudget, phase, 3).budgetMs).toBe(flatBudget);
    }
  });
});
