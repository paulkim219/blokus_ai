import { describe, expect, it } from 'vitest';
import { createInitialState, generateLegalMoves } from '../../engine/game';
import { moveKey } from '../../engine/game';
import { createOracleInteractionState } from './interaction';
import {
  ORACLE_STYLE_PROTOTYPES,
  PrototypeBelief,
  standardizeOracleFeatures,
  type PrototypePrediction,
} from './prototypeBayes';

describe('PrototypeBelief', () => {
  it('produces a normalised distribution without mutating the rules state', () => {
    const state = createInitialState();
    const moves = generateLegalMoves(state, state.currentTurn);
    const interaction = createOracleInteractionState();
    const beforeState = structuredClone(state);
    const beforeInteraction = structuredClone(interaction);
    const belief = new PrototypeBelief();

    const prediction = belief.predict(state, moves, interaction);

    expect(prediction.probabilities).toHaveLength(moves.length);
    expect(prediction.probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(new Set(moves.map(moveKey)).size).toBe(moves.length);
    expect(state).toEqual(beforeState);
    expect(interaction).toEqual(beforeInteraction);
  });

  it('concentrates posterior mass on the prototype that explains repeated actions', () => {
    const belief = new PrototypeBelief(ORACLE_STYLE_PROTOTYPES, {
      learningRate: 1,
      drift: 0,
    });
    const target = ORACLE_STYLE_PROTOTYPES.findIndex((style) => style.id === 'retaliator');
    const byPrototype = ORACLE_STYLE_PROTOTYPES.map((_, index) =>
      index === target ? [0.95, 0.05] : [0.1, 0.9],
    );
    const prediction: PrototypePrediction = {
      probabilities: [0.1, 0.9],
      byPrototype,
      features: [],
      posterior: belief.posterior(),
    };

    for (let observation = 0; observation < 4; observation += 1) {
      belief.observe(prediction, 0);
    }

    expect(belief.posterior()[target]).toBeGreaterThan(0.99);
    expect(belief.observations).toBe(4);
  });

  it('rejects a posterior with the wrong dimensionality', () => {
    const belief = new PrototypeBelief();
    expect(() => belief.setPosterior([1])).toThrow(/prototype count/);
  });

  it('standardizes preferences within the legal candidate set', () => {
    const state = createInitialState();
    const moves = generateLegalMoves(state, state.currentTurn).slice(0, 30);
    const raw = new PrototypeBelief().predict(
      state,
      moves,
      createOracleInteractionState(),
    ).features;
    const standardized = standardizeOracleFeatures(raw);
    const pieceMean =
      standardized.reduce((sum, candidate) => sum + candidate.pieceSize, 0) /
      standardized.length;
    const centerMean =
      standardized.reduce((sum, candidate) => sum + candidate.centerAffinity, 0) /
      standardized.length;
    expect(pieceMean).toBeCloseTo(0);
    expect(centerMean).toBeCloseTo(0);
    expect(raw.some((candidate) => candidate.pieceSize !== 0)).toBe(true);
  });
});
