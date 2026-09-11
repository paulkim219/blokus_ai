import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { GamePool, defaultWorkerCount, type GameAssignment, type GameOutcome } from './lib/pool.ts';
import { bootstrapCI, mean } from './lib/stats.ts';
import { MODELS, type ModelId } from '../site/src/data/models.ts';

/**
 * Seat-rotated vs-predecessor score trajectories for the public Hanni charts.
 *
 * Each pair is 100 seeds × 4 seats = 400 games, hero searching vs three searching predecessor
 * seats. Cheap pairs first; anything versus Hanni 2 Pro last.
 *
 *   node --import tsx scripts/hanniPredecessorTrajectories.ts
 *   node --import tsx scripts/hanniPredecessorTrajectories.ts --seeds 1 --only hanni-3-1-lite:hanni-3-1-nano
 */

const MAX_TURNS = 22;
const ITERATIONS = 300;
const SEED_BLOCK = 9_300_000;
const RESULTS_JSON = join(process.cwd(), 'selfplay-results', 'hanni-predecessor-trajectories.json');
const SITE_JSON = join(process.cwd(), 'site', 'src', 'data', 'predecessorTrajectories.json');

interface PairSpec {
  challenger: ModelId;
  opponent: ModelId;
  seedBase: number;
}

const PAIRS: PairSpec[] = [
  { challenger: 'hanni-3-1-lite', opponent: 'hanni-3-1-nano', seedBase: SEED_BLOCK },
  { challenger: 'hanni-3-1', opponent: 'hanni-3-1-lite', seedBase: SEED_BLOCK + 200 },
  { challenger: 'hanni-3-1-pro', opponent: 'hanni-3-1', seedBase: SEED_BLOCK + 400 },
  { challenger: 'hanni-3-1-pro-max', opponent: 'hanni-3-1-pro', seedBase: SEED_BLOCK + 600 },
  { challenger: 'hanni-3-2', opponent: 'hanni-3-1', seedBase: SEED_BLOCK + 800 },
  { challenger: 'hanni-3-2-pro', opponent: 'hanni-3-1-pro', seedBase: SEED_BLOCK + 1000 },
  { challenger: 'hanni-3-2-pro-max', opponent: 'hanni-3-1-pro-max', seedBase: SEED_BLOCK + 1200 },
  { challenger: 'hanni-2-lite', opponent: 'hanni-1', seedBase: SEED_BLOCK + 1400 },
  { challenger: 'hanni-3-1-nano', opponent: 'hanni-1', seedBase: SEED_BLOCK + 1600 },
  { challenger: 'hanni-3-1-nano', opponent: 'hanni-2-lite', seedBase: SEED_BLOCK + 1800 },
  { challenger: 'hanni-3-1-lite', opponent: 'hanni-2-lite', seedBase: SEED_BLOCK + 2000 },
  { challenger: 'hanni-3-1', opponent: 'hanni-2-lite', seedBase: SEED_BLOCK + 2200 },
  { challenger: 'hanni-3-2', opponent: 'hanni-2-lite', seedBase: SEED_BLOCK + 2400 },
  { challenger: 'hanni-2-pro', opponent: 'hanni-1', seedBase: SEED_BLOCK + 2600 },
  { challenger: 'hanni-2-pro', opponent: 'hanni-2-lite', seedBase: SEED_BLOCK + 2800 },
  { challenger: 'hanni-3-1-pro', opponent: 'hanni-2-pro', seedBase: SEED_BLOCK + 3000 },
  { challenger: 'hanni-3-1-pro-max', opponent: 'hanni-2-pro', seedBase: SEED_BLOCK + 3200 },
  { challenger: 'hanni-3-2-pro', opponent: 'hanni-2-pro', seedBase: SEED_BLOCK + 3400 },
  { challenger: 'hanni-3-2-pro-max', opponent: 'hanni-2-pro', seedBase: SEED_BLOCK + 3600 },
  // The move-curve generation, each against the tier it was actually promoted over. Cheap first.
  { challenger: 'hanni-3-5-lite', opponent: 'hanni-3-2-lite', seedBase: SEED_BLOCK + 3800 },
  { challenger: 'hanni-3-5', opponent: 'hanni-3-2', seedBase: SEED_BLOCK + 4000 },
  { challenger: 'hanni-3-5-pro', opponent: 'hanni-3-2-pro', seedBase: SEED_BLOCK + 4200 },
  { challenger: 'hanni-3-6-pro-max', opponent: 'hanni-3-2-pro-max', seedBase: SEED_BLOCK + 4400 },
  { challenger: 'hanni-4-1-lite', opponent: 'hanni-3-1-lite', seedBase: SEED_BLOCK + 4600 },
  { challenger: 'hanni-4-1', opponent: 'hanni-3-1', seedBase: SEED_BLOCK + 4800 },
  { challenger: 'hanni-4-1-pro', opponent: 'hanni-3-1-pro', seedBase: SEED_BLOCK + 5000 },
  { challenger: 'hanni-4-1-pro-max', opponent: 'hanni-3-1-pro-max', seedBase: SEED_BLOCK + 5200 },
];

export interface PredecessorTrajectoryResult {
  id: ModelId;
  challenger: ModelId;
  opponent: ModelId;
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
  results: PredecessorTrajectoryResult[];
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function keyOf(spec: PairSpec): string {
  return `${spec.challenger}:${spec.opponent}`;
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
    cropFrom: 16,
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

function aggregate(spec: PairSpec, outcomes: GameOutcome[]): PredecessorTrajectoryResult {
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
    id: spec.challenger,
    challenger: spec.challenger,
    opponent: spec.opponent,
    algoId: MODELS[spec.challenger].algoId,
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

function seatAssignment(
  hero: AlgoVersionId,
  opponent: AlgoVersionId,
  seat: PlayerColor,
): Record<PlayerColor, AlgoVersionId> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, color === seat ? hero : opponent]),
  ) as Record<PlayerColor, AlgoVersionId>;
}

async function runPair(
  spec: PairSpec,
  seeds: number,
  workers: number,
): Promise<PredecessorTrajectoryResult> {
  const heroAlgo = MODELS[spec.challenger].algoId;
  const oppAlgo = MODELS[spec.opponent].algoId;
  if (!isAlgoVersionId(heroAlgo) || !isAlgoVersionId(oppAlgo)) {
    throw new Error(`unknown algo id ${heroAlgo} or ${oppAlgo}`);
  }

  const assignments: GameAssignment[] = [];
  for (let i = 0; i < seeds; i += 1) {
    const seed = spec.seedBase + i;
    for (const seat of PLAYER_COLORS) {
      assignments.push({
        id: `${seed}:${seat}`,
        seatVersions: seatAssignment(heroAlgo, oppAlgo, seat),
        seatPolicies: Object.fromEntries(
          PLAYER_COLORS.map((color) => [color, 'mcts-bench']),
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
  const label = keyOf(spec);
  try {
    const outcomes = await pool.run(assignments, (_outcome, done, total) => {
      if (done === total || done % 40 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        process.stdout.write(`\r  ${label}  ${done}/${total}  ${elapsed.toFixed(0)}s   `);
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
  const wanted = only ? PAIRS.filter((pair) => keyOf(pair) === only) : PAIRS;
  if (only && wanted.length === 0) {
    throw new Error(`unknown --only ${only}`);
  }

  const payload = loadExisting();
  payload.seeds = Math.max(payload.seeds, seeds);
  payload.games = payload.seeds * 4;

  console.log(
    `Hanni vs-predecessor trajectories — ${wanted.length} pairs, ${seeds} seeds × 4 seats, ` +
      `${workers} workers, base ${ITERATIONS} iterations\n` +
      `Already recorded: ${payload.results.map((row) => `${row.challenger}:${row.opponent}`).join(', ') || 'none'}\n`,
  );

  for (const spec of wanted) {
    if (
      payload.results.some(
        (row) =>
          row.challenger === spec.challenger &&
          row.opponent === spec.opponent &&
          row.games >= seeds * 4,
      )
    ) {
      console.log(`skip ${keyOf(spec)} (already recorded)`);
      continue;
    }
    console.log(`######## ${keyOf(spec)} @ ${spec.seedBase} ########`);
    const started = Date.now();
    const result = await runPair(spec, seeds, workers);
    payload.results = payload.results.filter(
      (row) => !(row.challenger === spec.challenger && row.opponent === spec.opponent),
    );
    payload.results.push(result);
    writePayload(payload);
    console.log(
      `  ${keyOf(spec)}: Δ ${result.finalDelta.toFixed(2)} ` +
        `[${result.finalCi[0].toFixed(2)}, ${result.finalCi[1].toFixed(2)}]  ` +
        `${result.heroMsPerMove.toFixed(0)} ms/move  ` +
        `${result.games} games  ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
    );
  }

  writePayload(payload);
  console.log(`wrote ${SITE_JSON} (${payload.results.length} pairs)`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
