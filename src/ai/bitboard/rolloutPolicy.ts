/**
 * v4.1's runtime-cheap learned terminal-rollout policy.
 *
 * Training fits a phase-specific linear ranker on counterfactual terminal returns. Loading compiles
 * every static term into a phase × seat × placement table, so the hot loop pays three lookups and
 * two multiply-adds: a static score plus hand-square and hand-piece slopes. The feature extractor is
 * exported so training and deployment share one contract.
 */

import { WORDS } from './bitboard';
import type { PhaseId } from './config';
import { canonicalCell } from './leafNetFeatures';
import { PLACEMENTS, TOTAL_SQUARES } from './placements';
import { SEAT_COUNT } from './seats';

const GRID = 4;
const BUCKETS = GRID * GRID;
const STATIC_COUNT = 46;

export const ROLLOUT_POLICY_FEATURE_NAMES = [
  'size',
  'centreDistance',
  'cornerHalo',
  'edgeHalo',
  ...Array.from({ length: 21 }, (_, piece) => `piece_${piece}`),
  ...Array.from({ length: BUCKETS }, (_, bucket) => `footprint_${bucket}`),
  'canonicalX',
  'canonicalY',
  'canonicalXY',
  'canonicalX2',
  'canonicalY2',
  'handFraction_x_size',
  'handFraction_x_centre',
  'handFraction_x_corner',
  'pieceFraction_x_size',
  'pieceFraction_x_corner',
  'pieceFraction_x_edge',
] as const;

export const ROLLOUT_POLICY_FEATURE_COUNT = ROLLOUT_POLICY_FEATURE_NAMES.length;

if (STATIC_COUNT + 6 !== ROLLOUT_POLICY_FEATURE_COUNT) {
  throw new Error('rollout policy feature partition is stale');
}

const cornerCounts = new Float32Array(PLACEMENTS.count);
const edgeCounts = new Float32Array(PLACEMENTS.count);

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

for (let move = 0; move < PLACEMENTS.count; move += 1) {
  const offset = move * WORDS;
  let corner = 0;
  let edge = 0;
  for (let word = 0; word < WORDS; word += 1) {
    corner += popcount32(PLACEMENTS.cornerHalo[offset + word]);
    edge += popcount32(PLACEMENTS.edgeHalo[offset + word]);
  }
  cornerCounts[move] = corner;
  edgeCounts[move] = edge;
}

function phaseIndex(phase: PhaseId): number {
  return phase === 'opening' ? 0 : phase === 'midgame' ? 1 : 2;
}

function bitCount21(mask: number): number {
  let value = mask;
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Writes the exact raw feature vector fitted offline. No allocation. */
export function writeRolloutPolicyFeatures(
  out: Float32Array,
  move: number,
  seat: number,
  handSquares: number,
  handMask: number,
): Float32Array {
  out.fill(0);
  const size = PLACEMENTS.size[move];
  const centre = PLACEMENTS.centreDistance[move] / 19;
  const corner = cornerCounts[move] / 20;
  const edge = edgeCounts[move] / 20;
  out[0] = size / 5;
  out[1] = centre;
  out[2] = corner;
  out[3] = edge;
  out[4 + PLACEMENTS.pieceId[move]] = 1;

  let xTotal = 0;
  let yTotal = 0;
  const start = PLACEMENTS.cellStart[move];
  const end = PLACEMENTS.cellStart[move + 1];
  const cells = Math.max(1, end - start);
  for (let at = start; at < end; at += 1) {
    const canonical = canonicalCell(PLACEMENTS.cellList[at], seat);
    const x = canonical % 20;
    const y = Math.floor(canonical / 20);
    xTotal += x;
    yTotal += y;
    const bucket = Math.floor(x / 5) + GRID * Math.floor(y / 5);
    out[25 + bucket] += 1 / cells;
  }
  const x = xTotal / cells / 19;
  const y = yTotal / cells / 19;
  out[41] = x;
  out[42] = y;
  out[43] = x * y;
  out[44] = x * x;
  out[45] = y * y;

  const handFraction = handSquares / TOTAL_SQUARES;
  const pieceFraction = bitCount21(handMask) / 21;
  out[46] = handFraction * out[0];
  out[47] = handFraction * centre;
  out[48] = handFraction * corner;
  out[49] = pieceFraction * out[0];
  out[50] = pieceFraction * corner;
  out[51] = pieceFraction * edge;
  return out;
}

export interface RawRolloutPolicy {
  kind: 'canonical-rollout-policy-v41';
  featureCount: number;
  featureNames: string[];
  /** Raw-space linear weights in opening, midgame, endgame order. */
  weights: number[][];
  /** Validation-selected interpolation: 0 is incumbent, 1 is fully learned. */
  blend: number;
  meta?: Record<string, unknown>;
}

export interface RolloutPolicy {
  staticScores: Float32Array;
  handSlopes: Float32Array;
  pieceSlopes: Float32Array;
  blend: number;
  meta: Record<string, unknown>;
}

const scratch = new Float32Array(ROLLOUT_POLICY_FEATURE_COUNT);

export function loadRolloutPolicy(raw: RawRolloutPolicy): RolloutPolicy {
  if (
    raw.kind !== 'canonical-rollout-policy-v41' ||
    raw.featureCount !== ROLLOUT_POLICY_FEATURE_COUNT ||
    raw.weights.length !== 3 ||
    raw.weights.some((weights) => weights.length !== ROLLOUT_POLICY_FEATURE_COUNT) ||
    raw.blend < 0 ||
    raw.blend > 1
  ) {
    throw new Error('invalid v4.1 rollout policy contract');
  }
  const total = 3 * SEAT_COUNT * PLACEMENTS.count;
  const staticScores = new Float32Array(total);
  const handSlopes = new Float32Array(total);
  const pieceSlopes = new Float32Array(total);
  for (let phase = 0; phase < 3; phase += 1) {
    const weights = raw.weights[phase];
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      for (let move = 0; move < PLACEMENTS.count; move += 1) {
        writeRolloutPolicyFeatures(scratch, move, seat, 0, 0);
        let score = 0;
        for (let feature = 0; feature < STATIC_COUNT; feature += 1) {
          score += scratch[feature] * weights[feature];
        }
        const index = (phase * SEAT_COUNT + seat) * PLACEMENTS.count + move;
        staticScores[index] = score;
        handSlopes[index] =
          scratch[0] * weights[46] + scratch[1] * weights[47] + scratch[2] * weights[48];
        pieceSlopes[index] =
          scratch[0] * weights[49] + scratch[2] * weights[50] + scratch[3] * weights[51];
      }
    }
  }
  return {
    staticScores,
    handSlopes,
    pieceSlopes,
    blend: raw.blend,
    meta: raw.meta ?? {},
  };
}

export function scoreRolloutPolicy(
  policy: RolloutPolicy,
  phase: PhaseId,
  seat: number,
  move: number,
  handSquares: number,
  handMask: number,
): number {
  const index = (phaseIndex(phase) * SEAT_COUNT + seat) * PLACEMENTS.count + move;
  return (
    policy.staticScores[index] +
    policy.handSlopes[index] * (handSquares / TOTAL_SQUARES) +
    policy.pieceSlopes[index] * (bitCount21(handMask) / 21)
  );
}

const registry = new Map<string, RolloutPolicy>();

export function registerRolloutPolicy(path: string, policy: RolloutPolicy): void {
  registry.set(path, policy);
}

export function rolloutPolicyFor(path: string | undefined): RolloutPolicy | null {
  return path ? registry.get(path) ?? null : null;
}

export function isRolloutPolicyRegistered(path: string): boolean {
  return registry.has(path);
}

