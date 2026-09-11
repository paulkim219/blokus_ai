import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../../engine/game';
import { oracleSeat } from './interaction';
import { OracleRuntimeTracker } from './runtime';

describe('OracleRuntimeTracker', () => {
  it('keeps per-seat beliefs and exposes genuine fixed and shuffled controls', () => {
    const tracker = new OracleRuntimeTracker();
    let state = createInitialState();

    const blue = generateLegalMoves(state, state.currentTurn)[0];
    tracker.observe(state, blue);
    state = applyMove(state, blue);
    const greenMoves = generateLegalMoves(state, state.currentTurn);
    const green = greenMoves[greenMoves.length - 1];
    tracker.observe(state, green);

    const personalized = tracker.snapshot('personalized');
    const fixed = tracker.snapshot('fixed');
    const shuffled = tracker.snapshot('shuffled');
    const blueSeat = oracleSeat('blue');
    const greenSeat = oracleSeat('green');

    expect(personalized.observations[blueSeat]).toBe(1);
    expect(personalized.observations[greenSeat]).toBe(1);
    expect(personalized.posteriors[blueSeat]).not.toEqual(fixed.posteriors[blueSeat]);
    expect(shuffled.posteriors[blueSeat]).toEqual(personalized.posteriors[greenSeat]);
  });

  it('returns a deep snapshot that cannot mutate real-game memory', () => {
    const tracker = new OracleRuntimeTracker();
    const first = tracker.snapshot('personalized');
    first.posteriors[0][0] = 99;
    first.interaction.pressure[0][1] = 99;

    const second = tracker.snapshot('personalized');
    expect(second.posteriors[0][0]).not.toBe(99);
    expect(second.interaction.pressure[0][1]).toBe(0);
  });
});
