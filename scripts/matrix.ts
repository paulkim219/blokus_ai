import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import type { AlgoVersionId } from '../src/ai/algoVersions.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';
import { GamePool, type GameAssignment } from './lib/pool.ts';
import { summarizeMatch, type RotationGame } from './lib/stats.ts';

/**
 * Full round-robin: every version as a sole challenger against three clones of every version.
 *
 * The matrix is *not* antisymmetric — "A against three B" and "B against three A" are different
 * games, not sign flips of one number — so all N² cells are real measurements. The diagonal is the
 * exception: a mirror match is exactly 0.00 by construction (`summarizeMatch`'s null), so it is
 * filled in rather than played, which also skips the single most expensive cell on the board.
 *
 * Cells are ordered cheapest-first and each is written to the output JSON the moment it lands, so an
 * interrupted run leaves a usable partial matrix rather than nothing. Re-running skips cells that
 * are already present at the requested seed count.
 *
 *   npm run matrix -- --seeds 100 --iterations 300
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

/** Measured cost per move at 300 iterations, used only to order the work cheapest-first. */
const MS_PER_MOVE: Record<string, number> = {
  greedy: 1.8,
  v1: 279,
  'v2-lite': 271,
  'v2-pro': 732,
  v3: 41,
  'v3.1-lite': 43,
  'v3.1': 56,
};

interface Cell {
  challenger: string;
  champion: string;
  seeds: number;
  games: number;
  advantage: number;
  low: number;
  high: number;
  significant: boolean;
  meanChallengerScore: number;
  firstPlaceRate: number;
  soleWinRate: number;
  perSeatAdvantage: Record<string, number>;
  meanGameMs: number;
  wallMinutes: number;
}

interface Matrix {
  versions: string[];
  policy: string;
  iterations: number | null;
  seedBase: number;
  requestedSeeds: number;
  updated: string;
  cells: Record<string, Cell>;
}

const key = (challenger: string, champion: string): string => `${challenger}|${champion}`;

/** A version id that is really the greedy *policy* over the champion evaluation, not a version. */
const GREEDY = 'greedy';

async function main(): Promise<void> {
  const versions = (arg('versions', 'greedy,v1,v2-lite,v2-pro,v3,v3.1-lite,v3.1') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const seeds = Math.max(1, Number(arg('seeds', '100')));
  const seedBase = Number(arg('seed-base', '3300000'));
  const workers = Math.max(1, Number(arg('workers', '9')));
  const iterationsRaw = arg('iterations', '300');
  const iterationBudget = iterationsRaw ? Number(iterationsRaw) : undefined;
  const openingRandomPlies = Number(arg('opening-random-plies', '8'));
  const openingTopK = Number(arg('opening-top-k', '3'));

  const outDir = join(process.cwd(), 'selfplay-results');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, arg('out', 'matrix.json') ?? 'matrix.json');

  const matrix: Matrix = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf8')) as Matrix)
    : {
        versions,
        policy: 'mcts-bench',
        iterations: iterationBudget ?? null,
        seedBase,
        requestedSeeds: seeds,
        updated: new Date().toISOString(),
        cells: {},
      };
  matrix.versions = versions;
  matrix.requestedSeeds = seeds;

  // The diagonal is the harness's own null: identical players on identical seeds cancel exactly.
  for (const v of versions) {
    matrix.cells[key(v, v)] = {
      challenger: v,
      champion: v,
      seeds,
      games: 0,
      advantage: 0,
      low: 0,
      high: 0,
      significant: false,
      meanChallengerScore: Number.NaN,
      firstPlaceRate: 0.25,
      soleWinRate: Number.NaN,
      perSeatAdvantage: {},
      meanGameMs: Number.NaN,
      wallMinutes: 0,
    };
  }

  // `--pairs "a>b,c>d"` restricts the run to named cells and *ignores* the already-played check, so
  // a cell filled at low precision can be re-played at a higher seed count without re-playing the
  // other forty. Without it a second pass at a larger `--seeds` would redo the entire matrix.
  const only = (arg('pairs') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split('>').map((v) => v.trim()));
  const onlySet = new Set(only.map(([a, b]) => key(a, b)));

  const pending: Array<{ challenger: string; champion: string; cost: number }> = [];
  for (const challenger of versions) {
    for (const champion of versions) {
      if (challenger === champion) {
        continue;
      }
      if (onlySet.size > 0) {
        if (!onlySet.has(key(challenger, champion))) {
          continue;
        }
      } else {
        const done = matrix.cells[key(challenger, champion)];
        if (done && done.games > 0 && done.seeds >= seeds) {
          continue;
        }
      }
      pending.push({
        challenger,
        champion,
        cost: (MS_PER_MOVE[challenger] ?? 100) + 3 * (MS_PER_MOVE[champion] ?? 100),
      });
    }
  }
  // Cheapest first: the fast engines' whole sub-matrix lands in the first hour, so an interrupted
  // run still yields a complete, readable block rather than a scatter of unrelated cells.
  pending.sort((a, b) => a.cost - b.cost);

  const totalCost = pending.reduce((sum, p) => sum + p.cost, 0);
  const estHours = (seeds * 4 * 21 * totalCost) / 1000 / workers / 3600;
  console.log(
    `Round-robin matrix — ${versions.length} versions, ${pending.length} cells to play, ` +
      `${seeds} seeds × 4 seats = ${seeds * 4} games each\n` +
      `Budget: ${iterationBudget ?? 'time-based'} iterations/move, ${workers} workers\n` +
      `Rough estimate: ${estHours.toFixed(1)} h total\nOutput: ${outPath}\n`,
  );

  const pool = new GamePool(workers);
  let index = 0;

  for (const { challenger, champion } of pending) {
    index += 1;
    const started = Date.now();
    // "greedy" is a policy, not an algorithm: it is the champion evaluation with no tree at all.
    // Model it as the seat playing `--policy greedy` while everyone else searches, which is what
    // the trajectory runs already did, so the numbers are comparable to those.
    const assignments: GameAssignment[] = [];
    for (let i = 0; i < seeds; i += 1) {
      const seed = seedBase + i;
      for (const seat of PLAYER_COLORS) {
        const seatVersions = Object.fromEntries(
          PLAYER_COLORS.map((color) => {
            const who = color === seat ? challenger : champion;
            return [color, (who === GREEDY ? 'v1' : who) as AlgoVersionId];
          }),
        ) as Record<PlayerColor, AlgoVersionId>;
        const policies = Object.fromEntries(
          PLAYER_COLORS.map((color) => {
            const who = color === seat ? challenger : champion;
            return [color, (who === GREEDY ? 'greedy' : 'mcts-bench') as PolicyId];
          }),
        ) as Record<PlayerColor, PolicyId>;
        assignments.push({
          id: `${seed}:${seat}`,
          seatVersions,
          seatPolicies: policies,
          seed,
          iterationBudget,
          openingRandomPlies,
          openingTopK,
        });
      }
    }

    let lastLog = 0;
    const outcomes = await pool.run(assignments, (_outcome, done, total) => {
      const now = Date.now();
      if (now - lastLog < 20_000 && done !== total) {
        return;
      }
      lastLog = now;
      const elapsed = (now - started) / 1000;
      const eta = ((total - done) / Math.max(done / Math.max(elapsed, 1e-6), 1e-6)) / 60;
      console.log(
        `  [${index}/${pending.length}] ${challenger} vs 3× ${champion} — ` +
          `${done}/${total} games, ETA ${eta.toFixed(1)} min`,
      );
    });

    const gamesBySeed = new Map<number, RotationGame[]>();
    let gameCount = 0;
    let msTotal = 0;
    for (const outcome of outcomes) {
      if (outcome.error) {
        continue;
      }
      const [seedText, seat] = outcome.id.split(':');
      const seed = Number(seedText);
      const bucket = gamesBySeed.get(seed) ?? [];
      bucket.push({
        seed,
        seat: seat as PlayerColor,
        scores: outcome.scores,
        winner: outcome.winner,
      });
      gamesBySeed.set(seed, bucket);
      msTotal += outcome.durationMs;
      gameCount += 1;
    }
    for (const [seed, games] of gamesBySeed) {
      if (games.length !== PLAYER_COLORS.length) {
        gamesBySeed.delete(seed);
      }
    }
    if (gamesBySeed.size === 0) {
      console.error(`  !! ${challenger} vs ${champion} produced no complete rotations`);
      continue;
    }

    const summary = summarizeMatch(
      challenger as AlgoVersionId,
      champion as AlgoVersionId,
      gamesBySeed,
    );
    const wallMinutes = (Date.now() - started) / 60_000;

    matrix.cells[key(challenger, champion)] = {
      challenger,
      champion,
      seeds: gamesBySeed.size,
      games: gamesBySeed.size * 4,
      advantage: summary.advantage.mean,
      low: summary.advantage.low,
      high: summary.advantage.high,
      significant: summary.advantage.significant,
      meanChallengerScore: summary.meanChallengerScore,
      firstPlaceRate: summary.firstPlaceRate,
      soleWinRate: summary.soleWinRate,
      perSeatAdvantage: summary.perSeatAdvantage,
      meanGameMs: msTotal / Math.max(gameCount, 1),
      wallMinutes,
    };
    matrix.updated = new Date().toISOString();
    writeFileSync(outPath, `${JSON.stringify(matrix, null, 2)}\n`);

    console.log(
      `  [${index}/${pending.length}] ${challenger} vs 3× ${champion} = ` +
        `${summary.advantage.mean.toFixed(2)} [${summary.advantage.low.toFixed(2)}, ` +
        `${summary.advantage.high.toFixed(2)}] · ${gamesBySeed.size * 4} games · ` +
        `${wallMinutes.toFixed(1)} min\n`,
    );
  }

  pool.close();
  console.log(`\nMatrix complete — ${Object.keys(matrix.cells).length} cells in ${outPath}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
