import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves, isLegalPlacement, moveKey } from './game';
import { ORIENTATIONS } from './pieces';
import { BOARD_SIZE } from './types';
import type { GameState, OpeningMode, PlayerColor } from './types';

/** Exhaustive reference: try every piece, orientation and anchor on the board. */
function bruteForceLegalMoves(state: GameState, color: PlayerColor): string[] {
  const keys = new Set<string>();
  for (const pieceId of state.remainingPieces[color]) {
    for (let orientationIndex = 0; orientationIndex < ORIENTATIONS[pieceId].length; orientationIndex += 1) {
      for (let y = -BOARD_SIZE; y < BOARD_SIZE; y += 1) {
        for (let x = -BOARD_SIZE; x < BOARD_SIZE; x += 1) {
          const move = isLegalPlacement(state, color, pieceId, orientationIndex, { x, y }, false);
          if (move) {
            keys.add(moveKey(move));
          }
        }
      }
    }
  }
  return [...keys].sort();
}

/** Deterministic walk so both implementations see identical mid-game positions. */
function advance(state: GameState, plies: number): GameState {
  let current = state;
  for (let i = 0; i < plies; i += 1) {
    const moves = generateLegalMoves(current, current.currentTurn, 40);
    if (moves.length === 0) {
      break;
    }
    current = applyMove(current, moves[i % moves.length]);
  }
  return current;
}

describe('generateLegalMoves matches exhaustive search', () => {
  for (const openingMode of ['corner', 'anywhere'] as OpeningMode[]) {
    for (const plies of [0, 1, 4, 12, 28]) {
      it(`agrees at ply ${plies} (${openingMode} opening)`, () => {
        const state = advance(createInitialState(openingMode), plies);
        const color = state.currentTurn;
        const fast = generateLegalMoves(state, color).map(moveKey).sort();
        expect(fast).toEqual(bruteForceLegalMoves(state, color));
      });
    }
  }
});
