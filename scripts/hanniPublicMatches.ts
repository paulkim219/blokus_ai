import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMatch, type MatchResult, type MatchSpec } from './lib/matchRunner.ts';
import type { ComparatorId, ModelId } from '../site/src/data/models.ts';

/**
 * Public Hanni comparison sprint. Each pair is 100 seeds × 4 seats = 400 games.
 * Cheap matches first. Stops starting new matches after 11:00 AM PDT on 23 Aug 2026.
 *
 * Greedy is the one-ply v1 floor (searching challenger vs three greedy v1 seats), matching
 * `scripts/matrix.ts`.
 */

const DEADLINE_MS = Date.parse('2026-08-23T11:00:00-07:00');
const SEEDS = 100;
const RESULTS_JSON = join(process.cwd(), 'selfplay-results', 'hanni-public-matches.json');
const SITE_JSON = join(process.cwd(), 'site', 'src', 'data', 'publicMatchResults.json');

interface PublicSpec extends MatchSpec {
  hanni: ModelId;
  opponent: ComparatorId;
}

interface RecordedResult {
  challenger: ModelId;
  opponent: ComparatorId;
  status: 'measured';
  prominence: 'primary';
  protocol: 'post-2026-08-17';
  advantage: number;
  ci: [number, number];
  games: number;
  seeds: number;
  firstPlace?: number;
  note: string;
  label: string;
  finishedAt: string;
}

const MATCHES: PublicSpec[] = [
  // Greedy floor — opponents are one-ply, so these finish first.
  greedy('hanni-1', 'v1', 8_800_000),
  greedy('hanni-2-lite', 'v2-lite', 8_800_200),
  greedy('hanni-3-1-nano', 'v3.1-nano', 8_800_400),
  greedy('hanni-3-1-lite', 'v3.1-lite', 8_800_600),
  // Same-generation cheap bitboard pairs.
  search('hanni-3-1-lite', 'hanni-3-1-nano', 'v3.1-lite', 'v3.1-nano', 8_800_800),
  search('hanni-3-1', 'hanni-3-1-lite', 'v3.1', 'v3.1-lite', 8_801_000),
  search('hanni-3-1-nano', 'hanni-2-lite', 'v3.1-nano', 'v2-lite', 8_801_200),
  search('hanni-3-1', 'hanni-2-lite', 'v3.1', 'v2-lite', 8_801_400),
  search('hanni-3-2', 'hanni-2-lite', 'v3.2', 'v2-lite', 8_801_600),
  search('hanni-3-2', 'hanni-3-1', 'v3.2', 'v3.1', 8_801_800),
  search('hanni-3-1-pro', 'hanni-3-1', 'v3.1-pro', 'v3.1', 8_802_000),
  search('hanni-3-1-nano', 'hanni-1', 'v3.1-nano', 'v1', 8_802_200),
  search('hanni-3-1-pro-max', 'hanni-3-1-pro', 'v3.1-pro-max', 'v3.1-pro', 8_802_400),
  // Legacy Pro is expensive. Last so cheap pairs publish even if we hit the deadline.
  search('hanni-2-pro', 'hanni-1', 'v2-pro', 'v1', 8_802_600),
  search('hanni-3-1-pro-max', 'hanni-2-pro', 'v3.1-pro-max', 'v2-pro', 8_802_800),
  search('hanni-3-2-pro', 'hanni-2-pro', 'v3.2-pro', 'v2-pro', 8_803_000),
  search('hanni-3-2-pro-max', 'hanni-2-pro', 'v3.2-pro-max', 'v2-pro', 8_803_200),
];

function greedy(hanni: ModelId, candidate: string, seedBase: number): PublicSpec {
  return {
    hanni,
    opponent: 'greedy',
    candidate,
    baseline: 'v1',
    seeds: SEEDS,
    seedBase,
    iterations: 300,
    policy: 'mcts-bench',
    challengerPolicy: 'mcts-bench',
    championPolicy: 'greedy',
    label: `${candidate}-vs-greedy`,
  };
}

function search(
  hanni: ModelId,
  opponent: ComparatorId,
  candidate: string,
  baseline: string,
  seedBase: number,
): PublicSpec {
  return {
    hanni,
    opponent,
    candidate,
    baseline,
    seeds: SEEDS,
    seedBase,
    iterations: 300,
    policy: 'mcts-bench',
    label: `${candidate}-vs-${baseline}`,
  };
}

function record(spec: PublicSpec, result: MatchResult): RecordedResult {
  if (result.advantage == null || result.low == null || result.high == null) {
    throw new Error(`${spec.label} did not parse an advantage`);
  }
  const played = result.output.match(/— (\d+) games over (\d+) seeds/);
  const games = played ? Number(played[1]) : spec.seeds * 4;
  const seeds = played ? Number(played[2]) : spec.seeds;
  return {
    challenger: spec.hanni,
    opponent: spec.opponent,
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: result.advantage,
    ci: [result.low, result.high],
    games,
    seeds,
    firstPlace: result.firstPlace ?? undefined,
    note: `100-seed seat-rotated match, base 300 iterations. Label ${spec.label}.`,
    label: spec.label,
    finishedAt: new Date().toISOString(),
  };
}

function loadExisting(): RecordedResult[] {
  try {
    const parsed = JSON.parse(readFileSync(SITE_JSON, 'utf8')) as RecordedResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeResults(rows: RecordedResult[]): void {
  const text = `${JSON.stringify(rows, null, 2)}\n`;
  writeFileSync(RESULTS_JSON, text);
  writeFileSync(SITE_JSON, text);
}

async function main(): Promise<void> {
  const recorded: RecordedResult[] = loadExisting();
  console.log(
    `Hanni public comparison sprint — ${MATCHES.length} pairs, ${SEEDS} seeds × 4 seats each\n` +
      `Deadline: ${new Date(DEADLINE_MS).toString()}\n` +
      `Already recorded: ${recorded.map((row) => row.label).join(', ') || 'none'}\n`,
  );

  for (let index = 0; index < MATCHES.length; index += 1) {
    const spec = MATCHES[index];
    if (!spec) continue;
    if (recorded.some((row) => row.label === spec.label)) {
      console.log(`skip ${spec.label} (already recorded)`);
      continue;
    }
    const remainingMs = DEADLINE_MS - Date.now();
    if (remainingMs < 3 * 60_000) {
      console.log(
        `\nDEADLINE: stopping before ${spec.label} (${(remainingMs / 60_000).toFixed(1)} min left). ` +
          `${recorded.length}/${MATCHES.length} pairs finished.\n`,
      );
      break;
    }

    console.log(
      `\n######## ${index + 1}/${MATCHES.length}: ${spec.label} ` +
        `(${(remainingMs / 3_600_000).toFixed(1)} h until deadline) ########\n`,
    );
    const result = await runMatch(spec);
    recorded.push(record(spec, result));
    writeResults(recorded);
    console.log(
      `\n=== Recorded ${spec.label}: ${result.advantage?.toFixed(2)} ` +
        `[${result.low?.toFixed(2)}, ${result.high?.toFixed(2)}] ` +
        `first ${result.firstPlace?.toFixed(1)}% ===\n`,
    );
  }

  writeResults(recorded);
  console.log(`\nBatch complete: ${recorded.length}/${MATCHES.length} pairs written to ${SITE_JSON}\n`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
