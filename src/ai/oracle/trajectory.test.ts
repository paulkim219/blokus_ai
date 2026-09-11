import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../../engine/game';
import {
  ORACLE_CONTEXT_POLICY_FEATURE_NAMES,
  ORACLE_CONTEXT_STATE_FEATURE_NAMES,
  ORACLE_POLICY_FEATURE_NAMES,
  OracleTrajectoryCollector,
} from './trajectory';

describe('OracleTrajectoryCollector', () => {
  it('records the played action inside the standardized exact legal set', () => {
    let state = createInitialState('corner');
    const collector = new OracleTrajectoryCollector();
    for (let ply = 0; ply < 8; ply += 1) {
      const legal = generateLegalMoves(state, state.currentTurn);
      const played = legal[Math.min(2, legal.length - 1)];
      collector.observe(state, played, 'test-profile', ply);
      state = applyMove(state, played);
    }

    const result = collector.result();
    expect(result.missingPlayedActions).toBe(0);
    expect(result.decisions).toHaveLength(8);
    for (const decision of result.decisions) {
      expect(decision.candidates[decision.actualIndex]).toHaveLength(
        ORACLE_POLICY_FEATURE_NAMES.length,
      );
      for (let feature = 0; feature < ORACLE_POLICY_FEATURE_NAMES.length; feature += 1) {
        const mean =
          decision.candidates.reduce((sum, candidate) => sum + candidate[feature], 0) /
          decision.candidates.length;
        // Four-sigma clipping can move the mean slightly when a legal set has an outlier.
        expect(Math.abs(mean)).toBeLessThan(0.05);
      }
    }
  });

  it('returns defensive copies', () => {
    const state = createInitialState('corner');
    const collector = new OracleTrajectoryCollector();
    collector.observe(state, generateLegalMoves(state, state.currentTurn)[0], 'profile', 0);
    const first = collector.result();
    first.decisions[0].candidates[0][0] = 99;
    expect(collector.result().decisions[0].candidates[0][0]).not.toBe(99);
  });

  it('records canonical board, hand, geometry, and target context once per decision', () => {
    let state = createInitialState('corner');
    const collector = new OracleTrajectoryCollector(true);
    for (let ply = 0; ply < 5; ply += 1) {
      const move = generateLegalMoves(state, state.currentTurn)[0];
      collector.observe(state, move, 'context-profile', ply);
      state = applyMove(state, move);
    }

    const result = collector.result();
    expect(result.missingPlayedActions).toBe(0);
    for (const decision of result.decisions) {
      expect(decision.candidates[0]).toHaveLength(ORACLE_CONTEXT_POLICY_FEATURE_NAMES.length);
      expect(decision.stateFeatures).toHaveLength(ORACLE_CONTEXT_STATE_FEATURE_NAMES.length);
      expect(decision.board).toHaveLength(20 * 20 * 4);
    }
    expect(result.decisions[0].board?.reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(result.decisions[4].board?.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);
  });
});
