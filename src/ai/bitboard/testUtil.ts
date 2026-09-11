/**
 * Shared fixtures for the v12 tests: seeded random games played with the *legacy* engine, so every
 * position the bitboard engine is checked against was produced by the reference implementation and
 * not by the code under test.
 */

import { applyMove, createInitialState, generateLegalMoves, passTurn } from '../../engine/game';
import type { GameState, PlaceMove } from '../../engine/types';
import { createRng } from '../rng';

export interface RandomGame {
  /** Snapshots taken every `every` plies, including the final position. */
  states: GameState[];
  final: GameState;
}

export function playRandomGame(seed: number, maxPlies = 84, every = 3): RandomGame {
  const rng = createRng(seed);
  let state = createInitialState('corner');
  const states: GameState[] = [state];
  let passes = 0;

  for (let ply = 0; ply < maxPlies && passes < 4; ply += 1) {
    const moves: PlaceMove[] = generateLegalMoves(state, state.currentTurn);
    if (moves.length === 0) {
      state = passTurn(state);
      passes += 1;
      continue;
    }
    passes = 0;
    state = applyMove(state, moves[Math.floor(rng() * moves.length)]);
    if (ply % every === 0) {
      states.push(state);
    }
  }

  states.push(state);
  return { states, final: state };
}
