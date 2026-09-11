import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../engine/game';
import { estimateMoveWinRate, estimateWinOdds, smoothWinOdds } from './winOdds';
import { PLAYER_COLORS } from '../engine/types';

describe('win odds', () => {
  it(
    'returns percentages that sum to about 100',
    async () => {
      const odds = await estimateWinOdds(createInitialState(), 24);
      const sum = PLAYER_COLORS.reduce((total, color) => total + odds[color], 0);
      expect(sum).toBeGreaterThan(99);
      expect(sum).toBeLessThan(101);
      for (const color of PLAYER_COLORS) {
        expect(odds[color]).toBeGreaterThanOrEqual(0);
      }
    },
    15_000,
  );

  it('smooths odds without breaking the 100% total', () => {
    const smoothed = smoothWinOdds(
      { blue: 40, green: 20, purple: 20, yellow: 20 },
      { blue: 10, green: 30, purple: 30, yellow: 30 },
      0.5,
    );
    const sum = PLAYER_COLORS.reduce((total, color) => total + smoothed[color], 0);
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(101);
  });

  it(
    'estimates a win rate for a concrete move',
    () => {
      const state = createInitialState();
      const move = generateLegalMoves(state, 'blue', 1)[0];
      expect(move).toBeTruthy();
      const rate = estimateMoveWinRate(state, move, 12);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(100);
      // Sanity: applying the move yields a valid next state.
      expect(applyMove(state, move).currentTurn).toBe('green');
    },
    15_000,
  );
});
