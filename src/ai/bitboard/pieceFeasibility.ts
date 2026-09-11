import { PIECE_SIZES, PLACEMENTS } from './placements';
import type { Position } from './position';

/** Score how usable the mover's remaining hand is after one candidate placement. */
export function candidatePieceFeasibility(
  position: Position,
  seat: number,
  move: number,
  moves: Int32Array,
  perPiece: Int32Array,
): number {
  const undo = position.apply(move);
  position.forceTurn(seat);
  perPiece.fill(0);
  const count = position.generateMoves(seat, moves);
  for (let index = 0; index < count; index += 1) {
    perPiece[PLACEMENTS.pieceId[moves[index]]] += 1;
  }
  let score = 0;
  for (let piece = 0; piece < PIECE_SIZES.length; piece += 1) {
    if ((position.hand[seat] & (1 << piece)) === 0) continue;
    const legal = perPiece[piece];
    score += PIECE_SIZES[piece] * Math.log1p(legal);
    score -= (2 * PIECE_SIZES[piece]) / (1 + legal);
  }
  position.undo(undo);
  return score;
}
