import { createInterface } from 'node:readline';
import { playSeatedGame, SELFPLAY_SEARCH_OPTIONS } from '../src/ai/selfplay.ts';
import { registerAlgoConfig } from '../src/ai/algoVersions.ts';
import { calculateScores } from '../src/engine/game.ts';
import { preloadNets } from './lib/netPreload.ts';
import { extractAllFeatures, gameProgress } from '../src/ai/heuristics.ts';
import { OraclePredictionProbe } from '../src/ai/oracle/probe.ts';
import { OracleTrajectoryCollector } from '../src/ai/oracle/trajectory.ts';
import {
  getOracleSearchDiagnostics,
  resetOracleSearchDiagnostics,
} from '../src/ai/oracle/oneLap.ts';
import type { FeatureSample, GameAssignment, GameOutcome, ScoreTrace } from './lib/pool.ts';

/** 21 pieces plus a carried-forward terminal state. Matches `scripts/scoreTrajectory.ts`. */
const MAX_TRACE_TURNS = 22;

/**
 * Plays one game per line of stdin and writes one JSON result per line to stdout.
 * Nothing else may be written to stdout — the parent parses it as the protocol.
 */
async function handle(assignment: GameAssignment): Promise<GameOutcome> {
  for (const config of assignment.configs ?? []) {
    registerAlgoConfig(config);
  }
  // After registering, so a generated config naming its own weights is covered too.
  preloadNets(assignment.configs ?? []);

  const samples: FeatureSample[] = [];
  const tracing = assignment.traceSeat != null;
  const logging = assignment.logFeatures === true;
  const trace: ScoreTrace = { hero: [], opponents: [], heroMs: 0, heroMoves: 0 };
  const oracleProbe = assignment.oracleProbe
    ? new OraclePredictionProbe(assignment.oracleProbe)
    : null;
  const oracleTrajectory = assignment.oracleTrajectory
    ? new OracleTrajectoryCollector(assignment.oracleTrajectory === 'contextual')
    : null;
  let lastAt = Date.now();
  if (assignment.oracleDiagnostics) {
    resetOracleSearchDiagnostics();
  }

  const record = await playSeatedGame({
    hero: 'greedy',
    opponents: 'greedy',
    seatVersions: assignment.seatVersions,
    seatPolicies: assignment.seatPolicies,
    seatPersonalities: assignment.seatPersonalities,
    seatPersonalitySchedules: assignment.seatPersonalitySchedules,
    seed: assignment.seed,
    openingMode: assignment.openingMode,
    maxPlies: assignment.maxPlies,
    openingRandomPlies: assignment.openingRandomPlies,
    openingTopK: assignment.openingTopK,
    searchOptions: {
      ...SELFPLAY_SEARCH_OPTIONS,
      iterationBudget: assignment.iterationBudget,
    },
    onPly:
      logging || tracing
        ? (state, ply) => {
            if (logging) {
              // The position as the side to move sees it, before it moves: exactly the input the
              // evaluation is asked to score during search.
              samples.push({
                seat: state.currentTurn,
                ply,
                progress: gameProgress(state),
                features: extractAllFeatures(state, state.currentTurn, true),
              });
            }
            const seat = assignment.traceSeat;
            if (seat && state.currentTurn === seat && trace.hero.length < MAX_TRACE_TURNS) {
              const scores = calculateScores(state);
              const hero = scores.find((entry) => entry.color === seat);
              const others = scores.filter((entry) => entry.color !== seat);
              if (hero) {
                trace.hero.push(hero.score);
                trace.opponents.push(
                  others.reduce((sum, entry) => sum + entry.score, 0) / others.length,
                );
              }
            }
            if (tracing) {
              lastAt = Date.now();
            }
          }
        : undefined,
    onMove:
      tracing || oracleProbe || oracleTrajectory
        ? (state, move, ply, personality) => {
            if (tracing) {
              const elapsed = Date.now() - lastAt;
              if (state.currentTurn === assignment.traceSeat) {
                trace.heroMs += elapsed;
                trace.heroMoves += 1;
              }
            }
            oracleProbe?.observe(state, move, assignment.seatVersions[state.currentTurn]);
            // A scheduled seat changes objective mid-game, so the label must follow the
            // personality actually in force rather than the fixed algo version.
            const source = personality ?? assignment.seatVersions[state.currentTurn];
            oracleTrajectory?.observe(
              state,
              move,
              `${source}|${assignment.seatPolicies[state.currentTurn]}`,
              ply,
            );
          }
        : undefined,
  });

  return {
    id: assignment.id,
    scores: record.scores,
    winner: record.winner,
    plies: record.plies,
    finished: record.finished,
    durationMs: record.durationMs,
    samples: logging ? samples : undefined,
    scoreTrace: tracing ? trace : undefined,
    oracleProbe: oracleProbe?.result(),
    oracleTrajectory: oracleTrajectory?.result(),
    oracleSearch: assignment.oracleDiagnostics ? getOracleSearchDiagnostics() : undefined,
  };
}

const lines = createInterface({ input: process.stdin });

// Games are handled one at a time: a worker is a single CPU's worth of search.
let chain: Promise<void> = Promise.resolve();

lines.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  const assignment = JSON.parse(line) as GameAssignment;
  chain = chain.then(async () => {
    try {
      const outcome = await handle(assignment);
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
    } catch (error) {
      const outcome: GameOutcome = {
        id: assignment.id,
        scores: { blue: 0, yellow: 0, purple: 0, green: 0 },
        winner: [],
        plies: 0,
        finished: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
    }
  });
});
