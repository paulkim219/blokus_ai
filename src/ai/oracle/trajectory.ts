import { generateLegalMoves, moveKey } from '../../engine/game';
import { BOARD_SIZE } from '../../engine/types';
import type { GameState, PlaceMove } from '../../engine/types';
import {
  advanceOracleInteraction,
  createOracleInteractionContext,
  createOracleInteractionState,
  oracleColor,
  oracleSeat,
} from './interaction';
import { standardizeOracleFeatures } from './prototypeBayes';
import { extractOracleCandidateFeatures } from './styleFeatures';
import type { OracleInteractionState, OracleMoveFeatures } from './types';

export const ORACLE_POLICY_FEATURE_NAMES = [
  'pieceSize',
  'centerAffinity',
  'edgeAffinity',
  'outwardProgress',
  'frontierGain',
  'totalDenial',
  'totalContact',
  'retaliation',
  'persistence',
] as const;

export type OraclePolicyFeatureName = (typeof ORACLE_POLICY_FEATURE_NAMES)[number];

const PIECE_FEATURE_NAMES = Array.from({ length: 21 }, (_, piece) => `piece_${piece}`);
const TARGET_FEATURE_NAMES = Array.from({ length: 4 }, (_, relative) => [
  `target${relative}_pressure`,
  `target${relative}_deniedCorners`,
  `target${relative}_edgeContacts`,
  `target${relative}_diagonalContacts`,
]).flat();

export const ORACLE_CONTEXT_POLICY_FEATURE_NAMES = [
  ...ORACLE_POLICY_FEATURE_NAMES,
  ...PIECE_FEATURE_NAMES,
  'homeAnchorX',
  'homeAnchorY',
  'homeCentroidX',
  'homeCentroidY',
  ...TARGET_FEATURE_NAMES,
  ...Array.from({ length: 4 }, (_, relative) => `primaryTarget_${relative}`),
  ...Array.from({ length: 5 }, (_, cell) => `canonicalCell_${cell}`),
] as const;

export const ORACLE_CONTEXT_STATE_FEATURE_NAMES = [
  ...Array.from({ length: 4 }, (_, relative) =>
    Array.from({ length: 21 }, (_, piece) => `seat${relative}_remaining_${piece}`),
  ).flat(),
  ...Array.from({ length: 4 }, (_, relative) => `seat${relative}_occupiedSquares`),
  ...Array.from({ length: 4 }, (_, relative) => `seat${relative}_openCorners`),
  ...Array.from({ length: 4 }, (_, source) =>
    Array.from({ length: 4 }, (_, target) => `pressure_${source}_${target}`),
  ).flat(),
  'normalizedPly',
] as const;

export interface OracleTrajectoryDecision {
  seat: number;
  ply: number;
  label: string;
  candidates: number[][];
  actualIndex: number;
  /** Present only for the context-rich contract; canonical 20x20x4 channel-last ownership. */
  board?: number[];
  /** Present only for the context-rich contract; shared once by every legal candidate. */
  stateFeatures?: number[];
}

export interface OracleTrajectoryResult {
  decisions: OracleTrajectoryDecision[];
  missingPlayedActions: number;
}

export function oraclePolicyFeatureVector(features: OracleMoveFeatures): number[] {
  return ORACLE_POLICY_FEATURE_NAMES.map((name) => features[name]);
}

function canonicalCoordinate(coordinate: number, source: number, axis: 'x' | 'y'): number {
  const reflected =
    axis === 'x' ? source === 2 || source === 3 : source === 1 || source === 2;
  return reflected ? BOARD_SIZE - 1 - coordinate : coordinate;
}

function canonicalCellIndex(x: number, y: number, source: number): number {
  return (
    canonicalCoordinate(y, source, 'y') * BOARD_SIZE +
    canonicalCoordinate(x, source, 'x')
  );
}

export function oracleContextCandidateVector(
  move: PlaceMove,
  features: OracleMoveFeatures,
): number[] {
  const source = features.source;
  const piece = Array.from({ length: 21 }, (_, index) => Number(index === move.pieceId));
  const centroidX =
    move.absoluteCells.reduce((sum, cell) => sum + cell.x, 0) / move.absoluteCells.length;
  const centroidY =
    move.absoluteCells.reduce((sum, cell) => sum + cell.y, 0) / move.absoluteCells.length;
  const coordinates = [
    canonicalCoordinate(move.anchor.x, source, 'x') / (BOARD_SIZE - 1),
    canonicalCoordinate(move.anchor.y, source, 'y') / (BOARD_SIZE - 1),
    canonicalCoordinate(centroidX, source, 'x') / (BOARD_SIZE - 1),
    canonicalCoordinate(centroidY, source, 'y') / (BOARD_SIZE - 1),
  ];
  const targets: number[] = [];
  for (let relative = 0; relative < 4; relative += 1) {
    const target = (source + relative) % 4;
    targets.push(
      Math.min(4, features.targetPressure[target] / 5),
      Math.min(1, features.deniedCorners[target] / 5),
      Math.min(1, features.edgeContacts[target] / 5),
      Math.min(1, features.diagonalContacts[target] / 5),
    );
  }
  const primary = Array.from({ length: 4 }, (_, relative) =>
    Number(features.primaryTarget >= 0 && (source + relative) % 4 === features.primaryTarget),
  );
  const cells = move.absoluteCells
    .map((cell) => canonicalCellIndex(cell.x, cell.y, source) / (BOARD_SIZE * BOARD_SIZE - 1))
    .sort((a, b) => a - b);
  while (cells.length < 5) cells.push(-1);
  return [
    ...oraclePolicyFeatureVector(features),
    ...piece,
    ...coordinates,
    ...targets,
    ...primary,
    ...cells,
  ];
}

export function oracleContextStateVector(
  state: GameState,
  interaction: OracleInteractionState,
  source: number,
): number[] {
  const context = createOracleInteractionContext(state);
  const output: number[] = [];
  for (let relative = 0; relative < 4; relative += 1) {
    const color = oracleColor(source + relative);
    const remaining = new Set(state.remainingPieces[color]);
    for (let piece = 0; piece < 21; piece += 1) output.push(Number(remaining.has(piece)));
  }
  for (let relative = 0; relative < 4; relative += 1) {
    const color = oracleColor(source + relative);
    let occupied = 0;
    for (const row of state.board) {
      for (const owner of row) occupied += Number(owner === color);
    }
    output.push(occupied / 89);
  }
  for (let relative = 0; relative < 4; relative += 1) {
    output.push(context.openCorners[(source + relative) % 4].size / 20);
  }
  for (let relativeSource = 0; relativeSource < 4; relativeSource += 1) {
    for (let relativeTarget = 0; relativeTarget < 4; relativeTarget += 1) {
      output.push(
        Math.min(
          4,
          interaction.pressure[(source + relativeSource) % 4][(source + relativeTarget) % 4] /
            5,
        ),
      );
    }
  }
  output.push(interaction.ply / 84);
  return output;
}

export function oracleContextBoard(state: GameState, source: number): number[] {
  const board = Array.from({ length: BOARD_SIZE * BOARD_SIZE * 4 }, () => 0);
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const owner = state.board[y][x];
      if (!owner) continue;
      const relative = (oracleSeat(owner) - source + 4) % 4;
      board[canonicalCellIndex(x, y, source) * 4 + relative] = 1;
    }
  }
  return board;
}

/**
 * Prediction-only recorder for the learned Oracle policy. Candidate features are standardized
 * within the exact legal set, and the interaction state advances only after a real observed move.
 */
export class OracleTrajectoryCollector {
  private interaction: OracleInteractionState = createOracleInteractionState();
  private readonly decisions: OracleTrajectoryDecision[] = [];
  private missingPlayedActions = 0;
  private readonly contextual: boolean;

  constructor(contextual = false) {
    this.contextual = contextual;
  }

  observe(state: GameState, played: PlaceMove | null, label: string, ply: number): void {
    if (!played) {
      this.interaction = advanceOracleInteraction(this.interaction, null);
      return;
    }

    const source = oracleSeat(played.color);
    const candidates = generateLegalMoves(state, played.color);
    const key = moveKey(played);
    let actualIndex = candidates.findIndex((move) => moveKey(move) === key);
    if (actualIndex < 0) {
      candidates.push(played);
      actualIndex = candidates.length - 1;
      this.missingPlayedActions += 1;
    }
    const features = standardizeOracleFeatures(
      extractOracleCandidateFeatures(state, candidates, this.interaction),
    );
    const shared = this.contextual
      ? {
          board: oracleContextBoard(state, source),
          stateFeatures: oracleContextStateVector(state, this.interaction, source),
        }
      : {};
    this.decisions.push({
      seat: source,
      ply,
      label,
      candidates: this.contextual
        ? features.map((candidate, index) =>
            oracleContextCandidateVector(candidates[index], candidate),
          )
        : features.map(oraclePolicyFeatureVector),
      actualIndex,
      ...shared,
    });
    this.interaction = advanceOracleInteraction(this.interaction, features[actualIndex]);
  }

  result(): OracleTrajectoryResult {
    return {
      decisions: this.decisions.map((decision) => ({
        ...decision,
        candidates: decision.candidates.map((candidate) => [...candidate]),
        board: decision.board ? [...decision.board] : undefined,
        stateFeatures: decision.stateFeatures ? [...decision.stateFeatures] : undefined,
      })),
      missingPlayedActions: this.missingPlayedActions,
    };
  }
}
