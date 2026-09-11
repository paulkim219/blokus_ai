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

async function runOne(version: string, state: GameState, seed: number): Promise<number> {
      clearLegalMoveCache();
      resetV12();
      setSeed(seed);
      const started = performance.now();
      await searchBestMove(state, state.currentTurn, 60_000, undefined, {
        version,
        iterationBudget: 300,
        skipWinOddsRefinement: true,
      });
      return performance.now() - started;
}

preloadNets();
const states = fixtures();
const versions = [
  'v3.2-pro',
  'v4.3-policy-v32-pro',
  'v4.5-spatial-single-v32-pro',
  'v4.5-spatial-ensemble-v32-pro',
];
const totals = Object.fromEntries(versions.map((version) => [version, 0])) as Record<string, number>;
const counts = Object.fromEntries(versions.map((version) => [version, 0])) as Record<string, number>;
for (const version of versions) await runOne(version, states[1], 13_299_999);
for (let repeat = 0; repeat < 10; repeat += 1) {
  const order = [...versions.slice(repeat % versions.length), ...versions.slice(0, repeat % versions.length)];
  for (let index = 0; index < states.length; index += 1) {
    for (const version of order) {
      totals[version] += await runOne(version, states[index], 13_300_000 + repeat * 100 + index);
      counts[version] += 1;
    }
  }
}
const timings = Object.fromEntries(versions.map((version) => [version, totals[version] / counts[version]]));
const baseline = timings['v3.2-pro'];
const result = {
  timings,
  deltaPct: Object.fromEntries(versions.map((version) => [version, (timings[version] / baseline - 1) * 100])),
};
console.log(result);
writeFileSync('selfplay-results/v45-spatial-benchmark.json', `${JSON.stringify(result, null, 2)}\n`);
