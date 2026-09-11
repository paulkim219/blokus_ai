/**
 * Builds the shared position corpus, resumably.
 *
 * Collecting positions is the only expensive part of the v4.6 diagnostics — it costs real self-play
 * games — while scoring a rollout policy against them costs seconds. Splitting collection into its
 * own resumable script means an interrupted run loses at most one game, and every downstream
 * diagnostic (`rolloutBalance`, `fitRolloutPolicy`, `rootHeadroom`) reads the same positions.
 *
 * Run it repeatedly; it stops when the corpus has `--games` games.
 *
 *   node --import tsx scripts/buildCorpus.ts --corpus tmp/corpus.json --games 26 --batch 6
 */

import { existsSync } from 'node:fs';
import { collectCorpusResumable, loadCorpus } from './lib/rolloutCorpus.ts';
import { isAlgoVersionId } from '../src/ai/algoVersions.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

async function main(): Promise<void> {
  preloadNets();
  const path = arg('corpus', 'tmp/corpus.json') as string;
  const target = Math.max(1, Number(arg('games', '26')));
  const batch = Math.max(1, Number(arg('batch', String(target))));
  const stride = Math.max(1, Number(arg('stride', '4')));
  const seedBase = Number(arg('seed-base', '42000000'));
  const versionArg = arg('version', 'v3.2-pro');
  if (!isAlgoVersionId(versionArg)) throw new Error(`unknown version ${versionArg}`);

  const before = existsSync(path) ? new Set(loadCorpus(path).map((s) => s.game)).size : 0;
  // Only advance `batch` games per invocation, so each run finishes well inside the window a
  // reaped background job gets.
  const limit = Math.min(target, before + batch);
  console.log(`corpus ${path}: ${before}/${target} games present; collecting up to ${limit}`);

  const samples = await collectCorpusResumable(
    path,
    limit,
    seedBase,
    stride,
    versionArg,
    'mcts-bench',
    (done, total, n) => console.log(`  game ${done}/${total} — ${n} positions saved`),
  );
  const games = new Set(samples.map((sample) => sample.game)).size;
  console.log(`corpus now holds ${samples.length} positions from ${games} games`);
  console.log(games >= target ? 'COMPLETE' : `INCOMPLETE — run again (${target - games} games left)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
