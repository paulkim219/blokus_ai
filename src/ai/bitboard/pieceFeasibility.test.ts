import { describe, expect, it } from 'vitest';
import { candidatePieceFeasibility } from './pieceFeasibility';
import { PIECE_COUNT } from './placements';
import { Position, newMoveBuffer } from './position';

describe('remaining-piece feasibility', () => {
  it('scores a legal candidate without mutating the position', () => {
    const position = Position.initial();
    const legal = newMoveBuffer();
    const count = position.generateMoves(0, legal);
    expect(count).toBeGreaterThan(0);
    const before = position.clone();
    const score = candidatePieceFeasibility(
      position,
      0,
      legal[0],
      newMoveBuffer(),
      new Int32Array(PIECE_COUNT),
    );
    expect(Number.isFinite(score)).toBe(true);
    expect(position.hashLo).toBe(before.hashLo);
    expect(position.hashHi).toBe(before.hashHi);
    expect(position.turn).toBe(before.turn);
    expect(position.hand[0]).toBe(before.hand[0]);
  });
});
