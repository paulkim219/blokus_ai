import { BOARD_SIZE, START_CORNERS } from '../../engine/types';
import type { GameState, PlaceMove, PlayerColor } from '../../engine/types';
import { PIECES } from '../../engine/pieces';
import {
  createOracleInteractionContext,
  describeOracleInteraction,
  oracleSeat,
  type OracleInteractionContext,
} from './interaction';
import type {
  OracleInteractionState,
  OracleMoveFeatures,
} from './types';

const DIAGONAL = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

const ORTHOGONAL = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

function moveCells(move: PlaceMove): Set<number> {
  return new Set(move.absoluteCells.map((cell) => cell.y * BOARD_SIZE + cell.x));
}

function virtualOwner(
  state: GameState,
  move: PlaceMove,
  occupied: Set<number>,
  x: number,
  y: number,
): PlayerColor | null {
  return occupied.has(y * BOARD_SIZE + x) ? move.color : state.board[y][x];
}

function openCornerCountAfterMove(
  state: GameState,
  move: PlaceMove,
  before: ReadonlySet<number>,
): number {
  const occupied = moveCells(move);
  const after = new Set(before);
  for (const cell of move.absoluteCells) {
    after.delete(cell.y * BOARD_SIZE + cell.x);
    for (const [dx, dy] of ORTHOGONAL) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      if (inBounds(x, y)) {
        after.delete(y * BOARD_SIZE + x);
      }
    }
  }

  for (const cell of move.absoluteCells) {
    for (const [dx, dy] of DIAGONAL) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      if (!inBounds(x, y) || virtualOwner(state, move, occupied, x, y) !== null) {
        continue;
      }
      let edge = false;
      for (const [edgeDx, edgeDy] of ORTHOGONAL) {
        const nx = x + edgeDx;
        const ny = y + edgeDy;
        if (
          inBounds(nx, ny) &&
          virtualOwner(state, move, occupied, nx, ny) === move.color
        ) {
          edge = true;
          break;
        }
      }
      if (!edge) {
        after.add(y * BOARD_SIZE + x);
      }
    }
  }
  return after.size;
}

export function extractOracleMoveFeatures(
  state: GameState,
  move: PlaceMove,
  interaction: OracleInteractionState,
  context: OracleInteractionContext = createOracleInteractionContext(state),
): OracleMoveFeatures {
  const source = oracleSeat(move.color);
  const interactionFeatures = describeOracleInteraction(state, move, interaction, context);
  const center = (BOARD_SIZE - 1) / 2;
  const centroidX =
    move.absoluteCells.reduce((sum, cell) => sum + cell.x, 0) / move.absoluteCells.length;
  const centroidY =
    move.absoluteCells.reduce((sum, cell) => sum + cell.y, 0) / move.absoluteCells.length;
  const centerDistance = Math.abs(centroidX - center) + Math.abs(centroidY - center);
  const edgeDistance = Math.min(
    centroidX,
    centroidY,
    BOARD_SIZE - 1 - centroidX,
    BOARD_SIZE - 1 - centroidY,
  );
  const home = START_CORNERS[move.color];
  const homeDistance = Math.abs(centroidX - home.x) + Math.abs(centroidY - home.y);
  const beforeCorners = context.openCorners[source].size;
  const afterCorners = openCornerCountAfterMove(state, move, context.openCorners[source]);
  const totalDenial = interactionFeatures.deniedCorners.reduce((sum, value) => sum + value, 0);
  const totalContact =
    interactionFeatures.edgeContacts.reduce((sum, value) => sum + value, 0) +
    interactionFeatures.diagonalContacts.reduce((sum, value) => sum + value, 0) * 0.5;

  return {
    ...interactionFeatures,
    source,
    pieceSize: PIECES[move.pieceId].size / 5,
    centerAffinity: 1 - centerDistance / (BOARD_SIZE - 1),
    edgeAffinity: 1 - edgeDistance / ((BOARD_SIZE - 1) / 2),
    outwardProgress: homeDistance / ((BOARD_SIZE - 1) * 2),
    frontierGain: (afterCorners - beforeCorners) / 10,
    totalDenial,
    totalContact: totalContact / 10,
  };
}

export function extractOracleCandidateFeatures(
  state: GameState,
  moves: readonly PlaceMove[],
  interaction: OracleInteractionState,
): OracleMoveFeatures[] {
  const context = createOracleInteractionContext(state);
  return moves.map((move) => extractOracleMoveFeatures(state, move, interaction, context));
}
