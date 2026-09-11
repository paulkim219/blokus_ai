import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS } from '../../src/engine/types.ts';
import type { PlayerColor } from '../../src/engine/types.ts';
import {
  bootstrapCI,
  rotationAdvantage,
  squaresPlaced,
  summarizeMatch,
  type RotationGame,
} from './stats.ts';

/** The four rotations of one seed when both sides are the same config: one game, four readings. */
function mirrorRotation(scores: Record<PlayerColor, number>): RotationGame[] {
  const best = Math.max(...PLAYER_COLORS.map((color) => scores[color]));
  const winner = PLAYER_COLORS.filter((color) => scores[color] === best);
  return PLAYER_COLORS.map((seat) => ({ seed: 1, seat, scores, winner }));
}

describe('squares placed', () => {
  /**
   * This inverts `calculateScores`, so it breaks silently if the scoring rule ever changes. The
   * aggression frontier is read off it, and a frontier drawn from a stale inversion would look like
   * a finding rather than a bug.
   */
  it('recovers the count from a non-positive score', () => {
    expect(squaresPlaced(0)).toBe(89); // nothing left, but no completion bonus recorded
    expect(squaresPlaced(-1)).toBe(88);
    expect(squaresPlaced(-89)).toBe(0); // passed out immediately
  });

  it('reads a positive score as a completed set, bonus and all', () => {
    expect(squaresPlaced(15)).toBe(89); // every piece placed
    expect(squaresPlaced(20)).toBe(89); // every piece placed, monomino last
  });
});

describe('rotation advantage', () => {
  it('is exactly zero for a mirror match', () => {
    // This is the property the whole protocol rests on: two identical configs replay the same game
    // in all four rotations, so the advantages cancel and the null needs no calibration.
    expect(
      rotationAdvantage(mirrorRotation({ blue: 12, yellow: -8, purple: 3, green: -20 })),
    ).toBeCloseTo(0, 10);
    expect(
      rotationAdvantage(mirrorRotation({ blue: 0, yellow: 0, purple: 0, green: 0 })),
    ).toBeCloseTo(0, 10);
  });

  it('is positive when the challenger outscores the other seats', () => {
    const games: RotationGame[] = [
      {
        seed: 1,
        seat: 'blue',
        scores: { blue: 10, yellow: 1, purple: 1, green: 1 },
        winner: ['blue'],
      },
    ];
    expect(rotationAdvantage(games)).toBeCloseTo(9, 10);
  });

  it('returns zero for no games rather than NaN', () => {
    expect(rotationAdvantage([])).toBe(0);
  });
});

describe('bootstrap interval', () => {
  it('brackets the sample mean', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8];
    const interval = bootstrapCI(samples);
    expect(interval.mean).toBeCloseTo(4.5, 10);
    expect(interval.low).toBeLessThan(interval.mean);
    expect(interval.high).toBeGreaterThan(interval.mean);
  });

  it('calls a clearly positive sample significant', () => {
    expect(bootstrapCI(Array.from({ length: 40 }, () => 5)).significant).toBe(true);
  });

  it('does not call a sample straddling zero significant', () => {
    const samples = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 5 : -5));
    expect(bootstrapCI(samples).significant).toBe(false);
  });

  it('treats floating-point dust as zero', () => {
    // A mirror match lands on ~1e-16 rather than exact zero; that must not read as a result.
    expect(bootstrapCI(Array.from({ length: 40 }, () => 1e-16)).significant).toBe(false);
  });

  it('is deterministic for the same samples', () => {
    const samples = [-2, 0, 3, 5, 1, -1, 4, 2];
    expect(bootstrapCI(samples)).toEqual(bootstrapCI(samples));
  });
});

describe('match summary', () => {
  it('reports par first-place rate and a zero advantage for a mirror match', () => {
    const gamesBySeed = new Map<number, RotationGame[]>([
      [1, mirrorRotation({ blue: 5, yellow: -5, purple: 2, green: -2 })],
    ]);
    const summary = summarizeMatch('v1', 'v1', gamesBySeed);

    expect(summary.games).toBe(4);
    expect(summary.advantage.mean).toBeCloseTo(0, 10);
    expect(summary.advantage.significant).toBe(false);
    // Exactly one of the four rotations has the challenger in the winning seat.
    expect(summary.firstPlaceRate).toBeCloseTo(0.25, 10);
  });
});
