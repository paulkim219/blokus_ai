import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMove,
  createInitialState,
  generateLegalMoves,
  passTurn,
} from '../src/engine/game.ts';
import { TURN_ORDER } from '../src/engine/types.ts';
import { createRng, type Rng } from '../src/ai/rng.ts';
import {
  advanceOracleInteraction,
  createOracleInteractionState,
  oracleSeat,
} from '../src/ai/oracle/interaction.ts';
import { extractOracleCandidateFeatures } from '../src/ai/oracle/styleFeatures.ts';
import {
  ORACLE_STYLE_PROTOTYPES,
  PrototypeBelief,
  softmaxStylePolicy,
  standardizeOracleFeatures,
  type OracleStylePrototype,
  type OracleStyleWeights,
  type PrototypePrediction,
} from '../src/ai/oracle/prototypeBayes.ts';
import { bootstrapCI, mean, type Interval } from './lib/stats.ts';

const STANDARDIZED = process.argv.includes('--standardized');
const GENERATOR_TEMPERATURE = 0.55;
const TEMPERATURE_ARMS = [0.25, 0.4, 0.6, 0.9, 1.3];
const TRAIN_SEED_BASE = STANDARDIZED ? 51_600_000 : 51_000_000;
const EXACT_SEED_BASE = STANDARDIZED ? 51_700_000 : 51_100_000;
const HYBRID_SEED_BASE = STANDARDIZED ? 51_800_000 : 51_200_000;
const WARMUP_OBSERVATIONS = 3;
const MAX_PLIES = 100;

interface DecisionAccumulator {
  count: number;
  adaptiveNll: number;
  fixedNll: number;
  shuffledNll: number;
  oracleNll: number;
  uniformNll: number;
  adaptiveTop1: number;
  adaptiveTop5: number;
  classificationCorrect: number;
  classificationCount: number;
}

interface DecisionMetrics {
  decisions: number;
  adaptiveNll: number;
  fixedNll: number;
  shuffledNll: number;
  oracleNll: number;
  uniformNll: number;
  adaptiveTop1: number;
  adaptiveTop5: number;
  classificationRate: number | null;
}

interface GameArmResult {
  all: DecisionMetrics;
  warm: DecisionMetrics;
}

interface GameResult {
  seed: number;
  cohort: 'exact' | 'hybrid';
  plies: number;
  styles: string[];
  arms: Record<string, GameArmResult>;
}

interface MetricSummary {
  games: number;
  decisions: number;
  adaptiveNll: number;
  fixedNll: number;
  shuffledNll: number;
  oracleNll: number;
  uniformNll: number;
  bitsSavedVsUniform: number;
  adaptiveTop1: number;
  adaptiveTop5: number;
  classificationRate: number | null;
  fixedMinusAdaptive: Interval;
  shuffledMinusAdaptive: Interval;
}

interface ArmSummary {
  temperature: number;
  all: MetricSummary;
  warm: MetricSummary;
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) {
    return fallback;
  }
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function emptyAccumulator(): DecisionAccumulator {
  return {
    count: 0,
    adaptiveNll: 0,
    fixedNll: 0,
    shuffledNll: 0,
    oracleNll: 0,
    uniformNll: 0,
    adaptiveTop1: 0,
    adaptiveTop5: 0,
    classificationCorrect: 0,
    classificationCount: 0,
  };
}

function safeNll(probability: number): number {
  return -Math.log(Math.max(1e-12, probability));
}

function mixture(byPrototype: number[][], posterior: readonly number[]): number[] {
  if (byPrototype.length === 0) {
    return [];
  }
  const count = byPrototype[0].length;
  const probabilities = Array.from({ length: count }, (_, moveIndex) =>
    byPrototype.reduce(
      (sum, policy, prototypeIndex) =>
        sum + (posterior[prototypeIndex] ?? 0) * (policy[moveIndex] ?? 0),
      0,
    ),
  );
  const total = probabilities.reduce((sum, value) => sum + value, 0) || 1;
  return probabilities.map((value) => value / total);
}

function recordDecision(
  accumulator: DecisionAccumulator,
  adaptive: number[],
  fixed: number[],
  shuffled: number[],
  oracle: number[],
  actual: number,
): void {
  accumulator.count += 1;
  accumulator.adaptiveNll += safeNll(adaptive[actual]);
  accumulator.fixedNll += safeNll(fixed[actual]);
  accumulator.shuffledNll += safeNll(shuffled[actual]);
  accumulator.oracleNll += safeNll(oracle[actual]);
  accumulator.uniformNll += Math.log(Math.max(1, adaptive.length));
  const actualProbability = adaptive[actual];
  const rank = 1 + adaptive.filter((value) => value > actualProbability + 1e-12).length;
  accumulator.adaptiveTop1 += rank === 1 ? 1 : 0;
  accumulator.adaptiveTop5 += rank <= 5 ? 1 : 0;
}

function recordClassification(
  accumulator: DecisionAccumulator,
  prediction: PrototypePrediction,
  truePrototype: number | null,
): void {
  if (truePrototype === null) {
    return;
  }
  accumulator.classificationCount += 1;
  let best = 0;
  for (let index = 1; index < prediction.posterior.length; index += 1) {
    if (prediction.posterior[index] > prediction.posterior[best]) {
      best = index;
    }
  }
  accumulator.classificationCorrect += best === truePrototype ? 1 : 0;
}

function finalise(accumulator: DecisionAccumulator): DecisionMetrics {
  const denominator = Math.max(1, accumulator.count);
  return {
    decisions: accumulator.count,
    adaptiveNll: accumulator.adaptiveNll / denominator,
    fixedNll: accumulator.fixedNll / denominator,
    shuffledNll: accumulator.shuffledNll / denominator,
    oracleNll: accumulator.oracleNll / denominator,
    uniformNll: accumulator.uniformNll / denominator,
    adaptiveTop1: accumulator.adaptiveTop1 / denominator,
    adaptiveTop5: accumulator.adaptiveTop5 / denominator,
    classificationRate:
      accumulator.classificationCount > 0
        ? accumulator.classificationCorrect / accumulator.classificationCount
        : null,
  };
}

function sampleIndex(probabilities: readonly number[], rng: Rng): number {
  const draw = rng();
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index];
    if (draw <= cumulative) {
      return index;
    }
  }
  return Math.max(0, probabilities.length - 1);
}

function averageWeights(a: OracleStyleWeights, b: OracleStyleWeights): OracleStyleWeights {
  return Object.fromEntries(
    (Object.keys(a) as Array<keyof OracleStyleWeights>).map((key) => [key, (a[key] + b[key]) / 2]),
  ) as unknown as OracleStyleWeights;
}

const HYBRID_PAIRS = [
  [1, 5],
  [2, 3],
  [4, 0],
  [3, 1],
] as const;

function gameStyles(
  gameIndex: number,
  cohort: 'exact' | 'hybrid',
  rng: Rng,
): Array<{ style: OracleStylePrototype; prototype: number | null }> {
  const exactIndices = ORACLE_STYLE_PROTOTYPES.map((_, index) => index);
  for (let index = exactIndices.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [exactIndices[index], exactIndices[swap]] = [exactIndices[swap], exactIndices[index]];
  }
  if (cohort === 'exact') {
    return exactIndices.slice(0, 4).map((prototype) => ({
      style: ORACLE_STYLE_PROTOTYPES[prototype],
      prototype,
    }));
  }

  return HYBRID_PAIRS.map(([left, right], seat) => ({
    style: {
      id: `hybrid-${ORACLE_STYLE_PROTOTYPES[left].id}-${ORACLE_STYLE_PROTOTYPES[right].id}-${gameIndex}-${seat}`,
      label: 'Unseen hybrid',
      weights: averageWeights(
        ORACLE_STYLE_PROTOTYPES[left].weights,
        ORACLE_STYLE_PROTOTYPES[right].weights,
      ),
    },
    prototype: null,
  }));
}

function createBeliefs(temperature: number): PrototypeBelief[] {
  return TURN_ORDER.map(
    () =>
      new PrototypeBelief(ORACLE_STYLE_PROTOTYPES, {
        temperature,
        learningRate: 0.7,
        drift: 0.02,
        actionFloor: 0.01,
        standardizeFeatures: STANDARDIZED,
      }),
  );
}

function runGame(
  seed: number,
  gameIndex: number,
  cohort: 'exact' | 'hybrid',
  temperatures: readonly number[],
): GameResult {
  const rng = createRng(seed);
  const styles = gameStyles(gameIndex, cohort, rng);
  const arms = temperatures.map((temperature) => ({
    temperature,
    beliefs: createBeliefs(temperature),
    all: emptyAccumulator(),
    warm: emptyAccumulator(),
  }));
  let interaction = createOracleInteractionState();
  let state = createInitialState();
  let plies = 0;

  while (!state.finished && plies < MAX_PLIES) {
    const source = oracleSeat(state.currentTurn);
    const moves = generateLegalMoves(state, state.currentTurn);
    if (moves.length === 0) {
      state = passTurn(state);
      interaction = advanceOracleInteraction(interaction, null);
      plies += 1;
      continue;
    }

    const features = extractOracleCandidateFeatures(state, moves, interaction);
    const generatorFeatures = STANDARDIZED ? standardizeOracleFeatures(features) : features;
    const actualStyle = styles[source];
    const oraclePolicy = softmaxStylePolicy(
      generatorFeatures,
      actualStyle.style,
      GENERATOR_TEMPERATURE,
      0.01,
    );
    const actual = sampleIndex(oraclePolicy, rng);

    for (const arm of arms) {
      const belief = arm.beliefs[source];
      const adaptive = belief.predictFromFeatures(features);
      const fixed = mixture(adaptive.byPrototype, belief.prior);
      const shuffledPosterior = arm.beliefs[(source + 1) % TURN_ORDER.length].posterior();
      const shuffled = mixture(adaptive.byPrototype, shuffledPosterior);
      recordDecision(
        arm.all,
        adaptive.probabilities,
        fixed,
        shuffled,
        oraclePolicy,
        actual,
      );
      const warmed = belief.observations >= WARMUP_OBSERVATIONS;
      if (warmed) {
        recordDecision(
          arm.warm,
          adaptive.probabilities,
          fixed,
          shuffled,
          oraclePolicy,
          actual,
        );
      }
      belief.observe(adaptive, actual);
      const updated: PrototypePrediction = { ...adaptive, posterior: belief.posterior() };
      recordClassification(arm.all, updated, actualStyle.prototype);
      if (warmed) {
        recordClassification(arm.warm, updated, actualStyle.prototype);
      }
    }

    const move = moves[actual];
    interaction = advanceOracleInteraction(interaction, features[actual]);
    state = applyMove(state, move);
    plies += 1;
  }

  return {
    seed,
    cohort,
    plies,
    styles: styles.map((entry) => entry.style.id),
    arms: Object.fromEntries(
      arms.map((arm) => [
        String(arm.temperature),
        { all: finalise(arm.all), warm: finalise(arm.warm) },
      ]),
    ),
  };
}

function runCohort(
  games: number,
  seedBase: number,
  cohort: 'exact' | 'hybrid',
  temperatures: readonly number[],
): GameResult[] {
  const results: GameResult[] = [];
  const started = Date.now();
  for (let game = 0; game < games; game += 1) {
    results.push(runGame(seedBase + game, game, cohort, temperatures));
    if ((game + 1) % 10 === 0 || game + 1 === games) {
      process.stdout.write(
        `\r  ${cohort} ${game + 1}/${games} games  ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
  }
  process.stdout.write('\n');
  return results;
}

function summarizeMetric(
  games: GameResult[],
  temperature: number,
  scope: 'all' | 'warm',
): MetricSummary {
  const rows = games.map((game) => game.arms[String(temperature)][scope]);
  const decisions = rows.reduce((sum, row) => sum + row.decisions, 0);
  const weighted = (field: keyof DecisionMetrics): number =>
    rows.reduce((sum, row) => sum + Number(row[field] ?? 0) * row.decisions, 0) /
    Math.max(1, decisions);
  const fixedDeltas = rows.map((row) => row.fixedNll - row.adaptiveNll);
  const shuffledDeltas = rows.map((row) => row.shuffledNll - row.adaptiveNll);
  const classificationRows = rows.filter((row) => row.classificationRate !== null);
  const classificationRate =
    classificationRows.length > 0
      ? mean(classificationRows.map((row) => row.classificationRate ?? 0))
      : null;
  const adaptiveNll = weighted('adaptiveNll');
  const uniformNll = weighted('uniformNll');

  return {
    games: games.length,
    decisions,
    adaptiveNll,
    fixedNll: weighted('fixedNll'),
    shuffledNll: weighted('shuffledNll'),
    oracleNll: weighted('oracleNll'),
    uniformNll,
    bitsSavedVsUniform: (uniformNll - adaptiveNll) / Math.log(2),
    adaptiveTop1: weighted('adaptiveTop1'),
    adaptiveTop5: weighted('adaptiveTop5'),
    classificationRate,
    fixedMinusAdaptive: bootstrapCI(fixedDeltas, 4000, 51_500_001),
    shuffledMinusAdaptive: bootstrapCI(shuffledDeltas, 4000, 51_500_002),
  };
}

function summarizeArms(games: GameResult[], temperatures: readonly number[]): ArmSummary[] {
  return temperatures.map((temperature) => ({
    temperature,
    all: summarizeMetric(games, temperature, 'all'),
    warm: summarizeMetric(games, temperature, 'warm'),
  }));
}

function printSummary(label: string, summary: MetricSummary): void {
  const fixed = summary.fixedMinusAdaptive;
  const shuffled = summary.shuffledMinusAdaptive;
  console.log(
    `${label}: adaptive NLL ${summary.adaptiveNll.toFixed(3)}, ` +
      `fixed gain ${fixed.mean.toFixed(3)} [${fixed.low.toFixed(3)}, ${fixed.high.toFixed(3)}], ` +
      `shuffle gain ${shuffled.mean.toFixed(3)} [${shuffled.low.toFixed(3)}, ${shuffled.high.toFixed(3)}], ` +
      `top-5 ${(summary.adaptiveTop5 * 100).toFixed(1)}%, ` +
      `class ${summary.classificationRate === null ? 'n/a' : `${(summary.classificationRate * 100).toFixed(1)}%`}`,
  );
}

async function main(): Promise<void> {
  const trainGames = arg('train-games', 24);
  const holdoutGames = arg('holdout-games', 80);
  const hybridGames = arg('hybrid-games', 80);
  console.log(
    `Oracle Prototype Bayes${STANDARDIZED ? ' v2 standardized' : ''} preregistered experiment\n` +
      `train ${trainGames}, exact holdout ${holdoutGames}, hybrid holdout ${hybridGames}\n`,
  );

  const trainingGames = runCohort(trainGames, TRAIN_SEED_BASE, 'exact', TEMPERATURE_ARMS);
  const training = summarizeArms(trainingGames, TEMPERATURE_ARMS);
  const selected = [...training].sort((a, b) => a.warm.adaptiveNll - b.warm.adaptiveNll)[0];
  console.log(`selected temperature ${selected.temperature} on game-disjoint training NLL`);

  const exactGames = runCohort(
    holdoutGames,
    EXACT_SEED_BASE,
    'exact',
    [selected.temperature],
  );
  const hybridHoldoutGames = runCohort(
    hybridGames,
    HYBRID_SEED_BASE,
    'hybrid',
    [selected.temperature],
  );
  const exact = summarizeArms(exactGames, [selected.temperature])[0];
  const hybrid = summarizeArms(hybridHoldoutGames, [selected.temperature])[0];
  printSummary('exact holdout warm', exact.warm);
  printSummary('hybrid holdout warm', hybrid.warm);

  const exactPass =
    exact.warm.fixedMinusAdaptive.low > 0.05 &&
    exact.warm.shuffledMinusAdaptive.low > 0.03 &&
    (exact.warm.classificationRate ?? 0) > 0.45;
  const hybridPass =
    hybrid.warm.fixedMinusAdaptive.low > 0 &&
    hybrid.warm.shuffledMinusAdaptive.low > 0;
  const result = {
    experiment: STANDARDIZED
      ? 'v5-oracle-prototype-bayes-v2-standardized'
      : 'v5-oracle-prototype-bayes',
    preregistration: 'research_paper/v5_oracle_foundation.md',
    finishedAt: new Date().toISOString(),
    configuration: {
      trainGames,
      holdoutGames,
      hybridGames,
      trainingSeedBase: TRAIN_SEED_BASE,
      exactSeedBase: EXACT_SEED_BASE,
      hybridSeedBase: HYBRID_SEED_BASE,
      generatorTemperature: GENERATOR_TEMPERATURE,
      temperatureArms: TEMPERATURE_ARMS,
      selectedTemperature: selected.temperature,
      warmupObservations: WARMUP_OBSERVATIONS,
      standardizeFeatures: STANDARDIZED,
    },
    training,
    exact,
    hybrid,
    gates: {
      exactPass,
      hybridPass,
      experimentAPass: exactPass && hybridPass,
    },
  };
  const output = join(
    process.cwd(),
    'selfplay-results',
    STANDARDIZED
      ? 'v5-oracle-prototype-bayes-v2.json'
      : 'v5-oracle-prototype-bayes.json',
  );
  mkdirSync(join(process.cwd(), 'selfplay-results'), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${result.gates.experimentAPass ? 'PASS' : 'FAIL'} experiment A`);
  console.log(`wrote ${output}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
