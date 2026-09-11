import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../../engine/game';
import { OraclePredictionProbe } from './probe';

describe('OraclePredictionProbe', () => {
  it('observes moves without altering the played rules trajectory', () => {
    const probe = new OraclePredictionProbe({ temperature: 0.6, warmupObservations: 0 });
    const state = createInitialState();
    const before = structuredClone(state);
    const move = generateLegalMoves(state, state.currentTurn)[0];

    probe.observe(state, move, 'test-engine');

    expect(state).toEqual(before);
    expect(applyMove(state, move).moveHistory).toHaveLength(1);
    const result = probe.result();
    expect(result.all.decisions).toBe(1);
    expect(result.warm.decisions).toBe(1);
    expect(result.byLabel['test-engine'].decisions).toBe(1);
    expect(result.missingPlayedActions).toBe(0);
  });
});

