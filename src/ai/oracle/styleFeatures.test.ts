import { describe, expect, it } from 'vitest';
import { applyMove, createInitialState, generateLegalMoves } from '../../engine/game';
import {
  createOracleInteractionState,
  currentOracleOpenCorners,
} from './interaction';
import { extractOracleMoveFeatures } from './styleFeatures';

describe('Oracle style features', () => {
  it('computes exact incremental frontier gain for legal opening moves', () => {
    const state = createInitialState();
    const interaction = createOracleInteractionState();
    const before = currentOracleOpenCorners(state, 'blue').size;
    const moves = generateLegalMoves(state, 'blue').slice(0, 20);

    for (const move of moves) {
      const features = extractOracleMoveFeatures(state, move, interaction);
      const after = applyMove(state, move);
      const exact = currentOracleOpenCorners(after, 'blue').size;
      expect(features.frontierGain).toBeCloseTo((exact - before) / 10);
    }
  });
});

