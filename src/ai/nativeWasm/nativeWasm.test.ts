import raw from '../../../ml/v41-rollout-policy.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves, moveKey, passTurn } from '../../engine/game';
import type { GameState } from '../../engine/types';
import { getAlgo } from '../algoVersions';
import { placementFor } from '../bitboard/adapter';
import { searchBestMove } from '../mcts';
import { createRng } from '../rng';
import { instantiateNativeWasm, nativeRequestFor } from './search';

const table = JSON.stringify(raw);

/** A seeded game of `plies` random legal moves, with its record as placement ids (-1 = pass). */
function playRandom(plies: number, seed: number): { state: GameState; moves: number[] } {
  const rng = createRng(seed);
  let state = createInitialState();
  const moves: number[] = [];
  for (let ply = 0; ply < plies; ply += 1) {
    const legal = generateLegalMoves(state, state.currentTurn);
    if (legal.length === 0) {
      state = passTurn(state);
      moves.push(-1);
      continue;
    }
    const move = legal[Math.floor(rng() * legal.length)];
    moves.push(placementFor(move));
    state = applyMove(state, move);
  }
  return { state, moves };
}

describe('native engine in WebAssembly', () => {
  it('returns a legal move from a v5.2-nano search, through the app search path', async () => {
    const { state } = playRandom(24, 7);
    const player = state.currentTurn;
    let iterations = 0;
    const result = await searchBestMove(
      state,
      player,
      2000,
      (progress) => {
        if (progress.phase === 'done') iterations = progress.iterations;
      },
      { version: 'v5.2-nano', iterationBudget: 300 },
    );
    expect(result.bestMove).not.toBeNull();
    const legal = new Set(generateLegalMoves(state, player).map(moveKey));
    expect(legal.has(moveKey(result.bestMove!))).toBe(true);
    // A real tree search, not the opening shortcut (whose visits are ranks 1-3).
    expect(result.rankedMoves[0].visits).toBeGreaterThan(1);
    // The native config's iterationScale (0.383) applied once to the base 300, not twice.
    expect(getAlgo('v5.2-nano').iterationScale).toBe(1);
    expect(iterations).toBe(Math.round(300 * getAlgo('v5.2-nano').native!.config.search.iterationScale));
  });

  it('sees the same position from the app state as from the game record', async () => {
    const { state, moves } = playRandom(30, 11);
    const module = await instantiateNativeWasm();
    const spec = getAlgo('v5.2-nano').native!;
    const handle = module.createEngine(JSON.stringify(spec.config), table);
    const fromState = module.searchJson(handle, { ...nativeRequestFor(state, state.currentTurn), budget: 300, seed: 5 });
    const fromRecord = module.searchJson(handle, { moves, budget: 300, seed: 5 });
    expect(fromState).toBe(fromRecord);
  });

  it('refuses configs that need a socket-served network', async () => {
    const module = await instantiateNativeWasm();
    const config = structuredClone(getAlgo('v5.2-nano').native!.config);
    config.native = { prior: { socket: '/tmp/x.sock', blend: 0.5, temperature: 1 } };
    expect(() => module.createEngine(JSON.stringify(config), table)).toThrow(/native\.prior/);
  });
});
