/**
 * §7 Tier 1: "exact-solver agreement (Formulation A equals Formulation B on a bank of sealed
 * regions)".
 *
 * Formulation B is the ILP, which this repo does not ship, so the reference here is exhaustive
 * enumeration — same guarantee, worse asymptotics, and it exercises exactly what could be wrong in
 * Formulation A: the bound, the hole-feasibility term, and the memo. A bug in any of those shows up
 * as a value the brute force does not agree with.
 *
 * Scores follow the Blokus rule: −(squares left), +15 for placing everything, +5 more if the
 * monomino went last.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyBoard } from '../../engine/board';
import { PIECES } from '../../engine/pieces';
import { PLAYER_COLORS } from '../../engine/types';
import type { GameState, PlayerColor } from '../../engine/types';
import { toPosition } from './adapter';
import { MONOMINO_PIECE_ID, PIECE_SIZES, PLACEMENTS } from './placements';
import { clearPackCache, solveSealedRegion } from './packer';
import { newMoveBuffer, type Position } from './position';
import { SEAT_OF_COLOR } from './seats';
import { computeTerritory, isSealed } from './territory';
import { DEFAULT_BITBOARD_PARAMS } from './config';

function pieceIdByName(name: string): number {
  const id = PIECES.findIndex((piece) => piece.name === name);
  expect(id).toBeGreaterThanOrEqual(0);
  return id;
}

/**
 * A board where one colour owns a pocket and everything else is filled. The filled cells are not a
 * legal Blokus history — they do not have to be. The packer is a function of the position, and this
 * is the cheapest way to produce a genuinely sealed region on demand.
 */
function craftPocket(
  empty: Array<[number, number]>,
  ownCells: Array<[number, number]>,
  hand: number[],
  color: PlayerColor = 'blue',
): GameState {
  const board = createEmptyBoard();
  const filler: PlayerColor = color === 'purple' ? 'blue' : 'purple';
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      board[y][x] = filler;
    }
  }
  for (const [x, y] of empty) {
    board[y][x] = null;
  }
  for (const [x, y] of ownCells) {
    board[y][x] = color;
  }

  return {
    board,
    remainingPieces: Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, c === color ? hand : []]),
    ) as Record<PlayerColor, number[]>,
    currentTurn: color,
    hasPlayed: Object.fromEntries(PLAYER_COLORS.map((c) => [c, true])) as Record<
      PlayerColor,
      boolean
    >,
    consecutivePasses: 0,
    moveHistory: [],
    lastPlacedPieceId: Object.fromEntries(PLAYER_COLORS.map((c) => [c, null])) as Record<
      PlayerColor,
      number | null
    >,
    finished: false,
    openingMode: 'corner',
  };
}

/** Exhaustive max over play sequences: squares placed plus the completion bonuses. */
function bruteForceValue(position: Position, seat: number, depth = 0): number {
  const buffer = newMoveBuffer();
  position.forceTurn(seat);
  const count = position.generateMoves(seat, buffer);
  let best = 0;
  for (let i = 0; i < count; i += 1) {
    const move = buffer[i];
    const size = PIECE_SIZES[PLACEMENTS.pieceId[move]];
    position.forceTurn(seat);
    const undo = position.apply(move);
    position.forceTurn(seat);
    const value =
      position.hand[seat] === 0
        ? size + 15 + (PLACEMENTS.pieceId[move] === MONOMINO_PIECE_ID ? 5 : 0)
        : size + bruteForceValue(position, seat, depth + 1);
    position.undo(undo);
    if (value > best) {
      best = value;
    }
  }
  return best;
}

function solveAndCompare(state: GameState, color: PlayerColor = 'blue'): number {
  clearPackCache();
  const position = toPosition(state);
  const seat = SEAT_OF_COLOR[color];
  const map = computeTerritory(position);
  expect(isSealed(map, seat)).toBe(true);

  const result = solveSealedRegion(position, seat, map, DEFAULT_BITBOARD_PARAMS.endgame);
  expect(result).not.toBeNull();
  expect(result!.proven).toBe(true);

  const reference = bruteForceValue(position.clone(), seat) - position.handSquares[seat];
  expect(result!.score).toBe(reference);
  return result!.score;
}

describe('v12 sealed-region packer', () => {
  it('takes the all-placed bonus when the pocket fits the hand exactly', () => {
    // 2×2 pocket diagonally attached to a lone own square; the O4 fills it exactly.
    const state = craftPocket(
      [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ],
      [[0, 0]],
      [pieceIdByName('O4')],
    );
    expect(solveAndCompare(state)).toBe(15);
  });

  it('accepts a leftover piece when the pocket cannot hold everything', () => {
    const state = craftPocket(
      [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ],
      [[0, 0]],
      [pieceIdByName('O4'), MONOMINO_PIECE_ID],
    );
    // Best is O4 (4 squares), leaving the monomino: −1.
    expect(solveAndCompare(state)).toBe(-1);
  });

  it('takes the monomino-last bonus when the ordering allows it', () => {
    const state = craftPocket(
      [
        [1, 1],
        [2, 2],
      ],
      [[0, 0]],
      [MONOMINO_PIECE_ID],
    );
    expect(solveAndCompare(state)).toBe(20);
  });

  it('prefers the ordering that ends on the monomino', () => {
    // An L-shaped pocket that holds I2 and I1 in either order; only one order scores the +5.
    const state = craftPocket(
      [
        [1, 1],
        [2, 1],
        [3, 2],
      ],
      [[0, 0]],
      [MONOMINO_PIECE_ID, pieceIdByName('I2')],
    );
    expect(solveAndCompare(state)).toBe(20);
  });

  it('agrees with brute force on a larger pocket', () => {
    const state = craftPocket(
      [
        [1, 1],
        [2, 1],
        [3, 1],
        [1, 2],
        [2, 2],
        [3, 2],
        [1, 3],
        [2, 3],
        [3, 3],
      ],
      [[0, 0]],
      [pieceIdByName('L4'), pieceIdByName('I3'), MONOMINO_PIECE_ID],
    );
    solveAndCompare(state);
  });
});
