/**
 * §7 Tier 1: "Property tests on the move generator (every generated move is legal; every legal
 * move is generated, checked against a slow reference implementation on random positions)."
 *
 * The slow reference is `src/engine/game.ts` — the object-board generator that has played every
 * version from v4 to v11. That is the reason it was left untouched rather than rewritten.
 */

import { describe, expect, it } from 'vitest';
import { generateLegalMoves, moveKey } from '../../engine/game';
import { PLAYER_COLORS } from '../../engine/types';
import { toPlaceMove, toPosition } from './adapter';
import { newMoveBuffer } from './position';
import { SEAT_OF_COLOR } from './seats';
import { playRandomGame } from './testUtil';

function v12Keys(state: ReturnType<typeof playRandomGame>['final'], color: (typeof PLAYER_COLORS)[number]): Set<string> {
  const position = toPosition(state);
  const buffer = newMoveBuffer();
  const count = position.generateMoves(SEAT_OF_COLOR[color], buffer);
  const keys = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    keys.add(moveKey(toPlaceMove(buffer[i], color)));
  }
  expect(keys.size).toBe(count);
  return keys;
}

describe('v12 move generation', () => {
  it('matches the legacy generator on every colour of every sampled position', () => {
    let positionsChecked = 0;
    let movesChecked = 0;

    for (let seed = 1; seed <= 6; seed += 1) {
      const { states } = playRandomGame(seed);
      for (const state of states) {
        for (const color of PLAYER_COLORS) {
          const reference = new Set(
            generateLegalMoves(state, color).map((move) => moveKey(move)),
          );
          const actual = v12Keys(state, color);

          const missing = [...reference].filter((key) => !actual.has(key));
          const extra = [...actual].filter((key) => !reference.has(key));
          expect({ missing, extra }).toEqual({ missing: [], extra: [] });

          positionsChecked += 1;
          movesChecked += reference.size;
        }
      }
    }

    // Guards against the test silently degenerating into "both generators returned nothing".
    expect(positionsChecked).toBeGreaterThan(100);
    expect(movesChecked).toBeGreaterThan(10000);
  });

  it('agrees with the legacy generator about the opening', () => {
    const { states } = playRandomGame(11, 0);
    const state = states[0];
    for (const color of PLAYER_COLORS) {
      const reference = new Set(generateLegalMoves(state, color).map((move) => moveKey(move)));
      expect(v12Keys(state, color)).toEqual(reference);
      expect(reference.size).toBeGreaterThan(0);
    }
  });

  it('reports every generated move as legal', () => {
    const { states } = playRandomGame(21);
    for (const state of states) {
      const position = toPosition(state);
      const buffer = newMoveBuffer();
      for (const color of PLAYER_COLORS) {
        const seat = SEAT_OF_COLOR[color];
        const count = position.generateMoves(seat, buffer);
        for (let i = 0; i < count; i += 1) {
          expect(position.isLegal(seat, buffer[i])).toBe(true);
        }
      }
    }
  });
});
