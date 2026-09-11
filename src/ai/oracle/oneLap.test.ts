import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMove,
  createInitialState,
  generateLegalMoves,
  moveKey,
  passTurn,
} from '../../engine/game';
import type { GameState } from '../../engine/types';
import { resetV12 } from '../bitboard';
import {
  loadRolloutPolicy,
  registerRolloutPolicy,
  ROLLOUT_POLICY_FEATURE_COUNT,
  ROLLOUT_POLICY_FEATURE_NAMES,
} from '../bitboard/rolloutPolicy';
import { searchBestMove } from '../mcts';
import { setSeed } from '../rng';
import { createOracleInteractionState } from './interaction';
import { searchBestMoveOracle } from './oneLap';
import { ORACLE_STYLE_PROTOTYPES } from './prototypeBayes';
import { OracleRuntimeTracker } from './runtime';
import type { OracleSearchSnapshot } from './types';

beforeAll(() => {
  registerRolloutPolicy(
    'ml/v41-rollout-policy.json',
    loadRolloutPolicy({
      kind: 'canonical-rollout-policy-v41',
      featureCount: ROLLOUT_POLICY_FEATURE_COUNT,
      featureNames: [...ROLLOUT_POLICY_FEATURE_NAMES],
      weights: Array.from({ length: 3 }, () =>
        new Array<number>(ROLLOUT_POLICY_FEATURE_COUNT).fill(0),
      ),
      blend: 1,
    }),
  );
});

function fixture(plies = 16): GameState {
  let state = createInitialState();
  for (let ply = 0; ply < plies && !state.finished; ply += 1) {
    const legal = generateLegalMoves(state, state.currentTurn);
    state = legal.length > 0 ? applyMove(state, legal[ply % legal.length]) : passTurn(state);
  }
  return state;
}

describe('Oracle one-lap response search', () => {
  it('is exactly the base search before enough evidence exists', async () => {
    const state = fixture();
    const snapshot = new OracleRuntimeTracker().snapshot('personalized');

    resetV12();
    setSeed(88);
    const base = await searchBestMove(state, state.currentTurn, 5000, undefined, {
      version: 'v4.1',
      iterationBudget: 12,
      skipWinOddsRefinement: true,
    });
    resetV12();
    setSeed(88);
    const oracle = await searchBestMove(state, state.currentTurn, 5000, undefined, {
      version: 'v5-oracle-one-lap',
      iterationBudget: 12,
      skipWinOddsRefinement: true,
      oracle: snapshot,
    });

    expect(oracle.rankedMoves.map((entry) => moveKey(entry.move))).toEqual(
      base.rankedMoves.map((entry) => moveKey(entry.move)),
    );
    expect(oracle.rankedMoves.map((entry) => entry.value)).toEqual(
      base.rankedMoves.map((entry) => entry.value),
    );
  }, 60_000);

  it.each(['static', 'terminal'] as const)(
    'returns a legal reproducible move without mutating an active snapshot (%s)',
    async (responseEvaluator) => {
    const state = fixture();
    const oneHot = (index: number) =>
      ORACLE_STYLE_PROTOTYPES.map((_, prototype) => (prototype === index ? 1 : 0));
    const snapshot: OracleSearchSnapshot = {
      mode: 'personalized',
      posteriors: [oneHot(0), oneHot(2), oneHot(4), oneHot(5)],
      observations: [3, 3, 3, 3],
      interaction: createOracleInteractionState(),
    };
    const before = structuredClone(snapshot);
    const config = {
      baseVersion: 'v4.1',
      profileMode: 'personalized' as const,
      temperature: 0.6,
      minimumObservations: 3,
      rootCandidates: 2,
      replyWidth: 1,
      beamWidth: 1,
      baseSearchFraction: 0.75,
      responseBlend: 0.25,
      riskWeight: 0.1,
      responseEvaluator,
      terminalRollouts: responseEvaluator === 'terminal' ? 1 : 0,
      responseMode: 'absoluteBeam' as const,
      scenarioCount: 0,
      responseVisitScale: 4,
    };

    resetV12();
    setSeed(99);
    const first = await searchBestMoveOracle(
      state,
      state.currentTurn,
      5000,
      config,
      snapshot,
      undefined,
      { iterationBudget: 8 },
      'oracle-test',
    );
    resetV12();
    setSeed(99);
    const second = await searchBestMoveOracle(
      state,
      state.currentTurn,
      5000,
      config,
      snapshot,
      undefined,
      { iterationBudget: 8 },
      'oracle-test',
    );

    const legal = new Set(generateLegalMoves(state, state.currentTurn).map(moveKey));
    expect(first.bestMove && legal.has(moveKey(first.bestMove))).toBe(true);
    expect(second.bestMove && moveKey(second.bestMove)).toBe(
      first.bestMove && moveKey(first.bestMove),
    );
    expect(snapshot).toEqual(before);
    },
    60_000,
  );

  it('makes the fixed-prior counterfactual arm an exact v4.1 identity', async () => {
    const state = fixture();
    const prior = ORACLE_STYLE_PROTOTYPES.map(() => 1 / ORACLE_STYLE_PROTOTYPES.length);
    const snapshot: OracleSearchSnapshot = {
      mode: 'fixed',
      posteriors: Array.from({ length: 4 }, () => [...prior]),
      observations: [3, 3, 3, 3],
      interaction: createOracleInteractionState(),
    };
    const config = {
      baseVersion: 'v4.1',
      profileMode: 'fixed' as const,
      temperature: 0.6,
      minimumObservations: 3,
      rootCandidates: 2,
      replyWidth: 1,
      beamWidth: 1,
      baseSearchFraction: 1,
      responseBlend: 0.25,
      riskWeight: 0,
      responseEvaluator: 'terminal' as const,
      terminalRollouts: 1,
      responseMode: 'counterfactualSample' as const,
      scenarioCount: 2,
      responseVisitScale: 4,
    };

    resetV12();
    setSeed(707);
    const base = await searchBestMove(state, state.currentTurn, 5000, undefined, {
      version: 'v4.1',
      iterationBudget: 8,
      skipWinOddsRefinement: true,
    });
    resetV12();
    setSeed(707);
    const fixed = await searchBestMoveOracle(
      state,
      state.currentTurn,
      5000,
      config,
      snapshot,
      undefined,
      { iterationBudget: 8 },
      'oracle-counterfactual-fixed-test',
    );

    expect(fixed.rankedMoves).toEqual(base.rankedMoves);
    expect(fixed.bestMove && moveKey(fixed.bestMove)).toBe(
      base.bestMove && moveKey(base.bestMove),
    );
  }, 60_000);
});
