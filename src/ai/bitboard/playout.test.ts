import { describe, expect, it } from 'vitest';
import { createInitialState, applyMove, generateLegalMoves } from '../../engine/game';
import { DEFAULT_BITBOARD_PARAMS, withOverrides } from './config';
import { createEvalContext, detectPhase, refreshContext } from './features';
import { Playout, createOutcome } from './playout';
import { toPosition } from './adapter';
import { setSeed } from '../rng';
import {
  loadRolloutPolicy,
  registerRolloutPolicy,
  ROLLOUT_POLICY_FEATURE_COUNT,
  ROLLOUT_POLICY_FEATURE_NAMES,
} from './rolloutPolicy';

/**
 * The fitted rollout policy has to contain the shipped one exactly, or a fit that "loses" cannot be
 * distinguished from a port that changed behaviour. `playoutPolicy: 'linear'` with both new weights
 * at zero and `playoutTemp: 0` reduces `linearScore` to the legacy two-term argmax, so the two must
 * produce identical rollouts from identical seeds.
 */
function midGamePosition(plies: number) {
  let state = createInitialState('corner');
  for (let i = 0; i < plies; i += 1) {
    const moves = generateLegalMoves(state, state.currentTurn, 30);
    if (moves.length === 0) break;
    state = applyMove(state, moves[Math.floor(moves.length / 3)]);
  }
  return state;
}

function runRollouts(params: ReturnType<typeof withOverrides>, seed: number, count: number): number[] {
  const state = midGamePosition(12);
  const position = toPosition(state);
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  refreshContext(context, position, false);
  const phase = detectPhase(position, context, params, position.turn);
  const playout = new Playout(params);
  const outcome = createOutcome();
  const values: number[] = [];
  setSeed(seed);
  for (let i = 0; i < count; i += 1) {
    playout.run(position, context, phase, outcome);
    values.push(...outcome.values);
  }
  return values;
}

describe('linear rollout policy', () => {
  it('reproduces the legacy policy exactly at zero weights and zero temperature', () => {
    const legacy = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: { playoutPolicy: 'legacy', playoutEps: 0.6, playoutCutoff: 84 },
    });
    const linear = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: {
        playoutPolicy: 'linear',
        playoutEps: 0.6,
        playoutCutoff: 84,
        playoutCornerWeight: 0,
        playoutEdgeWeight: 0,
        playoutTemp: 0,
      },
    });

    expect(runRollouts(linear, 4242, 12)).toEqual(runRollouts(legacy, 4242, 12));
  });

  it('changes the rollout distribution once a halo weight is non-zero', () => {
    const base = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: {
        playoutPolicy: 'linear',
        playoutEps: 0,
        playoutCutoff: 84,
        playoutCornerWeight: 0,
        playoutEdgeWeight: 0,
        playoutTemp: 0,
      },
    });
    const weighted = withOverrides(base, { search: { playoutCornerWeight: 0.5 } });

    // ε=0 makes the policy deterministic given the candidate pool, so any difference is the weight.
    expect(runRollouts(weighted, 77, 8)).not.toEqual(runRollouts(base, 77, 8));
  });

  it('is deterministic under a fixed seed', () => {
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: {
        playoutPolicy: 'linear',
        playoutEps: 0.3,
        playoutCutoff: 84,
        playoutCornerWeight: 0.2,
        playoutEdgeWeight: -0.1,
        playoutTemp: 1.5,
      },
    });

    expect(runRollouts(params, 999, 10)).toEqual(runRollouts(params, 999, 10));
  });

  it('reproduces the legacy policy exactly at table blend zero', () => {
    const path = 'test/v41-zero-policy.json';
    registerRolloutPolicy(
      path,
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
    const legacy = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: { playoutPolicy: 'legacy', playoutEps: 0.6, playoutCutoff: 84 },
    });
    const identity = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: {
        playoutPolicy: 'table',
        playoutTablePath: path,
        playoutTableBlend: 0,
        playoutEps: 0.6,
        playoutCutoff: 84,
        playoutTemp: 0,
      },
    });

    expect(runRollouts(identity, 5150, 12)).toEqual(runRollouts(legacy, 5150, 12));
  });

  it('can bootstrap after a real prefix and restores the source position', () => {
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: { playoutEps: 0.6, playoutCutoff: 84 },
    });
    const state = midGamePosition(12);
    const position = toPosition(state);
    const beforeHash = [position.hashLo, position.hashHi, position.turn];
    const context = createEvalContext();
    refreshContext(context, position, false);
    const phase = detectPhase(position, context, params, position.turn);
    const outcome = createOutcome();
    let observedSteps = 0;

    setSeed(1234);
    new Playout(params).run(position, context, phase, outcome, undefined, 8, (_p, _c, steps, out) => {
      observedSteps = steps;
      out.set([0.1, 0.2, 0.3, 0.4]);
      return true;
    });

    expect(observedSteps).toBe(8);
    expect(outcome.learnedTail).toBe(true);
    expect(Array.from(outcome.values)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect([position.hashLo, position.hashHi, position.turn]).toEqual(beforeHash);
  });

  it('continues the incumbent rollout when the tail evaluator abstains', () => {
    const params = withOverrides(DEFAULT_BITBOARD_PARAMS, {
      search: { playoutEps: 0.6, playoutCutoff: 84 },
    });
    const state = midGamePosition(12);
    const make = () => {
      const position = toPosition(state);
      const context = createEvalContext();
      refreshContext(context, position, false);
      return { position, context, phase: detectPhase(position, context, params, position.turn) };
    };
    const baseline = make();
    const gated = make();
    const baselineOutcome = createOutcome();
    const gatedOutcome = createOutcome();

    setSeed(5678);
    new Playout(params).run(baseline.position, baseline.context, baseline.phase, baselineOutcome);
    setSeed(5678);
    new Playout(params).run(
      gated.position,
      gated.context,
      gated.phase,
      gatedOutcome,
      undefined,
      8,
      () => false,
    );

    expect(gatedOutcome.learnedTail).toBe(false);
    expect(gatedOutcome.terminal).toBe(baselineOutcome.terminal);
    expect(Array.from(gatedOutcome.values)).toEqual(Array.from(baselineOutcome.values));
  });
});
