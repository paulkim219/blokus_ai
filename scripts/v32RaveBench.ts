import { writeFileSync } from 'node:fs';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { applyMove, cloneState, createInitialState, generateLegalMoves } from '../src/engine/game.ts';
import type { GameState } from '../src/engine/types.ts';

const candidates = ['v3.2-rave10-pro', 'v3.2-rave50-pro'] as const;

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

async function measure(version: string, states: GameState[], repeat: number): Promise<{ wall: number; cpu: number }> {
  let wall = 0;
  let cpu = 0;
  for (let index = 0; index < states.length; index += 1) {
    clearLegalMoveCache();
    resetV12();
    setSeed(1_010_000 + 10 * repeat + index);
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    await searchBestMove(states[index], states[index].currentTurn, 60_000, undefined, {
      version,
      iterationBudget: 300,
      skipWinOddsRefinement: true,
    });
    const used = process.cpuUsage(cpuStarted);
    wall += performance.now() - started;
    cpu += (used.user + used.system) / 1000;
  }
  return { wall: wall / states.length, cpu: cpu / states.length };
}

const states = fixtures();
const versions = ['v3.1-pro', ...candidates];
const samples: Record<string, Array<{ wall: number; cpu: number }>> = Object.fromEntries(
  versions.map((version) => [version, []]),
);
for (let repeat = 0; repeat < 5; repeat += 1) {
  const order = repeat % 2 === 0 ? versions : [...versions].reverse();
  for (const version of order) samples[version].push(await measure(version, states, repeat));
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const baselineWallMs = mean(samples['v3.1-pro'].map((sample) => sample.wall));
const baselineCpuMs = mean(samples['v3.1-pro'].map((sample) => sample.cpu));
const rows = candidates.map((candidate) => {
  const candidateWallMs = mean(samples[candidate].map((sample) => sample.wall));
  const candidateCpuMs = mean(samples[candidate].map((sample) => sample.cpu));
  return {
    candidate,
    baselineWallMs,
    candidateWallMs,
    wallDeltaPct: (candidateWallMs / baselineWallMs - 1) * 100,
    baselineCpuMs,
    candidateCpuMs,
    cpuDeltaPct: (candidateCpuMs / baselineCpuMs - 1) * 100,
    samples: samples[candidate],
  };
});
for (const row of rows) {
  console.log(`${row.candidate}: CPU ${row.candidateCpuMs.toFixed(1)} vs ${row.baselineCpuMs.toFixed(1)} ms/move ` +
    `(${row.cpuDeltaPct >= 0 ? '+' : ''}${row.cpuDeltaPct.toFixed(1)}%); wall ` +
    `${row.candidateWallMs.toFixed(1)} vs ${row.baselineWallMs.toFixed(1)} ms`);
}
writeFileSync('selfplay-results/v32-rave-benchmark.json', `${JSON.stringify({ rows, samples }, null, 2)}\n`);
