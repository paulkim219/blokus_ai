/**
 * Counterfactual terminal-return labels for the v4.1 rollout action policy.
 *
 * Root corpus state -> incumbent stochastic rollout prefix -> exact deployment candidate pool.
 * Every candidate receives repeated incumbent continuations with common random numbers. The target
 * is the mover's backed terminal value, so the student optimizes simulation quality rather than
 * imitating a search move.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bitboardParamsFor, getAlgo, isAlgoVersionId } from '../src/ai/algoVersions.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { createOutcome, Playout, sampleMoves } from '../src/ai/bitboard/playout.ts';
import {
  ROLLOUT_POLICY_FEATURE_COUNT,
  ROLLOUT_POLICY_FEATURE_NAMES,
  writeRolloutPolicyFeatures,
} from '../src/ai/bitboard/rolloutPolicy.ts';
import type { PhaseId } from '../src/ai/bitboard/config.ts';
import type { Position } from '../src/ai/bitboard/position.ts';
import { setSeed } from '../src/ai/rng.ts';
import { loadCorpus, seatValue, type PhaseName, type Sample } from './lib/rolloutCorpus.ts';

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

function phaseIndex(phase: PhaseId): number {
  return phase === 'opening' ? 0 : phase === 'midgame' ? 1 : 2;
}

function incumbentScore(move: number, phase: PhaseId, params: ReturnType<typeof bitboardParamsFor>) {
  const ordering = params.ordering[phase];
  return (
    PLACEMENTS.size[move] * ordering.pieceSize -
    PLACEMENTS.centreDistance[move] * ordering.centrePull
  );
}

function main(): void {
  const corpusPath = arg('corpus', 'tmp/corpus.json');
  const out = arg('out', 'ml/data/v41-rollout-policy');
  const version = arg('version', 'v3.7');
  const rootCount = numberArg('roots', 450, 3);
  const prefixesPerRoot = numberArg('prefixes-per-root', 2, 1);
  const prefixBase = numberArg('prefix-base', 4, 1);
  const prefixStep = numberArg('prefix-step', 12, 1);
  const continuations = numberArg('continuations', 12, 2);
  const seedBase = numberArg('seed-base', 48_100_000, 0);
  if (!isAlgoVersionId(version)) throw new Error(`unknown version ${version}`);

  const roots = balanced(loadCorpus(corpusPath), rootCount);
  const params = bitboardParamsFor(getAlgo(version));
  const prefixPlayout = new Playout(params);
  const labelPlayout = new Playout(params);
  const prefixContext = createEvalContext();
  const stateContext = createEvalContext();
  prefixContext.fractionalTies = params.fractionalTerritoryTies;
  stateContext.fractionalTies = params.fractionalTerritoryTies;
  const prefixOutcome = createOutcome();
  const labelOutcome = createOutcome();
  const candidates = new Int32Array(512);
  const feature = new Float32Array(ROLLOUT_POLICY_FEATURE_COUNT);
  const backedScratch = new Float64Array(4);
  const features: number[] = [];
  const targets: number[] = [];
  let group = 0;
  let skippedTerminal = 0;
  let skippedSmallPool = 0;
  const started = performance.now();

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    const rootPosition = toPosition(root.state);
    const rootSeat = seatOf(root.player);
    if (rootPosition.turn !== rootSeat) rootPosition.forceTurn(rootSeat);
    refreshContext(prefixContext, rootPosition, false);
    const rootPhase = detectPhase(rootPosition, prefixContext, params, rootSeat);

    for (let prefixIndex = 0; prefixIndex < prefixesPerRoot; prefixIndex += 1) {
      const prefixPlies = prefixBase + prefixIndex * prefixStep;
      let sampledState: Position | null = null;
      setSeed(seedBase + rootIndex * 104729 + prefixIndex * 1009);
      prefixPlayout.run(
        rootPosition,
        prefixContext,
        rootPhase,
        prefixOutcome,
        undefined,
        prefixPlies,
        (position) => {
          sampledState = position.clone();
          return true;
        },
      );
      if (sampledState === null) {
        skippedTerminal += 1;
        continue;
      }

      const position = sampledState as Position;
      const seat = position.turn;
      refreshContext(stateContext, position, false);
      const phase = detectPhase(position, stateContext, params, seat);
      setSeed(seedBase + 5_000_000 + rootIndex * 65537 + prefixIndex * 769);
      const count = sampleMoves(
        position,
        seat,
        candidates,
        params.search.playoutMoveCap,
        params.search.playoutCorners,
      );
      if (count < 2) {
        skippedSmallPool += 1;
        continue;
      }

      const handSquares = position.handSquares[seat];
      const handMask = position.hand[seat];
      for (let candidateIndex = 0; candidateIndex < count; candidateIndex += 1) {
        const move = candidates[candidateIndex];
        const undo = position.apply(move);
        let total = 0;
        for (let repeat = 0; repeat < continuations; repeat += 1) {
          setSeed(
            seedBase +
              20_000_000 +
              rootIndex * 131071 +
              prefixIndex * 1543 +
              repeat * 97,
          );
          labelPlayout.run(position, stateContext, phase, labelOutcome);
          total += seatValue(labelOutcome.values, params, seat, backedScratch);
        }
        position.undo(undo);

        writeRolloutPolicyFeatures(feature, move, seat, handSquares, handMask);
        features.push(...feature);
        targets.push(
          root.game,
          group,
          phaseIndex(phase),
          total / continuations,
          incumbentScore(move, phase, params),
          move,
          seat,
        );
      }
      group += 1;
    }

    if ((rootIndex + 1) % 25 === 0 || rootIndex + 1 === roots.length) {
      console.log(
        `${rootIndex + 1}/${roots.length} roots; ${group} groups; ` +
          `${features.length / ROLLOUT_POLICY_FEATURE_COUNT} rows ` +
          `(${((performance.now() - started) / 1000).toFixed(1)}s)`,
      );
    }
  }

  const x = Float32Array.from(features);
  const y = Float32Array.from(targets);
  const targetWidth = 7;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.x.f32`, Buffer.from(x.buffer));
  writeFileSync(`${out}.y.f32`, Buffer.from(y.buffer));
  const meta = {
    architecture: 'v4.1-canonical-rollout-policy',
    featureCount: ROLLOUT_POLICY_FEATURE_COUNT,
    featureNames: ROLLOUT_POLICY_FEATURE_NAMES,
    targetWidth,
    targets: ['game', 'group', 'phase', 'targetValue', 'incumbentScore', 'move', 'seat'],
    corpus: corpusPath,
    sourceVersion: version,
    games: new Set(roots.map((root) => root.game)).size,
    roots: roots.length,
    groups: group,
    rows: y.length / targetWidth,
    prefixesPerRoot,
    prefixBase,
    prefixStep,
    continuations,
    skippedTerminal,
    skippedSmallPool,
    seedBase,
    targetSpace: 'moverBackedTerminalValue',
  };
  writeFileSync(`${out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Wrote ${out}.{x.f32,y.f32,meta.json}`);
}

main();

