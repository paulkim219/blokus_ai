/**
 * Per-iteration and per-phase cost for the bitboard engine — the measurement workstream D needs and
 * the repo has never had.
 *
 * Two gaps this fills:
 *
 * - `scripts/benchSearch.ts` is the only script reporting iterations per second, and it benchmarks
 *   the **legacy object engine** (`src/ai/mcts.ts`, `src/engine/game.ts`). The number describes code
 *   the champion does not run.
 * - No ms-per-iteration figure exists anywhere, and the `v3*Bench.ts` family samples plies 8/24/40
 *   and then averages them away. Per-iteration cost is not phase-invariant: the opening has ~356
 *   legal moves against about a dozen in the endgame.
 *
 * Noise discipline, because machine noise currently exceeds several deltas the existing bench
 * scripts report — two measurements of `v3.2-pro` differ by 8% across two scripts:
 *
 * - a warm-up pass that is measured and discarded;
 * - repeats with the version order **rotated**, so no arm systematically runs on a colder machine;
 * - **minimum over repeats as the primary statistic.** Timing noise here is one-sided: a scheduler
 *   preemption, a GC pause or a frequency drop can only ever *add* time to a deterministic
 *   computation, never remove it. The minimum is therefore the cleanest estimator of true cost,
 *   while a mean or median mixes in however much interference that particular run happened to catch.
 *   The spread (min to median) is reported alongside so the noise floor is visible: a delta smaller
 *   than the spread is not a measurement.
 *
 *   node --import tsx scripts/benchBitboard.ts
 *   node --import tsx scripts/benchBitboard.ts --save tmp/bench-before.json
 *   node --import tsx scripts/benchBitboard.ts --compare tmp/bench-before.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAlgoVersionId, bitboardParamsFor, getAlgo, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { getV12BudgetDiagnostics, resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { benchmarkFixtures, type Fixture } from './lib/benchFixtures.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Cell {
  version: string;
  phase: string;
  ply: number;
  legalMoves: number;
  msMean: number;
  msMedian: number;
  msMin: number;
  /** Iterations the search actually executed — `decided()` can stop it below the allocation. */
  iterations: number;
  usPerIteration: number;
}

async function timeOne(
  version: AlgoVersionId,
  fixture: Fixture,
  iterations: number,
  seed: number,
): Promise<{ ms: number; executed: number }> {
  clearLegalMoveCache();
  resetV12();
  setSeed(seed);
  const before = getV12BudgetDiagnostics();
  const started = performance.now();
  await searchBestMove(fixture.state, fixture.state.currentTurn, 600_000, undefined, {
    version,
    iterationBudget: iterations,
    skipWinOddsRefinement: true,
  });
  const ms = performance.now() - started;
  const after = getV12BudgetDiagnostics();
  // Executed, not allocated. Dividing wall time by the *allocation* would understate per-iteration
  // cost by exactly the decision-locked fraction, which is 10-17% at the tiers that ship.
  return { ms, executed: Math.max(1, after.spent - before.spent) };
}

async function main(): Promise<void> {
  preloadNets();
  const versions = (arg('versions', 'v3.5-lite,v3.5,v3.5-pro,v3.6-pro-max') as string)
    .split(',')
    .map((v) => v.trim());
  for (const v of versions) {
    if (!isAlgoVersionId(v)) throw new Error(`unknown version: ${v}`);
  }
  const iterations = Number(arg('iterations', '300'));
  const repeats = Number(arg('repeats', '3'));
  const seedBase = Number(arg('seed-base', '38000000'));
  const savePath = arg('save');
  const comparePath = arg('compare');

  const fixtures = benchmarkFixtures();

  // Warm-up: JIT tiering and the first-touch cost of every module-level scratch buffer land here
  // instead of in the first measured arm.
  for (const version of versions) {
    await timeOne(version as AlgoVersionId, fixtures[0], iterations, seedBase - 1);
  }

  const samples = new Map<string, { ms: number[]; executed: number[] }>();
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    // Rotate arm order per repeat so no version always runs first.
    const order = versions.map((_, i) => versions[(i + repeat) % versions.length]);
    for (const version of order) {
      for (let f = 0; f < fixtures.length; f += 1) {
        const key = `${version}::${f}`;
        const { ms, executed } = await timeOne(
          version as AlgoVersionId,
          fixtures[f],
          iterations,
          seedBase + repeat * 100 + f,
        );
        const bucket = samples.get(key) ?? { ms: [], executed: [] };
        bucket.ms.push(ms);
        bucket.executed.push(executed);
        samples.set(key, bucket);
      }
    }
  }

  const cells: Cell[] = [];
  for (const version of versions) {
    for (let f = 0; f < fixtures.length; f += 1) {
      const bucket = samples.get(`${version}::${f}`)!;
      const msMean = bucket.ms.reduce((a, b) => a + b, 0) / bucket.ms.length;
      const executed = bucket.executed.reduce((a, b) => a + b, 0) / bucket.executed.length;
      const msMin = Math.min(...bucket.ms);
      cells.push({
        version,
        phase: fixtures[f].phase,
        ply: fixtures[f].ply,
        legalMoves: fixtures[f].legalMoves,
        msMean,
        msMedian: median(bucket.ms),
        msMin,
        iterations: executed,
        usPerIteration: (msMin * 1000) / executed,
      });
    }
  }

  console.log(
    `bitboard cost — ${iterations} base iterations, ${repeats} repeats, order-rotated, warmed\n`,
  );
  console.log(
    `${'version'.padEnd(15)}${'phase'.padEnd(9)}${'ply'.padStart(4)}${'legal'.padStart(7)}` +
      `${'ms (min)'.padStart(10)}${'noise'.padStart(8)}${'iters'.padStart(8)}${'us/iter'.padStart(9)}`,
  );
  for (const c of cells) {
    const noise = ((c.msMedian / c.msMin) - 1) * 100;
    console.log(
      `${c.version.padEnd(15)}${c.phase.padEnd(9)}${String(c.ply).padStart(4)}${String(c.legalMoves).padStart(7)}` +
        `${c.msMin.toFixed(1).padStart(10)}${`+${noise.toFixed(1)}%`.padStart(8)}` +
        `${c.iterations.toFixed(0).padStart(8)}${c.usPerIteration.toFixed(1).padStart(9)}`,
    );
  }

  console.log('\nper-iteration cost by phase (us), the number this repo has never written down:');
  for (const version of versions) {
    const mine = cells.filter((c) => c.version === version);
    const scale = bitboardParamsFor(getAlgo(version as AlgoVersionId)).search.iterationScale;
    console.log(
      `  ${version.padEnd(15)} scale ${String(scale).padStart(5)}  ` +
        mine.map((c) => `${c.phase} ${c.usPerIteration.toFixed(1)}`).join('   '),
    );
  }

  if (savePath) {
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, `${JSON.stringify({ iterations, repeats, cells }, null, 2)}\n`);
    console.log(`\nWrote ${savePath}`);
  }

  if (comparePath) {
    if (!existsSync(comparePath)) throw new Error(`no baseline at ${comparePath}`);
    const before = (JSON.parse(readFileSync(comparePath, 'utf8')) as { cells: Cell[] }).cells;
    console.log(`\nagainst ${comparePath} (negative us/iter is faster):\n`);
    let totalBefore = 0;
    let totalAfter = 0;
    for (const c of cells) {
      const b = before.find((x) => x.version === c.version && x.ply === c.ply);
      if (!b) continue;
      totalBefore += b.usPerIteration;
      totalAfter += c.usPerIteration;
      const delta = ((c.usPerIteration / b.usPerIteration) - 1) * 100;
      console.log(
        `  ${c.version.padEnd(15)}${c.phase.padEnd(9)}` +
          `${b.usPerIteration.toFixed(1).padStart(8)} -> ${c.usPerIteration.toFixed(1).padStart(7)} us/iter` +
          `${delta.toFixed(1).padStart(9)}%`,
      );
    }
    const overall = ((totalAfter / totalBefore) - 1) * 100;
    const worstNoise = Math.max(...cells.map((c) => ((c.msMedian / c.msMin) - 1) * 100));
    console.log(`\n  overall ${overall.toFixed(1)}% per iteration`);
    console.log(
      `  noise floor this run: up to +${worstNoise.toFixed(1)}% between min and median.` +
        `\n  A delta smaller than that is not resolvable; raise --repeats or accept it as unmeasured.`,
    );
    console.log(
      '\n  A speed change is only claimable alongside a passing scripts/v37ReplayDiff.ts --check.' +
        '\n  Faster-but-different is not a speedup, it is a different engine.',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
