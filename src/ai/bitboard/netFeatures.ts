import { CELL_COUNT, popcount } from './bitboard';
import { PIECE_SIZES } from './placements';
import type { Position } from './position';
import { SEAT_COUNT } from './seats';
import type { EvalContext } from './features';

/**
 * The feature contract shared by the TensorFlow trainer and the in-engine forward pass.
 *
 * Two constraints shape this vector, and both come from what the v11/v12 investigation found.
 *
 * First, **every feature must already be computed by `refreshContext`**, or be an O(1) read off the
 * `Position`. The network is evaluated at every MCTS leaf, so a feature that costs its own board
 * sweep would price the evaluation out of the search that needs it. Nothing here re-runs a BFS.
 *
 * Second, the vector is **seat-relative**. Index 0 is always the seat being scored and the other
 * three follow in turn order from it, so one network serves all four seats and every position
 * yields four training rows instead of one. This also removes the seat-identity confound that
 * `v10e-seat` (−0.10 [−0.36, 0.16]) showed carries no signal worth spending parameters on.
 *
 * Keep `FEATURE_NAMES` and `writeFeatures` in lockstep: `ml/train_v4.py` reads the names from the
 * exported dataset header and asserts the width matches, so a mismatch fails loudly at train time
 * rather than silently scrambling the inputs at inference time.
 */

/** Per-seat block, repeated four times in seat-relative order. */
const PER_SEAT = [
  'placed',
  'piecesLeft',
  'squaresLeft',
  'territory',
  'reachable',
  'openCorners',
  'cornerScore',
  'centreScore',
  'waste',
  'uniqueCorners',
  'contestedCorners',
  'sealed',
  'largestPiece',
  'smallestPiece',
  'handSize1',
  'handSize2',
  'handSize3',
  'handSize4',
  'handSize5',
] as const;

const GLOBAL = [
  'progress',
  'regions',
  'contestedShare',
  'emptyShare',
  'phaseOpening',
  'phaseMidgame',
  'phaseEndgame',
  'toMoveIsSelf',
] as const;

export const FEATURE_NAMES: string[] = [
  ...Array.from({ length: SEAT_COUNT }, (_, s) => PER_SEAT.map((n) => `s${s}_${n}`)).flat(),
  ...GLOBAL,
  // The exact hand, one bit per piece, for every seat. Piece *identity* matters in Blokus in a way
  // the size histogram cannot express — holding the F-pentomino is not the same as holding the I,
  // and which specific shapes are gone determines what still fits in a funnel.
  ...Array.from({ length: SEAT_COUNT }, (_, s) =>
    Array.from({ length: 21 }, (_, p) => `s${s}_has${p}`),
  ).flat(),
];

export const FEATURE_COUNT = FEATURE_NAMES.length;

/**
 * Writes one seat's view of `position` into `out` at `offset`. `context` must already have been
 * refreshed for this position.
 */
export function writeFeatures(
  out: Float32Array,
  offset: number,
  position: Position,
  context: EvalContext,
  seat: number,
): void {
  const { territory, ownership } = context;
  let k = offset;

  let emptyCells = CELL_COUNT;
  for (let s = 0; s < SEAT_COUNT; s += 1) {
    emptyCells -= position.placedSquares(s);
  }

  for (let i = 0; i < SEAT_COUNT; i += 1) {
    const s = (seat + i) % SEAT_COUNT;
    const hand = position.hand[s];

    let piecesLeft = 0;
    let squaresLeft = 0;
    let largest = 0;
    let smallest = 6;
    const bySize = [0, 0, 0, 0, 0];
    for (let p = 0; p < 21; p += 1) {
      if ((hand & (1 << p)) === 0) {
        continue;
      }
      const size = PIECE_SIZES[p];
      piecesLeft += 1;
      squaresLeft += size;
      bySize[size - 1] += 1;
      if (size > largest) {
        largest = size;
      }
      if (size < smallest) {
        smallest = size;
      }
    }
    if (smallest === 6) {
      smallest = 0;
    }

    // Corners that only this seat holds are the ones that survive an opponent's next move; total
    // count alone overstates a position whose corners are all contested.
    let unique = 0;
    let contested = 0;
    for (let region = 0; region < ownership.count; region += 1) {
      const mine = ownership.corners[region * SEAT_COUNT + s];
      if (mine === 0) {
        continue;
      }
      const total = ownership.totalCorners[region];
      if (total === mine) {
        unique += mine;
      } else {
        contested += mine;
      }
    }

    const openCorners = popcount(territory.openCorners[s]);

    out[k++] = position.placedSquares(s) / 89;
    out[k++] = piecesLeft / 21;
    out[k++] = squaresLeft / 89;
    out[k++] = territory.territory[s] / 400;
    out[k++] = territory.reachableCount[s] / 400;
    out[k++] = openCorners / 40;
    out[k++] = context.cornerScore[s] / 10;
    out[k++] = context.centreScore[s] / 10;
    out[k++] = context.waste[s] / 50;
    out[k++] = unique / 40;
    out[k++] = contested / 40;
    out[k++] = openCorners === 0 ? 1 : 0;
    out[k++] = largest / 5;
    out[k++] = smallest / 5;
    for (let b = 0; b < 5; b += 1) {
      out[k++] = bySize[b] / 21;
    }
  }

  const progress = 1 - emptyCells / CELL_COUNT;
  const placedSelf = 21 - popcount21(position.hand[seat]);
  out[k++] = progress;
  out[k++] = ownership.count / 12;
  out[k++] = territory.contested / 400;
  out[k++] = emptyCells / CELL_COUNT;
  out[k++] = placedSelf < 5 ? 1 : 0;
  out[k++] = placedSelf >= 5 && placedSelf < 15 ? 1 : 0;
  out[k++] = placedSelf >= 15 ? 1 : 0;
  out[k++] = position.turn === seat ? 1 : 0;

  for (let i = 0; i < SEAT_COUNT; i += 1) {
    const hand = position.hand[(seat + i) % SEAT_COUNT];
    for (let p = 0; p < 21; p += 1) {
      out[k++] = (hand & (1 << p)) !== 0 ? 1 : 0;
    }
  }
}

function popcount21(mask: number): number {
  let m = mask - ((mask >> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >> 2) & 0x33333333);
  m = (m + (m >> 4)) & 0x0f0f0f0f;
  return (m * 0x01010101) >> 24;
}
