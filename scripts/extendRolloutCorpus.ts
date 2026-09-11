/** Resumably extend the shared game-tagged corpus used by v4.6 leaf experiments. */

import { collectCorpusResumable } from './lib/rolloutCorpus.ts';
import { isAlgoVersionId } from '../src/ai/algoVersions.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  preloadNets();
  const path = arg('corpus', 'tmp/corpus.json');
  const games = Number(arg('games', '24'));
  const seedBase = Number(arg('seed-base', '42000000'));
  const stride = Number(arg('stride', '4'));
  const version = arg('version', 'v3.2-pro');
  const policy = arg('policy', 'mcts-bench') as PolicyId;
  if (!Number.isFinite(games) || games < 1) throw new Error('--games must be positive');
  if (!isAlgoVersionId(version)) throw new Error(`unknown version ${version}`);
  const samples = await collectCorpusResumable(
    path,
    games,
    seedBase,
    stride,
    version,
    policy,
    (done, total, positions) => console.log(`${done}/${total} games; ${positions} positions`),
  );
  console.log(`Corpus now contains ${samples.length} positions from ${new Set(samples.map((s) => s.game)).size} games`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
