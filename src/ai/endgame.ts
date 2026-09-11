import { generateLegalMoves } from '../engine/game';
import { PIECES, getRemainingSquareCount } from '../engine/pieces';
import { PLAYER_COLORS } from '../engine/types';
import type { GameState, PlaceMove, PlayerColor } from '../engine/types';
import type { EndgameConfig } from './algoVersions';
import { regionIsSealed } from './territory';
import { territoryStatsFor } from './heuristics';

/**
 * Exact packing for a sealed endgame region.
 *
 * Once the space a colour can still reach is disjoint from every opponent's reachable space, the
 * position stops being a game: nobody can interfere, so the only question is how many of its own
 * squares that colour can still fit. Branch-and-bound answers that exactly, which random rollouts
 * never do reliably.
 *
 * Note this is deliberately *not* an exact-cover / Algorithm X formulation. Blokus placements must
 * chain corner-to-corner off cells already on the board, so the legal set changes with every
 * placement — a static cover matrix would solve a different problem.
 */
export interface EndgamePlan {
  /** Best sequence found for this colour, played alone. */
  moves: PlaceMove[];
  /** Squares the sequence places. */
  squares: number;
  /** Final-score value of the sequence, including the all-placed and monomino-last bonuses. */
  value: number;
  /** True when the whole tree was explored — the plan is provably optimal. */
  proven: boolean;
  nodes: number;
}

const ALL_PLACED_BONUS = 15;
const MONOMINO_LAST_BONUS = 5;
const MONOMINO_PIECE_ID = 0;

function planValue(squares: number, remainingAfter: number[], lastPieceId: number | null): number {
  if (remainingAfter.length > 0) {
    return squares;
  }
  return (
    squares + ALL_PLACED_BONUS + (lastPieceId === MONOMINO_PIECE_ID ? MONOMINO_LAST_BONUS : 0)
  );
}

/** A move applied for the solver only: board and piece list change, turn order does not. */
function applyOwnMove(state: GameState, move: PlaceMove): GameState {
  const board = state.board.map((row) => [...row]);
  for (const cell of move.absoluteCells) {
    board[cell.y][cell.x] = move.color;
  }
  return {
    ...state,
    board,
    remainingPieces: {
      ...state.remainingPieces,
      [move.color]: state.remainingPieces[move.color].filter((id) => id !== move.pieceId),
    },
    hasPlayed: { ...state.hasPlayed, [move.color]: true },
  };
}

interface SolveContext {
  color: PlayerColor;
  deadline: number;
  nodeBudget: number;
  nodes: number;
  exhausted: boolean;
  bestValue: number;
  bestMoves: PlaceMove[];
}

function search(
  ctx: SolveContext,
  state: GameState,
  placedSquares: number,
  emptyBudget: number,
  line: PlaceMove[],
  lastPieceId: number | null,
): void {
  ctx.nodes += 1;
  if (ctx.nodes >= ctx.nodeBudget || performance.now() >= ctx.deadline) {
    ctx.exhausted = true;
    return;
  }

  const remaining = state.remainingPieces[ctx.color];
  const value = planValue(placedSquares, remaining, lastPieceId);
  if (value > ctx.bestValue) {
    ctx.bestValue = value;
    ctx.bestMoves = [...line];
  }

  // Nothing left to gain beats the best line found so far: cut.
  const headroom = Math.min(getRemainingSquareCount(remaining), emptyBudget);
  const optimistic =
    headroom === getRemainingSquareCount(remaining)
      ? placedSquares + headroom + ALL_PLACED_BONUS + MONOMINO_LAST_BONUS
      : placedSquares + headroom;
  if (optimistic <= ctx.bestValue) {
    return;
  }

  // generateLegalMoves already orders by piece size descending, which is the ordering that makes
  // branch-and-bound cut earliest here.
  const moves = generateLegalMoves(state, ctx.color);
  for (const move of moves) {
    const size = PIECES[move.pieceId].size;
    line.push(move);
    search(
      ctx,
      applyOwnMove(state, move),
      placedSquares + size,
      emptyBudget - size,
      line,
      move.pieceId,
    );
    line.pop();
    if (ctx.exhausted) {
      return;
    }
  }
}

/**
 * Returns a provably-best packing for `color`, or `null` when the position does not qualify:
 * too many branches, or an opponent can still reach the same space.
 */
export function solveSealedEndgame(
  state: GameState,
  color: PlayerColor,
  config: EndgameConfig,
  deadline: number,
  ownMoves?: PlaceMove[],
): EndgamePlan | null {
  const moves = ownMoves ?? generateLegalMoves(state, color, config.maxOwnMoves + 1);
  if (moves.length === 0 || moves.length > config.maxOwnMoves) {
    return null;
  }

  // Reachability is measured from a colour's corner liberties, and a colour that has not opened yet
  // has none — it would read as unable to reach anything, and every region would look sealed.
  // Its opening move can still land anywhere legal, so nothing is sealed until everyone has played.
  for (const other of PLAYER_COLORS) {
    if (other !== color && !state.hasPlayed[other] && state.remainingPieces[other].length > 0) {
      return null;
    }
  }

  const territory = territoryStatsFor(state);
  if (!regionIsSealed(territory, color)) {
    return null;
  }

  const ctx: SolveContext = {
    color,
    deadline,
    nodeBudget: config.nodeBudget,
    nodes: 0,
    exhausted: false,
    bestValue: Number.NEGATIVE_INFINITY,
    bestMoves: [],
  };

  search(ctx, state, 0, territory.reachable[color], [], state.lastPlacedPieceId[color]);

  if (ctx.bestMoves.length === 0) {
    return null;
  }
  return {
    moves: ctx.bestMoves,
    squares: ctx.bestMoves.reduce((sum, move) => sum + PIECES[move.pieceId].size, 0),
    value: ctx.bestValue,
    proven: !ctx.exhausted,
    nodes: ctx.nodes,
  };
}
