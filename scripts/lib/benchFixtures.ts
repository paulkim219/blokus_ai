/**
 * Phase-representative fixture positions, shared by the bitboard benchmark and the replay-diff
 * harness so both measure the same board states.
 *
 * The `v3*Bench.ts` family has built these inline for a year and then averaged the three phases
 * away. Per-iteration cost is not phase-invariant — the opening has ~356 legal moves and the endgame
 * about a dozen — so the average hides exactly the structure an optimisation pass needs.
 */

import { applyMove, cloneState, createInitialState, generateLegalMoves } from '../../src/engine/game.ts';
import type { GameState } from '../../src/engine/types.ts';

export interface Fixture {
  phase: 'opening' | 'midgame' | 'endgame';
  ply: number;
  state: GameState;
  legalMoves: number;
}

/**
 * Deterministic: the same middle-ranked move is taken at every ply, so the fixture set is a pure
 * function of the rules and does not drift when the engine changes. That matters for an
 * optimisation pass whose whole claim is before/after comparability.
 */
export function benchmarkFixtures(plies: readonly number[] = [8, 24, 40]): Fixture[] {
  const targets = new Set(plies);
  const maxPly = Math.max(...plies);
  const out: Fixture[] = [];
  let state = createInitialState('corner');
  for (let ply = 1; ply <= maxPly; ply += 1) {
    const moves = generateLegalMoves(state, state.currentTurn);
    if (moves.length === 0) {
      throw new Error(`fixture has no legal move at ply ${ply}`);
    }
    state = applyMove(state, moves[Math.floor(moves.length / 3)]);
    if (targets.has(ply)) {
      const next = cloneState(state);
      out.push({
        phase: ply <= 12 ? 'opening' : ply <= 32 ? 'midgame' : 'endgame',
        ply,
        state: next,
        legalMoves: generateLegalMoves(next, next.currentTurn).length,
      });
    }
  }
  return out;
}
