import { WEIGHT_KEYS, type HeuristicWeights } from './algoVersions';
import type { FeatureVector } from './heuristics';

/**
 * Linear value learning for the evaluation weights.
 *
 * This is Monte-Carlo policy evaluation with linear function approximation: play games, record the
 * feature vector of every position, and regress it onto the outcome that position eventually led
 * to. The result is a weight vector fitted to what actually wins games rather than to intuition.
 *
 * Ridge rather than plain least squares because two of the features are near-collinear by
 * construction — in fast mode `mobility` is `liberties + 2 · piecesLeft` and `blocking` is a linear
 * function of the same opponents' liberties that `opponentMobility` already carries, so the normal
 * equations are ill-conditioned and unregularised coefficients would be arbitrary.
 */
export interface Dataset {
  /** One row per position, in `WEIGHT_KEYS` order. */
  rows: number[][];
  /** Outcome each row eventually led to. */
  targets: number[];
}

export interface FitResult {
  weights: HeuristicWeights;
  /** Raw coefficients in `WEIGHT_KEYS` order, before rescaling. */
  coefficients: number[];
  intercept: number;
  lambda: number;
  rSquared: number;
  rows: number;
  /** Column standard deviations — a zero here means the feature never varied in the data. */
  columnStdev: number[];
}

export function featuresToRow(features: FeatureVector): number[] {
  return WEIGHT_KEYS.map((key) => features[key]);
}

function weightsFromValues(values: number[]): HeuristicWeights {
  const weights = {} as HeuristicWeights;
  WEIGHT_KEYS.forEach((key, i) => {
    weights[key] = values[i] ?? 0;
  });
  return weights;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

/** Gaussian elimination with partial pivoting. `matrix` is modified in place. */
function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-12) {
      continue;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];

    for (let row = 0; row < n; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col] / a[col][col];
      if (factor === 0) {
        continue;
      }
      for (let k = col; k <= n; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }

  return Array.from({ length: n }, (_, i) =>
    Math.abs(a[i][i]) < 1e-12 ? 0 : a[i][n] / a[i][i],
  );
}

/**
 * Ridge regression on standardised columns, with the coefficients mapped back to raw feature
 * units. Standardising matters here: `centerControl` runs to the hundreds while `blocking` sits
 * near ten, and a single λ applied to raw columns would regularise them wildly unevenly.
 */
export function fitRidge(dataset: Dataset, lambda = 1): FitResult {
  const { rows, targets } = dataset;
  const n = rows.length;
  const p = WEIGHT_KEYS.length;
  if (n === 0) {
    throw new Error('fitRidge: empty dataset');
  }

  const columnMean = Array.from({ length: p }, (_, j) => mean(rows.map((row) => row[j])));
  const columnStdev = Array.from({ length: p }, (_, j) => {
    const m = columnMean[j];
    const variance = mean(rows.map((row) => (row[j] - m) ** 2));
    return Math.sqrt(variance);
  });
  const targetMean = mean(targets);

  const scaled = rows.map((row) =>
    row.map((value, j) => (columnStdev[j] > 1e-9 ? (value - columnMean[j]) / columnStdev[j] : 0)),
  );
  const centeredTargets = targets.map((value) => value - targetMean);

  const gram = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const moment = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i += 1) {
    const row = scaled[i];
    for (let j = 0; j < p; j += 1) {
      moment[j] += row[j] * centeredTargets[i];
      for (let k = j; k < p; k += 1) {
        gram[j][k] += row[j] * row[k];
      }
    }
  }
  for (let j = 0; j < p; j += 1) {
    for (let k = 0; k < j; k += 1) {
      gram[j][k] = gram[k][j];
    }
    gram[j][j] += lambda * n;
  }

  const standardized = solve(gram, moment);
  const coefficients = standardized.map((value, j) =>
    columnStdev[j] > 1e-9 ? value / columnStdev[j] : 0,
  );
  const intercept =
    targetMean - coefficients.reduce((sum, value, j) => sum + value * columnMean[j], 0);

  let residual = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted =
      intercept + rows[i].reduce((sum, value, j) => sum + value * coefficients[j], 0);
    residual += (targets[i] - predicted) ** 2;
    total += (targets[i] - targetMean) ** 2;
  }

  return {
    weights: weightsFromValues(coefficients),
    coefficients,
    intercept,
    lambda,
    rSquared: total > 0 ? 1 - residual / total : 0,
    rows: n,
    columnStdev,
  };
}

/**
 * The evaluation is only ever compared against other evaluations and is then squashed by
 * `positionalScale`, so a fitted vector is identified only up to a positive scale. Anchoring it to
 * a reference weight keeps the fitted numbers on the same footing as the hand-tuned ones — and
 * keeps `positionalScale` meaning what it meant before.
 */
export function rescaleWeights(
  weights: HeuristicWeights,
  anchorKey: keyof HeuristicWeights,
  anchorValue: number,
): HeuristicWeights {
  const current = weights[anchorKey];
  if (Math.abs(current) < 1e-9) {
    return { ...weights };
  }
  const factor = anchorValue / current;
  return weightsFromValues(WEIGHT_KEYS.map((key) => weights[key] * factor));
}

export function weightNorm(weights: HeuristicWeights): number {
  return Math.sqrt(WEIGHT_KEYS.reduce((sum, key) => sum + weights[key] ** 2, 0));
}

/**
 * Scale-normalisation that does not depend on any single coefficient being large. Anchoring to one
 * weight explodes the rest when that weight happens to be fitted near zero — which is exactly what
 * happens early in the game, where the final margin is barely predictable at all.
 */
export function rescaleToNorm(weights: HeuristicWeights, targetNorm: number): HeuristicWeights {
  const norm = weightNorm(weights);
  if (norm < 1e-9) {
    return { ...weights };
  }
  const factor = targetNorm / norm;
  return weightsFromValues(WEIGHT_KEYS.map((key) => weights[key] * factor));
}

/** Correlation between two columns — used to report which features are not separately identified. */
export function columnCorrelation(rows: number[][], a: number, b: number): number {
  const xs = rows.map((row) => row[a]);
  const ys = rows.map((row) => row[b]);
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx < 1e-12 || vy < 1e-12) {
    return 0;
  }
  return cov / Math.sqrt(vx * vy);
}
