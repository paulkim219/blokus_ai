import { CELL_COUNT } from './bitboard';
import type { EvalContext } from './features';
import { FEATURE_COUNT, FEATURE_NAMES, writeFeatures } from './netFeatures';
import type { Position } from './position';
import { SEAT_COUNT } from './seats';

const GRID = 4;
const BUCKETS = GRID * GRID;

/** Engineered vector plus compact root-relative spatial maps at 5×5-cell resolution. */
export const LEAF_FEATURE_NAMES = [
  ...FEATURE_NAMES,
  ...(['occupancy', 'openCorner', 'edgeHalo'] as const).flatMap((plane) =>
    Array.from({ length: SEAT_COUNT }, (_, relative) =>
      Array.from({ length: BUCKETS }, (_, bucket) => `${plane}_r${relative}_b${bucket}`),
    ).flat(),
  ),
];

export const LEAF_FEATURE_COUNT = LEAF_FEATURE_NAMES.length;

/** Rotate the root seat's home corner to top-left while preserving turn-order orientation. */
export function canonicalCell(cell: number, rootSeat: number): number {
  const x = cell % 20;
  const y = Math.floor(cell / 20);
  if (rootSeat === 1) return (19 - y) + 20 * x;
  if (rootSeat === 2) return (19 - x) + 20 * (19 - y);
  if (rootSeat === 3) return y + 20 * (19 - x);
  return cell;
}

/**
 * Coarse board geometry for the leaf MLP. The first 168 entries remain byte-compatible with every
 * earlier network. Exact 20×20 planes were tested first, but with 24 independent games they
 * memorised locations and failed held-out games; these pooled maps are the data-appropriate middle.
 */
export function writeLeafFeatures(
  out: Float32Array,
  offset: number,
  position: Position,
  context: EvalContext,
  rootSeat: number,
): void {
  writeFeatures(out, offset, position, context, rootSeat);
  let k = offset + FEATURE_COUNT;
  out.fill(0, k, k + 3 * SEAT_COUNT * BUCKETS);
  const planes = [position.own, context.territory.openCorners, position.edgeHalo];
  for (const plane of planes) {
    for (let relative = 0; relative < SEAT_COUNT; relative += 1) {
      const seat = (rootSeat + relative) % SEAT_COUNT;
      const mask = plane[seat];
      for (let cell = 0; cell < CELL_COUNT; cell += 1) {
        if (((mask[cell >>> 5] >>> (cell & 31)) & 1) === 0) continue;
        const canonical = canonicalCell(cell, rootSeat);
        const x = canonical % 20;
        const y = Math.floor(canonical / 20);
        out[k + Math.floor(x / 5) + GRID * Math.floor(y / 5)] += 1 / 25;
      }
      k += BUCKETS;
    }
  }
}
