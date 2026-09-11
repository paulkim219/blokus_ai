/**
 * §7 Tier 1: "incremental-evaluation consistency (incremental corner/territory updates equal a
 * from-scratch recomputation after every move)".
 *
 * The incrementally maintained state here is the pair of haloes per colour and the Zobrist hash.
 * Both are replayed against a from-scratch import of the same position at every ply of a random
 * game, which is the only way a hash bug shows up before it silently poisons the transposition
 * table.
 */

import { describe, expect, it } from 'vitest';
import { applyMove, calculateScores, createInitialState } from '../../engine/game';
import { PLAYER_COLORS } from '../../engine/types';
import { placementFor, toPosition } from './adapter';
import { WORDS } from './bitboard';
import { Position } from './position';
import { SEAT_COLORS, SEAT_OF_COLOR } from './seats';
import { playRandomGame } from './testUtil';

function expectSameBoard(incremental: Position, fresh: Position): void {
  for (let w = 0; w < WORDS; w += 1) {
    expect(incremental.occ[w]).toBe(fresh.occ[w]);
    for (let seat = 0; seat < 4; seat += 1) {
      expect(incremental.own[seat][w]).toBe(fresh.own[seat][w]);
      expect(incremental.edgeHalo[seat][w]).toBe(fresh.edgeHalo[seat][w]);
      expect(incremental.cornerHalo[seat][w]).toBe(fresh.cornerHalo[seat][w]);
    }
  }
  for (let seat = 0; seat < 4; seat += 1) {
    expect(incremental.hand[seat]).toBe(fresh.hand[seat]);
    expect(incremental.handSquares[seat]).toBe(fresh.handSquares[seat]);
    expect(incremental.lastPiece[seat]).toBe(fresh.lastPiece[seat]);
  }
}

describe('v12 position', () => {
  it('keeps haloes and the Zobrist hash equal to a from-scratch import at every ply', () => {
    const { final } = playRandomGame(7);
    const incremental = Position.initial(false);
    let legacy = createInitialState('corner');
    let placements = 0;

    for (const move of final.moveHistory) {
      if (move.type !== 'place') {
        legacy = applyMove(legacy, move);
        continue;
      }
      const id = placementFor(move);
      expect(id).toBeGreaterThanOrEqual(0);
      incremental.forceTurn(SEAT_OF_COLOR[move.color]);
      incremental.apply(id);
      legacy = applyMove(legacy, move);
      placements += 1;

      const fresh = toPosition(legacy);
      expectSameBoard(incremental, fresh);
      incremental.forceTurn(fresh.turn);
      expect(incremental.hashLo).toBe(fresh.hashLo);
      expect(incremental.hashHi).toBe(fresh.hashHi);
    }

    expect(placements).toBeGreaterThan(30);
  });

  it('restores every field on undo', () => {
    const { states } = playRandomGame(9);
    const state = states[Math.floor(states.length / 2)];
    const position = toPosition(state);
    const before = {
      hashLo: position.hashLo,
      hashHi: position.hashHi,
      occ: position.occ.slice(),
      turn: position.turn,
      out: position.getOutMask(),
    };

    const buffer = new Int32Array(4096);
    const count = position.generateMoves(position.turn, buffer);
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < Math.min(count, 25); i += 1) {
      const undo = position.apply(buffer[i]);
      position.undo(undo);
      expect(position.hashLo).toBe(before.hashLo);
      expect(position.hashHi).toBe(before.hashHi);
      expect(position.turn).toBe(before.turn);
      expect(position.getOutMask()).toBe(before.out);
      expect([...position.occ]).toEqual([...before.occ]);
    }
  });

  it('scores identically to the legacy scorer', () => {
    for (let seed = 1; seed <= 3; seed += 1) {
      const { final } = playRandomGame(seed);
      const position = toPosition(final);
      const scores = new Float64Array(4);
      position.scores(scores);
      const legacy = calculateScores(final);
      for (const color of PLAYER_COLORS) {
        const expected = legacy.find((entry) => entry.color === color)!.score;
        expect(scores[SEAT_OF_COLOR[color]]).toBe(expected);
      }
    }
  });

  it('orders seats by turn, with the diagonal opponent two seats away', () => {
    expect(SEAT_COLORS).toEqual(['blue', 'green', 'purple', 'yellow']);
    // Blue's corner is (0,0) and purple's is (19,19): opposite corners, two seats apart.
    expect(SEAT_OF_COLOR.purple - SEAT_OF_COLOR.blue).toBe(2);
    expect(SEAT_OF_COLOR.yellow - SEAT_OF_COLOR.green).toBe(2);
  });
});
