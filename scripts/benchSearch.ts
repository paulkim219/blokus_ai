import { applyMove, createInitialState, generateLegalMoves } from '../src/engine/game.ts';
import type { GameState } from '../src/engine/types.ts';
import { evaluateMovePrior, evaluateState } from '../src/ai/heuristics.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { SELFPLAY_SEARCH_OPTIONS } from '../src/ai/selfplay.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';

/** Advance the game with a cheap deterministic policy so we can benchmark mid-game states. */
function advance(state: GameState, plies: number): GameState {
  let current = state;
  for (let i = 0; i < plies; i += 1) {
    const moves = generateLegalMoves(current, current.currentTurn, 30);
    if (moves.length === 0) {
      break;
    }
    current = applyMove(current, moves[Math.floor(moves.length / 3)]);
  }
  return current;
}

function timeIt(label: string, iterations: number, fn: () => void): void {
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  const elapsed = performance.now() - started;
  console.log(
    `${label.padEnd(34)} ${(elapsed / iterations).toFixed(4)} ms/call   (${iterations} calls, ${elapsed.toFixed(0)} ms total)`,
  );
}

async function main(): Promise<void> {
  for (const plies of [8, 24, 40]) {
    const state = advance(createInitialState(), plies);
    const moves = generateLegalMoves(state, state.currentTurn, 200);
    const move = moves[0];
    console.log(`\n=== ply ${plies} (${moves.length} legal moves for ${state.currentTurn}) ===`);

    timeIt('generateLegalMoves(cap 12)', 200, () => {
      generateLegalMoves(state, state.currentTurn, 12);
    });
    timeIt('evaluateState(fast)', 200, () => {
      evaluateState(state, state.currentTurn, true);
    });
    timeIt('evaluateMovePrior(fast)', 200, () => {
      evaluateMovePrior(state, move, true);
    });

    clearLegalMoveCache();
    let iterations = 0;
    const started = performance.now();
    await searchBestMove(
      state,
      state.currentTurn,
      3200,
      async (progress) => {
        iterations = Math.max(iterations, progress.iterations);
      },
      SELFPLAY_SEARCH_OPTIONS,
    );
    const searchMs = performance.now() - started;
    console.log(
      `searchBestMove(3200ms)             ${searchMs.toFixed(0)} ms, ${iterations} MCTS iterations (${(iterations / (searchMs / 1000)).toFixed(0)}/sec)`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
