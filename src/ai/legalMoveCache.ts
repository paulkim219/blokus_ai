import { generateLegalMoves, moveKey } from '../engine/game';
import type { Cell, GameState, PlaceMove, PlayerColor } from '../engine/types';
import type { RankedMove } from './searchTypes';
import type { AlgoVersionId } from './algoVersions';

export interface LegalMoveCache {
  player: PlayerColor;
  remainingPieces: number[];
  sourceMoves: PlaceMove[];
  moves: PlaceMove[];
  rankedMoves: RankedMove[];
  builtAtHistoryLength: number;
  /** Ranked priors are version-specific; a mismatch must rebuild rather than reuse another engine. */
  version?: AlgoVersionId;
}

let activeCache: LegalMoveCache | null = null;

function piecesMatch(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((id, index) => id === right[index]);
}

export function pruneMovesByOccupancy(
  moves: PlaceMove[],
  board: GameState['board'],
): PlaceMove[] {
  return moves.filter((move) =>
    move.absoluteCells.every((cell) => board[cell.y]?.[cell.x] === null),
  );
}

export function pruneMovesOverlappingCells(moves: PlaceMove[], occupied: Cell[]): PlaceMove[] {
  const blocked = new Set(occupied.map((cell) => `${cell.x},${cell.y}`));
  return moves.filter(
    (move) => !move.absoluteCells.some((cell) => blocked.has(`${cell.x},${cell.y}`)),
  );
}

export function buildLegalMoveCache(
  state: GameState,
  player: PlayerColor,
  maxMoves = Number.POSITIVE_INFINITY,
  version?: AlgoVersionId,
): LegalMoveCache {
  const sourceMoves = generateLegalMoves(state, player, maxMoves);
  return {
    player,
    remainingPieces: [...state.remainingPieces[player]],
    sourceMoves,
    moves: pruneMovesByOccupancy(sourceMoves, state.board),
    rankedMoves: [],
    builtAtHistoryLength: state.moveHistory.length,
    version,
  };
}

export function cacheNeedsRebuild(
  cache: LegalMoveCache | null,
  state: GameState,
  player: PlayerColor,
  version?: AlgoVersionId,
): boolean {
  if (!cache || cache.player !== player) {
    return true;
  }
  if (version !== undefined && cache.version !== version) {
    return true;
  }
  if (state.moveHistory.length < cache.builtAtHistoryLength) {
    return true;
  }
  return !piecesMatch(cache.remainingPieces, state.remainingPieces[player]);
}

export function syncCacheToState(
  cache: LegalMoveCache | null,
  state: GameState,
  player: PlayerColor,
  maxMoves = Number.POSITIVE_INFINITY,
  version?: AlgoVersionId,
): LegalMoveCache {
  if (!cache || cacheNeedsRebuild(cache, state, player, version)) {
    return buildLegalMoveCache(state, player, maxMoves, version);
  }

  const pruned = pruneMovesByOccupancy(cache.sourceMoves, state.board);
  const surviving = new Set(pruned.map((move) => moveKey(move)));
  const rankedMoves = cache.rankedMoves.filter((entry) => surviving.has(moveKey(entry.move)));
  rankedMoves.sort((a, b) => b.value - a.value);

  return {
    ...cache,
    moves: pruned,
    rankedMoves,
  };
}

export function storeRankedMoves(
  cache: LegalMoveCache,
  rankedMoves: RankedMove[],
  version?: AlgoVersionId,
): LegalMoveCache {
  return {
    ...cache,
    rankedMoves: [...rankedMoves].sort((a, b) => b.value - a.value),
    version: version ?? cache.version,
  };
}

export function getActiveLegalMoveCache(): LegalMoveCache | null {
  return activeCache;
}

export function setActiveLegalMoveCache(cache: LegalMoveCache | null): void {
  activeCache = cache;
}

export function syncActiveLegalMoveCache(
  state: GameState,
  player: PlayerColor,
  maxMoves = Number.POSITIVE_INFINITY,
  version?: AlgoVersionId,
): LegalMoveCache {
  activeCache = syncCacheToState(activeCache, state, player, maxMoves, version);
  return activeCache;
}

export function clearLegalMoveCache(): void {
  activeCache = null;
}
