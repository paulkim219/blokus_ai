/**
 * The precomputed placement table (§6, Layer 0).
 *
 * "Precompute for every (piece, orientation, anchor offset) a 400-bit mask; move generation is then
 * a loop over open corners and compatible orientation masks with two ANDs."
 *
 * There are 91 fixed one-sided polyominoes of size 1–5 and roughly 300 in-bounds anchors each, so
 * the table holds ~27,000 placements. For each one we store three masks:
 *
 *   cells      the squares it covers            — must not intersect the occupied board
 *   edgeHalo   squares orthogonally adjacent    — must not intersect the mover's own colour
 *   cornerHalo squares diagonally adjacent      — must intersect the mover's own colour
 *
 * The corner requirement is checked implicitly instead: generation walks the mover's *open corner*
 * cells and only considers placements that cover one, which is equivalent given the other two
 * conditions (a legal placement must cover some cell diagonally adjacent to own colour, and that
 * cell is by definition empty and not edge-adjacent to own colour).
 *
 * Piece shapes come from `src/engine/pieces` so the two engines can never disagree about geometry.
 */

import { ORIENTATIONS, PIECES } from '../../engine/pieces';
import {
  BOARD_SIZE,
  CELL_COUNT,
  WORDS,
  cellIndex,
  dilateDiagonal,
  dilateOrthogonal,
  newMask,
  andNotInto,
  setBit,
  toIndices,
} from './bitboard';

export const PIECE_COUNT = PIECES.length;
export const PIECE_SIZES: Int32Array = new Int32Array(PIECES.map((piece) => piece.size));
export const MONOMINO_PIECE_ID = PIECES.findIndex((piece) => piece.size === 1);
/** Bitmask with one bit per piece id — a player's full hand. */
export const ALL_PIECES_MASK = (1 << PIECE_COUNT) - 1;
export const TOTAL_SQUARES = PIECES.reduce((sum, piece) => sum + piece.size, 0);

export interface PlacementTable {
  count: number;
  /** count × WORDS, flat. */
  cells: Uint32Array;
  edgeHalo: Uint32Array;
  cornerHalo: Uint32Array;
  /**
   * First and last-plus-one word index where `cells` or `edgeHalo` is non-zero, per placement.
   *
   * A placement covers at most five adjacent squares, so of the 13 words in a board mask only one to
   * three are ever set — but the intersection loops in `playout.ts` scanned all 13. Skipping a word
   * whose mask is zero cannot change an `&` test, so bounding those loops with this range is exactly
   * equivalent and is the single largest cost in the engine: `sampleMoves` measured **74.7% of
   * engine self time** in a CPU profile of a real search.
   */
  maskLo: Uint8Array;
  maskHi: Uint8Array;
  /**
   * Per-cell, per-piece start index into `coverList`, with a terminator: entry
   * `cell * (PIECE_COUNT + 1) + piece` is where that piece's placements covering that cell begin.
   *
   * `coverList` is already ascending by placement id within a cell, and ids are assigned piece-major,
   * so each piece's placements are already contiguous. Walking pieces in ascending order and each
   * piece's run in ascending order therefore reproduces the original sequence exactly — which is what
   * makes skipping a piece that is no longer in hand behaviour-identical rather than a reordering.
   *
   * The payoff is in the rollout tail: a playout runs to the end of the game, and by then most of a
   * seat's 21 pieces are gone, so most of the cover list was being scanned only to fail the hand test.
   */
  coverPieceStart: Int32Array;
  pieceId: Uint8Array;
  orientation: Uint8Array;
  size: Uint8Array;
  anchorX: Uint8Array;
  anchorY: Uint8Array;
  /** Sum of |x − 9.5| + |y − 9.5| over the covered cells, divided by size. Cached for ordering. */
  centreDistance: Float32Array;
  /** CSR view of the covered cell indices: cellStart[p] … cellStart[p + 1] index into cellList. */
  cellStart: Int32Array;
  cellList: Int32Array;
  /** CSR view of "which placements cover cell c": coverStart[c] … coverStart[c + 1] into coverList. */
  coverStart: Int32Array;
  coverList: Int32Array;
  /** Placement ids for (piece, orientation) start here and run in row-major anchor order. */
  base: Int32Array;
  spanX: Int32Array;
  spanY: Int32Array;
}

function orientationExtent(cells: Array<{ x: number; y: number }>): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const cell of cells) {
    if (cell.x + 1 > w) {
      w = cell.x + 1;
    }
    if (cell.y + 1 > h) {
      h = cell.y + 1;
    }
  }
  return { w, h };
}

function orientationKey(pieceId: number, orientation: number): number {
  return pieceId * 8 + orientation;
}

function build(): PlacementTable {
  const orientationSlots = PIECE_COUNT * 8;
  const base = new Int32Array(orientationSlots).fill(-1);
  const spanX = new Int32Array(orientationSlots);
  const spanY = new Int32Array(orientationSlots);

  // First pass: count, so every array can be allocated once at its exact size.
  let count = 0;
  let cellTotal = 0;
  for (let pieceId = 0; pieceId < PIECE_COUNT; pieceId += 1) {
    const orientations = ORIENTATIONS[pieceId];
    for (let o = 0; o < orientations.length; o += 1) {
      const { w, h } = orientationExtent(orientations[o].cells);
      const sx = BOARD_SIZE - w + 1;
      const sy = BOARD_SIZE - h + 1;
      const key = orientationKey(pieceId, o);
      base[key] = count;
      spanX[key] = sx;
      spanY[key] = sy;
      count += sx * sy;
      cellTotal += sx * sy * orientations[o].cells.length;
    }
  }

  const table: PlacementTable = {
    count,
    cells: new Uint32Array(count * WORDS),
    edgeHalo: new Uint32Array(count * WORDS),
    cornerHalo: new Uint32Array(count * WORDS),
    maskLo: new Uint8Array(count),
    maskHi: new Uint8Array(count),
    pieceId: new Uint8Array(count),
    orientation: new Uint8Array(count),
    size: new Uint8Array(count),
    anchorX: new Uint8Array(count),
    anchorY: new Uint8Array(count),
    centreDistance: new Float32Array(count),
    cellStart: new Int32Array(count + 1),
    cellList: new Int32Array(cellTotal),
    coverStart: new Int32Array(CELL_COUNT + 1),
    coverList: new Int32Array(cellTotal),
    coverPieceStart: new Int32Array(CELL_COUNT * (PIECE_COUNT + 1)),
    base,
    spanX,
    spanY,
  };

  const cellsMask = newMask();
  const haloMask = newMask();
  const scratchIndices = new Int32Array(CELL_COUNT);
  const coverCounts = new Int32Array(CELL_COUNT);
  const centre = (BOARD_SIZE - 1) / 2;

  let id = 0;
  let cellCursor = 0;
  for (let pieceId = 0; pieceId < PIECE_COUNT; pieceId += 1) {
    const orientations = ORIENTATIONS[pieceId];
    for (let o = 0; o < orientations.length; o += 1) {
      const shape = orientations[o].cells;
      const key = orientationKey(pieceId, o);
      const sx = table.spanX[key];
      const sy = table.spanY[key];

      for (let ay = 0; ay < sy; ay += 1) {
        for (let ax = 0; ax < sx; ax += 1) {
          cellsMask.fill(0);
          let centreSum = 0;
          for (const cell of shape) {
            const x = cell.x + ax;
            const y = cell.y + ay;
            setBit(cellsMask, cellIndex(x, y));
            centreSum += Math.abs(x - centre) + Math.abs(y - centre);
          }

          const offset = id * WORDS;
          table.cells.set(cellsMask, offset);

          dilateOrthogonal(haloMask, cellsMask);
          andNotInto(haloMask, cellsMask);
          table.edgeHalo.set(haloMask, offset);

          dilateDiagonal(haloMask, cellsMask);
          andNotInto(haloMask, cellsMask);
          table.cornerHalo.set(haloMask, offset);

          // Union of the two masks the playout's rejection tests read, so one range bounds both.
          let lo = WORDS;
          let hi = 0;
          for (let w = 0; w < WORDS; w += 1) {
            if (table.cells[offset + w] !== 0 || table.edgeHalo[offset + w] !== 0) {
              if (w < lo) lo = w;
              hi = w + 1;
            }
          }
          table.maskLo[id] = lo;
          table.maskHi[id] = hi;

          table.pieceId[id] = pieceId;
          table.orientation[id] = o;
          table.size[id] = shape.length;
          table.anchorX[id] = ax;
          table.anchorY[id] = ay;
          table.centreDistance[id] = centreSum / shape.length;

          table.cellStart[id] = cellCursor;
          const written = toIndices(cellsMask, scratchIndices);
          for (let i = 0; i < written; i += 1) {
            const index = scratchIndices[i];
            table.cellList[cellCursor + i] = index;
            coverCounts[index] += 1;
          }
          cellCursor += written;
          id += 1;
        }
      }
    }
  }
  table.cellStart[count] = cellCursor;

  // Second pass: invert cellList into the per-cell cover index.
  let running = 0;
  for (let c = 0; c < CELL_COUNT; c += 1) {
    table.coverStart[c] = running;
    running += coverCounts[c];
  }
  table.coverStart[CELL_COUNT] = running;

  const cursor = table.coverStart.slice(0, CELL_COUNT);
  for (let p = 0; p < count; p += 1) {
    for (let i = table.cellStart[p]; i < table.cellStart[p + 1]; i += 1) {
      const index = table.cellList[i];
      table.coverList[cursor[index]] = p;
      cursor[index] += 1;
    }
  }

  // Third pass: piece boundaries inside each cell's cover run.
  for (let c = 0; c < CELL_COUNT; c += 1) {
    const base = c * (PIECE_COUNT + 1);
    const start = table.coverStart[c];
    const end = table.coverStart[c + 1];
    let i = start;
    for (let piece = 0; piece < PIECE_COUNT; piece += 1) {
      table.coverPieceStart[base + piece] = i;
      while (i < end && table.pieceId[table.coverList[i]] === piece) {
        i += 1;
      }
    }
    table.coverPieceStart[base + PIECE_COUNT] = i;
  }

  return table;
}

/** Built once per process (~27k placements, a few milliseconds). */
export const PLACEMENTS: PlacementTable = build();

export function placementId(
  pieceId: number,
  orientation: number,
  anchorX: number,
  anchorY: number,
): number {
  const key = orientationKey(pieceId, orientation);
  const start = PLACEMENTS.base[key];
  if (start < 0) {
    return -1;
  }
  const sx = PLACEMENTS.spanX[key];
  const sy = PLACEMENTS.spanY[key];
  if (anchorX < 0 || anchorY < 0 || anchorX >= sx || anchorY >= sy) {
    return -1;
  }
  return start + anchorY * sx + anchorX;
}

/** Cells of a placement, as flat board indices. Allocates — callers on hot paths use the CSR view. */
export function placementCells(id: number): number[] {
  const out: number[] = [];
  for (let i = PLACEMENTS.cellStart[id]; i < PLACEMENTS.cellStart[id + 1]; i += 1) {
    out.push(PLACEMENTS.cellList[i]);
  }
  return out;
}

/** Squares still in hand for a piece bitmask. */
export function remainingSquares(pieceMask: number): number {
  let total = 0;
  let bits = pieceMask;
  while (bits !== 0) {
    const piece = 31 - Math.clz32(bits & -bits);
    total += PIECE_SIZES[piece];
    bits &= bits - 1;
  }
  return total;
}

/** Size of the smallest piece still in hand, or 0 for an empty hand. */
export function smallestRemaining(pieceMask: number): number {
  let best = 0;
  let bits = pieceMask;
  while (bits !== 0) {
    const piece = 31 - Math.clz32(bits & -bits);
    const size = PIECE_SIZES[piece];
    if (best === 0 || size < best) {
      best = size;
    }
    bits &= bits - 1;
  }
  return best;
}
