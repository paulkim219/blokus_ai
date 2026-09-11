import { writeFileSync } from 'node:fs';
import { preloadNets } from './lib/netPreload.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { applyMove, cloneState, createInitialState, generateLegalMoves } from '../src/engine/game.ts';
import type { GameState } from '../src/engine/types.ts';

const candidates = [
  'v3.2-policy-pro',
  'v3.2-policy-audit-pro',
  'v3.2-audit-race-pro',
  'v3.2-policy-groups-pro',
] as const;

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
  for (let index = 0; index < states.length; index += 1) {
    clearLegalMoveCache();
    resetV12();
    setSeed(990_000 + index);
    const started = performance.now();
    await searchBestMove(states[index], states[index].currentTurn, 60_000, undefined, {
      version,
      iterationBudget: 300,
      skipWinOddsRefinement: true,
    });
    total += performance.now() - started;
  }
  return total / states.length;
}

preloadNets();
const states = fixtures();
const rows: Array<{ candidate: string; baselineMs: number; candidateMs: number; deltaPct: number }> = [];
for (const candidate of candidates) {
  const baselineMs = await measure('v3.1-pro', states);
  const candidateMs = await measure(candidate, states);
  const deltaPct = (candidateMs / baselineMs - 1) * 100;
  rows.push({ candidate, baselineMs, candidateMs, deltaPct });
  console.log(
    `${candidate}: ${candidateMs.toFixed(1)} vs ${baselineMs.toFixed(1)} ms/move ` +
      `(${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`,
  );
}
writeFileSync('selfplay-results/v32-next-benchmark.json', `${JSON.stringify(rows, null, 2)}\n`);
