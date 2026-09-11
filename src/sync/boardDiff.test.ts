import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../engine/game';
import { applyExternalBoard, diffBoards, matchPlaceMoveFromCells } from './boardDiff';
import { emptyExternalBoard } from './types';
import type { GameState } from '../engine/types';

function boardFromState(state: GameState) {
  return state.board.map((row) => row.map((cell) => cell));
}

describe('board sync diff', () => {
  it('maps a legal opening placement from added cells', () => {
    const state = createInitialState();
    const move = generateLegalMoves(state, 'blue', 5)[0];
    expect(move).toBeTruthy();
    const matched = matchPlaceMoveFromCells(state, 'blue', move.absoluteCells);
    expect(matched).not.toBeNull();
    expect(matched!.pieceId).toBe(move.pieceId);
  });

  it('applies a remote board that is one move ahead', () => {
    const state = createInitialState();
    const move = generateLegalMoves(state, 'blue', 8)[0];
    const advanced = applyMove(state, move);
    const result = applyExternalBoard(state, boardFromState(advanced), 'green');
    expect(result.status).toBe('applied');
    expect(result.applied).toBe(1);
    expect(result.state.currentTurn).toBe('green');
    expect(result.state.board[move.absoluteCells[0].y][move.absoluteCells[0].x]).toBe('blue');
  });

  it('auto-passes when remote turn advanced without new cells', () => {
    const state = createInitialState();
    const move = generateLegalMoves(state, 'blue', 8)[0];
    const afterBlue = applyMove(state, move);
    // Remote still shows blue's placement but claims purple to move (green passed).
    const result = applyExternalBoard(afterBlue, boardFromState(afterBlue), 'purple');
    expect(result.status).toBe('pass');
    expect(result.passes).toBe(1);
    expect(result.state.currentTurn).toBe('purple');
  });

  it('reports mismatch when remote clears squares', () => {
    const state = createInitialState();
    const move = generateLegalMoves(state, 'blue', 8)[0];
    const afterBlue = applyMove(state, move);
    const wiped = emptyExternalBoard();
    const result = applyExternalBoard(afterBlue, wiped);
    expect(result.status).toBe('mismatch');
  });

  it('diffs only newly filled cells', () => {
    const state = createInitialState();
    const move = generateLegalMoves(state, 'blue', 8)[0];
    const after = applyMove(state, move);
    const diff = diffBoards(state.board, boardFromState(after));
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].color).toBe('blue');
    expect(diff.added[0].cells).toHaveLength(move.absoluteCells.length);
  });

  it('does not rewind to Blue when Meteor still says Blue after three openings', () => {
    const board = emptyExternalBoard();
    board[0][0] = 'blue';
    board[19][0] = 'green';
    board[19][19] = 'purple';
    const result = applyExternalBoard(createInitialState(), board, 'blue');
    expect(result.state.currentTurn).toBe('yellow');
    expect(result.state.consecutivePasses).toBe(0);
    expect(result.state.finished).toBe(false);
  });

  it('trusts a Pass button on green even when Meteor still says blue', () => {
    const board = emptyExternalBoard();
    board[0][0] = 'blue';
    board[0][1] = 'blue';
    board[19][0] = 'green';
    board[19][1] = 'green';
    board[19][19] = 'purple';
    board[18][19] = 'purple';
    board[0][19] = 'yellow';
    board[1][19] = 'yellow';
    const result = applyExternalBoard(createInitialState(), board, 'blue', 'green');
    expect(result.state.currentTurn).toBe('green');
  });
});
