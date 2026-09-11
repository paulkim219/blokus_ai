/**
 * Export a small game-disjoint V_pi dataset for the distributional leaf-value pilot.
 *
 * Each source position receives multiple independent terminal rollouts under the incumbent policy.
 * The stored targets are the empirical mean and variance of the four seat-relative score margins.
 * Four feature rows (one perspective per seat) share those rollouts, which is augmentation rather
 * than four independent observations; the trainer therefore splits and reports by source game.
 *
 *   npx tsx scripts/exportLeafValuePilot.ts --corpus tmp/corpus.json \
 *     --out ml/data/v46-leaf-pilot --positions 240 --rollouts 64
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bitboardParamsFor, getAlgo } from '../src/ai/algoVersions.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { FEATURE_COUNT, FEATURE_NAMES, writeFeatures } from '../src/ai/bitboard/netFeatures.ts';
import { createOutcome, Playout } from '../src/ai/bitboard/playout.ts';
import { SEAT_COUNT } from '../src/ai/bitboard/seats.ts';
import { setSeed } from '../src/ai/rng.ts';
import { loadCorpus, type PhaseName, type Sample } from './lib/rolloutCorpus.ts';
import { seatOf, toPosition } from '../src/ai/bitboard/index.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name: string, fallback: number, minimum: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`--${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function phaseId(phase: PhaseName): number {
  return phase === 'opening' ? 0 : phase === 'midgame' ? 1 : 2;
}

function balanced(samples: Sample[], count: number): Sample[] {
  const phases: PhaseName[] = ['opening', 'midgame', 'endgame'];
  const picked: Sample[] = [];
  for (let p = 0; p < phases.length; p += 1) {
    const candidates = samples.filter((sample) => sample.phase === phases[p]);
    const target = Math.min(candidates.length, Math.floor(count / 3) + (p < count % 3 ? 1 : 0));
    const step = candidates.length / Math.max(1, target);
    for (let i = 0; i < target; i += 1) {
      picked.push(candidates[Math.min(candidates.length - 1, Math.floor(i * step))]);
    }
  }
  if (picked.length < count) {
    const selected = new Set(picked);
    picked.push(...samples.filter((sample) => !selected.has(sample)).slice(0, count - picked.length));
  }
  return picked;
}

function margin(scores: Float64Array, seat: number): number {
  let others = 0;
  for (let opponent = 0; opponent < SEAT_COUNT; opponent += 1) {
    if (opponent !== seat) others += scores[opponent];
  }
  return scores[seat] - others / (SEAT_COUNT - 1);
}

function main(): void {
  const corpusPath = arg('corpus', 'tmp/corpus.json');
  const out = arg('out', 'ml/data/v46-leaf-pilot');
  const positions = numberArg('positions', 240, 1);
  const rollouts = numberArg('rollouts', 64, 2);
  const seedBase = numberArg('seed-base', 46_200_000, 0);
  const all = loadCorpus(corpusPath);
  const samples = balanced(all, Math.min(positions, all.length));
  const params = bitboardParamsFor(getAlgo('v3.2-pro'));
  const playout = new Playout(params);
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  const outcome = createOutcome();
  const input = new Float32Array(FEATURE_COUNT);
  const x = new Float32Array(samples.length * SEAT_COUNT * FEATURE_COUNT);
  // game, phase, source-position, perspective, then 4 means and 4 variances.
  const targetWidth = 12;
  const y = new Float32Array(samples.length * SEAT_COUNT * targetWidth);
  const sums = new Float64Array(SEAT_COUNT);
  const sums2 = new Float64Array(SEAT_COUNT);
  const started = performance.now();

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const position = toPosition(sample.state);
    const mover = seatOf(sample.player);
    if (position.turn !== mover) position.forceTurn(mover);
    refreshContext(context, position, false);
    const phase = detectPhase(position, context, params, mover);
    sums.fill(0);
    sums2.fill(0);
    setSeed(seedBase + index * 104729);
    for (let r = 0; r < rollouts; r += 1) {
      playout.run(position, context, phase, outcome);
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        const value = margin(outcome.values, seat);
        sums[seat] += value;
        sums2[seat] += value * value;
      }
    }

    for (let perspective = 0; perspective < SEAT_COUNT; perspective += 1) {
      const row = index * SEAT_COUNT + perspective;
      writeFeatures(input, 0, position, context, perspective);
      x.set(input, row * FEATURE_COUNT);
      const offset = row * targetWidth;
      y[offset] = sample.game;
      y[offset + 1] = phaseId(sample.phase);
      y[offset + 2] = index;
      y[offset + 3] = perspective;
      for (let relative = 0; relative < SEAT_COUNT; relative += 1) {
        const seat = (perspective + relative) % SEAT_COUNT;
        const empiricalMean = sums[seat] / rollouts;
        const empiricalVariance = Math.max(
          1e-3,
          (sums2[seat] - sums[seat] * sums[seat] / rollouts) / (rollouts - 1),
        );
        y[offset + 4 + relative] = empiricalMean;
        y[offset + 8 + relative] = empiricalVariance;
      }
    }
    if ((index + 1) % 20 === 0 || index + 1 === samples.length) {
      console.log(
        `${index + 1}/${samples.length} positions ` +
          `(${((performance.now() - started) / 1000).toFixed(1)}s)`,
      );
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.x.f32`, Buffer.from(x.buffer));
  writeFileSync(`${out}.y.f32`, Buffer.from(y.buffer));
  const meta = {
    featureCount: FEATURE_COUNT,
    featureNames: FEATURE_NAMES,
    targetWidth,
    targets: [
      'game', 'phase', 'position', 'perspective',
      'mean0', 'mean1', 'mean2', 'mean3',
      'variance0', 'variance1', 'variance2', 'variance3',
    ],
    corpus: corpusPath,
    games: [...new Set(samples.map((sample) => sample.game))].length,
    positions: samples.length,
    rows: samples.length * SEAT_COUNT,
    rolloutsPerPosition: rollouts,
    rolloutPolicy: { version: 'v3.2-pro', epsilon: params.search.playoutEps },
    phaseCounts: Object.fromEntries(
      (['opening', 'midgame', 'endgame'] as const).map((phase) => [
        phase,
        samples.filter((sample) => sample.phase === phase).length,
      ]),
    ),
  };
  writeFileSync(`${out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Wrote ${out}.{x.f32,y.f32,meta.json}`);
}

main();
