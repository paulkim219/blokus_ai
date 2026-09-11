import { describe, expect, it } from 'vitest';
import { createInitialState } from '../engine/game';
import { solveSealedEndgame } from './endgame';
import type { GameState } from '../engine/types';

/**
 * A board with `color` cells painted directly — the solver only cares about the position.
 * The other three seats are finished (no pieces left), which is what an endgame looks like.
 */
function stateWithBlueCells(cells: Array<[number, number]>, remaining: number[]): GameState {
  const state = createInitialState();
  for (const [x, y] of cells) {
    state.board[y][x] = 'blue';
  }
  state.remainingPieces.blue = remaining;
  state.hasPlayed.blue = true;
  for (const color of ['yellow', 'purple', 'green'] as const) {
    state.remainingPieces[color] = [];
  }
  return state;
}

const FAR_FUTURE = Number.POSITIVE_INFINITY;
const CONFIG = { maxOwnMoves: 60, nodeBudget: 20000 };

describe('sealed endgame packer', () => {
  it('finishes a one-square pocket and counts both end bonuses', () => {
    // Blue owns (0,0) and holds only the monomino. Its single liberty is (1,1); nobody else has
    // played, so no opponent can reach that space and the region is sealed.
    const state = stateWithBlueCells([[0, 0]], [0]);

    const plan = solveSealedEndgame(state, 'blue', CONFIG, FAR_FUTURE);

    expect(plan).not.toBeNull();
    expect(plan!.moves).toHaveLength(1);
    expect(plan!.squares).toBe(1);
    // 1 square + 15 for placing everything + 5 for finishing on the monomino.
    expect(plan!.value).toBe(21);
    expect(plan!.proven).toBe(true);
  });

  it('prefers the line that places more squares', () => {
    // Two pieces left: the monomino and the domino. Both fit in the open corner region, and the
    // best line places both.
    const state = stateWithBlueCells([[0, 0]], [0, 1]);

    const plan = solveSealedEndgame(state, 'blue', CONFIG, FAR_FUTURE);

    expect(plan).not.toBeNull();
    expect(plan!.squares).toBe(3);
    expect(plan!.value).toBe(3 + 15 + 5);
    // Finishing on the monomino is worth 5, so it must be played last.
    expect(plan!.moves[plan!.moves.length - 1].pieceId).toBe(0);
  });

  it('declines positions an opponent can still reach', () => {
    const state = stateWithBlueCells([[0, 0]], [0]);
    state.board[19][19] = 'purple';
    state.hasPlayed.purple = true;
    state.remainingPieces.purple = [0];

    expect(solveSealedEndgame(state, 'blue', CONFIG, FAR_FUTURE)).toBeNull();
  });

  it('declines while an opponent has not opened yet', () => {
    // A colour that has not played has no liberties, so reachability would call it harmless — but
    // its first piece can still land anywhere in its corner. Nothing is sealed until it moves.
    const state = stateWithBlueCells([[0, 0]], [0]);
    state.remainingPieces.purple = [0];
    state.hasPlayed.purple = false;

    expect(solveSealedEndgame(state, 'blue', CONFIG, FAR_FUTURE)).toBeNull();
  });

  it('declines on the opening board', () => {
    // The opening has 58 legal moves — under the default maxOwnMoves of 60, so the branching-factor
    // gate does not catch it. Nothing about a full board is an endgame.
    expect(solveSealedEndgame(createInitialState(), 'blue', CONFIG, FAR_FUTURE)).toBeNull();
  });

  it('declines when the branching factor is still large', () => {
    const state = stateWithBlueCells([[0, 0]], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(solveSealedEndgame(state, 'blue', { ...CONFIG, maxOwnMoves: 2 }, FAR_FUTURE)).toBeNull();
  });
});
