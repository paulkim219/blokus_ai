import { applyMove, isLegalPlacement, nextPlayer, passTurn } from '../engine/game';
import { ORIENTATIONS, PIECES } from '../engine/pieces';
import { BOARD_SIZE, PLAYER_COLORS, TURN_ORDER } from '../engine/types';
import type { Cell, GameState, PlaceMove, PlayerColor } from '../engine/types';
import {
  hydrateFromExternalBoard,
  localBoardIsEmpty,
  remoteBoardFilledCount,
} from './hydrate';
import { inferCurrentTurn, colorsPresent } from './detectOurColor';
import { remapBoardColorsByCorners } from './remapColors';
import type { ExternalBoard } from './types';

export interface DiffResult {
  added: Array<{ color: PlayerColor; cells: Cell[] }>;
  removed: Cell[];
  overwritten: Cell[];
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function normalizeCells(cells: Cell[]): Cell[] {
  const minX = Math.min(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  return cells
    .map((c) => ({ x: c.x - minX, y: c.y - minY }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function shapeKey(cells: Cell[]): string {
  return normalizeCells(cells)
    .map((c) => `${c.x},${c.y}`)
    .join('|');
}

/** Orthogonally connected components (polyomino pieces are edge-connected). */
export function connectedComponents(cells: Cell[]): Cell[][] {
  const pending = new Set(cells.map(cellKey));
  const byKey = new Map(cells.map((cell) => [cellKey(cell), cell]));
  const components: Cell[][] = [];

  while (pending.size > 0) {
    const start = pending.values().next().value as string;
    const queue = [start];
    pending.delete(start);
    const group: Cell[] = [];

    while (queue.length > 0) {
      const key = queue.pop()!;
      const cell = byKey.get(key)!;
      group.push(cell);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const next = `${cell.x + dx},${cell.y + dy}`;
        if (pending.has(next)) {
          pending.delete(next);
          queue.push(next);
        }
      }
    }
    components.push(group);
  }

  return components;
}

export function diffBoards(local: GameState['board'], remote: ExternalBoard): DiffResult {
  const addedCells: Cell[] = [];
  const addedColors = new Map<string, PlayerColor>();
  const removed: Cell[] = [];
  const overwritten: Cell[] = [];

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const prev = local[y][x];
      const next = remote[y][x];
      if (prev === next) {
        continue;
      }
      if (prev === null && next !== null) {
        addedCells.push({ x, y });
        addedColors.set(cellKey({ x, y }), next);
      } else if (prev !== null && next === null) {
        removed.push({ x, y });
      } else if (prev !== null && next !== null && prev !== next) {
        overwritten.push({ x, y });
      }
    }
  }

  const byColor = new Map<PlayerColor, Cell[]>();
  for (const cell of addedCells) {
    const color = addedColors.get(cellKey(cell))!;
    const list = byColor.get(color) ?? [];
    list.push(cell);
    byColor.set(color, list);
  }

  const added: DiffResult['added'] = [];
  for (const color of PLAYER_COLORS) {
    const cells = byColor.get(color);
    if (!cells || cells.length === 0) {
      continue;
    }
    for (const component of connectedComponents(cells)) {
      added.push({ color, cells: component });
    }
  }

  return { added, removed, overwritten };
}

export function matchPlaceMoveFromCells(
  state: GameState,
  color: PlayerColor,
  cells: Cell[],
): PlaceMove | null {
  if (cells.length === 0 || state.currentTurn !== color) {
    return null;
  }

  const targetKey = shapeKey(cells);
  const minX = Math.min(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  const cellSet = new Set(cells.map(cellKey));

  for (const pieceId of state.remainingPieces[color]) {
    if (PIECES[pieceId].size !== cells.length) {
      continue;
    }
    for (let orientationIndex = 0; orientationIndex < ORIENTATIONS[pieceId].length; orientationIndex += 1) {
      if (shapeKey(ORIENTATIONS[pieceId][orientationIndex].cells) !== targetKey) {
        continue;
      }
      const move = isLegalPlacement(state, color, pieceId, orientationIndex, { x: minX, y: minY });
      if (
        move &&
        move.absoluteCells.length === cells.length &&
        move.absoluteCells.every((cell) => cellSet.has(cellKey(cell)))
      ) {
        return move;
      }
    }
  }

  return null;
}

function boardsEqual(local: GameState['board'], remote: ExternalBoard): boolean {
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (local[y][x] !== remote[y][x]) {
        return false;
      }
    }
  }
  return true;
}

function turnsUntil(from: PlayerColor, to: PlayerColor): number {
  let steps = 0;
  let current = from;
  while (current !== to && steps < TURN_ORDER.length) {
    current = nextPlayer(current);
    steps += 1;
  }
  return steps;
}

export interface ApplyExternalResult {
  state: GameState;
  applied: number;
  passes: number;
  status: 'applied' | 'synced' | 'pass' | 'mismatch' | 'error';
  detail: string;
}

/**
 * Bring local engine state in line with an external occupancy grid.
 * Uses immediate hydration for mid-game snapshots, otherwise move-by-move catch-up.
 */
export function applyExternalBoard(
  state: GameState,
  remote: ExternalBoard,
  remoteTurn?: PlayerColor,
  passColor?: PlayerColor,
): ApplyExternalResult {
  let current = state;
  let applied = 0;
  let passes = 0;

  if (remote.length !== BOARD_SIZE || remote.some((row) => row.length !== BOARD_SIZE)) {
    return {
      state,
      applied: 0,
      passes: 0,
      status: 'error',
      detail: 'Remote board is not 20×20',
    };
  }

  // Align scraped hues to Blokee seats via start corners (fixes green/yellow swaps).
  remote = remapBoardColorsByCorners(remote);

  const remoteFilled = remoteBoardFilledCount(remote);
  const shouldHydrate =
    remoteFilled > 0 &&
    (localBoardIsEmpty(state) ||
      Math.abs(remoteFilled - state.board.flat().filter(Boolean).length) > 8);

  if (shouldHydrate) {
    const hydrated = hydrateFromExternalBoard(remote, remoteTurn, state.openingMode, passColor);
    if (hydrated.state) {
      return {
        state: hydrated.state,
        applied: hydrated.placedPieces,
        passes: 0,
        status: 'applied',
        detail: hydrated.detail,
      };
    }
    // Fall through to sequential apply if hydrate could not map shapes.
  }

  const targetTurn =
    inferCurrentTurn({ scrapedTurn: remoteTurn, passColor, board: remote }).turn ?? remoteTurn;

  // Catch up placements (and implied passes) until boards match or we stall.
  for (let guard = 0; guard < 120; guard += 1) {
    if (boardsEqual(current.board, remote)) {
      if (targetTurn && targetTurn !== current.currentTurn && !current.finished) {
        const gap = turnsUntil(current.currentTurn, targetTurn);
        if (gap === 0 || gap >= TURN_ORDER.length) {
          break;
        }
        const opened = new Set(colorsPresent(remote));
        // Don't fabricate passes for seats that already have pieces — Meteor often
        // leaves isActive on Blue after Blue (and others) have already opened.
        if (opened.has(current.currentTurn)) {
          current = { ...current, currentTurn: targetTurn, consecutivePasses: 0 };
          return {
            state: current,
            applied,
            passes,
            status: applied > 0 ? 'applied' : 'synced',
            detail: `Board matched; turn is ${targetTurn}`,
          };
        }
        for (let i = 0; i < gap; i += 1) {
          current = passTurn(current);
          passes += 1;
        }
        return {
          state: current,
          applied,
          passes,
          status: passes > 0 ? 'pass' : 'synced',
          detail:
            passes > 0
              ? `Board matched; advanced ${passes} pass(es) to ${targetTurn}`
              : 'Board already in sync',
        };
      }
      return {
        state: current,
        applied,
        passes,
        status: applied > 0 || passes > 0 ? (applied > 0 ? 'applied' : 'pass') : 'synced',
        detail:
          applied > 0
            ? `Applied ${applied} placement(s)${passes ? `, ${passes} pass(es)` : ''}`
            : passes > 0
              ? `Advanced ${passes} pass(es)`
              : 'Board already in sync',
      };
    }

    const diff = diffBoards(current.board, remote);
    if (diff.removed.length > 0 || diff.overwritten.length > 0) {
      return {
        state: current,
        applied,
        passes,
        status: 'mismatch',
        detail: 'Remote board removed or overwrote squares — start a matching game or undo locally',
      };
    }
    if (diff.added.length === 0) {
      return {
        state: current,
        applied,
        passes,
        status: 'mismatch',
        detail: 'Boards differ but no additive placement was found',
      };
    }

    // Prefer a placement for the seat to move; otherwise try any single component.
    const forTurn =
      diff.added.find((entry) => entry.color === current.currentTurn) ?? null;

    if (!forTurn) {
      // Remote placed for another color first — pass until that color's turn, or fail.
      const nextColor = diff.added[0].color;
      const gap = turnsUntil(current.currentTurn, nextColor);
      if (gap <= 0 || gap >= TURN_ORDER.length) {
        return {
          state: current,
          applied,
          passes,
          status: 'mismatch',
          detail: `Expected ${current.currentTurn} to move, but remote added ${nextColor}`,
        };
      }
      for (let i = 0; i < gap; i += 1) {
        current = passTurn(current);
        passes += 1;
      }
      continue;
    }

    // One polyomino at a time (smallest first if multiple components for same color).
    const components = diff.added
      .filter((entry) => entry.color === forTurn.color)
      .sort((a, b) => a.cells.length - b.cells.length);
    const target = components[0];
    const move = matchPlaceMoveFromCells(current, target.color, target.cells);
    if (!move) {
      return {
        state: current,
        applied,
        passes,
        status: 'mismatch',
        detail: `Could not map ${target.color} cells (${target.cells.length}) to a legal remaining piece`,
      };
    }
    current = applyMove(current, move);
    applied += 1;
  }

  // Last resort: force-mirror the remote occupancy even if move order could not be reconstructed.
  const hydrated = hydrateFromExternalBoard(remote, remoteTurn, state.openingMode, passColor);
  if (hydrated.state) {
    return {
      state: hydrated.state,
      applied: hydrated.placedPieces,
      passes,
      status: 'applied',
      detail: `${hydrated.detail} (fallback mirror)`,
    };
  }

  return {
    state: current,
    applied,
    passes,
    status: 'error',
    detail: hydrated.detail || 'Sync exceeded move catch-up limit',
  };
}
