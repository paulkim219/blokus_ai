import { BOARD_SIZE, PLAYER_COLORS, START_CORNERS, TURN_ORDER } from '../../engine/types';
import type { GameState, PlaceMove, PlayerColor } from '../../engine/types';
import type { OracleInteractionState, OracleMoveInteraction } from './types';

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

const ALL_NEIGHBOURS = [...ORTHOGONAL, ...DIAGONAL] as const;

export const ORACLE_PRESSURE_DECAY = 0.9;

export interface OracleInteractionContext {
  openCorners: Array<Set<number>>;
}

export function oracleSeat(color: PlayerColor): number {
  return TURN_ORDER.indexOf(color);
}

export function oracleColor(seat: number): PlayerColor {
  return TURN_ORDER[((seat % TURN_ORDER.length) + TURN_ORDER.length) % TURN_ORDER.length];
}

export function createOracleInteractionState(): OracleInteractionState {
  return {
    ply: 0,
    pressure: Array.from({ length: PLAYER_COLORS.length }, () =>
      Array.from({ length: PLAYER_COLORS.length }, () => 0),
    ),
    lastAggressor: Array.from({ length: PLAYER_COLORS.length }, () => -1),
    lastVictim: Array.from({ length: PLAYER_COLORS.length }, () => -1),
  };
}

export function cloneOracleInteractionState(
  state: OracleInteractionState,
): OracleInteractionState {
  return {
    ply: state.ply,
    pressure: state.pressure.map((row) => [...row]),
    lastAggressor: [...state.lastAggressor],
    lastVictim: [...state.lastVictim],
  };
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

export function currentOracleOpenCorners(state: GameState, color: PlayerColor): Set<number> {
  const result = new Set<number>();
  if (!state.hasPlayed[color]) {
    if (state.openingMode === 'corner') {
      const corner = START_CORNERS[color];
      if (state.board[corner.y][corner.x] === null) {
        result.add(corner.y * BOARD_SIZE + corner.x);
      }
    }
    return result;
  }

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (state.board[y][x] !== null) {
        continue;
      }
      let diagonal = false;
      for (const [dx, dy] of DIAGONAL) {
        const nx = x + dx;
        const ny = y + dy;
        if (inBounds(nx, ny) && state.board[ny][nx] === color) {
          diagonal = true;
          break;
        }
      }
      if (!diagonal) {
        continue;
      }
      let edge = false;
      for (const [dx, dy] of ORTHOGONAL) {
        const nx = x + dx;
        const ny = y + dy;
        if (inBounds(nx, ny) && state.board[ny][nx] === color) {
          edge = true;
          break;
        }
      }
      if (!edge) {
        result.add(y * BOARD_SIZE + x);
      }
    }
  }
  return result;
}

export function createOracleInteractionContext(state: GameState): OracleInteractionContext {
  return {
    openCorners: TURN_ORDER.map((color) => currentOracleOpenCorners(state, color)),
  };
}

/**
 * Extracts who a move pressures without mutating either the rules state or the interaction state.
 * The weights are intentionally simple and preregistered: denying a legal corner is stronger
 * evidence than merely landing next to an opponent's material.
 */
export function describeOracleInteraction(
  state: GameState,
  move: PlaceMove,
  interaction: OracleInteractionState,
  context: OracleInteractionContext = createOracleInteractionContext(state),
): OracleMoveInteraction {
  const source = oracleSeat(move.color);
  const deniedCorners = Array.from({ length: PLAYER_COLORS.length }, () => 0);
  const edgeContacts = Array.from({ length: PLAYER_COLORS.length }, () => 0);
  const diagonalContacts = Array.from({ length: PLAYER_COLORS.length }, () => 0);
  const seenEdge = TURN_ORDER.map(() => new Set<number>());
  const seenDiagonal = TURN_ORDER.map(() => new Set<number>());

  for (const cell of move.absoluteCells) {
    const cellIndex = cell.y * BOARD_SIZE + cell.x;
    for (let target = 0; target < PLAYER_COLORS.length; target += 1) {
      if (target !== source && context.openCorners[target].has(cellIndex)) {
        deniedCorners[target] += 1;
      }
    }

    for (let neighbourIndex = 0; neighbourIndex < ALL_NEIGHBOURS.length; neighbourIndex += 1) {
      const [dx, dy] = ALL_NEIGHBOURS[neighbourIndex];
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      if (!inBounds(nx, ny)) {
        continue;
      }
      const occupant = state.board[ny][nx];
      if (!occupant || occupant === move.color) {
        continue;
      }
      const target = oracleSeat(occupant);
      const index = ny * BOARD_SIZE + nx;
      if (neighbourIndex < ORTHOGONAL.length) {
        seenEdge[target].add(index);
      } else {
        seenDiagonal[target].add(index);
      }
    }
  }

  for (let target = 0; target < PLAYER_COLORS.length; target += 1) {
    edgeContacts[target] = seenEdge[target].size;
    diagonalContacts[target] = seenDiagonal[target].size;
  }

  const targetPressure = Array.from({ length: PLAYER_COLORS.length }, (_, target) =>
    target === source
      ? 0
      : deniedCorners[target] * 2 + edgeContacts[target] * 0.35 + diagonalContacts[target] * 0.15,
  );
  let primaryTarget = -1;
  let largestPressure = 0;
  let retaliation = 0;
  let persistence = 0;
  for (let target = 0; target < PLAYER_COLORS.length; target += 1) {
    if (targetPressure[target] > largestPressure) {
      largestPressure = targetPressure[target];
      primaryTarget = target;
    }
    retaliation += targetPressure[target] * interaction.pressure[target][source];
    persistence += targetPressure[target] * interaction.pressure[source][target];
  }

  return {
    source,
    targetPressure,
    deniedCorners,
    edgeContacts,
    diagonalContacts,
    primaryTarget,
    retaliation,
    persistence,
  };
}

/** Returns a new state so hypothetical search branches never alter the real-game history. */
export function advanceOracleInteraction(
  interaction: OracleInteractionState,
  move: OracleMoveInteraction | null,
  decay = ORACLE_PRESSURE_DECAY,
): OracleInteractionState {
  const next = cloneOracleInteractionState(interaction);
  next.ply += 1;
  for (let source = 0; source < PLAYER_COLORS.length; source += 1) {
    for (let target = 0; target < PLAYER_COLORS.length; target += 1) {
      next.pressure[source][target] *= decay;
    }
  }
  if (!move) {
    return next;
  }
  for (let target = 0; target < PLAYER_COLORS.length; target += 1) {
    const added = move.targetPressure[target];
    if (added <= 0 || target === move.source) {
      continue;
    }
    next.pressure[move.source][target] += added;
    if (added >= 0.5) {
      next.lastAggressor[target] = move.source;
      next.lastVictim[move.source] = target;
    }
  }
  return next;
}
