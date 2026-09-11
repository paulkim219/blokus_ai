import { testBit } from './bitboard';
import type { EvalContext } from './features';
import { PLACEMENTS } from './placements';
import {
  POLICY_FEATURE_COUNT,
  POLICY_FEATURE_NAMES,
  writePolicyFeatures,
} from './policyFeatures';
import type { Position } from './position';
import { HOME_CORNER } from './seats';

const LOCAL_FEATURE_NAMES = [
  'move_selfDiagonalContacts',
  ...Array.from({ length: 3 }, (_, opponent) => [
    `move_opponent${opponent + 1}EdgeContacts`,
    `move_opponent${opponent + 1}DiagonalContacts`,
    `move_opponent${opponent + 1}OpenCornersCovered`,
  ]).flat(),
] as const;

/**
 * Experimental v4.3 action contract. The original 242 inputs remain as a prefix so every deployed
 * artifact keeps its exact interpretation. The suffix fixes two information losses:
 *
 * - absolute action coordinates were ambiguous after the mover was relabelled as relative seat 0;
 * - global child deltas did not say which opponent frontier the placement physically touched.
 */
export const POLICY_V2_FEATURE_NAMES = [
  ...POLICY_FEATURE_NAMES,
  'move_homeAnchorX',
  'move_homeAnchorY',
  'move_homeCentroidX',
  'move_homeCentroidY',
  ...LOCAL_FEATURE_NAMES,
];

export const POLICY_V2_FEATURE_COUNT = POLICY_V2_FEATURE_NAMES.length;

function towardHome(coordinate: number, homeCoordinate: number): number {
  return (homeCoordinate === 0 ? coordinate : 19 - coordinate) / 19;
}

/** Writes the v4.3 policy feature proposal. `child` already contains `placement`. */
export function writePolicyFeaturesV2(
  out: Float32Array,
  child: Position,
  childContext: EvalContext,
  perspectiveSeat: number,
  placement: number,
  parentFeatures: Float32Array,
): void {
  writePolicyFeatures(
    out,
    child,
    childContext,
    perspectiveSeat,
    placement,
    parentFeatures,
  );

  const start = PLACEMENTS.cellStart[placement];
  const end = PLACEMENTS.cellStart[placement + 1];
  let sumX = 0;
  let sumY = 0;
  for (let i = start; i < end; i += 1) {
    const cell = PLACEMENTS.cellList[i];
    sumX += cell % 20;
    sumY += Math.floor(cell / 20);
  }
  const cells = Math.max(1, end - start);
  const home = HOME_CORNER[perspectiveSeat];
  const homeX = home % 20;
  const homeY = Math.floor(home / 20);

  let k = POLICY_FEATURE_COUNT;
  out[k++] = towardHome(PLACEMENTS.anchorX[placement], homeX);
  out[k++] = towardHome(PLACEMENTS.anchorY[placement], homeY);
  out[k++] = towardHome(sumX / cells, homeX);
  out[k++] = towardHome(sumY / cells, homeY);

  const edgeContacts = new Int32Array(4);
  const diagonalContacts = new Int32Array(4);
  const openCornersCovered = new Int32Array(4);
  for (let i = start; i < end; i += 1) {
    const cell = PLACEMENTS.cellList[i];
    const x = cell % 20;
    const y = Math.floor(cell / 20);
    for (let relative = 0; relative < 4; relative += 1) {
      const seat = (perspectiveSeat + relative) % 4;
      if (
        relative > 0 &&
        testBit(child.cornerHalo[seat], cell) &&
        !testBit(child.edgeHalo[seat], cell)
      ) {
        openCornersCovered[relative] += 1;
      }
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (
            (dx === 0 && dy === 0) ||
            x + dx < 0 ||
            x + dx > 19 ||
            y + dy < 0 ||
            y + dy > 19
          ) {
            continue;
          }
          const neighbour = (y + dy) * 20 + x + dx;
          if (!testBit(child.own[seat], neighbour)) {
            continue;
          }
          if (dx === 0 || dy === 0) {
            edgeContacts[relative] += 1;
          } else {
            diagonalContacts[relative] += 1;
          }
        }
      }
    }
  }

  out[k++] = diagonalContacts[0] / 20;
  for (let relative = 1; relative < 4; relative += 1) {
    out[k++] = edgeContacts[relative] / 20;
    out[k++] = diagonalContacts[relative] / 20;
    out[k++] = openCornersCovered[relative] / 5;
  }
}
