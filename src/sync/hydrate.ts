import { cloneBoard } from '../engine/board';
import { createInitialState } from '../engine/game';
import { ORIENTATIONS, PIECES } from '../engine/pieces';
import { BOARD_SIZE, PLAYER_COLORS } from '../engine/types';
import type { Cell, GameState, OpeningMode, PlayerColor } from '../engine/types';
import { connectedComponents } from './boardDiff';
import { inferCurrentTurn } from './detectOurColor';
import type { ExternalBoard } from './types';

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

function matchPieceId(cells: Cell[], availableIds: number[]): number | null {
  const target = shapeKey(cells);
  for (const pieceId of availableIds) {
    if (PIECES[pieceId].size !== cells.length) {
      continue;
    }
    for (const orientation of ORIENTATIONS[pieceId]) {
      if (shapeKey(orientation.cells) === target) {
        return pieceId;
      }
    }
  }
  return null;
}

function countFilled(board: ExternalBoard): number {
  let count = 0;
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x]) {
        count += 1;
      }
    }
  }
  return count;
}

export interface HydrateResult {
  state: GameState | null;
  detail: string;
  placedPieces: number;
}

/**
 * Rebuild engine state directly from a remote occupancy grid.
 * Used for immediate mid-game mirroring when move-by-move catch-up is impractical.
 */
export function hydrateFromExternalBoard(
  remote: ExternalBoard,
  remoteTurn?: PlayerColor,
  openingMode: OpeningMode = 'corner',
  passColor?: PlayerColor,
): HydrateResult {
  if (remote.length !== BOARD_SIZE || remote.some((row) => row.length !== BOARD_SIZE)) {
    return { state: null, detail: 'Remote board is not 20×20', placedPieces: 0 };
  }

  const filled = countFilled(remote);
  if (filled === 0) {
    return { state: null, detail: 'Remote board is empty', placedPieces: 0 };
  }

  const state = createInitialState(openingMode);
  state.board = cloneBoard(remote as GameState['board']);
  let placedPieces = 0;

  for (const color of PLAYER_COLORS) {
    const cells: Cell[] = [];
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        if (remote[y][x] === color) {
          cells.push({ x, y });
        }
      }
    }

    if (cells.length === 0) {
      continue;
    }

    const available = PIECES.map((piece) => piece.id);
    const used: number[] = [];
    const components = connectedComponents(cells).sort((a, b) => b.length - a.length);

    for (const component of components) {
      const pieceId = matchPieceId(component, available.filter((id) => !used.includes(id)));
      if (pieceId === null) {
        return {
          state: null,
          detail: `Could not map a ${color} shape (${component.length} squares) to a Blokus piece`,
          placedPieces,
        };
      }
      used.push(pieceId);
      placedPieces += 1;
    }

    state.remainingPieces[color] = available.filter((id) => !used.includes(id));
    state.hasPlayed[color] = used.length > 0;
    state.lastPlacedPieceId[color] = used.length > 0 ? used[used.length - 1] : null;
  }

  // Synthetic history length so UI knows the game is mid-progress.
  state.moveHistory = Array.from({ length: placedPieces }, (_, index) => ({
    type: 'pass' as const,
    color: PLAYER_COLORS[index % PLAYER_COLORS.length],
  }));
  const inferred = inferCurrentTurn({ scrapedTurn: remoteTurn, passColor, board: remote });
  state.currentTurn = passColor ?? inferred.turn ?? remoteTurn ?? 'blue';
  state.consecutivePasses = 0;
  state.finished = false;

  return {
    state,
    detail: `Mirrored remote board (${placedPieces} pieces, ${filled} squares)${
      passColor ? `; Pass on ${passColor}` : inferred.turn ? `; turn ${inferred.turn}` : ''
    }`,
    placedPieces,
  };
}

export function localBoardIsEmpty(state: GameState): boolean {
  return state.board.every((row) => row.every((cell) => cell === null));
}

export function remoteBoardFilledCount(remote: ExternalBoard): number {
  return countFilled(remote);
}
