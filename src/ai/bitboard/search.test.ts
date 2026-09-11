/**
 * End-to-end checks on the controller of §6.
 *
 * Determinism is the load-bearing one. `scripts/tournament.ts` fails a run whose mirror match does
 * not print exactly 0.00, which only holds if a seed plus an iteration budget reproduce a search
 * exactly — so the same search run twice must return the same move and the same visit counts.
 */

import { describe, expect, it } from 'vitest';
import { generateLegalMoves, moveKey } from '../../engine/game';
import { searchBestMove, rankMovesGreedy } from '../mcts';
import { setSeed } from '../rng';
import { clearLegalMoveCache } from '../legalMoveCache';
import { toPosition } from './adapter';
import { DEFAULT_BITBOARD_PARAMS, resetV12, searchBestMoveV12 } from './index';
import { withOverrides } from './config';
import { playRandomGame } from './testUtil';

function legalKeys(state: Parameters<typeof generateLegalMoves>[0], color: 'blue') {
  return new Set(generateLegalMoves(state, color).map((move) => moveKey(move)));
}

describe('v12 search', () => {
  it('plays a legal move from the opening', async () => {
    const { states } = playRandomGame(31, 0);
    const state = states[0];
    clearLegalMoveCache();
    resetV12();
    setSeed(1234);

    const result = await searchBestMove(state, 'blue', 5000, undefined, {
      version: 'v12',
      iterationBudget: 60,
      skipWinOddsRefinement: true,
    });

    expect(result.bestMove).not.toBeNull();
    expect(legalKeys(state, 'blue').has(moveKey(result.bestMove!))).toBe(true);
    expect(result.rankedMoves.length).toBeGreaterThan(1);
  });

  it('is reproducible for a given seed and iteration budget', async () => {
    const { states } = playRandomGame(33);
    const state = states[2];

    const run = async () => {
      clearLegalMoveCache();
      resetV12();
      setSeed(99);
      return searchBestMove(state, state.currentTurn, 5000, undefined, {
        version: 'v12',
        iterationBudget: 80,
        skipWinOddsRefinement: true,
      });
    };

    const first = await run();
    const second = await run();
    expect(moveKey(second.bestMove!)).toBe(moveKey(first.bestMove!));
    expect(second.rankedMoves.map((entry) => entry.visits)).toEqual(
      first.rankedMoves.map((entry) => entry.visits),
    );
  });

  it('ranks moves without a tree under the greedy policy', async () => {
    const { states } = playRandomGame(35);
    const state = states[3];
    clearLegalMoveCache();
    resetV12();
    setSeed(7);

    const result = await rankMovesGreedy(state, state.currentTurn, undefined, 400, undefined, undefined, 'v12');
    expect(result.bestMove).not.toBeNull();
    const legal = new Set(
      generateLegalMoves(state, state.currentTurn).map((move) => moveKey(move)),
    );
    expect(legal.has(moveKey(result.bestMove!))).toBe(true);
    // Every ranked entry must be one of the legal moves, not just the best one.
    for (const entry of result.rankedMoves) {
      expect(legal.has(moveKey(entry.move))).toBe(true);
    }
  });

  it('leaves the position untouched after a search', async () => {
    const { states } = playRandomGame(37);
    const state = states[4];
    const before = toPosition(state);
    const snapshot = [...before.occ];

    clearLegalMoveCache();
    resetV12();
    setSeed(5);
    await searchBestMove(state, state.currentTurn, 5000, undefined, {
      version: 'v12',
      iterationBudget: 60,
      skipWinOddsRefinement: true,
    });

    const after = toPosition(state);
    expect([...after.occ]).toEqual(snapshot);
  });

  it('keeps the variance root audit and spatial grouping deterministic', async () => {
    const state = playRandomGame(321, 16, 16).final;
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: {
        rootAudit: 'variance',
        rootAuditTopK: 4,
        rootAuditRollouts: 16,
        rootAuditBlend: 0.35,
        rootGrouping: 'spatial',
      },
    });
    const run = async () => {
      resetV12();
      setSeed(3210);
      return searchBestMoveV12(state, state.currentTurn, 5000, params, undefined, {
        iterationBudget: 40,
        engineKey: 'audit-group-test',
      });
    };
    const first = await run();
    const second = await run();
    expect(moveKey(second.bestMove!)).toBe(moveKey(first.bestMove!));
    expect(second.rankedMoves.map((entry) => entry.value)).toEqual(
      first.rankedMoves.map((entry) => entry.value),
    );
  });

  it('keeps a two-tree root ensemble deterministic and within one total budget', async () => {
    const state = playRandomGame(654, 12, 12).final;
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: { rootEnsembleTrees: 2 },
    });
    const run = async () => {
      resetV12();
      setSeed(6540);
      return searchBestMoveV12(state, state.currentTurn, 5000, params, undefined, {
        iterationBudget: 41,
        engineKey: 'ensemble-test',
      });
    };
    const first = await run();
    const second = await run();
    expect(moveKey(second.bestMove!)).toBe(moveKey(first.bestMove!));
    expect(second.rankedMoves.map((entry) => entry.visits)).toEqual(
      first.rankedMoves.map((entry) => entry.visits),
    );
    expect(second.rankedMoves.reduce((sum, entry) => sum + entry.visits, 0)).toBeLessThanOrEqual(41);
  });

  it('resets online playout learning per move and remains reproducible', async () => {
    const state = playRandomGame(777, 14, 14).final;
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: {
        playoutMastWeight: 1,
        playoutEpsByPhase: { opening: 0.15, midgame: 0.3, endgame: 0.15 },
        raveEquivalence: 10,
      },
    });
    const run = async () => {
      resetV12();
      setSeed(7770);
      return searchBestMoveV12(state, state.currentTurn, 5000, params, undefined, {
        iterationBudget: 60,
        engineKey: 'mast-epsilon-test',
      });
    };
    const first = await run();
    const second = await run();
    expect(moveKey(second.bestMove!)).toBe(moveKey(first.bestMove!));
    expect(second.rankedMoves.map((entry) => entry.visits)).toEqual(
      first.rankedMoves.map((entry) => entry.visits),
    );
  });
});
