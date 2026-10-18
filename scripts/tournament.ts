import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import {
  isAlgoVersionId,
  registerAlgoConfig,
  type AlgoConfig,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { POLICY_TIME_MS, type PolicyId } from '../src/ai/selfplay.ts';
import { GamePool, defaultWorkerCount, type GameAssignment } from './lib/pool.ts';
import { formatMatchSummary, summarizeMatch, type RotationGame } from './lib/stats.ts';

/**
 * Seat-rotated, seeded, parallel match runner.
 *
 * Replaces the "hero in the blue seat vs three clones, one game at a time" protocol. Each seed
 * produces four games (challenger in each seat), all four workers stay busy, and the reported
 * statistic has an exact zero null so a mirror match must score 0.00.
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const POLICIES: PolicyId[] = ['greedy', 'mcts-bench', 'mcts-short', 'mcts-long'];

function parsePolicy(value: string | undefined, fallback: PolicyId): PolicyId {
  return value && POLICIES.includes(value as PolicyId) ? (value as PolicyId) : fallback;
}

function parseVersion(value: string | undefined, fallback: AlgoVersionId): AlgoVersionId {
  return isAlgoVersionId(value) ? value : fallback;
}

function seatAssignment(
  challenger: AlgoVersionId,
  champion: AlgoVersionId,
  seat: PlayerColor,
): Record<PlayerColor, AlgoVersionId> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, color === seat ? challenger : champion]),
  ) as Record<PlayerColor, AlgoVersionId>;
}

/** Loads a generated config (from the tuner) and makes it playable under its own id. */
function loadConfigFile(path: string | undefined): AlgoConfig | null {
  if (!path) {
    return null;
  }
  const config = JSON.parse(readFileSync(path, 'utf8')) as AlgoConfig;
  registerAlgoConfig(config);
  return config;
}

async function main(): Promise<void> {
  const challengerConfig = loadConfigFile(arg('challenger-file'));
  const championConfig = loadConfigFile(arg('champion-file'));
  const extraConfigs = [challengerConfig, championConfig].filter(
    (config): config is AlgoConfig => config !== null,
  );
  const challenger = challengerConfig?.id ?? parseVersion(arg('challenger'), 'v10');
  const champion = championConfig?.id ?? parseVersion(arg('champion'), 'v1');
  const policy = parsePolicy(arg('policy'), 'mcts-bench');
  const challengerPolicy = parsePolicy(arg('challenger-policy'), policy);
  const championPolicy = parsePolicy(arg('champion-policy'), policy);
  const seeds = Math.max(1, Number(arg('seeds', '25')));
  const seedBase = Number(arg('seed-base', '1000'));
  const workers = Math.max(1, Number(arg('workers', String(defaultWorkerCount()))));
  const iterationsRaw = arg('iterations');
  const iterationBudget = iterationsRaw ? Number(iterationsRaw) : undefined;
  const label = arg('label', `${challenger}-vs-${champion}`) ?? 'match';
  // Greedy play has no randomness at all, so without opening sampling every seed replays one
  // identical game. Even MCTS benefits: seeds alone barely move the first few plies.
  const openingRandomPlies = Number(arg('opening-random-plies', '8'));
  const openingTopK = Number(arg('opening-top-k', '3'));
  const native = process.argv.includes('--native') || process.env.BLOKEE_NATIVE === '1';

  const assignments: GameAssignment[] = [];
  for (let i = 0; i < seeds; i += 1) {
    const seed = seedBase + i;
    for (const seat of PLAYER_COLORS) {
      const policies = Object.fromEntries(
        PLAYER_COLORS.map((color) => [
          color,
          color === seat ? challengerPolicy : championPolicy,
        ]),
      ) as Record<PlayerColor, PolicyId>;
      assignments.push({
        id: `${seed}:${seat}`,
        seatVersions: seatAssignment(challenger, champion, seat),
        seatPolicies: policies,
        seed,
        iterationBudget,
        openingRandomPlies,
        openingTopK,
        configs: extraConfigs.length > 0 ? extraConfigs : undefined,
      });
    }
  }

  const outDir = join(process.cwd(), 'selfplay-results');
  mkdirSync(outDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(outDir, `match-${runId}.jsonl`);
  const summaryPath = join(outDir, `match-${runId}-summary.txt`);

  const header = [
    'Seat-rotated tournament',
    `Started: ${new Date().toISOString()}`,
    `Challenger: ${challenger}   Champion: ${champion}`,
    `Policy: challenger ${challengerPolicy} / champion ${championPolicy}` +
      (iterationBudget
        ? ` (${iterationBudget} base iterations/move)`
        : ` (${POLICY_TIME_MS[challengerPolicy]} / ${POLICY_TIME_MS[championPolicy]} ms/move)`),
    `Seeds: ${seeds} × 4 seats = ${assignments.length} games`,
    `Opening sampling: first ${openingRandomPlies} plies from the top ${openingTopK}`,
    `Workers: ${workers}${native ? ' (native Rust engine)' : ''}`,
    `Label: ${label}`,
    '',
  ].join('\n');
  writeFileSync(summaryPath, header);
  console.log(header);

  const pool = new GamePool(workers, { native });
  const startedAt = Date.now();
  const gamesBySeed = new Map<number, RotationGame[]>();

  const outcomes = await pool.run(assignments, (outcome, done, total) => {
    if (outcome.error) {
      console.error(`game ${outcome.id} failed: ${outcome.error}`);
      return;
    }
    // Append as we go rather than after the pool drains. Long runs on this machine are routinely
    // interrupted, and a run that dies at 70% used to leave nothing at all; now the completed
    // rotations survive and `npm run aggregate` can pool them with a later run on disjoint seeds.
    {
      const [seedText, seat] = outcome.id.split(':');
      appendFileSync(
        logPath,
        `${JSON.stringify({
          seed: Number(seedText),
          seat: seat as PlayerColor,
          scores: outcome.scores,
          winner: outcome.winner,
          label,
          challenger,
          champion,
        })}\n`,
      );
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(elapsed, 1e-6);
    const eta = (total - done) / Math.max(rate, 1e-6);
    console.log(
      `${done}/${total} games — ${outcome.durationMs}ms — ${(rate * 3600).toFixed(0)} games/hr — ETA ${(eta / 60).toFixed(1)} min`,
    );
  });
  pool.close();

  for (const outcome of outcomes) {
    if (outcome.error) {
      continue;
    }
    const [seedText, seat] = outcome.id.split(':');
    const seed = Number(seedText);
    const game: RotationGame = {
      seed,
      seat: seat as PlayerColor,
      scores: outcome.scores,
      winner: outcome.winner,
    };
    const bucket = gamesBySeed.get(seed) ?? [];
    bucket.push(game);
    gamesBySeed.set(seed, bucket);
  }

  // Only complete rotations are comparable — a partial quad reintroduces the seat bias.
  for (const [seed, games] of gamesBySeed) {
    if (games.length !== PLAYER_COLORS.length) {
      gamesBySeed.delete(seed);
    }
  }

  const summary = summarizeMatch(challenger, champion, gamesBySeed);
  const text = [
    formatMatchSummary(summary),
    `Wall clock: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`,
    `Log: ${logPath}`,
  ].join('\n');

  console.log(`\n=== Result ===\n${text}`);
  appendFileSync(summaryPath, `\n=== Result ===\n${text}\n`);

  if (
    challenger === champion &&
    challengerPolicy === championPolicy &&
    Math.abs(summary.advantage.mean) > 1e-9
  ) {
    console.error(
      `\nWARNING: a mirror match must score exactly 0.00 (got ${summary.advantage.mean}). ` +
        'Something in the engine is still non-deterministic given a seed.',
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
