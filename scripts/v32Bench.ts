import { resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { applyMove, cloneState, createInitialState, generateLegalMoves } from '../src/engine/game.ts';
import type { GameState } from '../src/engine/types.ts';

const versions = [
  ['v3.1', 'v3.2-notrans'],
  ['v3.1-pro', 'v3.2-notrans-pro'],
  ['v3.1-pro-max', 'v3.2-notrans-pro-max'],
] as const;

function benchmarkStates(): GameState[] {
  let state = createInitialState('corner');
  const targets = new Set([8, 24, 40]);
  const states: GameState[] = [];
  for (let ply = 1; ply <= 40; ply += 1) {
    const moves = generateLegalMoves(state, state.currentTurn);
    if (moves.length === 0) {
      throw new Error(`Fixture unexpectedly has no legal move at ply ${ply}`);
    }
    state = applyMove(state, moves[Math.floor(moves.length / 3)]);
    if (targets.has(ply)) states.push(cloneState(state));
  }
  return states;
}

async function measure(version: string, states: GameState[]): Promise<number> {
  const samples: number[] = [];
  for (let repeat = 0; repeat < 2; repeat += 1) {
    for (let index = 0; index < states.length; index += 1) {
      clearLegalMoveCache();
      resetV12();
      setSeed(320_000 + repeat * 10 + index);
      const started = performance.now();
      await searchBestMove(states[index], states[index].currentTurn, 60_000, undefined, {
        version,
        iterationBudget: 100,
        skipWinOddsRefinement: true,
      });
      samples.push(performance.now() - started);
    }
  }
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

async function main(): Promise<void> {
  const states = benchmarkStates();
  console.log('Fixed-position timing: 3 phases x 2 repeats, 100 base iterations/move');
  for (const [baseline, candidate] of versions) {
    // Interleave the pair so both see approximately the same machine conditions.
    const baselineMs = await measure(baseline, states);
    const candidateMs = await measure(candidate, states);
    console.log(
      `${candidate} vs ${baseline}: ${candidateMs.toFixed(1)} vs ${baselineMs.toFixed(1)} ms/move ` +
        `(${((candidateMs / baselineMs - 1) * 100).toFixed(1)}%)`,
    );
  }
}

void main();
