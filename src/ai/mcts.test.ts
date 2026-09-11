import { describe, expect, it, beforeEach } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves, isLegalPlacement } from '../engine/game';
import { evaluateMovePrior } from '../ai/heuristics';
import { analyzeBeforeMove, ponderNextMove, rankMovesGreedy } from '../ai/mcts';
import { clearLegalMoveCache } from './legalMoveCache';

describe('ai smoke', () => {
  beforeEach(() => {
    clearLegalMoveCache();
  });
  it('ranks legal opening moves with heuristic fallback', () => {
    const state = createInitialState();
    const moves = generateLegalMoves(state, 'blue');
    expect(moves.length).toBeGreaterThan(0);
    const best = moves
      .map((move) => ({ move, score: evaluateMovePrior(state, move, true) }))
      .sort((a, b) => b.score - a.score)[0].move;
    const validation = isLegalPlacement(
      state,
      'blue',
      best.pieceId,
      best.orientationIndex,
      best.anchor,
    );
    expect(validation).not.toBeNull();
  });

  it('returns a legal recommendation quickly from the opening', async () => {
    const state = createInitialState();
    const started = Date.now();
    const result = await rankMovesGreedy(state, 'blue');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.bestMove).not.toBeNull();
    const validation = isLegalPlacement(
      state,
      'blue',
      result.bestMove!.pieceId,
      result.bestMove!.orientationIndex,
      result.bestMove!.anchor,
    );
    expect(validation).not.toBeNull();
  });

  it(
    'reports progress during analyzeBeforeMove',
    async () => {
      const state = createInitialState();
      const phases: string[] = [];
      const result = await analyzeBeforeMove(state, 'blue', 1000, (progress) => {
        phases.push(progress.phase);
      });
      expect(result.bestMove).not.toBeNull();
      expect(phases.length).toBeGreaterThan(0);
      expect(phases[0]).toBe('starting');
      expect(phases).toContain('generating');
    },
    20_000,
  );

  it('ponders legal replies while it is not the player turn', async () => {
    const opening = createInitialState();
    const first = generateLegalMoves(opening, 'blue')[0];
    const afterBlue = applyMove(opening, first);
    expect(afterBlue.currentTurn).toBe('green');
    const result = await ponderNextMove(afterBlue, 'blue', 800);
    expect(result.rankedMoves.length).toBeGreaterThan(0);
    expect(result.bestMove).not.toBeNull();
    const stillLegal = result.bestMove!.absoluteCells.every(
      (cell) => afterBlue.board[cell.y][cell.x] === null,
    );
    expect(stillLegal).toBe(true);
  });
});
