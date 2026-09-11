import {
  getAbsoluteCells,
  getRemainingSquareCount,
  ORIENTATIONS,
  PIECES,
} from './pieces';
import {
  cellsAreEmpty,
  cellsInPlayerQuarter,
  cloneBoard,
  coversCorner,
  hasSameColorEdgeContact,
  inBounds,
  touchesSameColorCorner,
} from './board';
import {
  BOARD_SIZE,
  PLAYER_COLORS,
  PLAYER_QUARTERS,
  START_CORNERS,
  TURN_ORDER,
} from './types';
import type {
  Cell,
  GameMove,
  GameState,
  OpeningMode,
  PassMove,
  PlaceMove,
  PlayerColor,
} from './types';

export function createInitialState(openingMode: OpeningMode = 'corner'): GameState {
  return {
    board: Array.from({ length: BOARD_SIZE }, () =>
      Array.from({ length: BOARD_SIZE }, () => null),
    ),
    remainingPieces: Object.fromEntries(
      PLAYER_COLORS.map((color) => [color, PIECES.map((piece) => piece.id)]),
    ) as Record<PlayerColor, number[]>,
    currentTurn: 'blue',
    hasPlayed: Object.fromEntries(PLAYER_COLORS.map((color) => [color, false])) as Record<
      PlayerColor,
      boolean
    >,
    consecutivePasses: 0,
    moveHistory: [],
    lastPlacedPieceId: Object.fromEntries(PLAYER_COLORS.map((color) => [color, null])) as Record<
      PlayerColor,
      number | null
    >,
    finished: false,
    openingMode,
  };
}

export function cloneState(state: GameState): GameState {
  return {
    board: cloneBoard(state.board),
    remainingPieces: Object.fromEntries(
      PLAYER_COLORS.map((color) => [color, [...state.remainingPieces[color]]]),
    ) as Record<PlayerColor, number[]>,
    currentTurn: state.currentTurn,
    hasPlayed: { ...state.hasPlayed },
    consecutivePasses: state.consecutivePasses,
    moveHistory: [...state.moveHistory],
    lastPlacedPieceId: { ...state.lastPlacedPieceId },
    finished: state.finished,
    openingMode: state.openingMode,
  };
}

export function nextPlayer(color: PlayerColor): PlayerColor {
  const index = TURN_ORDER.indexOf(color);
  return TURN_ORDER[(index + 1) % TURN_ORDER.length];
}

function validatePlacement(
  state: GameState,
  color: PlayerColor,
  pieceId: number,
  orientationIndex: number,
  absoluteCells: Cell[],
  requireTurn = true,
): PlaceMove | null {
  if (requireTurn && state.currentTurn !== color) {
    return null;
  }
  if (!state.remainingPieces[color].includes(pieceId)) {
    return null;
  }
  if (orientationIndex < 0 || orientationIndex >= ORIENTATIONS[pieceId].length) {
    return null;
  }
  if (!cellsAreEmpty(state.board, absoluteCells)) {
    return null;
  }

  if (!state.hasPlayed[color]) {
    if (state.openingMode === 'anywhere') {
      if (!cellsInPlayerQuarter(absoluteCells, color)) {
        return null;
      }
    } else if (!coversCorner(absoluteCells, START_CORNERS[color])) {
      return null;
    }
  } else if (!touchesSameColorCorner(state.board, absoluteCells, color)) {
    return null;
  }

  if (hasSameColorEdgeContact(state.board, absoluteCells, color)) {
    return null;
  }

  const minX = Math.min(...absoluteCells.map((cell) => cell.x));
  const minY = Math.min(...absoluteCells.map((cell) => cell.y));

  return {
    type: 'place',
    color,
    pieceId,
    anchor: { x: minX, y: minY },
    orientationIndex,
    absoluteCells,
  };
}

export function isLegalPlacement(
  state: GameState,
  color: PlayerColor,
  pieceId: number,
  orientationIndex: number,
  anchor: Cell,
  requireTurn = true,
): PlaceMove | null {
  const absoluteCells = getAbsoluteCells(pieceId, orientationIndex, anchor);
  return validatePlacement(state, color, pieceId, orientationIndex, absoluteCells, requireTurn);
}

export function isLegalPlacementWithPin(
  state: GameState,
  color: PlayerColor,
  pieceId: number,
  orientationIndex: number,
  boardPin: Cell,
  piecePin: Cell,
): PlaceMove | null {
  const absoluteCells = getAbsoluteCells(pieceId, orientationIndex, {
    x: boardPin.x - piecePin.x,
    y: boardPin.y - piecePin.y,
  });
  return validatePlacement(state, color, pieceId, orientationIndex, absoluteCells, true);
}

export function generateLegalMoves(
  state: GameState,
  color: PlayerColor,
  maxMoves = Number.POSITIVE_INFINITY,
): PlaceMove[] {
  const moves: PlaceMove[] = [];
  const seen = new Set<string>();
  // Prefer larger pieces first — stronger early and keeps search budgets useful.
  const pieceIds = [...state.remainingPieces[color]].sort(
    (a, b) => PIECES[b].size - PIECES[a].size,
  );
  // Every placement after the opening must cover one of these cells, so deriving
  // anchors from them once beats rescanning the board per orientation.
  const liberties = state.hasPlayed[color] ? collectCornerLiberties(state, color) : null;
  if (liberties?.length === 0) {
    return moves;
  }

  for (const pieceId of pieceIds) {
    for (let orientationIndex = 0; orientationIndex < ORIENTATIONS[pieceId].length; orientationIndex += 1) {
      const orientation = ORIENTATIONS[pieceId][orientationIndex];
      const anchors = liberties
        ? anchorsFromLiberties(liberties, orientation.cells)
        : candidateAnchors(state, color, orientation.cells);

      for (const anchor of anchors) {
        const move = isLegalPlacement(state, color, pieceId, orientationIndex, anchor, false);
        if (!move) {
          continue;
        }
        const key = `${move.pieceId}:${move.orientationIndex}:${move.anchor.x},${move.anchor.y}`;
        if (!seen.has(key)) {
          seen.add(key);
          moves.push(move);
          if (moves.length >= maxMoves) {
            return moves;
          }
        }
      }
    }
  }

  return moves;
}

const DIAGONAL_DELTAS = [
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

const ORTHOGONAL_DELTAS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/**
 * Empty cells that touch `color` diagonally but never orthogonally — exactly the cells a
 * legal non-opening placement is allowed to occupy while keeping corner contact.
 */
function collectCornerLiberties(state: GameState, color: PlayerColor): Cell[] {
  const board = state.board;
  const liberties: Cell[] = [];

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] !== null) {
        continue;
      }

      let touchesCorner = false;
      for (const delta of DIAGONAL_DELTAS) {
        const nx = x + delta.x;
        const ny = y + delta.y;
        if (nx >= 0 && ny >= 0 && nx < BOARD_SIZE && ny < BOARD_SIZE && board[ny][nx] === color) {
          touchesCorner = true;
          break;
        }
      }
      if (!touchesCorner) {
        continue;
      }

      let touchesEdge = false;
      for (const delta of ORTHOGONAL_DELTAS) {
        const nx = x + delta.x;
        const ny = y + delta.y;
        if (nx >= 0 && ny >= 0 && nx < BOARD_SIZE && ny < BOARD_SIZE && board[ny][nx] === color) {
          touchesEdge = true;
          break;
        }
      }
      if (!touchesEdge) {
        liberties.push({ x, y });
      }
    }
  }

  return liberties;
}

/** Anchors that land some cell of the orientation on a corner liberty, fully in bounds. */
function anchorsFromLiberties(liberties: Cell[], relativeCells: Cell[]): Cell[] {
  const anchors: Cell[] = [];
  const seen = new Set<number>();
  let maxX = 0;
  let maxY = 0;
  for (const cell of relativeCells) {
    maxX = Math.max(maxX, cell.x);
    maxY = Math.max(maxY, cell.y);
  }

  for (const liberty of liberties) {
    for (const cell of relativeCells) {
      const anchorX = liberty.x - cell.x;
      const anchorY = liberty.y - cell.y;
      if (
        anchorX < 0 ||
        anchorY < 0 ||
        anchorX + maxX >= BOARD_SIZE ||
        anchorY + maxY >= BOARD_SIZE
      ) {
        continue;
      }
      const key = anchorY * BOARD_SIZE + anchorX;
      if (!seen.has(key)) {
        seen.add(key);
        anchors.push({ x: anchorX, y: anchorY });
      }
    }
  }

  return anchors;
}

function candidateAnchors(
  state: GameState,
  color: PlayerColor,
  relativeCells: Cell[],
): Cell[] {
  if (state.openingMode === 'anywhere') {
    return quarterOpeningAnchors(color, relativeCells);
  }
  const startCorner = START_CORNERS[color];
  const anchors: Cell[] = [];
  for (const cell of relativeCells) {
    anchors.push({
      x: startCorner.x - cell.x,
      y: startCorner.y - cell.y,
    });
  }
  return anchors.filter((anchor) =>
    relativeCells.every((cell) => inBounds({ x: anchor.x + cell.x, y: anchor.y + cell.y })),
  );
}

/** All anchors where every cell of the orientation lies inside the player's quarter. */
function quarterOpeningAnchors(color: PlayerColor, relativeCells: Cell[]): Cell[] {
  const quarter = PLAYER_QUARTERS[color];
  const minAx = Math.max(...relativeCells.map((cell) => quarter.minX - cell.x));
  const maxAx = Math.min(...relativeCells.map((cell) => quarter.maxX - cell.x));
  const minAy = Math.max(...relativeCells.map((cell) => quarter.minY - cell.y));
  const maxAy = Math.min(...relativeCells.map((cell) => quarter.maxY - cell.y));
  if (minAx > maxAx || minAy > maxAy) {
    return [];
  }

  const anchors: Cell[] = [];
  for (let y = minAy; y <= maxAy; y += 1) {
    for (let x = minAx; x <= maxAx; x += 1) {
      anchors.push({ x, y });
    }
  }
  return anchors;
}

export function hasLegalMove(state: GameState, color: PlayerColor): boolean {
  return generateLegalMoves(state, color, 1).length > 0;
}

export function applyMove(state: GameState, move: GameMove): GameState {
  if (move.color !== state.currentTurn) {
    return state;
  }
  const next = cloneState(state);
  if (move.type === 'pass') {
    next.moveHistory.push(move);
    next.consecutivePasses += 1;
    if (next.consecutivePasses >= PLAYER_COLORS.length) {
      next.finished = true;
    } else {
      next.currentTurn = nextPlayer(move.color);
    }
    return next;
  }

  for (const cell of move.absoluteCells) {
    next.board[cell.y][cell.x] = move.color;
  }
  next.remainingPieces[move.color] = next.remainingPieces[move.color].filter(
    (id) => id !== move.pieceId,
  );
  next.hasPlayed[move.color] = true;
  next.lastPlacedPieceId[move.color] = move.pieceId;
  next.moveHistory.push(move);
  next.consecutivePasses = 0;
  next.currentTurn = nextPlayer(move.color);
  // Game ends only after every seat passes in a row (not when one player looks dominant).
  next.finished = false;
  return next;
}

export function passTurn(state: GameState): GameState {
  const pass: PassMove = { type: 'pass', color: state.currentTurn };
  return applyMove(state, pass);
}

export function undoMove(state: GameState): GameState {
  if (state.moveHistory.length === 0) {
    return state;
  }

  const history = [...state.moveHistory];
  const lastMove = history.pop();
  if (!lastMove) {
    return state;
  }

  const rebuilt = createInitialState(state.openingMode);
  for (const move of history) {
    Object.assign(rebuilt, applyMove(rebuilt, move));
  }
  return rebuilt;
}

export interface PlayerScore {
  color: PlayerColor;
  remainingSquares: number;
  score: number;
  allPlaced: boolean;
}

export function calculateScores(state: GameState): PlayerScore[] {
  return PLAYER_COLORS.map((color) => {
    const remainingSquares = getRemainingSquareCount(state.remainingPieces[color]);
    const allPlaced = remainingSquares === 0;
    let score = -remainingSquares;
    if (allPlaced) {
      score += 15;
      if (state.lastPlacedPieceId[color] === 0) {
        score += 5;
      }
    }
    return { color, remainingSquares, score, allPlaced };
  });
}

export function getStateAtMoveIndex(state: GameState, moveIndex: number): GameState {
  const rebuilt = createInitialState(state.openingMode);
  for (let i = 0; i < moveIndex && i < state.moveHistory.length; i += 1) {
    Object.assign(rebuilt, applyMove(rebuilt, state.moveHistory[i]));
  }
  return rebuilt;
}

export function moveKey(move: PlaceMove): string {
  return `${move.pieceId}:${move.orientationIndex}:${move.anchor.x},${move.anchor.y}`;
}

export function movesEqual(a: PlaceMove, b: PlaceMove): boolean {
  return moveKey(a) === moveKey(b);
}
