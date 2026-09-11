/** Export rollout samples from the states MCTS actually expands, rather than from game roots. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bitboardParamsFor, getAlgo } from '../src/ai/algoVersions.ts';
import { LEAF_FEATURE_COUNT, LEAF_FEATURE_NAMES } from '../src/ai/bitboard/leafNetFeatures.ts';
import { V12Search, type LeafSample } from '../src/ai/bitboard/mcts.ts';
import { createEvalContext } from '../src/ai/bitboard/features.ts';
import { createOutcome, Playout } from '../src/ai/bitboard/playout.ts';
import { objectiveBlend, valueVector } from '../src/ai/bitboard/backup.ts';
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
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${name} must be >= ${minimum}`);
  return value;
}

function phaseId(phase: string): number {
  return phase === 'opening' ? 0 : phase === 'midgame' ? 1 : 2;
}

function balanced(samples: Sample[], count: number): Sample[] {
  const phases: PhaseName[] = ['opening', 'midgame', 'endgame'];
  const selected: Sample[] = [];
  for (let p = 0; p < phases.length; p += 1) {
    const rows = samples.filter((sample) => sample.phase === phases[p]);
    const target = Math.min(rows.length, Math.floor(count / 3) + (p < count % 3 ? 1 : 0));
    const step = rows.length / Math.max(1, target);
    for (let i = 0; i < target; i += 1) selected.push(rows[Math.floor(i * step)]);
  }
  return selected;
}

function relativeBackedValues(
  sample: LeafSample,
  rankBlend: number,
  params: ReturnType<typeof bitboardParamsFor>,
  scratch: Float64Array,
): number[] {
  valueVector(
    sample.scores,
    params.search.sigmoidScale,
    rankBlend,
    scratch,
    params.search.opponentAggregation,
  );
  return Array.from(
    { length: SEAT_COUNT },
    (_, relative) => scratch[(sample.rootSeat + relative) % SEAT_COUNT],
  );
}

function main(): void {
  const corpus = arg('corpus', 'tmp/corpus.json');
  const out = arg('out', 'ml/data/v46-search-leaves');
  const rootCount = numberArg('roots', 180, 1);
  const iterations = numberArg('iterations', 300, 16);
  const samplesPerRoot = numberArg('samples-per-root', 12, 1);
  const rolloutsPerLeaf = numberArg('rollouts-per-leaf', 32, 2);
  const seedBase = numberArg('seed-base', 46_300_000, 0);
  const roots = balanced(loadCorpus(corpus), rootCount);
  const params = bitboardParamsFor(getAlgo('v3.2-pro'));
  const features: number[] = [];
  const targets: number[] = [];
  const playout = new Playout(params);
  const playoutContext = createEvalContext();
  playoutContext.fractionalTies = params.fractionalTerritoryTies;
  const outcome = createOutcome();
  const backedScratch = new Float64Array(SEAT_COUNT);
  let terminal = 0;
  let truncated = 0;
  const started = performance.now();

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    const position = toPosition(root.state);
    const seat = seatOf(root.player);
    if (position.turn !== seat) position.forceTurn(seat);
    const search = new V12Search(params);
    const candidates: LeafSample[] = [];
    let seen = 0;
    const stride = Math.max(1, Math.floor(iterations / samplesPerRoot));
    setSeed(seedBase + rootIndex * 104729);
    const rootScores = new Float64Array(SEAT_COUNT);
    position.scores(rootScores);
    let bestOther = -Infinity;
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other !== seat && rootScores[other] > bestOther) bestOther = rootScores[other];
    }
    const rankBlend = objectiveBlend(
      params.search.rankBlend,
      rootScores[seat] - bestOther,
      params.search.objectiveShift,
    );
    search.run(position, seat, {
      iterations,
      onLeafSample: (sample) => {
        if (!sample.terminal) {
          truncated += 1;
          return;
        }
        terminal += 1;
        seen += 1;
        if (seen % stride === 0 && candidates.length < samplesPerRoot) candidates.push(sample);
      },
    });

    for (let leafIndex = 0; leafIndex < candidates.length; leafIndex += 1) {
      const leaf = candidates[leafIndex];
      const sums = new Float64Array(SEAT_COUNT);
      const sums2 = new Float64Array(SEAT_COUNT);
      setSeed(seedBase + 10_000_000 + rootIndex * 65537 + leafIndex * 257);
      for (let repeat = 0; repeat < rolloutsPerLeaf; repeat += 1) {
        playout.run(leaf.position, playoutContext, leaf.phase, outcome);
        const margins = relativeBackedValues(
          { ...leaf, scores: outcome.values },
          rankBlend,
          params,
          backedScratch,
        );
        for (let relative = 0; relative < SEAT_COUNT; relative += 1) {
          sums[relative] += margins[relative];
          sums2[relative] += margins[relative] * margins[relative];
        }
      }
      features.push(...leaf.features);
      const means = Array.from(sums, (sum) => sum / rolloutsPerLeaf);
      const variances = Array.from(sums2, (sum2, relative) =>
        Math.max(
          1e-3,
          (sum2 - sums[relative] * sums[relative] / rolloutsPerLeaf) / (rolloutsPerLeaf - 1),
        ),
      );
      targets.push(
        root.game,
        phaseId(leaf.phase),
        rootIndex,
        leaf.rootSeat,
        ...means,
        ...variances,
      );
    }
    if ((rootIndex + 1) % 10 === 0 || rootIndex + 1 === roots.length) {
      console.log(
          `${rootIndex + 1}/${roots.length} roots; ${features.length / LEAF_FEATURE_COUNT} rows ` +
          `(${((performance.now() - started) / 1000).toFixed(1)}s)`,
      );
    }
  }

  const x = Float32Array.from(features);
  const y = Float32Array.from(targets);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.x.f32`, Buffer.from(x.buffer));
  writeFileSync(`${out}.y.f32`, Buffer.from(y.buffer));
  const meta = {
    featureCount: LEAF_FEATURE_COUNT,
    featureNames: LEAF_FEATURE_NAMES,
    targetWidth: 12,
    targets: [
      'game', 'phase', 'root', 'perspective',
      'mean0', 'mean1', 'mean2', 'mean3',
      'variance0', 'variance1', 'variance2', 'variance3',
    ],
    corpus,
    games: new Set(roots.map((root) => root.game)).size,
    roots: roots.length,
    iterations,
    rows: y.length / 12,
    samplesPerRoot,
    rolloutsPerLeaf,
    terminalSamplesSeen: terminal,
    truncatedSamplesSkipped: truncated,
    rolloutPolicy: { version: 'v3.2-pro', epsilon: params.search.playoutEps },
    targetSpace: 'backedValueVector',
  };
  writeFileSync(`${out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Wrote ${out}.{x.f32,y.f32,meta.json}`);
}

main();
