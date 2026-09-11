import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves, isLegalPlacement } from '../engine/game';
import {
  buildLegalMoveCache,
  cacheNeedsRebuild,
  pruneMovesByOccupancy,
  pruneMovesOverlappingCells,
  syncCacheToState,
} from './legalMoveCache';

describe('off-turn legal moves', () => {
  it('enumerates a seat that is not currentTurn', () => {
    const state = createInitialState();
    expect(state.currentTurn).toBe('blue');
    const greenMoves = generateLegalMoves(state, 'green');
    expect(greenMoves.length).toBeGreaterThan(0);
    expect(greenMoves.every((move) => move.color === 'green')).toBe(true);
  });

  it('still rejects off-turn placements from the UI helper', () => {
    const state = createInitialState();
    const greenMove = generateLegalMoves(state, 'green')[0];
    expect(greenMove).toBeTruthy();
    const blocked = isLegalPlacement(
      state,
      'green',
      greenMove.pieceId,
      greenMove.orientationIndex,
      greenMove.anchor,
    );
    expect(blocked).toBeNull();
  });
});

describe('legal move cache prune', () => {
  it('drops only moves that overlap newly occupied cells', () => {
    const state = createInitialState();
    const cache = buildLegalMoveCache(state, 'blue');
    expect(cache.moves.length).toBeGreaterThan(1);

    const victim = cache.moves[0];
    const occupied = victim.absoluteCells;
    const pruned = pruneMovesOverlappingCells(cache.moves, occupied);
    expect(pruned.length).toBeLessThan(cache.moves.length);
    expect(pruned.some((move) => move.absoluteCells === victim.absoluteCells)).toBe(false);
    expect(
      pruned.every((move) =>
        move.absoluteCells.every(
          (cell) => !occupied.some((hit) => hit.x === cell.x && hit.y === cell.y),
        ),
      ),
    ).toBe(true);
  });

  it('prunes after an opponent occupies squares, without rebuilding for our pieces', () => {
    const opening = createInitialState();
    const blueFirst = generateLegalMoves(opening, 'blue')[0];
    const afterBlue = applyMove(opening, blueFirst);
    const cache = buildLegalMoveCache(afterBlue, 'blue');
    const beforeCount = cache.moves.length;
    expect(beforeCount).toBeGreaterThan(0);

    const greenMove = generateLegalMoves(afterBlue, 'green')[0];
    const afterGreen = applyMove(afterBlue, greenMove);
    const synced = syncCacheToState(cache, afterGreen, 'blue');

    expect(synced.remainingPieces).toEqual(cache.remainingPieces);
    expect(synced.moves.length).toBeLessThanOrEqual(beforeCount);
    expect(
      synced.moves.every((move) =>
        move.absoluteCells.every((cell) => afterGreen.board[cell.y][cell.x] === null),
      ),
    ).toBe(true);
  });

  it('rebuilds after we place (new corners / fewer pieces)', () => {
    const opening = createInitialState();
    const cache = buildLegalMoveCache(opening, 'blue');
    const blueFirst = generateLegalMoves(opening, 'blue')[0];
    const afterBlue = applyMove(opening, blueFirst);
    const rebuilt = syncCacheToState(cache, afterBlue, 'blue');
    expect(rebuilt.remainingPieces).not.toEqual(cache.remainingPieces);
    expect(rebuilt.moves.length).toBeGreaterThan(0);
  });

  it('restores pruned moves from the source list when occupancy is cleared', () => {
    const state = createInitialState();
    const cache = buildLegalMoveCache(state, 'blue');
    const occupied = cache.moves[0].absoluteCells;
    const board = state.board.map((row) => [...row]);
    for (const cell of occupied) {
      board[cell.y][cell.x] = 'green';
    }
    const blockedState = { ...state, board };
    const pruned = syncCacheToState(cache, blockedState, 'blue');
    expect(pruned.moves.length).toBeLessThan(cache.sourceMoves.length);
    const restored = syncCacheToState(pruned, state, 'blue');
    expect(restored.moves.length).toBe(cache.sourceMoves.length);
  });

  it('occupancy prune matches overlapping-cell prune', () => {
    const state = createInitialState();
    const moves = generateLegalMoves(state, 'blue');
    const occupied = moves[0].absoluteCells;
    const byCells = pruneMovesOverlappingCells(moves, occupied);
    const board = state.board.map((row) => [...row]);
    for (const cell of occupied) {
      board[cell.y][cell.x] = 'green';
    }
    const byBoard = pruneMovesByOccupancy(moves, board);
    expect(byBoard.length).toBe(byCells.length);
  });

  it('rebuilds when the search version changes', () => {
    const state = createInitialState();
    const v31 = buildLegalMoveCache(state, 'blue', Number.POSITIVE_INFINITY, 'v3.1');
    expect(cacheNeedsRebuild(v31, state, 'blue', 'v3.1')).toBe(false);
    expect(cacheNeedsRebuild(v31, state, 'blue', 'v2-pro')).toBe(true);
    const switched = syncCacheToState(v31, state, 'blue', Number.POSITIVE_INFINITY, 'v2-pro');
    expect(switched.version).toBe('v2-pro');
    expect(switched.rankedMoves).toEqual([]);
  });
});
