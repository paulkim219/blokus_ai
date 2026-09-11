/**
 * Export v4.7 rollout-prefix states from the leaf distribution the incumbent search actually sees.
 *
 * Each row is produced by:
 *   root corpus state -> v3.7-pro MCTS leaf -> stochastic real prefix -> repeated terminal tails.
 *
 * The prefix trajectory is sampled once per row. The label is the conditional distribution of
 * incumbent continuations from the resulting prefix state, expressed in the four-seat backed-value
 * space consumed directly by MCTS. Source-game ids are retained for leak-free splits.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bitboardParamsFor, getAlgo, isAlgoVersionId } from '../src/ai/algoVersions.ts';
import { objectiveBlend, valueVector } from '../src/ai/bitboard/backup.ts';
import { createEvalContext, refreshContext } from '../src/ai/bitboard/features.ts';
import { LEAF_FEATURE_COUNT, LEAF_FEATURE_NAMES, writeLeafFeatures } from '../src/ai/bitboard/leafNetFeatures.ts';
import { V12Search, type LeafSample } from '../src/ai/bitboard/mcts.ts';
import { createOutcome, Playout } from '../src/ai/bitboard/playout.ts';
import type { Position } from '../src/ai/bitboard/position.ts';
import { SEAT_COUNT } from '../src/ai/bitboard/seats.ts';
import { seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import { setSeed } from '../src/ai/rng.ts';
import { loadCorpus, type PhaseName, type Sample } from './lib/rolloutCorpus.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name: string, fallback: number, minimum: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${name} must be >= ${minimum}`);
  return value;
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

function phaseId(phase: PhaseName): number {
  return phase === 'opening' ? 0 : phase === 'midgame' ? 1 : 2;
}

function relativeValues(
  scores: Float64Array,
  rootSeat: number,
  rankBlend: number,
  params: ReturnType<typeof bitboardParamsFor>,
  scratch: Float64Array,
): number[] {
  valueVector(
    scores,
    params.search.sigmoidScale,
    rankBlend,
    scratch,
    params.search.opponentAggregation,
  );
  return Array.from(
    { length: SEAT_COUNT },
    (_, relative) => scratch[(rootSeat + relative) % SEAT_COUNT],
  );
}

function rankBlendAtRoot(
  position: Position,
  rootSeat: number,
  params: ReturnType<typeof bitboardParamsFor>,
): number {
  const scores = new Float64Array(SEAT_COUNT);
  position.scores(scores);
  let bestOther = -Infinity;
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    if (seat !== rootSeat) bestOther = Math.max(bestOther, scores[seat]);
  }
  return objectiveBlend(
    params.search.rankBlend,
    scores[rootSeat] - bestOther,
    params.search.objectiveShift,
  );
}

function main(): void {
  const corpus = arg('corpus', 'tmp/corpus.json');
  const out = arg('out', 'ml/data/v47-tail16-values');
  const version = arg('version', 'v3.7-pro');
  const rootCount = numberArg('roots', 180, 1);
  const iterations = numberArg('iterations', 600, 16);
  const samplesPerRoot = numberArg('samples-per-root', 8, 1);
  const prefixesPerLeaf = numberArg('prefixes-per-leaf', 2, 1);
  const prefixPlies = numberArg('prefix-plies', 16, 1);
  const rolloutsPerPrefix = numberArg('rollouts-per-prefix', 24, 2);
  const seedBase = numberArg('seed-base', 47_100_000, 0);
  if (!isAlgoVersionId(version)) throw new Error(`unknown version ${version}`);

  const roots = balanced(loadCorpus(corpus), rootCount);
  const params = bitboardParamsFor(getAlgo(version));
  const features: number[] = [];
  const targets: number[] = [];
  const prefixPlayout = new Playout(params);
  const labelPlayout = new Playout(params);
  const prefixContext = createEvalContext();
  const labelContext = createEvalContext();
  prefixContext.fractionalTies = params.fractionalTerritoryTies;
  labelContext.fractionalTies = params.fractionalTerritoryTies;
  const prefixOutcome = createOutcome();
  const labelOutcome = createOutcome();
  const backedScratch = new Float64Array(SEAT_COUNT);
  const input = new Float32Array(LEAF_FEATURE_COUNT);
  let leavesSeen = 0;
  let prefixesSkippedTerminal = 0;
  const started = performance.now();

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    const position = toPosition(root.state);
    const seat = seatOf(root.player);
    if (position.turn !== seat) position.forceTurn(seat);
    const rankBlend = rankBlendAtRoot(position, seat, params);
    const search = new V12Search(params);
    const leaves: LeafSample[] = [];
    let observed = 0;
    const stride = Math.max(1, Math.floor(iterations / samplesPerRoot));
    setSeed(seedBase + rootIndex * 104729);
    search.run(position, seat, {
      iterations,
      onLeafSample: (sample) => {
        if (!sample.terminal) return;
        leavesSeen += 1;
        observed += 1;
        if (observed % stride === 0 && leaves.length < samplesPerRoot) leaves.push(sample);
      },
    });

    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex += 1) {
      const leaf = leaves[leafIndex];
      for (let prefixIndex = 0; prefixIndex < prefixesPerLeaf; prefixIndex += 1) {
        let prefixState: Position | null = null;
        setSeed(
          seedBase + 5_000_000 + rootIndex * 65537 + leafIndex * 769 + prefixIndex * 37,
        );
        prefixPlayout.run(
          leaf.position,
          prefixContext,
          leaf.phase,
          prefixOutcome,
          undefined,
          prefixPlies,
          (state) => {
            prefixState = state.clone();
            // Continue this sampling rollout only to preserve the incumbent RNG/undo path. Labels
            // are generated independently below from the cloned prefix state.
            return false;
          },
        );
        if (prefixState === null) {
          prefixesSkippedTerminal += 1;
          continue;
        }

        const sums = new Float64Array(SEAT_COUNT);
        const sums2 = new Float64Array(SEAT_COUNT * SEAT_COUNT);
        const state = prefixState as Position;
        refreshContext(labelContext, state, false);
        writeLeafFeatures(input, 0, state, labelContext, leaf.rootSeat);
        setSeed(
          seedBase + 20_000_000 + rootIndex * 131071 + leafIndex * 1543 + prefixIndex * 97,
        );
        for (let repeat = 0; repeat < rolloutsPerPrefix; repeat += 1) {
          labelPlayout.run(state, labelContext, leaf.phase, labelOutcome);
          const backed = relativeValues(
            labelOutcome.values,
            leaf.rootSeat,
            rankBlend,
            params,
            backedScratch,
          );
          for (let relative = 0; relative < SEAT_COUNT; relative += 1) {
            sums[relative] += backed[relative];
            for (let other = 0; other < SEAT_COUNT; other += 1) {
              sums2[relative * SEAT_COUNT + other] += backed[relative] * backed[other];
            }
          }
        }

        features.push(...input);
        const means = Array.from(sums, (sum) => sum / rolloutsPerPrefix);
        const covariance: number[] = [];
        for (let row = 0; row < SEAT_COUNT; row += 1) {
          for (let column = 0; column <= row; column += 1) {
            const cross = sums2[row * SEAT_COUNT + column];
            const value =
              (cross - sums[row] * sums[column] / rolloutsPerPrefix) /
              (rolloutsPerPrefix - 1);
            covariance.push(row === column ? Math.max(1e-5, value) : value);
          }
        }
        targets.push(
          root.game,
          phaseId(root.phase),
          rootIndex,
          leaf.rootSeat,
          ...means,
          ...covariance,
        );
      }
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
  const targetWidth = 18;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.x.f32`, Buffer.from(x.buffer));
  writeFileSync(`${out}.y.f32`, Buffer.from(y.buffer));
  const meta = {
    architecture: 'v4.7-real-prefix-learned-tail',
    featureCount: LEAF_FEATURE_COUNT,
    featureNames: LEAF_FEATURE_NAMES,
    targetWidth,
    targets: [
      'game', 'phase', 'root', 'perspective',
      'mean0', 'mean1', 'mean2', 'mean3',
      'cov00', 'cov10', 'cov11', 'cov20', 'cov21', 'cov22',
      'cov30', 'cov31', 'cov32', 'cov33',
    ],
    corpus,
    sourceVersion: version,
    games: new Set(roots.map((root) => root.game)).size,
    roots: roots.length,
    iterations,
    rows: y.length / targetWidth,
    samplesPerRoot,
    prefixesPerLeaf,
    prefixPlies,
    rolloutsPerPrefix,
    terminalLeafSamplesSeen: leavesSeen,
    prefixesSkippedTerminal,
    rolloutPolicy: {
      epsilon: params.search.playoutEps,
      cutoff: params.search.playoutCutoff,
      moveCap: params.search.playoutMoveCap,
    },
    targetSpace: 'backedValueVector',
    seedBase,
  };
  writeFileSync(`${out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Wrote ${out}.{x.f32,y.f32,meta.json}`);
}

main();
