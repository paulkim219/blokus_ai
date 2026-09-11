import { describe, expect, it } from 'vitest';
import { HOME_CORNER } from './seats';
import { canonicalCell } from './leafNetFeatures';

describe('leaf spatial feature canonicalisation', () => {
  it('rotates every root home corner to top-left', () => {
    for (let seat = 0; seat < 4; seat += 1) {
      expect(canonicalCell(HOME_CORNER[seat], seat)).toBe(0);
    }
  });

  it('keeps the next seat in the canonical bottom-left direction', () => {
    for (let seat = 0; seat < 4; seat += 1) {
      expect(canonicalCell(HOME_CORNER[(seat + 1) % 4], seat)).toBe(380);
    }
  });
});
