import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId } from '../src/ai/algoVersions.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';
import { GamePool, defaultWorkerCount, type GameAssignment } from './lib/pool.ts';

/**
 * Generates training data for the value model: play games, log the feature vector of every
 * position as the side to move saw it, and label each row with the outcome that position led to.
 *
 * Self-play data is only useful if the games differ, so openings are sampled rather than played
 * greedily — otherwise every seed replays one identical game and the regression sees one trajectory
 * repeated thousands of times.
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

async function main(): Promise<void> {
  const version = arg('version', 'v1')!;
  if (!isAlgoVersionId(version)) {
    throw new Error(`unknown version: ${version}`);
  }
  const policy = (arg('policy', 'greedy') ?? 'greedy') as PolicyId;
  const games = Math.max(1, Number(arg('games', '400')));
  const seedBase = Number(arg('seed-base', '500000'));
  const workers = Math.max(1, Number(arg('workers', String(defaultWorkerCount()))));
  const iterationsRaw = arg('iterations');
  const iterationBudget = iterationsRaw ? Number(iterationsRaw) : undefined;
  const openingRandomPlies = Number(arg('opening-random-plies', '12'));
  const openingTopK = Number(arg('opening-top-k', '4'));

  const outDir = join(process.cwd(), 'tuning');
  mkdirSync(outDir, { recursive: true });
  const outPath =
    arg('out') ?? join(outDir, `features-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

  const seatVersions = Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, version]),
  ) as Record<PlayerColor, typeof version>;
  const seatPolicies = Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, policy]),
  ) as Record<PlayerColor, PolicyId>;

  const assignments: GameAssignment[] = Array.from({ length: games }, (_, i) => ({
    id: `g${i}`,
    seatVersions,
    seatPolicies,
    seed: seedBase + i,
    iterationBudget,
    openingRandomPlies,
    openingTopK,
    logFeatures: true,
  }));

  console.log(
    `Collecting ${games} ${policy} games of ${version} on ${workers} workers → ${outPath}`,
  );

  const pool = new GamePool(workers);
  let rows = 0;
  await pool.run(assignments, (outcome, done, total) => {
    if (outcome.error || !outcome.samples) {
      return;
    }
    const lines = outcome.samples.map((sample) => {
      const others = PLAYER_COLORS.filter((color) => color !== sample.seat);
      const opponentMean =
        others.reduce((sum, color) => sum + outcome.scores[color], 0) / others.length;
      return JSON.stringify({
        seat: sample.seat,
        ply: sample.ply,
        progress: sample.progress,
        features: sample.features,
        // Same statistic the tournament reports, so the fitted evaluation is optimising the
        // quantity a match is scored on.
        target: outcome.scores[sample.seat] - opponentMean,
      });
    });
    rows += lines.length;
    appendFileSync(outPath, `${lines.join('\n')}\n`);
    if (done % 50 === 0 || done === total) {
      console.log(`${done}/${total} games — ${rows} rows`);
    }
  });
  pool.close();

  console.log(`Done: ${rows} rows → ${outPath}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
