import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../engine/game';
import type { GameState } from '../engine/types';
import { extractFeatures, evaluateMovePrior, evaluateState } from './heuristics';
import {
  ALGO_VERSIONS,
  DEFAULT_UI_ALGO_VERSION,
  UI_ALGO_VERSIONS,
  bitboardParamsFor,
  getAlgo,
  isUiAlgoVersion,
  registerAlgoConfig,
  unregisterAlgoConfig,
  weightsFor,
} from './algoVersions';
import { isRolloutPolicyRegistered } from './bitboard/rolloutPolicy';
import { preloadUiArtifacts, V41_ROLLOUT_POLICY_PATH } from './preloadUiArtifacts';

/** Deterministic mid-game position — no RNG involved, so it pins exact numbers. */
function midGameState(plies = 24): GameState {
  let state = createInitialState();
  for (let i = 0; i < plies; i += 1) {
    const moves = generateLegalMoves(state, state.currentTurn, 30);
    if (moves.length === 0) {
      break;
    }
    state = applyMove(state, moves[Math.floor(moves.length / 3)]);
  }
  return state;
}

describe('versioned evaluation', () => {
  it('exposes unique liberties on the opening board', () => {
    const state = createInitialState();
    const features = extractFeatures(state, 'blue', true);
    expect(features.uniqueLiberties).toBeTypeOf('number');
    expect(features.cornerAccess).toBe(0);
  });

  it('v4 and v5 both return finite opening scores', () => {
    const state = createInitialState();
    expect(Number.isFinite(evaluateState(state, 'blue', true, 'v1'))).toBe(true);
    expect(Number.isFinite(evaluateState(state, 'blue', true, 'v5'))).toBe(true);
    expect(ALGO_VERSIONS.v5.selectByVisits).toBe(true);
    expect(ALGO_VERSIONS.v1.selectByVisits).toBe(false);
  });

  it('evaluateMovePrior accepts a version id', () => {
    const state = createInitialState();
    const move = generateLegalMoves(state, 'blue', 1)[0];
    const a = evaluateMovePrior(state, move, true, 'v1');
    const b = evaluateMovePrior(state, move, true, 'v5');
    expect(Number.isFinite(a)).toBe(true);
    expect(Number.isFinite(b)).toBe(true);
  });
});

/**
 * v4 is the champion every challenger is measured against, so its numbers must not drift while
 * heuristics.ts is refactored. If one of these fails, the baseline moved and every past result in
 * docs/ALGORITHMS.md became incomparable.
 */
describe('v4 golden values', () => {
  const state = midGameState();
  const move = generateLegalMoves(state, state.currentTurn, 30)[0];

  it('pins the fast evaluation', () => {
    expect(evaluateState(state, 'blue', true, 'v1')).toBeCloseTo(-19.188889, 5);
  });

  it('pins the slow (explanation-path) evaluation', () => {
    expect(evaluateState(state, 'blue', false, 'v1')).toBeCloseTo(26.011111, 5);
  });

  it('pins the move prior', () => {
    expect(evaluateMovePrior(state, move, true, 'v1')).toBeCloseTo(18.383333, 5);
  });

  it('leaves the new features at zero for v4', () => {
    const features = extractFeatures(state, 'blue', true, 'v1');
    expect(features.voronoiTerritory).toBe(0);
    expect(features.reachableArea).toBe(0);
  });

  it('computes the new features for v10 and changes its evaluation', () => {
    const features = extractFeatures(state, 'blue', true, 'v10');
    expect(features.voronoiTerritory).toBeGreaterThan(0);
    expect(features.reachableArea).toBeGreaterThan(0);
    expect(evaluateState(state, 'blue', true, 'v10')).not.toBeCloseTo(
      evaluateState(state, 'blue', true, 'v1'),
      5,
    );
  });
});

describe('config resolution', () => {
  it('fills v4 optionals with behaviour-preserving defaults', () => {
    const v4 = getAlgo('v1');
    expect(v4.selection).toBe('ucb1');
    expect(v4.weightsLate).toBeNull();
    expect(v4.seatProfile).toBeNull();
    expect(v4.rootWidening).toBeNull();
    expect(v4.endgame).toBeNull();
    expect(v4.leafValue).toBe('rollout');
  });

  it('returns authored weights unchanged when there is no schedule or seat profile', () => {
    const v4 = getAlgo('v1');
    expect(weightsFor(v4, 'blue', 0.1)).toBe(v4.weights);
    expect(weightsFor(v4, 'green', 0.9)).toBe(v4.weights);
  });

  it('interpolates v10 weights from early to late', () => {
    const v10 = getAlgo('v10');
    const early = weightsFor(v10, 'blue', 0.05);
    const late = weightsFor(v10, 'blue', 0.95);
    // Packing takes over: the unplaced-squares penalty grows, blocking fades.
    expect(late.remainingPenalty).toBeLessThan(early.remainingPenalty);
    expect(late.blocking).toBeLessThan(early.blocking);
    expect(late.reachableArea).toBeGreaterThan(early.reachableArea);
  });

  it('applies seat multipliers', () => {
    const v10 = getAlgo('v10');
    const blue = weightsFor(v10, 'blue', 0.05);
    const yellow = weightsFor(v10, 'yellow', 0.05);
    // Yellow moves last and is tuned to fight for space rather than claim it.
    expect(Math.abs(yellow.blocking)).toBeGreaterThan(Math.abs(blue.blocking));
    expect(yellow.cornerAccess).toBeLessThan(blue.cornerAccess);
  });

  it('registers and removes generated configs', () => {
    const id = registerAlgoConfig({
      ...ALGO_VERSIONS.v4,
      id: 'test-candidate',
      summary: 'generated',
      exploration: 2.5,
    });
    expect(getAlgo(id).exploration).toBe(2.5);
    unregisterAlgoConfig(id);
    // Unknown ids fall back to the champion rather than throwing mid-game.
    expect(getAlgo(id).id).toBe('v1');
  });

  it('resolves every UI dropdown version to its own live config', () => {
    for (const id of UI_ALGO_VERSIONS) {
      expect(getAlgo(id).id).toBe(id);
    }
    expect(DEFAULT_UI_ALGO_VERSION).toBe('v3.1');
    expect(isUiAlgoVersion('v3.1')).toBe(true);
    expect(isUiAlgoVersion('v4.1-lite')).toBe(true);
    expect(isUiAlgoVersion('v4.1-pro-max')).toBe(true);
    expect(isUiAlgoVersion('v1')).toBe(false);
    preloadUiArtifacts();
    expect(bitboardParamsFor(getAlgo('v4.1-lite')).search.playoutTablePath).toBe(
      V41_ROLLOUT_POLICY_PATH,
    );
    expect(isRolloutPolicyRegistered(V41_ROLLOUT_POLICY_PATH)).toBe(true);
  });
});
