import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import type { AlgoVersionId } from '../src/ai/algoVersions.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';
import {
  GamePool,
  defaultWorkerCount,
  type GameAssignment,
  type GameOutcome,
} from './lib/pool.ts';
import {
  summarizeMatch,
  type MatchSummary,
  type RotationGame,
} from './lib/stats.ts';

const COUNTERFACTUAL = process.argv.includes('--counterfactual');
const TERMINAL = !COUNTERFACTUAL && process.argv.includes('--terminal');
const PERSONALIZED = COUNTERFACTUAL
  ? 'v5-oracle-counterfactual'
  : TERMINAL
    ? 'v5-oracle-terminal'
    : 'v5-oracle-one-lap';
const FIXED = COUNTERFACTUAL
  ? 'v5-oracle-counterfactual-fixed'
  : TERMINAL
    ? 'v5-oracle-terminal-fixed'
    : 'v5-oracle-one-lap-fixed';
const SHUFFLED = COUNTERFACTUAL
  ? 'v5-oracle-counterfactual-shuffled'
  : TERMINAL
    ? 'v5-oracle-terminal-shuffled'
    : 'v5-oracle-one-lap-shuffled';
const BASELINE = 'v4.1';
const BUDGET_ONLY = 'v5-oracle-budget65';
const COST_SEED_BASE = COUNTERFACTUAL
  ? 52_100_000
  : TERMINAL
    ? 52_000_000
    : 51_900_000;

interface CostSummary {
  games: number;
  moves: number;
  msPerMove: number;
  oracleCalls: number;
  activeCalls: number;
  rerankedCalls: number;
  changedMoves: number;
  changedRate: number;
  responseMsPerActiveCall: number;
  leafEvaluationsPerActiveCall: number;
  continuationRolloutsPerActiveCall: number;
}

interface ScreenSummary {
  label: string;
  match: MatchSummary;
  challengerMsPerMove: number;
  completedGames: number;
  requestedGames: number;
  oracleCalls: number;
  activeCalls: number;
  changedMoves: number;
}

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  const parsed = at >= 0 ? Number(process.argv[at + 1]) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function policies(): Record<PlayerColor, PolicyId> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, 'mcts-bench']),
  ) as Record<PlayerColor, PolicyId>;
}

function allSeats(version: AlgoVersionId): Record<PlayerColor, AlgoVersionId> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, version]),
  ) as Record<PlayerColor, AlgoVersionId>;
}

function versus(
  challenger: AlgoVersionId,
  champion: AlgoVersionId,
  seat: PlayerColor,
): Record<PlayerColor, AlgoVersionId> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, color === seat ? challenger : champion]),
  ) as Record<PlayerColor, AlgoVersionId>;
}

function commonAssignment(
  id: string,
  seatVersions: Record<PlayerColor, AlgoVersionId>,
  seed: number,
  iterations: number,
): GameAssignment {
  return {
    id,
    seatVersions,
    seatPolicies: policies(),
    seed,
    iterationBudget: iterations,
    openingRandomPlies: 8,
    openingTopK: 3,
    oracleDiagnostics: true,
  };
}

function costAssignments(seeds: number, iterations: number): GameAssignment[] {
  const assignments: GameAssignment[] = [];
  for (let index = 0; index < seeds; index += 1) {
    const seed = COST_SEED_BASE + index;
    assignments.push(
      commonAssignment(`cost|baseline|${seed}`, allSeats(BASELINE), seed, iterations),
      commonAssignment(`cost|oracle|${seed}`, allSeats(PERSONALIZED), seed, iterations),
    );
  }
  return assignments;
}

function screenAssignments(
  label: string,
  challenger: AlgoVersionId,
  champion: AlgoVersionId,
  seedBase: number,
  seeds: number,
  iterations: number,
): GameAssignment[] {
  const assignments: GameAssignment[] = [];
  for (let index = 0; index < seeds; index += 1) {
    const seed = seedBase + index;
    for (const seat of PLAYER_COLORS) {
      assignments.push({
        ...commonAssignment(
          `screen|${label}|${seed}|${seat}`,
          versus(challenger, champion, seat),
          seed,
          iterations,
        ),
        traceSeat: seat,
      });
    }
  }
  return assignments;
}

function summarizeCost(outcomes: GameOutcome[]): CostSummary {
  const usable = outcomes.filter((outcome) => !outcome.error);
  const diagnostics = usable.flatMap((outcome) =>
    outcome.oracleSearch ? [outcome.oracleSearch] : [],
  );
  const moves = usable.reduce((sum, outcome) => sum + outcome.plies, 0);
  const activeCalls = diagnostics.reduce((sum, row) => sum + row.activeCalls, 0);
  const changedMoves = diagnostics.reduce((sum, row) => sum + row.changedMoves, 0);
  return {
    games: usable.length,
    moves,
    msPerMove:
      usable.reduce((sum, outcome) => sum + outcome.durationMs, 0) / Math.max(1, moves),
    oracleCalls: diagnostics.reduce((sum, row) => sum + row.calls, 0),
    activeCalls,
    rerankedCalls: diagnostics.reduce((sum, row) => sum + row.rerankedCalls, 0),
    changedMoves,
    changedRate: changedMoves / Math.max(1, activeCalls),
    responseMsPerActiveCall:
      diagnostics.reduce((sum, row) => sum + row.responseMs, 0) / Math.max(1, activeCalls),
    leafEvaluationsPerActiveCall:
      diagnostics.reduce((sum, row) => sum + row.leafEvaluations, 0) /
      Math.max(1, activeCalls),
    continuationRolloutsPerActiveCall:
      diagnostics.reduce((sum, row) => sum + row.continuationRollouts, 0) /
      Math.max(1, activeCalls),
  };
}

function summarizeScreen(
  label: string,
  challenger: AlgoVersionId,
  champion: AlgoVersionId,
  outcomes: GameOutcome[],
  requestedGames: number,
): ScreenSummary {
  const usable = outcomes.filter((outcome) => !outcome.error);
  const gamesBySeed = new Map<number, RotationGame[]>();
  for (const outcome of usable) {
    const [, , seedText, seatText] = outcome.id.split('|');
    const seed = Number(seedText);
    const game: RotationGame = {
      seed,
      seat: seatText as PlayerColor,
      scores: outcome.scores,
      winner: outcome.winner,
    };
    const bucket = gamesBySeed.get(seed) ?? [];
    bucket.push(game);
    gamesBySeed.set(seed, bucket);
  }
  const diagnostics = usable.flatMap((outcome) =>
    outcome.oracleSearch ? [outcome.oracleSearch] : [],
  );
  const heroMoves = usable.reduce(
    (sum, outcome) => sum + (outcome.scoreTrace?.heroMoves ?? 0),
    0,
  );
  return {
    label,
    match: summarizeMatch(challenger, champion, gamesBySeed),
    challengerMsPerMove:
      usable.reduce((sum, outcome) => sum + (outcome.scoreTrace?.heroMs ?? 0), 0) /
      Math.max(1, heroMoves),
    completedGames: usable.length,
    requestedGames,
    oracleCalls: diagnostics.reduce((sum, row) => sum + row.calls, 0),
    activeCalls: diagnostics.reduce((sum, row) => sum + row.activeCalls, 0),
    changedMoves: diagnostics.reduce((sum, row) => sum + row.changedMoves, 0),
  };
}

async function run(
  pool: GamePool,
  label: string,
  assignments: GameAssignment[],
): Promise<GameOutcome[]> {
  const started = Date.now();
  console.log(`\n${label}: ${assignments.length} games`);
  return pool.run(assignments, (outcome, done, total) => {
    if (outcome.error) {
      console.error(`\n${outcome.id}: ${outcome.error}`);
    }
    if (done % 4 === 0 || done === total) {
      process.stdout.write(
        `\r  ${done}/${total} games  ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      if (done === total) process.stdout.write('\n');
    }
  });
}

async function main(): Promise<void> {
  const costSeeds = arg('cost-seeds', 6);
  const screenSeeds = arg('screen-seeds', 12);
  const iterations = arg('iterations', 60);
  const workers = arg('workers', defaultWorkerCount());
  console.log(
    `Oracle ${
      COUNTERFACTUAL
        ? 'counterfactual identity-delta Experiment F'
        : TERMINAL
          ? 'terminal continuation Experiment E'
          : 'one-lap Experiment D'
    }\n` +
      `${iterations} base iterations, ${workers} workers, ` +
      `${costSeeds} paired cost seeds, ${screenSeeds} screen seeds/arm`,
  );

  const pool = new GamePool(workers);
  try {
    const cost = await run(pool, 'cost screen', costAssignments(costSeeds, iterations));
    const costBaseline = summarizeCost(
      cost.filter((outcome) => outcome.id.startsWith('cost|baseline|')),
    );
    const costOracle = summarizeCost(
      cost.filter((outcome) => outcome.id.startsWith('cost|oracle|')),
    );

    const specs = [
      {
        label: 'personalized-vs-fixed',
        challenger: PERSONALIZED,
        champion: FIXED,
        seedBase: COUNTERFACTUAL ? 52_110_000 : TERMINAL ? 52_010_000 : 51_910_000,
      },
      {
        label: 'personalized-vs-shuffled',
        challenger: PERSONALIZED,
        champion: SHUFFLED,
        seedBase: COUNTERFACTUAL ? 52_120_000 : TERMINAL ? 52_020_000 : 51_920_000,
      },
      {
        label: 'personalized-vs-v4.1',
        challenger: PERSONALIZED,
        champion: BASELINE,
        seedBase: COUNTERFACTUAL ? 52_130_000 : TERMINAL ? 52_030_000 : 51_930_000,
      },
      ...(TERMINAL
        ? [
            {
              label: 'budget65-vs-v4.1',
              challenger: BUDGET_ONLY,
              champion: BASELINE,
              seedBase: 52_040_000,
            },
          ]
        : []),
    ];
    const screens: ScreenSummary[] = [];
    for (const spec of specs) {
      const assignments = screenAssignments(
        spec.label,
        spec.challenger,
        spec.champion,
        spec.seedBase,
        screenSeeds,
        iterations,
      );
      const outcomes = await run(pool, spec.label, assignments);
      screens.push(
        summarizeScreen(
          spec.label,
          spec.challenger,
          spec.champion,
          outcomes,
          assignments.length,
        ),
      );
    }

    const allComplete =
      costBaseline.games === costSeeds &&
      costOracle.games === costSeeds &&
      screens.every((screen) => screen.completedGames === screen.requestedGames);
    const personalizedVsFixed = screens.find(
      (screen) => screen.label === 'personalized-vs-fixed',
    )!;
    const personalizedVsShuffled = screens.find(
      (screen) => screen.label === 'personalized-vs-shuffled',
    )!;
    const personalizedVsBaseline = screens.find(
      (screen) => screen.label === 'personalized-vs-v4.1',
    )!;
    const responseActivated = costOracle.activeCalls > 0 && costOracle.rerankedCalls > 0;
    const output = {
      experiment: TERMINAL
        ? 'v5-oracle-terminal-continuation-triage'
        : COUNTERFACTUAL
          ? 'v5-oracle-counterfactual-identity-delta-triage'
        : 'v5-oracle-one-lap-triage',
      preregistration: 'research_paper/v5_oracle_foundation.md',
      finishedAt: new Date().toISOString(),
      configuration: {
        costSeedBase: COST_SEED_BASE,
        costSeeds,
        screenSeeds,
        iterations,
        workers,
      },
      cost: {
        baseline: costBaseline,
        oracle: costOracle,
        ratio: costOracle.msPerMove / Math.max(1e-9, costBaseline.msPerMove),
      },
      screens,
      gate: {
        allComplete,
        personalizedPositiveVsFixed: personalizedVsFixed.match.advantage.mean > 0,
        personalizedPositiveVsShuffled: personalizedVsShuffled.match.advantage.mean > 0,
        personalizedNonnegativeVsBaseline:
          personalizedVsBaseline.match.advantage.mean >= 0,
        responseActivated,
        changeRateBelowCap: !COUNTERFACTUAL || costOracle.changedRate < 0.25,
        pass:
          allComplete &&
          personalizedVsFixed.match.advantage.mean > 0 &&
          personalizedVsShuffled.match.advantage.mean > 0 &&
          (!(TERMINAL || COUNTERFACTUAL) ||
            personalizedVsBaseline.match.advantage.mean >= 0) &&
          responseActivated &&
          (!COUNTERFACTUAL || costOracle.changedRate < 0.25),
      },
    };
    mkdirSync(join(process.cwd(), 'selfplay-results'), { recursive: true });
    writeFileSync(
      join(
        process.cwd(),
        'selfplay-results',
        COUNTERFACTUAL
          ? 'v5-oracle-counterfactual-identity-delta-triage.json'
          : TERMINAL
          ? 'v5-oracle-terminal-continuation-triage.json'
          : 'v5-oracle-one-lap-triage.json',
      ),
      `${JSON.stringify(output, null, 2)}\n`,
    );

    console.log(
      `\nCost: v4.1 ${costBaseline.msPerMove.toFixed(1)} ms/move; Oracle ` +
        `${costOracle.msPerMove.toFixed(1)} ms/move (${output.cost.ratio.toFixed(2)}x), ` +
        `${(costOracle.changedRate * 100).toFixed(1)}% active choices changed.`,
    );
    for (const screen of screens) {
      const interval = screen.match.advantage;
      console.log(
        `${screen.label}: ${interval.mean.toFixed(2)} ` +
          `[${interval.low.toFixed(2)}, ${interval.high.toFixed(2)}], ` +
          `${screen.challengerMsPerMove.toFixed(1)} ms/challenger move`,
      );
    }
    console.log(
      `${output.gate.pass ? 'PASS' : 'FAIL'} ` +
        `${
          COUNTERFACTUAL
            ? 'counterfactual identity-delta'
            : TERMINAL
              ? 'terminal continuation'
              : 'one-lap'
        } triage gate`,
    );
  } finally {
    pool.close();
  }
}

await main();
