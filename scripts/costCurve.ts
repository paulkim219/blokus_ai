import { createInitialState, applyMove, generateLegalMoves } from '../src/engine/game.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { registerAlgoConfig, ALGO_VERSIONS, type AlgoConfig } from '../src/ai/algoVersions.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';

/** ms/move for a version across iteration budgets, so a time budget can be turned into a config. */
async function timeAt(version: string, iterations: number, plies: number): Promise<number> {
  let state = createInitialState('corner');
  for (let i = 0; i < 10; i += 1) {
    state = applyMove(state, generateLegalMoves(state, state.currentTurn, 1)[0]);
  }
  resetV12();
  let total = 0;
  let n = 0;
  for (let i = 0; i < plies && !state.finished; i += 1) {
    const legal = generateLegalMoves(state, state.currentTurn, 1);
    if (legal.length === 0) {
      break;
    }
    const t = Date.now();
    const r = await searchBestMove(state, state.currentTurn, 600_000, undefined, {
      version,
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
    });
    total += Date.now() - t;
    n += 1;
    state = applyMove(state, r.bestMove ?? legal[0]);
  }
  return total / Math.max(n, 1);
}

async function main(): Promise<void> {
  const versions = (process.argv[2] ?? 'v3.1-nano,v3.1-lite,v3.1,v3.1-pro,v2-pro').split(',');
  const iterations = Number(process.argv[3] ?? '300');
  console.log('version        ms/move  (base budget ' + iterations + ' iterations, per-version scale applied)');
  for (const v of versions) {
    const ms = await timeAt(v, iterations, 8);
    console.log(`${v.padEnd(14)} ${ms.toFixed(0)}`);
  }
}
void main();
