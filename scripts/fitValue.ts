import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALGO_VERSIONS,
  WEIGHT_KEYS,
  isAlgoVersionId,
  type AlgoConfig,
  type HeuristicWeights,
} from '../src/ai/algoVersions.ts';
import type { FeatureVector } from '../src/ai/heuristics.ts';
import {
  columnCorrelation,
  featuresToRow,
  fitRidge,
  rescaleToNorm,
  weightNorm,
  type Dataset,
} from '../src/ai/valueModel.ts';

/**
 * Fits evaluation weights from collected self-play data.
 *
 * Two vectors are fitted, early and late, matching the phase schedule the config interpolates
 * between. Rows in the middle of the game belong to neither end of that interpolation and are
 * dropped rather than smeared across both.
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

interface Row {
  progress: number;
  features: FeatureVector;
  target: number;
}

function load(path: string): Row[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Row);
}

/**
 * Features that carry no independent information and must not be fitted:
 *
 * - `remainingPenalty` is exactly `89 − placedSquares` for every colour, so the pair has one
 *   degree of freedom. Only the difference of their weights affects play, and the constant it
 *   leaves behind cancels in `myScore − opponentTerm` (the opponent weights sum to one). Fitting
 *   both just hands ridge an arbitrary split to invent.
 * - `territory` is never computed during search, so any weight for it is fiction.
 */
const DEFAULT_DROPPED: Array<keyof HeuristicWeights> = ['remainingPenalty', 'territory'];

/** A constant column gets a zero coefficient from the solver, which is exactly what dropping means. */
function toDataset(rows: Row[], dropped: Array<keyof HeuristicWeights>): Dataset {
  const dropIndices = dropped.map((key) => WEIGHT_KEYS.indexOf(key)).filter((i) => i >= 0);
  return {
    rows: rows.map((row) => {
      const values = featuresToRow(row.features);
      for (const index of dropIndices) {
        values[index] = 0;
      }
      return values;
    }),
    targets: rows.map((row) => row.target),
  };
}

function reportCollinearity(dataset: Dataset): string[] {
  const notes: string[] = [];
  for (let a = 0; a < WEIGHT_KEYS.length; a += 1) {
    for (let b = a + 1; b < WEIGHT_KEYS.length; b += 1) {
      const correlation = columnCorrelation(dataset.rows, a, b);
      if (Math.abs(correlation) > 0.9) {
        notes.push(
          `  ${WEIGHT_KEYS[a]} ↔ ${WEIGHT_KEYS[b]}: r = ${correlation.toFixed(3)} — not separately identified`,
        );
      }
    }
  }
  return notes;
}

function formatWeights(weights: HeuristicWeights): string {
  return WEIGHT_KEYS.map((key) => `    ${key.padEnd(18)} ${weights[key].toFixed(3)}`).join('\n');
}

async function main(): Promise<void> {
  const inputPath = arg('in');
  if (!inputPath) {
    throw new Error('usage: fitValue --in tuning/features-*.jsonl [--base v10] [--lambda 1]');
  }
  const baseId = arg('base', 'v10')!;
  if (!isAlgoVersionId(baseId)) {
    throw new Error(`unknown base version: ${baseId}`);
  }
  const lambda = Number(arg('lambda', '1'));
  const base = ALGO_VERSIONS[baseId];
  const earlyEnd = Number(arg('early-end', String(base.phaseSplit?.earlyEnd ?? 0.3)));
  const lateStart = Number(arg('late-start', String(base.phaseSplit?.lateStart ?? 0.65)));

  const rows = load(inputPath);
  const early = rows.filter((row) => row.progress <= earlyEnd);
  const late = rows.filter((row) => row.progress >= lateStart);
  console.log(
    `Loaded ${rows.length} rows: ${early.length} early (≤ ${earlyEnd}), ${late.length} late (≥ ${lateStart})`,
  );
  if (early.length < 100 || late.length < 100) {
    throw new Error('not enough rows in one of the phase buckets — collect more games');
  }

  const dropped = (arg('drop') ?? DEFAULT_DROPPED.join(','))
    .split(',')
    .map((key) => key.trim())
    .filter((key): key is keyof HeuristicWeights =>
      (WEIGHT_KEYS as string[]).includes(key),
    );
  const earlyData = toDataset(early, dropped);
  const lateData = toDataset(late, dropped);
  console.log(`Dropped (no independent information): ${dropped.join(', ') || 'none'}`);
  const earlyFit = fitRidge(earlyData, lambda);
  const lateFit = fitRidge(lateData, lambda);

  // Matching v4's overall magnitude keeps the fitted vector on the scale the rest of the engine
  // expects (positionalScale, the phase piece bonus), without letting one near-zero coefficient
  // set the scale for all the others.
  const targetNorm = weightNorm(ALGO_VERSIONS.v4.weights);
  const weights = rescaleToNorm(earlyFit.weights, targetNorm);
  const weightsLate = rescaleToNorm(lateFit.weights, targetNorm);

  // The late fit is the half that carries signal: near the end, the feature vector really does
  // determine the outcome. `--late-only` keeps the base's early weights rather than replacing
  // them with coefficients the data cannot identify.
  const lateOnly = process.argv.includes('--late-only');

  const tuned: AlgoConfig = {
    ...structuredClone(base),
    id: lateOnly ? `${baseId}-fitted-late` : `${baseId}-fitted`,
    summary: lateOnly
      ? `${baseId} with late-game weights fitted by ridge regression (λ=${lambda}) on ${lateFit.rows} late rows (R² ${lateFit.rSquared.toFixed(3)}); early weights untouched.`
      : `Weights fitted by ridge regression (λ=${lambda}) on ${rows.length} self-play rows from ${inputPath}.`,
    weights: lateOnly ? base.weights : weights,
    weightsLate,
    phaseSplit: { earlyEnd, lateStart },
  };

  const outDir = join(process.cwd(), 'tuning');
  mkdirSync(outDir, { recursive: true });
  const outPath =
    arg('out') ?? join(outDir, `fitted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, `${JSON.stringify(tuned, null, 2)}\n`);

  const collinear = [...reportCollinearity(earlyData), ...reportCollinearity(lateData)];
  console.log(
    [
      '',
      `Early fit: R² = ${earlyFit.rSquared.toFixed(4)} over ${earlyFit.rows} rows`,
      formatWeights(weights),
      '',
      `Late fit:  R² = ${lateFit.rSquared.toFixed(4)} over ${lateFit.rows} rows`,
      formatWeights(weightsLate),
      '',
      earlyFit.rSquared < 0.05
        ? 'NOTE: the early fit explains almost none of the variance. Monte-Carlo returns from the\n' +
          '      opening are nearly independent of the position, so these coefficients are not\n' +
          '      identified — tune the early weights with scripts/tune.ts instead of trusting them.'
        : '',
      collinear.length > 0
        ? `Collinear pairs (ridge is holding these together, do not read their split literally):\n${[...new Set(collinear)].join('\n')}`
        : 'No feature pair exceeded |r| = 0.9.',
      '',
      `Wrote ${outPath}`,
      `Test it:  npx tsx scripts/tournament.ts --challenger-file ${outPath} --champion ${baseId} --policy greedy --seeds 400`,
    ].join('\n'),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
