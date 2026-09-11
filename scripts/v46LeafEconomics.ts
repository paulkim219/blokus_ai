/**
 * E9/E18 — price the learned-leaf channel before training another network.
 *
 * Measures three quantities on a shared, game-tagged corpus:
 *
 *  1. Conditional terminal-rollout variance by phase. This is the irreducible noise a value model
 *     can remove (or, for a distributional model, must reproduce deliberately).
 *  2. Raw rollout cost versus feature extraction + the existing MLP forward pass.
 *  3. End-to-end MCTS throughput with full rollouts versus deterministic MLP leaf replacement.
 *
 * The existing v4 weights are intentionally used only as a timing payload. Their prediction quality
 * is irrelevant here; the search benchmark answers whether an MLP of this shape can buy enough
 * additional iterations to make the channel worth pursuing.
 *
 *   npx tsx scripts/v46LeafEconomics.ts --positions 120 --rollouts 64 --repeats 5
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { bitboardParamsFor, getAlgo } from '../src/ai/algoVersions.ts';
import { objectiveBlend, valueVector } from '../src/ai/bitboard/backup.ts';
import { withOverrides, type BitboardParams, type PhaseId } from '../src/ai/bitboard/config.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { V12Search } from '../src/ai/bitboard/mcts.ts';
import { forward, loadNet, netFor, type Net } from '../src/ai/bitboard/net.ts';
import { FEATURE_COUNT, writeFeatures } from '../src/ai/bitboard/netFeatures.ts';
import { createOutcome, Playout } from '../src/ai/bitboard/playout.ts';
import { SEAT_COUNT } from '../src/ai/bitboard/seats.ts';
import { setSeed } from '../src/ai/rng.ts';
import { loadCorpus, type PhaseName, type Sample } from './lib/rolloutCorpus.ts';
import { preloadNets } from './lib/netPreload.ts';
import { seatOf, toPosition } from '../src/ai/bitboard/index.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name: string, fallback: number, minimum: number): number {
  const parsed = Number(arg(name, String(fallback)));
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be a finite number >= ${minimum}`);
  }
  return parsed;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function margin(scores: Float64Array, seat: number): number {
  let opponents = 0;
  for (let other = 0; other < SEAT_COUNT; other += 1) {
    if (other !== seat) opponents += scores[other];
  }
  return scores[seat] - opponents / (SEAT_COUNT - 1);
}

interface VarianceRow {
  phase: PhaseName;
  rawVariance: number;
  valueVariance: number;
  rawMean: number;
  valueMean: number;
}

function summariseVariance(rows: VarianceRow[]): Record<string, unknown> {
  const summarise = (picked: VarianceRow[]) =>
    picked.length === 0
      ? { positions: 0 }
      : {
          positions: picked.length,
          conditionalRawSd: Math.sqrt(mean(picked.map((row) => row.rawVariance))),
          conditionalValueSd: Math.sqrt(mean(picked.map((row) => row.valueVariance))),
          betweenPositionRawSd: Math.sqrt(sampleVariance(picked.map((row) => row.rawMean))),
          betweenPositionValueSd: Math.sqrt(sampleVariance(picked.map((row) => row.valueMean))),
        };
  return {
    all: summarise(rows),
    opening: summarise(rows.filter((row) => row.phase === 'opening')),
    midgame: summarise(rows.filter((row) => row.phase === 'midgame')),
    endgame: summarise(rows.filter((row) => row.phase === 'endgame')),
  };
}

function selectGameSpread(samples: Sample[], count: number): Sample[] {
  if (samples.length <= count) return samples;
  const selected: Sample[] = [];
  const phases: PhaseName[] = ['opening', 'midgame', 'endgame'];
  const quota = Math.floor(count / phases.length);
  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
    const phase = phases[phaseIndex];
    const target = quota + (phaseIndex < count % phases.length ? 1 : 0);
    const phaseRows = samples.filter((sample) => sample.phase === phase);
    const byGame = new Map<number, Sample[]>();
    for (const sample of phaseRows) {
      const rows = byGame.get(sample.game) ?? [];
      rows.push(sample);
      byGame.set(sample.game, rows);
    }
    const games = [...byGame.keys()].sort((a, b) => a - b);
    let offset = 0;
    let added = true;
    while (selected.filter((sample) => sample.phase === phase).length < target && added) {
      added = false;
      for (const game of games) {
        const rows = byGame.get(game)!;
        if (offset < rows.length) {
          selected.push(rows[offset]);
          added = true;
          if (selected.filter((sample) => sample.phase === phase).length === target) break;
        }
      }
      offset += 1;
    }
  }
  if (selected.length < count) {
    const chosen = new Set(selected);
    selected.push(...samples.filter((sample) => !chosen.has(sample)).slice(0, count - selected.length));
  }
  return selected;
}

function backedValue(
  scores: Float64Array,
  params: BitboardParams,
  seat: number,
  scratch: Float64Array,
): number {
  const blend = objectiveBlend(params.search.rankBlend, 0, params.search.objectiveShift);
  valueVector(
    scores,
    params.search.sigmoidScale,
    blend,
    scratch,
    params.search.opponentAggregation,
  );
  return scratch[seat];
}

function measureRollouts(
  samples: Sample[],
  params: BitboardParams,
  rollouts: number,
  seedBase: number,
): { elapsedMs: number; rows: VarianceRow[] } {
  const playout = new Playout(params);
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  const outcome = createOutcome();
  const scratch = new Float64Array(SEAT_COUNT);
  const rows: VarianceRow[] = [];
  const started = performance.now();

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const position = toPosition(sample.state);
    const seat = seatOf(sample.player);
    if (position.turn !== seat) position.forceTurn(seat);
    refreshContext(context, position, false);
    const phase: PhaseId = detectPhase(position, context, params, seat);
    const raw: number[] = [];
    const values: number[] = [];
    setSeed(seedBase + index * 104729);
    for (let repeat = 0; repeat < rollouts; repeat += 1) {
      playout.run(position, context, phase, outcome);
      raw.push(margin(outcome.values, seat));
      values.push(backedValue(outcome.values, params, seat, scratch));
    }
    rows.push({
      phase: sample.phase,
      rawVariance: sampleVariance(raw),
      valueVariance: sampleVariance(values),
      rawMean: mean(raw),
      valueMean: mean(values),
    });
  }
  return { elapsedMs: performance.now() - started, rows };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function syntheticNet(widths: number[]): Net {
  let input = FEATURE_COUNT;
  const layers = widths.map((output, layerIndex) => {
    const weights = new Array<number>(input * output);
    for (let i = 0; i < weights.length; i += 1) {
      // Non-zero deterministic values prevent an engine from constant-folding a degenerate pass.
      weights[i] = ((i * 17 + layerIndex * 13) % 31 - 15) * 1e-3;
    }
    const layer = {
      w: weights,
      b: new Array<number>(output).fill(0),
      gamma: new Array<number>(output).fill(1),
      beta: new Array<number>(output).fill(0),
      in: input,
      out: output,
    };
    input = output;
    return layer;
  });
  return loadNet({
    featureCount: FEATURE_COUNT,
    mean: new Array<number>(FEATURE_COUNT).fill(0),
    scale: new Array<number>(FEATURE_COUNT).fill(1),
    layers,
    head: {
      w: new Array<number>(input * SEAT_COUNT).fill(0.01),
      b: new Array<number>(SEAT_COUNT).fill(0),
    },
  });
}

function benchmarkFeatureNet(samples: Sample[], params: BitboardParams, loops: number): Record<string, unknown> {
  const path = 'ml/v4-weights.json';
  const net = netFor(path);
  if (!net) throw new Error(`${path} is not registered`);
  const tiny = syntheticNet([64, 32]);
  const medium = syntheticNet([128, 64, 32]);
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  const input = new Float32Array(FEATURE_COUNT);
  const prepared = samples.map((sample) => ({
    position: toPosition(sample.state),
    seat: seatOf(sample.player),
  }));

  const timeCalls = (run: (position: ReturnType<typeof toPosition>, seat: number) => void) => {
    const timings: number[] = [];
    for (let loop = 0; loop < loops; loop += 1) {
      for (const { position, seat } of prepared) {
        const started = performance.now();
        run(position, seat);
        timings.push(performance.now() - started);
      }
    }
    return {
      calls: timings.length,
      meanMicros: mean(timings) * 1000,
      medianMicros: percentile(timings, 0.5) * 1000,
      p95Micros: percentile(timings, 0.95) * 1000,
    };
  };

  // Warm every implementation before taking small-call timings.
  for (const { position, seat } of prepared) {
    refreshContext(context, position, false);
    writeFeatures(input, 0, position, context, seat);
    forward(net, input);
    forward(medium, input);
    forward(tiny, input);
  }

  const refresh = timeCalls((position) => refreshContext(context, position, false));
  for (const { position } of prepared) refreshContext(context, position, false);
  const features = timeCalls((position, seat) => writeFeatures(input, 0, position, context, seat));
  const existingForward = timeCalls(() => { forward(net, input); });
  const mediumForward = timeCalls(() => { forward(medium, input); });
  const tinyForward = timeCalls(() => { forward(tiny, input); });
  const endToEndExisting = timeCalls((position, seat) => {
    refreshContext(context, position, false);
    writeFeatures(input, 0, position, context, seat);
    forward(net, input);
  });
  const endToEndTiny = timeCalls((position, seat) => {
    refreshContext(context, position, false);
    writeFeatures(input, 0, position, context, seat);
    forward(tiny, input);
  });

  return {
    refreshContext: refresh,
    writeFeatures: features,
    existingForward,
    medium128x64x32Forward: mediumForward,
    tiny64x32Forward: tinyForward,
    endToEndExisting,
    endToEndTiny,
  };
}

function benchmarkSearch(
  samples: Sample[],
  base: BitboardParams,
  iterations: number,
  repeats: number,
): Record<string, unknown> {
  const netParams = withOverrides(base, {
    search: {
      netPath: 'ml/v4-weights.json',
      netBlend: 1,
      netOutputKind: 'meanMargins',
      netPrior: false,
      pooledNetPath: undefined,
    },
  });
  const arms = [
    { name: 'fullRollout', params: base },
    { name: 'existingMlpReplacement', params: netParams },
  ];
  const elapsed: Record<string, number[]> = Object.fromEntries(arms.map((arm) => [arm.name, []]));
  const fixtureCount = Math.min(9, samples.length);
  const fixtures = selectGameSpread(samples, fixtureCount);

  // Warm both paths before timing JIT-compiled JavaScript.
  for (const arm of arms) {
    const sample = fixtures[0];
    const position = toPosition(sample.state);
    const seat = seatOf(sample.player);
    if (position.turn !== seat) position.forceTurn(seat);
    setSeed(91_000_000);
    new V12Search(arm.params).run(position, seat, { iterations: Math.min(64, iterations) });
  }

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const ordered = repeat % 2 === 0 ? arms : [...arms].reverse();
    for (const sample of fixtures) {
      for (const arm of ordered) {
        const position = toPosition(sample.state);
        const seat = seatOf(sample.player);
        if (position.turn !== seat) position.forceTurn(seat);
        setSeed(91_100_000 + repeat * 1000 + sample.game * 31 + sample.state.moveHistory.length);
        const search = new V12Search(arm.params);
        const started = performance.now();
        search.run(position, seat, { iterations });
        elapsed[arm.name].push(performance.now() - started);
      }
    }
  }

  const full = mean(elapsed.fullRollout);
  const mlp = mean(elapsed.existingMlpReplacement);
  const speedup = full / mlp;
  return {
    iterations,
    fixtures: fixtures.length,
    repeats,
    fullRolloutMs: full,
    existingMlpReplacementMs: mlp,
    speedup,
    estimatedPointCeiling: 1.3 * Math.log2(speedup),
    samplesMs: elapsed,
  };
}

function main(): void {
  preloadNets();
  const corpusPath = arg('corpus', 'tmp/corpus.json');
  const positionCount = numberArg('positions', 120, 1);
  const rollouts = numberArg('rollouts', 64, 2);
  const repeats = numberArg('repeats', 5, 1);
  const iterations = numberArg('iterations', 300, 32);
  const seedBase = numberArg('seed-base', 46_100_000, 0);
  const outPath = arg('out', 'selfplay-results/v46-leaf-economics.json');
  const all = loadCorpus(corpusPath);
  const samples = selectGameSpread(all, positionCount);
  const params = bitboardParamsFor(getAlgo('v3.2-pro'));

  console.log(`E9: ${samples.length} positions, ${rollouts} rollouts each, ${new Set(samples.map((s) => s.game)).size} games`);
  const rollout = measureRollouts(samples, params, rollouts, seedBase);
  const variance = summariseVariance(rollout.rows);
  const rolloutMicros = rollout.elapsedMs * 1000 / (samples.length * rollouts);
  console.log(`  rollout: ${rolloutMicros.toFixed(1)} µs/sample`);
  console.log(JSON.stringify(variance, null, 2));

  const inference = benchmarkFeatureNet(samples.slice(0, Math.min(40, samples.length)), params, 20);
  const existingE2E = inference.endToEndExisting as { meanMicros: number };
  const tinyE2E = inference.endToEndTiny as { meanMicros: number };
  console.log(
    `E18: feature+existing MLP ${existingE2E.meanMicros.toFixed(1)} µs; ` +
      `feature+64x32 MLP ${tinyE2E.meanMicros.toFixed(1)} µs`,
  );

  const search = benchmarkSearch(samples, params, iterations, repeats);
  console.log(
    `Search: ${Number(search.fullRolloutMs).toFixed(1)} → ${Number(search.existingMlpReplacementMs).toFixed(1)} ms ` +
      `(${Number(search.speedup).toFixed(2)}×; ${Number(search.estimatedPointCeiling).toFixed(2)} point speed ceiling)`,
  );

  const result = {
    generatedAt: new Date().toISOString(),
    corpus: corpusPath,
    games: new Set(samples.map((sample) => sample.game)).size,
    positions: samples.length,
    rolloutsPerPosition: rollouts,
    rolloutMicros,
    variance,
    inference,
    search,
  };
  mkdirSync(outPath.slice(0, Math.max(0, outPath.lastIndexOf('/'))) || '.', { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

main();
