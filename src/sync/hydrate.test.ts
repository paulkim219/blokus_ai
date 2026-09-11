import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../engine/game';
import { applyExternalBoard } from './boardDiff';
import { hydrateFromExternalBoard } from './hydrate';
import type { GameState } from '../engine/types';

function boardFromState(state: GameState) {
  return state.board.map((row) => row.map((cell) => cell));
}

describe('hydrate from remote board', () => {
  it('mirrors a mid-game board onto an empty local state', () => {
    let remote = createInitialState();
    for (let i = 0; i < 8; i += 1) {
      const moves = generateLegalMoves(remote, remote.currentTurn, 12);
      if (moves.length === 0) {
        break;
      }
      remote = applyMove(remote, moves[0]);
    }

    const local = createInitialState();
    const result = applyExternalBoard(local, boardFromState(remote), remote.currentTurn);
    expect(result.status).toBe('applied');
    expect(result.applied).toBeGreaterThan(0);
    expect(result.state.board).toEqual(remote.board);
    expect(result.state.currentTurn).toBe(remote.currentTurn);
  });

  it('reconstructs remaining pieces per color', () => {
    let remote = createInitialState();
    const first = generateLegalMoves(remote, 'blue', 5)[0];
    remote = applyMove(remote, first);
    const hydrated = hydrateFromExternalBoard(boardFromState(remote), 'green');
    expect(hydrated.state).not.toBeNull();
    expect(hydrated.state!.remainingPieces.blue).not.toContain(first.pieceId);
    expect(hydrated.state!.remainingPieces.blue.length).toBe(20);
    expect(hydrated.state!.hasPlayed.blue).toBe(true);
    expect(hydrated.state!.currentTurn).toBe('green');
  });

  it('does not keep Blue to move after Blue, Green, and Purple have opened', () => {
    const board = boardFromState(createInitialState());
    board[0][0] = 'blue';
    board[19][0] = 'green';
    board[19][19] = 'purple';
    const hydrated = hydrateFromExternalBoard(board, 'blue');
    expect(hydrated.state).not.toBeNull();
    expect(hydrated.state!.currentTurn).toBe('yellow');
  });

  it('uses the Pass-button seat even if scrape still says Blue', () => {
    const board = boardFromState(createInitialState());
    board[0][0] = 'blue';
    board[19][0] = 'green';
    board[19][19] = 'purple';
    board[0][19] = 'yellow';
    const hydrated = hydrateFromExternalBoard(board, 'blue', 'corner', 'green');
    expect(hydrated.state).not.toBeNull();
    expect(hydrated.state!.currentTurn).toBe('green');
  });
});
