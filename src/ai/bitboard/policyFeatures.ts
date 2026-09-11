import type { EvalContext } from './features';
import { FEATURE_COUNT, FEATURE_NAMES, writeFeatures } from './netFeatures';
import { PLACEMENTS } from './placements';
import type { Position } from './position';

const DELTA_FIELDS = [
  'placed',
  'territory',
  'reachable',
  'openCorners',
  'cornerScore',
  'centreScore',
  'waste',
  'uniqueCorners',
  'contestedCorners',
] as const;

const DELTA_INDICES = Array.from({ length: 4 }, (_, seat) =>
  DELTA_FIELDS.map((field) => FEATURE_NAMES.indexOf(`s${seat}_${field}`)),
).flat();
const GLOBAL_DELTA_NAMES = ['regions', 'contestedShare', 'emptyShare'] as const;
const GLOBAL_DELTA_INDICES = GLOBAL_DELTA_NAMES.map((name) => FEATURE_NAMES.indexOf(name));

export const POLICY_FEATURE_NAMES = [
  ...FEATURE_NAMES,
  ...Array.from({ length: 21 }, (_, piece) => `move_piece${piece}`),
  ...Array.from({ length: 8 }, (_, orientation) => `move_orientation${orientation}`),
  'move_size',
  'move_anchorX',
  'move_anchorY',
  'move_centroidX',
  'move_centroidY',
  'move_centreDistance',
  ...Array.from({ length: 4 }, (_, seat) =>
    DELTA_FIELDS.map((field) => `delta_s${seat}_${field}`),
  ).flat(),
  ...GLOBAL_DELTA_NAMES.map((name) => `delta_${name}`),
];

export const POLICY_FEATURE_COUNT = POLICY_FEATURE_NAMES.length;

/**
 * Policy-only input: the child-state vector plus explicit move identity/geometry and the features
 * that changed from the parent. The value network never sees this contract; it remains on the
 * original 168 state features.
 */
export function writePolicyFeatures(
  out: Float32Array,
  child: Position,
  childContext: EvalContext,
  perspectiveSeat: number,
  placement: number,
  parentFeatures: Float32Array,
): void {
  writeFeatures(out, 0, child, childContext, perspectiveSeat);
  out.fill(0, FEATURE_COUNT);
  let k = FEATURE_COUNT;

  out[k + PLACEMENTS.pieceId[placement]] = 1;
  k += 21;
  out[k + PLACEMENTS.orientation[placement]] = 1;
  k += 8;

  let sumX = 0;
  let sumY = 0;
  const start = PLACEMENTS.cellStart[placement];
  const end = PLACEMENTS.cellStart[placement + 1];
  for (let i = start; i < end; i += 1) {
    const cell = PLACEMENTS.cellList[i];
    sumX += cell % 20;
    sumY += Math.floor(cell / 20);
  }
  const cells = Math.max(1, end - start);
  out[k++] = PLACEMENTS.size[placement] / 5;
  out[k++] = PLACEMENTS.anchorX[placement] / 19;
  out[k++] = PLACEMENTS.anchorY[placement] / 19;
  out[k++] = sumX / cells / 19;
  out[k++] = sumY / cells / 19;
  out[k++] = PLACEMENTS.centreDistance[placement] / 19;

  for (const index of DELTA_INDICES) {
    out[k++] = out[index] - parentFeatures[index];
  }
  for (const index of GLOBAL_DELTA_INDICES) {
    out[k++] = out[index] - parentFeatures[index];
  }
}
