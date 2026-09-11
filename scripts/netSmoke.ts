import { preloadNets } from './lib/netPreload.ts';
import { netFor } from '../src/ai/bitboard/net.ts';
import { createInitialState, applyMove, generateLegalMoves } from '../src/engine/game.ts';
import { searchBestMove } from '../src/ai/mcts.ts';

/** Plumbing check: is the learned evaluation actually reaching the search, and what does it cost? */
async function main(): Promise<void> {
  preloadNets();
  console.log('net loaded:', netFor('ml/v4-weights.json') !== null);
  let state = createInitialState('corner');
  for (let i = 0; i < 8; i += 1) {
    const legal = generateLegalMoves(state, state.currentTurn, 1);
    state = applyMove(state, legal[0]);
  }
  for (const version of ['v3.1', 'v4-prior', 'v4-prior-hybrid', 'v4-hybrid25']) {
    const started = Date.now();
    const result = await searchBestMove(state, state.currentTurn, 600_000, undefined, {
      version,
      iterationBudget: 300,
      skipWinOddsRefinement: true,
    });
    console.log(
      `${version.padEnd(6)} piece ${result.bestMove?.pieceId}  value ` +
        `${result.rankedMoves[0]?.value.toFixed(3)}  ${Date.now() - started} ms`,
    );
  }
}
void main();
