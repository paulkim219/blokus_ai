/**
 * E14/E5 — an offline, match-free metric for the terminal-rollout policy, calibrated against the
 * six ε arms whose playing strength is already measured.
 *
 * Why this exists. The v3.2 shift spent eight hours discovering that ε=0.60 beats ε=0.15 by +0.88,
 * one 400-game match per point on a single scalar knob. That is the most expensive possible way to
 * search a policy space, and it is why the rollout policy — the channel with the largest measured
 * headroom in the engine — still has exactly two hand-set weights.
 *
 * Simulation balancing (Silver & Tesauro 2009; Huang, Coulom & Lin 2010) says what a rollout policy
 * is *for*: not to play well, but for its expected outcome to track the true value of the position.
 * A stronger playout policy routinely makes the wrapping search weaker, which is precisely the
 * inverted-U the ε ladder measured. That objective is computable offline and nearly free.
 *
 * The reference value is the realized final margin of the game each position came from — an
 * unbiased sample of the outcome under strong (v3.2-pro) play, already paid for by the position
 * collection, and *not* itself produced by the rollout policy under test. Scoring rollouts against a
 * deeper search of the same engine would grade the policy against its own bias.
 *
 * A metric is only usable if it orders the measured ε ladder. That check is printed at the end and
 * is the whole point of the script: if none of the three reproduces the strength ordering, do not
 * optimise against them.
 *
 *   node --import tsx scripts/rolloutBalance.ts --corpus tmp/corpus.json --games 20
 */

import { existsSync, writeFileSync } from 'node:fs';
import {
  collectCorpus,
  evaluatePolicy,
  loadCorpus,
  saveCorpus,
  spearman,
  type PolicyScore,
  type Sample,
} from './lib/rolloutCorpus.ts';
import { bitboardParamsFor, getAlgo, isAlgoVersionId } from '../src/ai/algoVersions.ts';
import type { BitboardParams, DeepPartial } from '../src/ai/bitboard/config.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

/**
 * Playing strength of each ε arm, from the v3.2 shift ledger (`v32_eight_hour_shift.md` §I, §L).
 * Pooled where disjoint blocks exist. These are the calibration points: a usable offline metric has
 * to order them.
 */
const MEASURED_STRENGTH: Record<string, number> = {
  '0.05': -1.01,
  '0.15': 0,
  '0.30': 0.29,
  '0.45': 0.28,
  '0.60': 0.7,
  '1.00': 0.36,
};

async function main(): Promise<void> {
  preloadNets();

  const corpusPath = arg('corpus', 'tmp/corpus.json') as string;
  const games = Math.max(1, Number(arg('games', '20')));
  const stride = Math.max(1, Number(arg('stride', '4')));
  const maxPositions = Math.max(1, Number(arg('positions', '240')));
  const rollouts = Math.max(1, Number(arg('rollouts', '200')));
  const seedBase = Number(arg('seed-base', '42000000'));
  const versionArg = arg('version', 'v3.2-pro');
  const outPath = arg('out');
  const epsilons = (arg('epsilons', '0.05,0.15,0.30,0.45,0.60,1.00') ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));

  if (!isAlgoVersionId(versionArg)) throw new Error(`unknown version ${versionArg}`);
  const base = bitboardParamsFor(getAlgo(versionArg));

  let all: Sample[];
  if (existsSync(corpusPath)) {
    all = loadCorpus(corpusPath);
    console.log(`Loaded ${all.length} positions from ${corpusPath}`);
  } else {
    console.log(`Collecting ${games} ${versionArg} games into ${corpusPath}...`);
    all = await collectCorpus(games, seedBase, stride, versionArg, 'mcts-bench', (done, total, n) =>
      console.log(`  ${done}/${total} games — ${n} positions`),
    );
    saveCorpus(corpusPath, all);
  }
  const step = Math.max(1, Math.floor(all.length / maxPositions));
  const samples = all.filter((_, index) => index % step === 0).slice(0, maxPositions);
  console.log(`${samples.length} positions of ${all.length}; ${rollouts} rollouts per arm\n`);

  const results: Array<{ label: string; epsilon: number } & PolicyScore> = [];
  for (const epsilon of epsilons) {
    const started = Date.now();
    const overrides: DeepPartial<BitboardParams> = {
      search: { playoutPolicy: 'legacy', playoutEps: epsilon, playoutEpsByPhase: null },
    };
    const score = evaluatePolicy(base, overrides, samples, rollouts, seedBase);
    results.push({ label: epsilon.toFixed(2), epsilon, ...score });
    console.log(
      `ε=${epsilon.toFixed(2)}  bias=${score.bias.toFixed(4).padStart(8)}  ` +
        `|bias|=${Math.abs(score.bias).toFixed(4).padStart(7)}  ` +
        `mse=${score.mse.toFixed(5).padStart(8)}  rho=${score.rho.toFixed(3).padStart(6)}  ` +
        `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
  }

  console.log('\n=== By phase (bias) ===');
  for (const result of results) {
    const parts = (['opening', 'midgame', 'endgame'] as const).map(
      (phase) =>
        `${phase}=${result.byPhase[phase].bias.toFixed(4).padStart(8)}(n=${result.byPhase[phase].n})`,
    );
    console.log(`ε=${result.label}  ${parts.join('  ')}`);
  }

  const known = results.filter((result) => MEASURED_STRENGTH[result.label] !== undefined);
  if (known.length >= 3) {
    const strength = known.map((result) => MEASURED_STRENGTH[result.label]);
    console.log('\n=== Calibration against measured playing strength ===');
    console.log(
      `arms: ${known.map((r) => `ε=${r.label}:${MEASURED_STRENGTH[r.label].toFixed(2)}`).join('  ')}`,
    );
    const checks: Array<[string, number[]]> = [
      ['-|bias| vs strength', known.map((r) => -Math.abs(r.bias))],
      ['-mse    vs strength', known.map((r) => -r.mse)],
      ['rho     vs strength', known.map((r) => r.rho)],
    ];
    for (const [label, values] of checks) {
      console.log(`  ${label}: Spearman ${spearman(values, strength).toFixed(3)}`);
    }
    const leastBias = known.reduce((a, b) => (Math.abs(a.bias) <= Math.abs(b.bias) ? a : b));
    const leastMse = known.reduce((a, b) => (a.mse <= b.mse ? a : b));
    console.log(
      `\n  |bias| minimised at ε=${leastBias.label}; mse minimised at ε=${leastMse.label}; ` +
        `playing strength peaks at ε=0.60 (+0.70 pooled).`,
    );
  }

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify({ version: versionArg, rollouts, results }, null, 2)}\n`);
    console.log(`\nWrote ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
