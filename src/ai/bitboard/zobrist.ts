/**
 * Zobrist hashing for the transposition table (§6, Layer 0).
 *
 * "Transpositions are unusually common in Blokus, because permuting the order of a player's own
 * placements reaches the same position, and the game is monotone (cells only fill), so the search
 * graph is a DAG with no cycles."
 *
 * The board alone determines each hand: two pieces of the same colour never share an edge, so a
 * colour's squares decompose uniquely into orthogonally-connected components, one per placed piece.
 * The hash therefore only needs (cell, colour), the seat to move, and each seat's last piece — the
 * last piece is not recoverable from the board and decides the +5 monomino bonus.
 *
 * Keys are 64 bits carried as two 32-bit halves; JavaScript has no fast 64-bit integer and BigInt
 * costs more than the collision risk it removes.
 */

import { CELL_COUNT } from './bitboard';
import { PIECE_COUNT } from './placements';
import { SEAT_COUNT } from './seats';

/** Fixed seed: a self-play match must replay identically across processes. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

const nextKey = splitmix32(0x5eed_b10c);

function keyTable(size: number): { lo: Uint32Array; hi: Uint32Array } {
  const lo = new Uint32Array(size);
  const hi = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) {
    lo[i] = nextKey();
    hi[i] = nextKey();
  }
  return { lo, hi };
}

/** Indexed `cell * SEAT_COUNT + seat`. */
export const CELL_KEYS = keyTable(CELL_COUNT * SEAT_COUNT);
export const TURN_KEYS = keyTable(SEAT_COUNT);
/** Indexed `seat * (PIECE_COUNT + 1) + (pieceId + 1)`; index 0 means "has not placed yet". */
export const LAST_PIECE_KEYS = keyTable(SEAT_COUNT * (PIECE_COUNT + 1));

export function cellKeyIndex(cell: number, seat: number): number {
  return cell * SEAT_COUNT + seat;
}

export function lastPieceKeyIndex(seat: number, pieceId: number): number {
  return seat * (PIECE_COUNT + 1) + pieceId + 1;
}
