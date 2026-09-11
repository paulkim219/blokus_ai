import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatLadderSummary,
  runLadder,
  SELFPLAY_SEARCH_OPTIONS,
  type PolicyId,
} from '../src/ai/selfplay.ts';
import type { SearchOptions } from '../src/ai/searchTypes.ts';
import { DEFAULT_ALGO_VERSION, isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const POLICIES: PolicyId[] = ['greedy', 'mcts-bench', 'mcts-short', 'mcts-long'];

function parsePolicy(value: string | undefined, fallback: PolicyId): PolicyId {
  if (value && POLICIES.includes(value as PolicyId)) {
    return value as PolicyId;
  }
  return fallback;
}

function parseVersion(value: string | undefined, fallback: AlgoVersionId): AlgoVersionId {
  if (isAlgoVersionId(value)) {
    return value;
  }
  return fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === 'true' || value === '1' || value === 'yes';
}

interface BatchRecord {
  batch: number;
  timestamp: string;
  elapsedMinutes: number;
  gamesThisBatch: number;
  cumulativeGames: number;
  batchFirstPlace: number;
  batchWins: number;
  batchMeanHeroScore: number;
  batchMeanMargin: number;
  cumulativeFirstPlace: number;
  cumulativeWins: number;
  cumulativeMeanHeroScore: number;
  cumulativeMeanMargin: number;
  cumulativeFirstPlaceRate: number;
  cumulativeWinRate: number;
  batchDurationSec: number;
  hero: PolicyId;
  opponents: PolicyId;
  heroVersion: AlgoVersionId;
  opponentVersion: AlgoVersionId;
  label: string;
}

async function main(): Promise<void> {
  const hero = parsePolicy(arg('hero'), 'mcts-short');
  const opponents = parsePolicy(arg('opponents'), 'greedy');
  const batchSize = Math.max(1, Number(arg('batch-size', '3')));
  const durationMinutes = Math.max(1, Number(arg('duration-minutes', '120')));
  const heroColor = (arg('hero-color', 'blue') ?? 'blue') as 'blue' | 'yellow' | 'purple' | 'green';
  const label = arg('label', 'default') ?? 'default';
  const fastSelfplay = parseBool(arg('fast-selfplay'), true);
  const heroVersion = parseVersion(arg('hero-version'), DEFAULT_ALGO_VERSION);
  const opponentVersion = parseVersion(arg('opponent-version'), heroVersion);

  const searchOptions: SearchOptions | undefined = fastSelfplay ? SELFPLAY_SEARCH_OPTIONS : undefined;

  const startedAt = Date.now();
  const deadline = startedAt + durationMinutes * 60_000;
  const runId = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'selfplay-results');
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, `run-${runId}.jsonl`);
  const summaryPath = join(outDir, `run-${runId}-summary.txt`);

  const header = [
    `Self-play batch run`,
    `Started: ${new Date(startedAt).toISOString()}`,
    `Duration: ${durationMinutes} minutes`,
    `Hero: ${hero} ${heroVersion} vs 3× ${opponents} ${opponentVersion} (hero=${heroColor})`,
    `Batch size: ${batchSize}`,
    `Fast selfplay: ${fastSelfplay}`,
    `Label: ${label}`,
    '',
  ].join('\n');

  writeFileSync(summaryPath, header);
  console.log(header);

  let batch = 0;
  let cumulativeGames = 0;
  let cumulativeFirstPlace = 0;
  let cumulativeWins = 0;
  let cumulativeScoreSum = 0;
  let cumulativeMarginSum = 0;

  while (Date.now() < deadline) {
    batch += 1;
    const batchStarted = Date.now();
    console.log(`\n--- Batch ${batch} (${batchSize} games) ---`);

    const ladder = await runLadder({
      hero,
      opponents,
      games: batchSize,
      heroColor,
      searchOptions,
      heroVersion,
      opponentVersion,
    });

    cumulativeGames += ladder.games;
    cumulativeFirstPlace += ladder.firstPlace;
    cumulativeWins += ladder.wins;
    cumulativeScoreSum += ladder.meanHeroScore * ladder.games;
    cumulativeMarginSum += ladder.meanMargin * ladder.games;

    const elapsedMinutes = (Date.now() - startedAt) / 60_000;
    const batchDurationSec = (Date.now() - batchStarted) / 1000;
    const cumulativeMeanHeroScore = cumulativeScoreSum / Math.max(cumulativeGames, 1);
    const cumulativeMeanMargin = cumulativeMarginSum / Math.max(cumulativeGames, 1);

    const record: BatchRecord = {
      batch,
      timestamp: new Date().toISOString(),
      elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
      gamesThisBatch: ladder.games,
      cumulativeGames,
      batchFirstPlace: ladder.firstPlace,
      batchWins: ladder.wins,
      batchMeanHeroScore: Math.round(ladder.meanHeroScore * 100) / 100,
      batchMeanMargin: Math.round(ladder.meanMargin * 100) / 100,
      cumulativeFirstPlace,
      cumulativeWins,
      cumulativeMeanHeroScore: Math.round(cumulativeMeanHeroScore * 100) / 100,
      cumulativeMeanMargin: Math.round(cumulativeMeanMargin * 100) / 100,
      cumulativeFirstPlaceRate:
        Math.round((cumulativeFirstPlace / cumulativeGames) * 1000) / 10,
      cumulativeWinRate: Math.round((cumulativeWins / cumulativeGames) * 1000) / 10,
      batchDurationSec: Math.round(batchDurationSec * 10) / 10,
      hero,
      opponents,
      heroVersion,
      opponentVersion,
      label,
    };

    appendFileSync(logPath, `${JSON.stringify(record)}\n`);

    const batchSummary = [
      formatLadderSummary(ladder),
      `Batch time: ${record.batchDurationSec}s`,
      `Cumulative: ${cumulativeFirstPlace}/${cumulativeGames} first (${record.cumulativeFirstPlaceRate}%), ${cumulativeWins} sole wins (${record.cumulativeWinRate}%), mean score ${record.cumulativeMeanHeroScore}, mean margin ${record.cumulativeMeanMargin}`,
      `Elapsed: ${record.elapsedMinutes}/${durationMinutes} min`,
    ].join('\n');

    console.log(batchSummary);
    appendFileSync(summaryPath, `\n--- Batch ${batch} ---\n${batchSummary}\n`);

    const remainingMs = deadline - Date.now();
    if (remainingMs < batchDurationSec * 1000 * 0.5) {
      console.log('\nNot enough time for another batch — stopping.');
      break;
    }
  }

  const finalSummary = [
    '',
    '=== Final ===',
    `Batches: ${batch}`,
    `Total games: ${cumulativeGames}`,
    `First place: ${cumulativeFirstPlace}/${cumulativeGames} (${((cumulativeFirstPlace / Math.max(cumulativeGames, 1)) * 100).toFixed(1)}%)`,
    `Sole wins: ${cumulativeWins}/${cumulativeGames} (${((cumulativeWins / Math.max(cumulativeGames, 1)) * 100).toFixed(1)}%)`,
    `Mean hero score: ${(cumulativeScoreSum / Math.max(cumulativeGames, 1)).toFixed(2)}`,
    `Mean margin vs best opponent: ${(cumulativeMarginSum / Math.max(cumulativeGames, 1)).toFixed(2)}`,
    `Log: ${logPath}`,
  ].join('\n');

  console.log(finalSummary);
  appendFileSync(summaryPath, finalSummary);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
