/**
 * The boundary between the v12 engine and the rest of the repo.
 *
 * Everything outside `src/ai/bitboard` speaks `GameState` / `PlaceMove` / `PlayerColor`; everything
 * inside speaks bitboards, seat indices and placement ids. Both directions are here and nowhere
 * else, so the engine can be replaced or the representation changed without touching the UI, the
 * live-sync path, or the existing tournament harness.
 */

import { BOARD_SIZE } from '../../engine/types';
import type { Cell, GameState, PlaceMove, PlayerColor } from '../../engine/types';
import { CELL_COUNT, cellIndex } from './bitboard';
import { PLACEMENTS, placementId } from './placements';
import { Position } from './position';
import { SEAT_COLORS, SEAT_OF_COLOR } from './seats';

const cellOwnerScratch = new Int8Array(CELL_COUNT);
const handScratch = new Int32Array(4);
const lastPieceScratch = new Int32Array(4);

export function toPosition(state: GameState): Position {
  cellOwnerScratch.fill(-1);
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const row = state.board[y];
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const owner = row[x];
      if (owner) {
        cellOwnerScratch[cellIndex(x, y)] = SEAT_OF_COLOR[owner];
      }
    }
  }

  for (let seat = 0; seat < SEAT_COLORS.length; seat += 1) {
    const color = SEAT_COLORS[seat];
    let mask = 0;
    for (const pieceId of state.remainingPieces[color]) {
      mask |= 1 << pieceId;
    }
    handScratch[seat] = mask;
    lastPieceScratch[seat] = state.lastPlacedPieceId[color] ?? -1;
  }

  return Position.fromCells(
    cellOwnerScratch,
    handScratch,
    lastPieceScratch,
    SEAT_OF_COLOR[state.currentTurn],
    state.openingMode === 'anywhere',
  );
}

export function seatOf(color: PlayerColor): number {
  return SEAT_OF_COLOR[color];
}

export function colorOf(seat: number): PlayerColor {
  return SEAT_COLORS[seat];
}

/** Placement id → the legacy move object. Anchors match because orientations are normalised. */
export function toPlaceMove(id: number, color: PlayerColor): PlaceMove {
  const cells: Cell[] = [];
  for (let i = PLACEMENTS.cellStart[id]; i < PLACEMENTS.cellStart[id + 1]; i += 1) {
    const cell = PLACEMENTS.cellList[i];
    cells.push({ x: cell % BOARD_SIZE, y: (cell / BOARD_SIZE) | 0 });
  }
  return {
    type: 'place',
    color,
    pieceId: PLACEMENTS.pieceId[id],
    orientationIndex: PLACEMENTS.orientation[id],
    anchor: { x: PLACEMENTS.anchorX[id], y: PLACEMENTS.anchorY[id] },
    absoluteCells: cells,
  };
}

/** Legacy move object → placement id, or -1 if it is not a placement this table knows. */
export function placementFor(move: PlaceMove): number {
  return placementId(move.pieceId, move.orientationIndex, move.anchor.x, move.anchor.y);
}
