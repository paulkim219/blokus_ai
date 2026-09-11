import { describe, expect, it } from 'vitest';
import { marginsFrom, valueVector, valueVectorFromMeanMargins } from './backup';

describe('learned mean-margin value contract', () => {
  it('matches the ordinary mean-opponent value when given equivalent labels', () => {
    const scores = new Float64Array([-4, -11, -18, 7]);
    const margins = marginsFrom(scores, new Float64Array(4), 'mean');
    const fromScores = valueVector(scores, 12, 0.35, new Float64Array(4), 'mean');
    const fromMargins = valueVectorFromMeanMargins(margins, 12, 0.35, new Float64Array(4));

    expect([...fromMargins]).toEqual([...fromScores]);
  });

  it('does not subtract an opponent reference twice', () => {
    const margins = new Float64Array([12, 4, -6, -10]);
    const direct = valueVectorFromMeanMargins(margins, 12, 0, new Float64Array(4));
    const treatedAsScores = valueVector(margins, 12, 0, new Float64Array(4), 'max');

    expect(direct[0]).not.toBeCloseTo(treatedAsScores[0], 8);
  });
});
