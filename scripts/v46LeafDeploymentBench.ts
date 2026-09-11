/**
 * Search-level screen for deterministic, stochastic, and hybrid leaf-value deployment.
 *
 * This is deliberately an oracle-regret diagnostic, not a promotion match. It first calibrates an
 * equal-wall-clock iteration budget for each arm, then compares the chosen root move with a deeper
 * incumbent search on held-out, game-tagged roots.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { bitboardParamsFor, getAlgo } from '../src/ai/algoVersions.ts';
import { withOverrides, type BitboardParams, type DeepPartial } from '../src/ai/bitboard/config.ts';
import { V12Search, type RankedPlacement } from '../src/ai/bitboard/mcts.ts';
import { loadNet, registerNet } from '../src/ai/bitboard/net.ts';
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

function logit(value: number): number {
  const p = Math.max(1e-6, Math.min(1 - 1e-6, value));
  return Math.log(p / (1 - p));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

interface Arm {
  name: string;
  overrides: DeepPartial<BitboardParams>;
  params?: BitboardParams;
  ms300?: number;
  equalWallIterations?: number;
}

function runSearch(sample: Sample, params: BitboardParams, iterations: number, seed: number) {
  const position = toPosition(sample.state);
  const seat = seatOf(sample.player);
  if (position.turn !== seat) position.forceTurn(seat);
  setSeed(seed);
  return new V12Search(params).run(position, seat, { iterations });
}

function valueFor(ranked: RankedPlacement[], move: number): number | null {
  return ranked.find((entry) => entry.move === move)?.value ?? null;
}

function main(): void {
  const corpusPath = arg('corpus', 'tmp/corpus.json');
  const netPath = arg('net', 'ml/v46-search-leaf-distribution.json');
  const outputKind = arg('output-kind', 'meanMargins') as 'meanMargins' | 'values';
  const rootCount = numberArg('roots', 36, 6);
  const baseIterations = numberArg('iterations', 300, 32);
  const oracleIterations = numberArg('oracle-iterations', 1800, baseIterations);
  const seedBase = numberArg('seed-base', 46_400_000, 0);
  const outPath = arg('out', 'selfplay-results/v46-leaf-deployment-bench.json');
  registerNet(netPath, loadNet(JSON.parse(readFileSync(netPath, 'utf8'))));
  const base = bitboardParamsFor(getAlgo('v3.2-pro'));
  const network = {
    netPath,
    netBlend: 1,
    netScale: 12,
    netOutputKind: outputKind,
    netPrior: false,
  };
  const arms: Arm[] = [
    { name: 'full-rollout', overrides: {} },
    {
      name: 'mean-blend-0.10',
      overrides: {
        search: {
          ...network,
          netBlend: 0.1,
          netValueSampling: 'mean',
          netRolloutProbability: 0,
        },
      },
    },
    {
      name: 'mean-blend-0.25',
      overrides: {
        search: {
          ...network,
          netBlend: 0.25,
          netValueSampling: 'mean',
          netRolloutProbability: 0,
        },
      },
    },
    {
      name: 'mean',
      overrides: { search: { ...network, netValueSampling: 'mean', netRolloutProbability: 0 } },
    },
    {
      name: 'sample-0.5',
      overrides: {
        search: { ...network, netValueSampling: 'gaussian', netSampleScale: 0.5, netRolloutProbability: 0 },
      },
    },
    {
      name: 'sample-1.0',
      overrides: {
        search: { ...network, netValueSampling: 'gaussian', netSampleScale: 1, netRolloutProbability: 0 },
      },
    },
    {
      name: 'sample-1.0-real25',
      overrides: {
        search: { ...network, netValueSampling: 'gaussian', netSampleScale: 1, netRolloutProbability: 0.25 },
      },
    },
  ];
  for (const arm of arms) arm.params = withOverrides(base, arm.overrides);
  const roots = balanced(loadCorpus(corpusPath), rootCount);
  const timingRoots = roots.slice(0, Math.min(12, roots.length));

  for (const arm of arms) {
    // Warmup.
    runSearch(timingRoots[0], arm.params!, 64, seedBase);
    const timings: number[] = [];
    for (let index = 0; index < timingRoots.length; index += 1) {
      const started = performance.now();
      runSearch(timingRoots[index], arm.params!, baseIterations, seedBase + index);
      timings.push(performance.now() - started);
    }
    arm.ms300 = mean(timings);
  }
  const baselineMs = arms[0].ms300!;
  for (const arm of arms) {
    arm.equalWallIterations = Math.max(32, Math.round(baseIterations * baselineMs / arm.ms300!));
    console.log(
      `${arm.name.padEnd(22)} ${arm.ms300!.toFixed(1).padStart(7)} ms/${baseIterations}; ` +
        `equal-wall ${arm.equalWallIterations} iterations`,
    );
  }

  const rows = Object.fromEntries(arms.map((arm) => [arm.name, [] as Array<Record<string, unknown>>]));
  const oracleParams = bitboardParamsFor(getAlgo('v3.2-pro-max'));
  for (let index = 0; index < roots.length; index += 1) {
    const sample = roots[index];
    const oracle = runSearch(sample, oracleParams, oracleIterations, seedBase + 900_000 + index);
    const oracleBestValue = oracle.ranked[0]?.value ?? 0.5;
    for (let armIndex = 0; armIndex < arms.length; armIndex += 1) {
      const arm = arms[armIndex];
      const result = runSearch(
        sample,
        arm.params!,
        arm.equalWallIterations!,
        seedBase + 500_000 + index,
      );
      const oracleValue = valueFor(oracle.ranked, result.best);
      rows[arm.name].push({
        game: sample.game,
        phase: sample.phase,
        agree: result.best === oracle.best,
        regret: oracleValue === null ? null : 12 * (logit(oracleBestValue) - logit(oracleValue)),
      });
    }
    if ((index + 1) % 6 === 0 || index + 1 === roots.length) {
      console.log(`${index + 1}/${roots.length} oracle roots`);
    }
  }

  const summary = Object.fromEntries(arms.map((arm) => {
    const armRows = rows[arm.name];
    const scored = armRows.filter((row) => row.regret !== null);
    return [arm.name, {
      msAtBaseIterations: arm.ms300,
      equalWallIterations: arm.equalWallIterations,
      agreement: armRows.filter((row) => row.agree).length / armRows.length,
      meanRegret: mean(scored.map((row) => row.regret as number)),
      scored: scored.length,
      byPhase: Object.fromEntries((['opening', 'midgame', 'endgame'] as const).map((phase) => {
        const phaseRows = armRows.filter((row) => row.phase === phase && row.regret !== null);
        return [phase, {
          n: phaseRows.length,
          agreement: phaseRows.filter((row) => row.agree).length / Math.max(1, phaseRows.length),
          meanRegret: mean(phaseRows.map((row) => row.regret as number)),
        }];
      })),
    }];
  }));
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(outPath, `${JSON.stringify({ netPath, baseIterations, oracleIterations, summary, rows }, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

main();
