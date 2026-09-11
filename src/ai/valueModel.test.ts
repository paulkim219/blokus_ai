import { describe, expect, it } from 'vitest';
import { WEIGHT_KEYS } from './algoVersions';
import { columnCorrelation, fitRidge, rescaleWeights, type Dataset } from './valueModel';

/** Builds rows where the target is an exact linear function of two features plus noise-free zeros. */
function syntheticDataset(coefficients: Partial<Record<string, number>>, rows = 400): Dataset {
  const data: number[][] = [];
  const targets: number[] = [];
  let state = 7;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  for (let i = 0; i < rows; i += 1) {
    const row = WEIGHT_KEYS.map(() => next() * 10);
    const target = WEIGHT_KEYS.reduce(
      (sum, key, j) => sum + (coefficients[key] ?? 0) * row[j],
      0,
    );
    data.push(row);
    targets.push(target);
  }
  return { rows: data, targets };
}

describe('ridge regression', () => {
  it('recovers a known linear relationship', () => {
    const dataset = syntheticDataset({ placedSquares: 2, cornerAccess: -3 });
    const fit = fitRidge(dataset, 1e-6);

    expect(fit.weights.placedSquares).toBeCloseTo(2, 3);
    expect(fit.weights.cornerAccess).toBeCloseTo(-3, 3);
    expect(fit.weights.centerControl).toBeCloseTo(0, 3);
    expect(fit.rSquared).toBeGreaterThan(0.999);
  });

  it('shrinks coefficients as lambda grows', () => {
    const dataset = syntheticDataset({ placedSquares: 2 });
    const light = fitRidge(dataset, 1e-6);
    const heavy = fitRidge(dataset, 10);

    expect(Math.abs(heavy.weights.placedSquares)).toBeLessThan(
      Math.abs(light.weights.placedSquares),
    );
  });

  it('gives a constant feature zero weight instead of exploding', () => {
    const dataset = syntheticDataset({ placedSquares: 1 });
    for (const row of dataset.rows) {
      row[WEIGHT_KEYS.indexOf('territory')] = 5;
    }
    const fit = fitRidge(dataset, 1e-6);

    expect(fit.weights.territory).toBe(0);
    expect(Number.isFinite(fit.weights.placedSquares)).toBe(true);
  });

  it('rejects an empty dataset', () => {
    expect(() => fitRidge({ rows: [], targets: [] })).toThrow();
  });
});

describe('weight rescaling', () => {
  it('anchors one weight and keeps every ratio', () => {
    const fit = fitRidge(syntheticDataset({ placedSquares: 1, cornerAccess: 2 }), 1e-6);
    const scaled = rescaleWeights(fit.weights, 'placedSquares', 2.6);

    expect(scaled.placedSquares).toBeCloseTo(2.6, 6);
    expect(scaled.cornerAccess / scaled.placedSquares).toBeCloseTo(
      fit.weights.cornerAccess / fit.weights.placedSquares,
      6,
    );
  });
});

describe('collinearity reporting', () => {
  it('detects a perfectly correlated pair', () => {
    const dataset = syntheticDataset({ placedSquares: 1 });
    const a = WEIGHT_KEYS.indexOf('mobility');
    const b = WEIGHT_KEYS.indexOf('opponentMobility');
    for (const row of dataset.rows) {
      row[b] = row[a] * 2 + 1;
    }
    expect(columnCorrelation(dataset.rows, a, b)).toBeCloseTo(1, 6);
  });
});
