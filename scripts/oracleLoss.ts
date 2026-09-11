import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlaceMove, PlayerColor } from '../src/engine/types.ts';
import { applyMove, moveKey } from '../src/engine/game.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { getMoveValue, searchBestMove } from '../src/ai/mcts.ts';
import { playSeatedGame, POLICY_TIME_MS, type PolicyId } from '../src/ai/selfplay.ts';
import { setSeed } from '../src/ai/rng.ts';
import { describeMove, formatEvent, type MoveEvent } from '../src/ai/bitboard/events.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';

/**
 * §7 Tier 2 — oracle-labelled blunder analysis.
 *
 * "Take a long-time-control run of the same engine as an oracle and replay each logged game,
 * recording at each of the agent's moves the oracle's estimated score-vector loss relative to the
 * oracle's best move. This is the Blokus analogue of centipawn loss, and it localises errors to
 * plies. Aggregating loss by phase, by seat, and by heuristic feature active at the time gives
 * directly actionable signal for tuning."
 *
 * Tier 1 lives in `src/ai/bitboard/*.test.ts`; Tier 3 is `scripts/tournament.ts`. This is the missing
 * middle, and unlike win rate it says *which ply* went wrong.
 *
 *   npm run oracle-loss -- --version v12 --games 8 --iterations 300 --oracle-iterations 3000
 */

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

interface Sample {
  state: GameState;
  move: PlaceMove;
  seat: PlayerColor;
  ply: number;
  game: number;
}

interface LossRow extends MoveEvent {
  game: number;
  /** True when the played move fell outside the oracle's own shortlist. */
  unranked: boolean;
  /**
   * Which of this seat's own 21 moves this was, 1-based.
   *
   * `ply` counts all four seats interleaved, so it conflates "late in the game" with "late in the
   * turn order". Own-move index is the axis a compute schedule is indexed by, and it is the one
   * `src/ai/bitboard/timeManager.ts` and `search.iterationShape` both use.
   */
  ownMove: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Naive standard error. Positions within a game are correlated, so this is a lower bound. */
function standardError(values: number[]): number {
  if (values.length < 2) {
    return Number.NaN;
  }
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function bucket<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = map.get(id);
    if (list) {
      list.push(row);
    } else {
      map.set(id, [row]);
    }
  }
  return map;
}

async function main(): Promise<void> {
  const version = (isAlgoVersionId(arg('version')) ? arg('version') : 'v12') as AlgoVersionId;
  // §7 says to use "a long-time-control run of *the same engine*" as the oracle. That measures how
  // consistent an engine is with itself, which is not comparable across engines — two versions each
  // judged by their own oracle can post identical losses while playing at different strengths. Pass
  // `--common-oracle` to judge every version by one yardstick, which is what comparing v11 and v12
  // requires.
  const commonOracle = arg('common-oracle');
  const oracleVersion = (
    isAlgoVersionId(commonOracle)
      ? commonOracle
      : isAlgoVersionId(arg('oracle'))
        ? arg('oracle')
        : version
  ) as AlgoVersionId;
  const games = Math.max(1, Number(arg('games', '4')));
  const seedBase = Number(arg('seed-base', '5000'));
  const iterations = Number(arg('iterations', '300'));
  const oracleIterations = Number(arg('oracle-iterations', '3000'));
  const policy = (arg('policy', 'mcts-bench') ?? 'mcts-bench') as PolicyId;
  const maxSamplesPerGame = Number(arg('max-samples', '25'));

  const outDir = join(process.cwd(), 'selfplay-results');
  mkdirSync(outDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(outDir, `oracle-${runId}.jsonl`);
  const eventPath = join(outDir, `oracle-${runId}-events.txt`);
  const summaryPath = join(outDir, `oracle-${runId}-summary.txt`);

  const header = [
    'Oracle-loss analysis (§7 Tier 2)',
    `Version: ${version}   Oracle: ${oracleVersion} @ ${oracleIterations} iterations` +
      (oracleVersion === version ? '  (self-oracle — not comparable across versions)' : '  (common oracle)'),
    `Games: ${games}   Play budget: ${iterations} iterations (${policy}, ${POLICY_TIME_MS[policy]}ms nominal)`,
    '',
  ].join('\n');
  writeFileSync(summaryPath, header);
  console.log(header);

  const rows: LossRow[] = [];

  for (let game = 0; game < games; game += 1) {
    const seed = seedBase + game;
    const samples: Sample[] = [];
    const seatVersions = Object.fromEntries(
      PLAYER_COLORS.map((color) => [color, version]),
    ) as Record<PlayerColor, AlgoVersionId>;
    const seatPolicies = Object.fromEntries(
      PLAYER_COLORS.map((color) => [color, policy]),
    ) as Record<PlayerColor, PolicyId>;

    resetV12();
    await playSeatedGame({
      hero: policy,
      opponents: policy,
      seatVersions,
      seatPolicies,
      seed,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: {
        iterationBudget: iterations,
        skipWinOddsRefinement: true,
        lightRollouts: true,
      },
      onMove: (state, move, ply) => {
        if (move) {
          samples.push({ state, move, seat: move.color, ply, game });
        }
      },
    });

    // Even spread across the game: the opening and the endgame are as interesting as the middle,
    // and the oracle is far too slow to label every ply of every game.
    const stride = Math.max(1, Math.floor(samples.length / maxSamplesPerGame));
    for (let i = 0; i < samples.length; i += stride) {
      const sample = samples[i];
      resetV12();
      setSeed(seed * 7919 + sample.ply);
      const oracle = await searchBestMove(sample.state, sample.seat, 600_000, undefined, {
        version: oracleVersion,
        iterationBudget: oracleIterations,
        skipWinOddsRefinement: true,
        lightRollouts: true,
      });

      const best = oracle.rankedMoves[0];
      const playedValue = getMoveValue(oracle.rankedMoves, sample.move);
      const unranked = !Number.isFinite(playedValue);
      const after = applyMove(sample.state, sample.move);
      const event = describeMove(sample.state, after, sample.move, sample.ply);
      event.oracleLoss = unranked ? Number.NaN : (best?.value ?? 0) - playedValue;
      event.bestAlternative =
        best && moveKey(best.move) !== moveKey(sample.move)
          ? `${best.move.pieceId}@(${best.move.anchor.x},${best.move.anchor.y})`
          : 'the move played';

      const row: LossRow = {
        ...event,
        game,
        unranked,
        ownMove: 21 - sample.state.remainingPieces[sample.seat].length + 1,
      };
      rows.push(row);
      appendFileSync(logPath, `${JSON.stringify(row)}\n`);
      appendFileSync(eventPath, `${formatEvent(event)}\n`);
    }

    console.log(`game ${game + 1}/${games} — ${samples.length} plies, ${rows.length} labelled`);
  }

  const scored = rows.filter((row) => !row.unranked && Number.isFinite(row.oracleLoss));
  const losses = scored.map((row) => row.oracleLoss!);

  const lines: string[] = [
    `Labelled moves: ${rows.length} (${rows.length - scored.length} outside the oracle shortlist)`,
    `Mean oracle loss: ${mean(losses).toFixed(3)} squares`,
    '',
    'By phase:',
  ];
  for (const [phase, group] of bucket(scored, (row) => row.phase)) {
    lines.push(
      `  ${phase.padEnd(8)} n=${String(group.length).padStart(4)}  mean ${mean(
        group.map((row) => row.oracleLoss!),
      ).toFixed(3)}`,
    );
  }

  // The compute schedule is indexed by own move, not by phase: `detectPhase` collapses moves 6-15
  // into one bucket and switches to `endgame` early on a fragmented board, so a phase mean cannot
  // say whether move 6 and move 15 deserve the same budget. Bucket in threes to keep n per cell
  // usable at the sample sizes the oracle can afford.
  lines.push('', 'By own move (the axis `search.iterationShape` is indexed by):');
  const ownMoveBands: Array<[string, number, number]> = [
    ['1-3', 1, 3],
    ['4-6', 4, 6],
    ['7-9', 7, 9],
    ['10-12', 10, 12],
    ['13-15', 13, 15],
    ['16-18', 16, 18],
    ['19-21', 19, 21],
  ];
  for (const [label, from, to] of ownMoveBands) {
    const group = scored.filter((row) => row.ownMove >= from && row.ownMove <= to);
    if (group.length === 0) {
      continue;
    }
    const values = group.map((row) => row.oracleLoss!);
    lines.push(
      `  moves ${label.padEnd(6)} n=${String(group.length).padStart(4)}  mean ${mean(values).toFixed(3)}` +
        `  se ${standardError(values).toFixed(3)}`,
    );
  }
  lines.push(
    '  (a mean without its standard error is not a profile — these are per-position regrets and',
    '   positions inside one game are correlated, so treat the se as optimistic.)',
  );

  lines.push('', 'By seat (turn order):');
  for (const [seat, group] of bucket(scored, (row) => `${row.seat} ${row.color}`)) {
    lines.push(
      `  ${seat.padEnd(12)} n=${String(group.length).padStart(4)}  mean ${mean(
        group.map((row) => row.oracleLoss!),
      ).toFixed(3)}`,
    );
  }

  lines.push('', 'By event:');
  const events: Array<[string, (row: LossRow) => boolean]> = [
    ['cut available, cut played', (row) => row.cutAvailable && row.cutsArticulation],
    ['cut available, not played', (row) => row.cutAvailable && !row.cutsArticulation],
    ['no cut available', (row) => !row.cutAvailable],
    ['blocked a corner', (row) => row.deniedCorners > 0],
    ['pure extension', (row) => row.deniedCorners === 0],
    ['someone sealed after', (row) => row.sealedSeats.length > 0],
  ];
  for (const [label, predicate] of events) {
    const group = scored.filter(predicate);
    if (group.length === 0) {
      continue;
    }
    lines.push(
      `  ${label.padEnd(26)} n=${String(group.length).padStart(4)}  mean ${mean(
        group.map((row) => row.oracleLoss!),
      ).toFixed(3)}`,
    );
  }

  lines.push('', `Rows: ${logPath}`, `Events: ${eventPath}`);
  const text = lines.join('\n');
  console.log(`\n=== Result ===\n${text}`);
  appendFileSync(summaryPath, `\n=== Result ===\n${text}\n`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
