import { writeFileSync } from 'node:fs';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { applyMove, cloneState, createInitialState, generateLegalMoves } from '../src/engine/game.ts';
import type { GameState } from '../src/engine/types.ts';
import { preloadNets } from './lib/netPreload.ts';

function fixtures(): GameState[] {
  let state = createInitialState('corner');
  const states: GameState[] = [];
  for (let ply = 1; ply <= 40; ply += 1) {
    const moves = generateLegalMoves(state, state.currentTurn);
    if (moves.length === 0) throw new Error(`fixture has no move at ply ${ply}`);
    state = applyMove(state, moves[Math.floor(moves.length / 3)]);
    if (ply === 8 || ply === 24 || ply === 40) states.push(cloneState(state));
  }
  return states;
}

async function measure(version: string, states: GameState[]): Promise<number> {
  let total = 0;
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (let index = 0; index < states.length; index += 1) {
      clearLegalMoveCache();
      resetV12();
      setSeed(11_800_000 + repeat * 100 + index);
      const started = performance.now();
      await searchBestMove(states[index], states[index].currentTurn, 60_000, undefined, {
        version,
        iterationBudget: 300,
        skipWinOddsRefinement: true,
      });
      total += performance.now() - started;
    }
  }
  return total / (3 * states.length);
}

preloadNets();
const states = fixtures();
const baselineMs = await measure('v3.2-pro', states);
const candidateMs = await measure('v4.3-policy-v32-pro', states);
const result = {
  baseline: 'v3.2-pro',
  candidate: 'v4.3-policy-v32-pro',
  baselineMs,
  candidateMs,
  deltaPct: (candidateMs / baselineMs - 1) * 100,
};
console.log(result);
writeFileSync('selfplay-results/v43-feature-benchmark.json', `${JSON.stringify(result, null, 2)}\n`);
