/**
 * CPU profile of a real bitboard search, for workstream D.
 *
 * The static reading of the code says allocation dominates. That is a hypothesis, and the first
 * optimisation applied on its strength (pooling `Position.apply`'s undo records) measured -0.9%
 * against an 18% noise floor — i.e. unmeasurable. Guessing at hot spots from source is how an
 * optimisation pass wastes a day; this asks V8 where the time actually goes.
 *
 *   node --cpu-prof --cpu-prof-dir=tmp/prof --import tsx scripts/v37Profile.ts
 *   node --import tsx scripts/v37Profile.ts --report tmp/prof
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { benchmarkFixtures } from './lib/benchFixtures.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

function report(dir: string): void {
  const file = readdirSync(dir).find((f) => f.endsWith('.cpuprofile'));
  if (!file) throw new Error(`no .cpuprofile in ${dir}`);
  const profile = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Profile;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));

  const selfTime = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    selfTime.set(id, (selfTime.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }

  // Only engine frames matter. Module loading and the tsx transform dominate a short process and
  // would otherwise bury the search entirely.
  const engine = new Map<string, number>();
  let engineTotal = 0;
  let otherTotal = 0;
  for (const [id, us] of selfTime) {
    const frame = byId.get(id)?.callFrame;
    if (!frame) continue;
    const url = frame.url;
    const isEngine = url.includes('/src/ai/') || url.includes('/src/engine/');
    if (!isEngine) {
      otherTotal += us;
      continue;
    }
    const short = url.slice(url.lastIndexOf('/') + 1);
    const key = `${short}:${frame.lineNumber + 1} ${frame.functionName || '(anonymous)'}`;
    engine.set(key, (engine.get(key) ?? 0) + us);
    engineTotal += us;
  }

  const ranked = [...engine.entries()].sort((a, b) => b[1] - a[1]);
  console.log(
    `engine self time ${(engineTotal / 1e6).toFixed(2)}s of ${((engineTotal + otherTotal) / 1e6).toFixed(2)}s sampled\n`,
  );
  console.log(`${'share'.padStart(7)}  ${'ms'.padStart(8)}  location`);
  for (const [key, us] of ranked.slice(0, 25)) {
    console.log(`${((100 * us) / engineTotal).toFixed(1).padStart(6)}%  ${(us / 1000).toFixed(0).padStart(8)}  ${key}`);
  }

  const byFile = new Map<string, number>();
  for (const [key, us] of engine) {
    const f = key.split(':')[0];
    byFile.set(f, (byFile.get(f) ?? 0) + us);
  }
  console.log('\nby file:');
  for (const [f, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${((100 * us) / engineTotal).toFixed(1).padStart(5)}%  ${f}`);
  }
}

async function main(): Promise<void> {
  const reportDir = arg('report');
  if (reportDir) {
    report(reportDir);
    return;
  }
  preloadNets();
  const fixtures = benchmarkFixtures();
  for (let repeat = 0; repeat < 4; repeat += 1) {
    for (const fixture of fixtures) {
      resetV12();
      setSeed(1234 + repeat);
      await searchBestMove(fixture.state, fixture.state.currentTurn, 600_000, undefined, {
        version: 'v3.5-pro',
        iterationBudget: 300,
        skipWinOddsRefinement: true,
      });
    }
  }
  console.log('profiled run complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
