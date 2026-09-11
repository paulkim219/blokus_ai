/**
 * E14 — fit the terminal-rollout policy by simulation balancing instead of by tournament.
 *
 * The v3.2 shift found +0.88 by moving one hand-set constant (ε) and spent eight hours doing it, one
 * 400-game match per point. The policy still has two weights, both guessed. This fits four
 * parameters against an offline objective that costs seconds, then hands back a config for a single
 * confirming match.
 *
 * Objective: mean squared error of the rollout estimate against the realized final margin of the
 * game each position came from. Minimising it drives the estimator toward E[outcome | position],
 * which is exactly what a *balanced* simulation policy is (Silver & Tesauro 2009) — as opposed to a
 * *strong* one, which the literature and this engine's own ε ladder both say makes the search worse.
 *
 * The search is a cross-entropy method: sample a population from a Gaussian, keep the elite
 * fraction, refit. Train and holdout are split **by game**, and the printed decision uses holdout.
 *
 *   node --import tsx scripts/fitRolloutPolicy.ts --corpus tmp/fit-corpus.json --games 24
 */

import { existsSync, writeFileSync } from 'node:fs';
import {
  collectCorpus,
  evaluatePolicy,
  loadCorpus,
  saveCorpus,
  splitByGame,
  type Sample,
} from './lib/rolloutCorpus.ts';
import {
  bitboardParamsFor,
  getAlgo,
  isAlgoVersionId,
} from '../src/ai/algoVersions.ts';
import type { DeepPartial, BitboardParams } from '../src/ai/bitboard/config.ts';
import { createRng } from '../src/ai/rng.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

interface Dimension {
  name: 'playoutCornerWeight' | 'playoutEdgeWeight' | 'playoutTemp' | 'playoutEps';
  min: number;
  max: number;
  mean: number;
  sigma: number;
}

/**
 * Four parameters, all reachable back to the incumbent: corner=edge=0 and temp=0 reduce
 * `linearScore` to the shipped two-term argmax, and eps=0.60 is v3.2's promoted value. A fit that
 * cannot beat its own starting point is a null with no excuses.
 */
function dimensions(): Dimension[] {
  return [
    { name: 'playoutCornerWeight', min: -0.8, max: 0.8, mean: 0, sigma: 0.3 },
    { name: 'playoutEdgeWeight', min: -0.8, max: 0.8, mean: 0, sigma: 0.3 },
    { name: 'playoutTemp', min: 0, max: 5, mean: 1.0, sigma: 1.0 },
    { name: 'playoutEps', min: 0, max: 1, mean: 0.6, sigma: 0.25 },
  ];
}

function overridesFrom(values: number[], dims: Dimension[]): DeepPartial<BitboardParams> {
  const search: Record<string, unknown> = { playoutPolicy: 'linear', playoutEpsByPhase: null };
  dims.forEach((dim, index) => {
    search[dim.name] = values[index];
  });
  return { search } as DeepPartial<BitboardParams>;
}

function describe(values: number[], dims: Dimension[]): string {
  return dims.map((dim, i) => `${dim.name.replace('playout', '')}=${values[i].toFixed(3)}`).join(' ');
}

async function main(): Promise<void> {
  preloadNets();

  const corpusPath = arg('corpus', 'tmp/fit-corpus.json') as string;
  const games = Math.max(1, Number(arg('games', '24')));
  const stride = Math.max(1, Number(arg('stride', '4')));
  const seedBase = Number(arg('seed-base', '52000000'));
  const rollouts = Math.max(1, Number(arg('rollouts', '150')));
  const generations = Math.max(1, Number(arg('generations', '10')));
  const population = Math.max(4, Number(arg('population', '24')));
  const eliteFraction = Number(arg('elite', '0.25'));
  const versionArg = arg('version', 'v3.2-pro');
  const outPath = arg('out', 'tmp/fit-rollout-policy.json');
  if (!isAlgoVersionId(versionArg)) throw new Error(`unknown version ${versionArg}`);
  const base = bitboardParamsFor(getAlgo(versionArg));

  let samples: Sample[];
  if (existsSync(corpusPath)) {
    samples = loadCorpus(corpusPath);
    console.log(`Loaded ${samples.length} positions from ${corpusPath}`);
  } else {
    console.log(`Collecting ${games} ${versionArg} games into ${corpusPath}...`);
    samples = await collectCorpus(games, seedBase, stride, versionArg, 'mcts-bench', (done, total, n) =>
      console.log(`  ${done}/${total} games — ${n} positions`),
    );
    saveCorpus(corpusPath, samples);
  }

  const { train, holdout } = splitByGame(samples, 0.3);
  console.log(
    `${train.length} train / ${holdout.length} holdout positions ` +
      `(${new Set(train.map((s) => s.game)).size}/${new Set(holdout.map((s) => s.game)).size} games), ` +
      `${rollouts} rollouts per position\n`,
  );

  // The incumbent, scored on the same corpus with the same rollout seeds.
  const legacy: DeepPartial<BitboardParams> = { search: { playoutPolicy: 'legacy' } };
  const baseTrain = evaluatePolicy(base, legacy, train, rollouts, seedBase);
  const baseHold = evaluatePolicy(base, legacy, holdout, rollouts, seedBase);
  console.log(
    `incumbent (${versionArg}, legacy ε=${base.search.playoutEps})  ` +
      `train mse=${baseTrain.mse.toFixed(5)} bias=${baseTrain.bias.toFixed(4)} rho=${baseTrain.rho.toFixed(3)}  |  ` +
      `holdout mse=${baseHold.mse.toFixed(5)} bias=${baseHold.bias.toFixed(4)} rho=${baseHold.rho.toFixed(3)}\n`,
  );

  const dims = dimensions();
  const rng = createRng(Number(arg('fit-seed', '99')));
  const eliteCount = Math.max(2, Math.round(population * eliteFraction));
  let best: { values: number[]; mse: number } | null = null;

  for (let generation = 0; generation < generations; generation += 1) {
    const candidates: Array<{ values: number[]; mse: number }> = [];
    for (let i = 0; i < population; i += 1) {
      const values = dims.map((dim) => {
        // Box–Muller from the seeded stream, so a run replays exactly.
        const u = Math.max(1e-9, rng());
        const v = rng();
        const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return Math.min(dim.max, Math.max(dim.min, dim.mean + gauss * dim.sigma));
      });
      const score = evaluatePolicy(base, overridesFrom(values, dims), train, rollouts, seedBase);
      candidates.push({ values, mse: score.mse });
    }
    candidates.sort((a, b) => a.mse - b.mse);
    const elite = candidates.slice(0, eliteCount);
    dims.forEach((dim, index) => {
      const values = elite.map((candidate) => candidate.values[index]);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance =
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
      dim.mean = mean;
      // A floor on sigma keeps the population from collapsing before the objective is resolved.
      dim.sigma = Math.max(Math.sqrt(variance), (dim.max - dim.min) * 0.02);
    });
    if (!best || elite[0].mse < best.mse) {
      best = elite[0];
    }
    console.log(
      `gen ${String(generation).padStart(2)}  best=${elite[0].mse.toFixed(5)}  ` +
        `mean: ${describe(dims.map((d) => d.mean), dims)}`,
    );
  }

  if (!best) throw new Error('no candidate evaluated');
  const bestOverrides = overridesFrom(best.values, dims);
  const fittedTrain = evaluatePolicy(base, bestOverrides, train, rollouts, seedBase);
  const fittedHold = evaluatePolicy(base, bestOverrides, holdout, rollouts, seedBase);

  console.log(`\n=== Fitted policy ===`);
  console.log(describe(best.values, dims));
  console.log(
    `train   mse=${fittedTrain.mse.toFixed(5)} (incumbent ${baseTrain.mse.toFixed(5)})  ` +
      `bias=${fittedTrain.bias.toFixed(4)}  rho=${fittedTrain.rho.toFixed(3)}`,
  );
  console.log(
    `holdout mse=${fittedHold.mse.toFixed(5)} (incumbent ${baseHold.mse.toFixed(5)})  ` +
      `bias=${fittedHold.bias.toFixed(4)}  rho=${fittedHold.rho.toFixed(3)}`,
  );
  const delta = baseHold.mse - fittedHold.mse;
  console.log(
    `\nHoldout MSE improvement: ${delta >= 0 ? '+' : ''}${delta.toFixed(5)} ` +
      `(${((delta / baseHold.mse) * 100).toFixed(2)}%). ` +
      `${delta <= 0 ? 'No offline gain — do not spend a match.' : 'Offline gain; a match is warranted.'}`,
  );

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        version: versionArg,
        rollouts,
        fitted: Object.fromEntries(dims.map((dim, i) => [dim.name, best!.values[i]])),
        incumbent: { train: baseTrain, holdout: baseHold },
        candidate: { train: fittedTrain, holdout: fittedHold },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
