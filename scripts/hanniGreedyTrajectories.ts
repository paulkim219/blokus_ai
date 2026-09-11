import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { GamePool, defaultWorkerCount, type GameAssignment, type GameOutcome } from './lib/pool.ts';
import { bootstrapCI, mean } from './lib/stats.ts';
import type { ModelId } from '../site/src/data/models.ts';

/**
 * Seat-rotated vs-greedy score trajectories for the public Hanni charts.
 *
 * Each engine plays 100 seeds × 4 seats = 400 games against three one-ply greedy (v1) seats.
 * Scores are sampled on the searching seat's own turns, then carried forward to length 22 so a
 * short game does not drop out of the tail. Cheap engines first; Hanni 2 Pro last.
 *
 *   node --import tsx scripts/hanniGreedyTrajectories.ts
 *   node --import tsx scripts/hanniGreedyTrajectories.ts --seeds 1 --only hanni-3-1-nano
 *   node --import tsx scripts/hanniGreedyTrajectories.ts --force   # re-measure after an engine change
 */

const MAX_TURNS = 22;
const ITERATIONS = 300;
const SEED_BLOCK = 9_200_000;
const RESULTS_JSON = join(process.cwd(), 'selfplay-results', 'hanni-greedy-trajectories.json');
const SITE_JSON = join(process.cwd(), 'site', 'src', 'data', 'greedyTrajectories.json');

interface EngineSpec {
  id: ModelId;
  algoId: AlgoVersionId;
  seedBase: number;
}

/** Cheap first, legacy Pro last. Seed bases are disjoint 200-wide blocks. */
const ENGINES: EngineSpec[] = [
  { id: 'hanni-3-1-nano', algoId: 'v3.1-nano', seedBase: SEED_BLOCK },
  { id: 'hanni-3-1-lite', algoId: 'v3.1-lite', seedBase: SEED_BLOCK + 200 },
  { id: 'hanni-1', algoId: 'v1', seedBase: SEED_BLOCK + 400 },
  { id: 'hanni-2-lite', algoId: 'v2-lite', seedBase: SEED_BLOCK + 600 },
  { id: 'hanni-3-1', algoId: 'v3.1', seedBase: SEED_BLOCK + 800 },
  { id: 'hanni-3-2', algoId: 'v3.2', seedBase: SEED_BLOCK + 1000 },
  { id: 'hanni-3-1-pro', algoId: 'v3.1-pro', seedBase: SEED_BLOCK + 1200 },
  { id: 'hanni-3-2-pro', algoId: 'v3.2-pro', seedBase: SEED_BLOCK + 1400 },
  { id: 'hanni-3-1-pro-max', algoId: 'v3.1-pro-max', seedBase: SEED_BLOCK + 1600 },
  { id: 'hanni-3-2-pro-max', algoId: 'v3.2-pro-max', seedBase: SEED_BLOCK + 1800 },
  { id: 'hanni-2-pro', algoId: 'v2-pro', seedBase: SEED_BLOCK + 2000 },
  { id: 'hanni-3-2-lite', algoId: 'v3.2-lite', seedBase: SEED_BLOCK + 3000 },
  // The move-curve generation. Cheap first, as above.
  { id: 'hanni-3-5-lite', algoId: 'v3.5-lite', seedBase: SEED_BLOCK + 2200 },
  { id: 'hanni-3-5', algoId: 'v3.5', seedBase: SEED_BLOCK + 2400 },
  { id: 'hanni-3-5-pro', algoId: 'v3.5-pro', seedBase: SEED_BLOCK + 2600 },
  { id: 'hanni-3-6-pro-max', algoId: 'v3.6-pro-max', seedBase: SEED_BLOCK + 2800 },
  // The no-opening-search generation.
  { id: 'hanni-3-7-lite', algoId: 'v3.7-lite', seedBase: SEED_BLOCK + 3200 },
  { id: 'hanni-3-7', algoId: 'v3.7', seedBase: SEED_BLOCK + 3400 },
  { id: 'hanni-3-7-pro', algoId: 'v3.7-pro', seedBase: SEED_BLOCK + 3600 },
  { id: 'hanni-3-7-pro-max', algoId: 'v3.7-pro-max', seedBase: SEED_BLOCK + 3800 },
  { id: 'hanni-4-1-lite', algoId: 'v4.1-lite', seedBase: SEED_BLOCK + 4000 },
  { id: 'hanni-4-1', algoId: 'v4.1', seedBase: SEED_BLOCK + 4200 },
  { id: 'hanni-4-1-pro', algoId: 'v4.1-pro', seedBase: SEED_BLOCK + 4400 },
  { id: 'hanni-4-1-pro-max', algoId: 'v4.1-pro-max', seedBase: SEED_BLOCK + 4600 },
  { id: 'hanni-4-1-ultra', algoId: 'v4.1-ultra', seedBase: SEED_BLOCK + 4800 },
];

export interface GreedyTrajectoryResult {
  id: ModelId;
  algoId: string;
  games: number;
  seeds: number;
  turns: number;
  delta: number[];
  deltaLow: number[];
  deltaHigh: number[];
  heroMsPerMove: number;
  finalDelta: number;
  finalCi: [number, number];
  finishedAt: string;
}

interface FilePayload {
  protocol: 'post-2026-08-17';
  seeds: number;
  games: number;
  iterations: number;
  cropFrom: number;
  results: GreedyTrajectoryResult[];
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function loadExisting(): FilePayload {
  try {
    const parsed = JSON.parse(readFileSync(RESULTS_JSON, 'utf8')) as FilePayload;
    if (parsed && Array.isArray(parsed.results)) {
      return parsed;
    }
  } catch {
    // first run
  }
  return emptyPayload(100);
}

function emptyPayload(seeds: number): FilePayload {
  return {
    protocol: 'post-2026-08-17',
    seeds,
    games: seeds * 4,
    iterations: ITERATIONS,
    cropFrom: 12,
    results: [],
  };
}

function writePayload(payload: FilePayload): void {
  mkdirSync(join(process.cwd(), 'selfplay-results'), { recursive: true });
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(RESULTS_JSON, text);
  writeFileSync(SITE_JSON, text);
}

function padTrace(
  hero: number[],
  opponents: number[],
  finalHero: number,
  finalOpp: number,
): { hero: number[]; opponents: number[] } {
  const paddedHero: number[] = [];
  const paddedOpp: number[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    paddedHero.push(turn < hero.length ? hero[turn]! : finalHero);
    paddedOpp.push(turn < opponents.length ? opponents[turn]! : finalOpp);
  }
  return { hero: paddedHero, opponents: paddedOpp };
}

function finalOpponentMean(scores: GameOutcome['scores'], seat: PlayerColor): number {
  return (
    PLAYER_COLORS.filter((color) => color !== seat).reduce((sum, color) => sum + scores[color], 0) /
    3
  );
}

function aggregate(
  spec: EngineSpec,
  outcomes: GameOutcome[],
): GreedyTrajectoryResult {
  const bySeed = new Map<number, Array<{ delta: number[] }>>();
  let heroMs = 0;
  let heroMoves = 0;
  let games = 0;

  for (const outcome of outcomes) {
    if (outcome.error || !outcome.scoreTrace) {
      continue;
    }
    const [seedText, seatText] = outcome.id.split(':');
    const seed = Number(seedText);
    const seat = seatText as PlayerColor;
    const padded = padTrace(
      outcome.scoreTrace.hero,
      outcome.scoreTrace.opponents,
      outcome.scores[seat],
      finalOpponentMean(outcome.scores, seat),
    );
    const delta = padded.hero.map((value, turn) => value - padded.opponents[turn]!);
    const bucket = bySeed.get(seed) ?? [];
    bucket.push({ delta });
    bySeed.set(seed, bucket);
    heroMs += outcome.scoreTrace.heroMs;
    heroMoves += outcome.scoreTrace.heroMoves;
    games += 1;
  }

  const delta: number[] = [];
  const deltaLow: number[] = [];
  const deltaHigh: number[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const perSeed: number[] = [];
    for (const rotations of bySeed.values()) {
      perSeed.push(mean(rotations.map((game) => game.delta[turn]!)));
    }
    const interval = bootstrapCI(perSeed);
    delta.push(interval.mean);
    deltaLow.push(interval.low);
    deltaHigh.push(interval.high);
  }

  const last = MAX_TURNS - 1;
  return {
    id: spec.id,
    algoId: spec.algoId,
    games,
    seeds: bySeed.size,
    turns: MAX_TURNS,
    delta,
    deltaLow,
    deltaHigh,
    heroMsPerMove: heroMoves > 0 ? heroMs / heroMoves : 0,
    finalDelta: delta[last] ?? 0,
    finalCi: [deltaLow[last] ?? 0, deltaHigh[last] ?? 0],
    finishedAt: new Date().toISOString(),
  };
}

function seatAssignment(hero: AlgoVersionId, seat: PlayerColor): Record<PlayerColor, AlgoVersionId> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, color === seat ? hero : 'v1']),
  ) as Record<PlayerColor, AlgoVersionId>;
}

async function runEngine(
  spec: EngineSpec,
  seeds: number,
  workers: number,
): Promise<GreedyTrajectoryResult> {
  if (!isAlgoVersionId(spec.algoId)) {
    throw new Error(`unknown algo id ${spec.algoId}`);
  }

  const assignments: GameAssignment[] = [];
  for (let i = 0; i < seeds; i += 1) {
    const seed = spec.seedBase + i;
    for (const seat of PLAYER_COLORS) {
      assignments.push({
        id: `${seed}:${seat}`,
        seatVersions: seatAssignment(spec.algoId, seat),
        seatPolicies: Object.fromEntries(
          PLAYER_COLORS.map((color) => [color, color === seat ? 'mcts-bench' : 'greedy']),
        ) as GameAssignment['seatPolicies'],
        seed,
        iterationBudget: ITERATIONS,
        openingRandomPlies: 8,
        openingTopK: 3,
        traceSeat: seat,
      });
    }
  }

  const pool = new GamePool(workers);
  const started = Date.now();
  try {
    const outcomes = await pool.run(assignments, (_outcome, done, total) => {
      if (done === total || done % 40 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        process.stdout.write(
          `\r  ${spec.id}  ${done}/${total}  ${elapsed.toFixed(0)}s   `,
        );
      }
    });
    process.stdout.write('\n');
    const failed = outcomes.filter((outcome) => outcome.error);
    if (failed.length > 0) {
      console.error(`  ${failed.length} games failed; first: ${failed[0]?.error}`);
    }
    return aggregate(spec, outcomes);
  } finally {
    pool.close();
  }
}

async function main(): Promise<void> {
  const seeds = Math.max(1, Number(arg('seeds', '100')));
  const workers = Math.max(1, Number(arg('workers', String(defaultWorkerCount()))));
  const only = arg('only');
  const wanted = only ? ENGINES.filter((engine) => engine.id === only) : ENGINES;
  if (only && wanted.length === 0) {
    throw new Error(`unknown --only ${only}`);
  }

  // Resumability is the default, but it silently blocks the case this script exists to serve after
  // an engine change: every row is "already recorded" at full game count, so a re-measurement does
  // nothing and the published ms/move keeps describing an engine that no longer exists.
  const force = process.argv.includes('--force');

  const payload = loadExisting();
  payload.seeds = Math.max(payload.seeds, seeds);
  payload.games = payload.seeds * 4;

  console.log(
    `Hanni vs-greedy trajectories — ${wanted.length} engines, ${seeds} seeds × 4 seats, ` +
      `${workers} workers, base ${ITERATIONS} iterations\n` +
      `Already recorded: ${payload.results.map((row) => row.id).join(', ') || 'none'}\n`,
  );

  for (const spec of wanted) {
    if (!force && payload.results.some((row) => row.id === spec.id && row.games >= seeds * 4)) {
      console.log(`skip ${spec.id} (already recorded)`);
      continue;
    }
    console.log(`######## ${spec.id} (${spec.algoId}) @ ${spec.seedBase} ########`);
    const started = Date.now();
    const result = await runEngine(spec, seeds, workers);
    payload.results = payload.results.filter((row) => row.id !== spec.id);
    payload.results.push(result);
    writePayload(payload);
    console.log(
      `  ${spec.id}: Δ ${result.finalDelta.toFixed(2)} ` +
        `[${result.finalCi[0].toFixed(2)}, ${result.finalCi[1].toFixed(2)}]  ` +
        `${result.heroMsPerMove.toFixed(0)} ms/move  ` +
        `${result.games} games  ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
    );
  }

  writePayload(payload);
  console.log(`wrote ${SITE_JSON} (${payload.results.length} engines)`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
