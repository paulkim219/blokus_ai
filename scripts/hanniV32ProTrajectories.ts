import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { GamePool, defaultWorkerCount, type GameAssignment, type GameOutcome } from './lib/pool.ts';
import { bootstrapCI, mean } from './lib/stats.ts';
import { MODELS, type ModelId } from '../site/src/data/models.ts';

/**
 * Seat-rotated vs-Hanni-3.2-Pro score trajectories for the public Pareto chart.
 *
 * The vs-Hanni-3.1 chart saturates at the top of the ladder: Hanni 4.1 Pro Max and Hanni 4.1 Ultra
 * both score about +4.8 against it despite being 1.49 points apart head-to-head. Once an engine is
 * placing ~80 of 89 squares there is little margin left to win, so the strong tiers compress into
 * each other and the chart reads as though extra compute buys nothing. A stronger reference
 * decompresses that top end.
 *
 * Unlike the vs-3.1 generator this one *does* measure the reference against itself. A seat-rotated
 * mirror match is exactly 0.00 by construction, which is the point: the reference appears on the
 * chart at zero delta with a real, identically-measured cost, so readers can see what the baseline
 * itself costs rather than inferring it.
 *
 *   node --import tsx scripts/hanniV32ProTrajectories.ts
 *   node --import tsx scripts/hanniV32ProTrajectories.ts --seeds 1 --only hanni-3-1-nano
 *   node --import tsx scripts/hanniV32ProTrajectories.ts --force
 */

const MAX_TURNS = 22;
const ITERATIONS = 300;
const SEED_BLOCK = 9_600_000;
const OPPONENT: ModelId = 'hanni-3-2-pro';
const OPPONENT_ALGO: AlgoVersionId = 'v3.2-pro';
const RESULTS_JSON = join(process.cwd(), 'selfplay-results', 'hanni-v32pro-trajectories.json');
const SITE_JSON = join(process.cwd(), 'site', 'src', 'data', 'v32ProTrajectories.json');

interface EngineSpec {
  id: ModelId;
  algoId: AlgoVersionId;
  seedBase: number;
}

/** Cheap first, legacy Pro last. Seed bases are disjoint 200-wide blocks. */
/**
 * Pro and above only.
 *
 * This chart exists to decompress the top of the ladder, and those are the configurations that
 * crowd together against Hanni 3.1. The lite and nano tiers land far below this reference and would
 * stretch the y-axis down past -15, re-compressing the very comparison the chart is for. They are
 * still measured on the vs-greedy and vs-3.1 charts; the generator is resumable, so adding them here
 * later costs only their own run time.
 */
const ENGINES: EngineSpec[] = [
  { id: 'hanni-3-1-pro', algoId: 'v3.1-pro', seedBase: SEED_BLOCK + 2000 },
  { id: 'hanni-3-7-pro', algoId: 'v3.7-pro', seedBase: SEED_BLOCK + 2200 },
  { id: 'hanni-3-5-pro', algoId: 'v3.5-pro', seedBase: SEED_BLOCK + 2400 },
  { id: 'hanni-3-2-pro', algoId: 'v3.2-pro', seedBase: SEED_BLOCK + 2600 },
  { id: 'hanni-4-1-pro', algoId: 'v4.1-pro', seedBase: SEED_BLOCK + 2800 },
  { id: 'hanni-3-7-pro-max', algoId: 'v3.7-pro-max', seedBase: SEED_BLOCK + 3200 },
  { id: 'hanni-3-1-pro-max', algoId: 'v3.1-pro-max', seedBase: SEED_BLOCK + 3600 },
  { id: 'hanni-3-2-pro-max', algoId: 'v3.2-pro-max', seedBase: SEED_BLOCK + 3800 },
  { id: 'hanni-3-6-pro-max', algoId: 'v3.6-pro-max', seedBase: SEED_BLOCK + 4000 },
  { id: 'hanni-4-1-pro-max', algoId: 'v4.1-pro-max', seedBase: SEED_BLOCK + 4200 },
  { id: 'hanni-2-pro', algoId: 'v2-pro', seedBase: SEED_BLOCK + 4400 },
  { id: 'hanni-4-1-ultra', algoId: 'v4.1-ultra', seedBase: SEED_BLOCK + 4800 },
];

export interface V32ProTrajectoryResult {
  id: ModelId;
  algoId: string;
  opponent: ModelId;
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
  opponent: ModelId;
  seeds: number;
  games: number;
  iterations: number;
  cropFrom: number;
  results: V32ProTrajectoryResult[];
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
    opponent: OPPONENT,
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

function aggregate(spec: EngineSpec, outcomes: GameOutcome[]): V32ProTrajectoryResult {
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
    opponent: OPPONENT,
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
    PLAYER_COLORS.map((color) => [color, color === seat ? hero : OPPONENT_ALGO]),
  ) as Record<PlayerColor, AlgoVersionId>;
}

async function runEngine(
  spec: EngineSpec,
  seeds: number,
  workers: number,
): Promise<V32ProTrajectoryResult> {
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
  try {
    const outcomes = await pool.run(assignments, (_outcome, done, total) => {
      if (done === total || done % 40 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        process.stdout.write(`\r  ${spec.id}  ${done}/${total}  ${elapsed.toFixed(0)}s   `);
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
  for (const spec of wanted) {
    // The reference is deliberately included: its mirror match is exactly 0.00 and supplies the
    // baseline's own cost on the same measurement basis as every other point.
    if (MODELS[spec.id] == null) {
      throw new Error(`unknown model ${spec.id}`);
    }
  }

  const force = process.argv.includes('--force');

  const payload = loadExisting();
  payload.opponent = OPPONENT;
  payload.seeds = Math.max(payload.seeds, seeds);
  payload.games = payload.seeds * 4;

  console.log(
    `Hanni vs-3.1 trajectories — ${wanted.length} engines, ${seeds} seeds × 4 seats, ` +
      `${workers} workers, base ${ITERATIONS} iterations\n` +
      `Already recorded: ${payload.results.map((row) => row.id).join(', ') || 'none'}\n`,
  );

  for (const spec of wanted) {
    if (!force && payload.results.some((row) => row.id === spec.id && row.games >= seeds * 4)) {
      console.log(`skip ${spec.id} (already recorded)`);
      continue;
    }
    console.log(`######## ${spec.id} (${spec.algoId}) vs ${OPPONENT} @ ${spec.seedBase} ########`);
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
