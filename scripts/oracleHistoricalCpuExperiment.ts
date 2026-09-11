import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_ORDER } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import type { AlgoVersionId } from '../src/ai/algoVersions.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';
import type { OracleProbeMetrics } from '../src/ai/oracle/probe.ts';
import {
  GamePool,
  defaultWorkerCount,
  type GameAssignment,
  type GameOutcome,
} from './lib/pool.ts';
import { bootstrapCI, mean, type Interval } from './lib/stats.ts';

const ENGINES: AlgoVersionId[] = ['v1', 'v2-pro', 'v3.1', 'v3.2', 'v3.7', 'v4.1'];
const STANDARDIZED = process.argv.includes('--standardized');
const SEED_BASE = STANDARDIZED ? 51_400_000 : 51_300_000;
const TEMPERATURE = 0.6;
const WARMUP_OBSERVATIONS = 3;

interface Summary {
  seeds: number;
  games: number;
  decisions: number;
  adaptiveNll: number;
  fixedNll: number;
  shuffledNll: number;
  uniformNll: number;
  bitsSavedVsUniform: number;
  adaptiveTop1: number;
  adaptiveTop5: number;
  fixedMinusAdaptive: Interval;
  shuffledMinusAdaptive: Interval;
  missingPlayedActions: number;
  byEngine: Record<string, OracleProbeMetrics>;
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) {
    return fallback;
  }
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function assignments(seeds: number, iterations: number): GameAssignment[] {
  const result: GameAssignment[] = [];
  const policies = Object.fromEntries(TURN_ORDER.map((color) => [color, 'mcts-bench'])) as Record<
    PlayerColor,
    PolicyId
  >;
  for (let seedIndex = 0; seedIndex < seeds; seedIndex += 1) {
    const seed = SEED_BASE + seedIndex;
    const lineup = Array.from({ length: 4 }, (_, offset) =>
      ENGINES[(seedIndex + offset) % ENGINES.length],
    );
    for (let rotation = 0; rotation < TURN_ORDER.length; rotation += 1) {
      const seatVersions = Object.fromEntries(
        TURN_ORDER.map((color, seat) => [color, lineup[(seat + rotation) % lineup.length]]),
      ) as Record<PlayerColor, AlgoVersionId>;
      result.push({
        id: `${seed}:${rotation}`,
        seatVersions,
        seatPolicies: policies,
        seed,
        iterationBudget: iterations,
        openingRandomPlies: 8,
        openingTopK: 3,
        oracleProbe: {
          temperature: TEMPERATURE,
          warmupObservations: WARMUP_OBSERVATIONS,
          standardizeFeatures: STANDARDIZED,
        },
      });
    }
  }
  return result;
}

function weightedMetric(rows: OracleProbeMetrics[], key: keyof OracleProbeMetrics): number {
  const decisions = rows.reduce((sum, row) => sum + row.decisions, 0);
  return (
    rows.reduce((sum, row) => sum + Number(row[key]) * row.decisions, 0) /
    Math.max(1, decisions)
  );
}

function summarize(outcomes: GameOutcome[], requestedSeeds: number): Summary {
  const usable = outcomes.filter((outcome) => !outcome.error && outcome.oracleProbe);
  const rows = usable.map((outcome) => outcome.oracleProbe!.warm);
  const bySeed = new Map<number, OracleProbeMetrics[]>();
  for (const outcome of usable) {
    const seed = Number(outcome.id.split(':')[0]);
    const bucket = bySeed.get(seed) ?? [];
    bucket.push(outcome.oracleProbe!.warm);
    bySeed.set(seed, bucket);
  }
  const perSeedFixed = [...bySeed.values()].map((bucket) =>
    mean(bucket.map((row) => row.fixedNll - row.adaptiveNll)),
  );
  const perSeedShuffled = [...bySeed.values()].map((bucket) =>
    mean(bucket.map((row) => row.shuffledNll - row.adaptiveNll)),
  );
  const byEngineRows = new Map<string, OracleProbeMetrics[]>();
  for (const outcome of usable) {
    for (const [engine, metrics] of Object.entries(outcome.oracleProbe!.byLabel)) {
      const bucket = byEngineRows.get(engine) ?? [];
      bucket.push(metrics);
      byEngineRows.set(engine, bucket);
    }
  }
  const byEngine = Object.fromEntries(
    [...byEngineRows.entries()].map(([engine, engineRows]) => [
      engine,
      {
        decisions: engineRows.reduce((sum, row) => sum + row.decisions, 0),
        adaptiveNll: weightedMetric(engineRows, 'adaptiveNll'),
        fixedNll: weightedMetric(engineRows, 'fixedNll'),
        shuffledNll: weightedMetric(engineRows, 'shuffledNll'),
        uniformNll: weightedMetric(engineRows, 'uniformNll'),
        adaptiveTop1: weightedMetric(engineRows, 'adaptiveTop1'),
        adaptiveTop5: weightedMetric(engineRows, 'adaptiveTop5'),
      },
    ]),
  );
  const adaptiveNll = weightedMetric(rows, 'adaptiveNll');
  const uniformNll = weightedMetric(rows, 'uniformNll');
  return {
    seeds: Math.min(requestedSeeds, bySeed.size),
    games: usable.length,
    decisions: rows.reduce((sum, row) => sum + row.decisions, 0),
    adaptiveNll,
    fixedNll: weightedMetric(rows, 'fixedNll'),
    shuffledNll: weightedMetric(rows, 'shuffledNll'),
    uniformNll,
    bitsSavedVsUniform: (uniformNll - adaptiveNll) / Math.log(2),
    adaptiveTop1: weightedMetric(rows, 'adaptiveTop1'),
    adaptiveTop5: weightedMetric(rows, 'adaptiveTop5'),
    fixedMinusAdaptive: bootstrapCI(perSeedFixed, 4000, 51_500_101),
    shuffledMinusAdaptive: bootstrapCI(perSeedShuffled, 4000, 51_500_102),
    missingPlayedActions: usable.reduce(
      (sum, outcome) => sum + outcome.oracleProbe!.missingPlayedActions,
      0,
    ),
    byEngine,
  };
}

async function main(): Promise<void> {
  const seeds = arg('seeds', 12);
  const iterations = arg('iterations', 60);
  const workers = arg('workers', defaultWorkerCount());
  const work = assignments(seeds, iterations);
  console.log(
    `Oracle historical-CPU${STANDARDIZED ? ' v2 standardized' : ''} prediction gate\n` +
      `${ENGINES.join(', ')}\n` +
      `${seeds} seeds × 4 rotations = ${work.length} games, ${iterations} base iterations, ${workers} workers\n`,
  );
  const pool = new GamePool(workers);
  const started = Date.now();
  let outcomes: GameOutcome[];
  try {
    outcomes = await pool.run(work, (outcome, done, total) => {
      if (outcome.error) {
        console.error(`game ${outcome.id} failed: ${outcome.error}`);
      }
      if (done % 4 === 0 || done === total) {
        process.stdout.write(
          `\r  ${done}/${total} games  ${((Date.now() - started) / 1000).toFixed(0)}s`,
        );
      }
    });
  } finally {
    pool.close();
  }
  process.stdout.write('\n');
  const summary = summarize(outcomes, seeds);
  const pass =
    summary.games === work.length &&
    summary.fixedMinusAdaptive.low > 0 &&
    summary.shuffledMinusAdaptive.low > 0 &&
    summary.missingPlayedActions === 0;
  const output = {
    experiment: STANDARDIZED
      ? 'v5-oracle-historical-cpu-v2-standardized'
      : 'v5-oracle-historical-cpu',
    preregistration: 'research_paper/v5_oracle_foundation.md',
    finishedAt: new Date().toISOString(),
    configuration: {
      engines: ENGINES,
      seedBase: SEED_BASE,
      seeds,
      rotationsPerSeed: 4,
      iterations,
      temperature: TEMPERATURE,
      warmupObservations: WARMUP_OBSERVATIONS,
      standardizeFeatures: STANDARDIZED,
    },
    summary,
    gate: { pass },
  };
  const path = join(
    process.cwd(),
    'selfplay-results',
    STANDARDIZED
      ? 'v5-oracle-historical-cpu-v2.json'
      : 'v5-oracle-historical-cpu.json',
  );
  mkdirSync(join(process.cwd(), 'selfplay-results'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `adaptive NLL ${summary.adaptiveNll.toFixed(3)}; ` +
      `fixed gain ${summary.fixedMinusAdaptive.mean.toFixed(3)} ` +
      `[${summary.fixedMinusAdaptive.low.toFixed(3)}, ${summary.fixedMinusAdaptive.high.toFixed(3)}]; ` +
      `shuffle gain ${summary.shuffledMinusAdaptive.mean.toFixed(3)} ` +
      `[${summary.shuffledMinusAdaptive.low.toFixed(3)}, ${summary.shuffledMinusAdaptive.high.toFixed(3)}]`,
  );
  console.log(`${pass ? 'PASS' : 'FAIL'} historical-CPU gate`);
  console.log(`wrote ${path}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
