/**
 * E2 — reads the oracle-labelled corpus and reports root-decision headroom.
 *
 * No search runs here; `enrichCorpus.ts` already paid for it. Three questions:
 *
 *   (a) how often the deployed search and a deep oracle disagree about the root move;
 *   (b) what the oracle thinks that disagreement costs — the ceiling on any better root *ranking*;
 *   (c) where the oracle's move sits in the two hand funnels — the ceiling on any root *reranking*,
 *       since a learned prior cannot recover a move the funnels discarded.
 *
 *   node --import tsx scripts/headroomSummary.ts --oracle-labels tmp/corpus-oracle.json
 */

import { readFileSync } from 'node:fs';
import type { Enrichment } from './enrichCorpus.ts';
import type { PhaseName } from './lib/rolloutCorpus.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

/**
 * Recomputes regret from the stored children rather than trusting the enrichment's own field.
 *
 * `rankRoot` sorts by **visits**, so `rankedMoves[0].value` is the most-visited child's mean value
 * and not the maximum — regret computed against it can be negative, and was.
 *
 * The unit is squares, not the tree's internal [0, 1]: `index.ts` reports
 * `value = logit(meanValue) * sigmoidScale`, putting the ranked values back on the score-margin
 * scale (the raw squashed value is kept separately as `winRate`). So this regret is directly
 * comparable to the tournament statistic, which is also in squares.
 *
 * Positions where the deployed move is outside the oracle's stored top children are skipped rather
 * than scored as zero — those are the *largest* disagreements, so counting them as zero would bias
 * the headroom estimate downwards.
 */
function regretOf(row: Enrichment): number | null {
  if (row.children.length === 0) return null;
  const deployed = row.children.find((child) => child.placement === row.deployed);
  if (!deployed) return null;
  const top = Math.max(...row.children.map((child) => child.value));
  return top - deployed.value;
}

function summarise(label: string, rows: Enrichment[]): string {
  if (rows.length === 0) return `${label.padEnd(9)} — no positions`;
  const n = rows.length;
  const pct = (count: number) => `${((count / n) * 100).toFixed(1)}%`.padStart(6);
  const regrets = rows.map(regretOf).filter((value): value is number => value !== null);
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const disagree = rows.filter((row) => row.deployed !== row.oracle);
  const ranks = [...rows].sort((a, b) => a.tier1Rank - b.tier1Rank);
  return [
    `${label.padEnd(9)} n=${String(n).padStart(4)}`,
    `legal=${mean(rows.map((r) => r.legal)).toFixed(0).padStart(4)}`,
    `agree=${pct(n - disagree.length)}`,
    `regret=${mean(regrets).toFixed(4).padStart(7)}(n=${regrets.length})`,
    `cut-by-tier0=${pct(rows.filter((r) => r.tier0Rank >= r.funnel).length)}`,
    `outside-40=${pct(rows.filter((r) => r.tier1Rank >= r.shortlist).length)}`,
    `outside-12=${pct(rows.filter((r) => r.tier1Rank >= 12).length)}`,
    `medianRank=${String(ranks[Math.floor(n / 2)].tier1Rank).padStart(3)}`,
  ].join('  ');
}

function main(): void {
  const path = arg('oracle-labels', 'tmp/corpus-oracle.json') as string;
  const rows = JSON.parse(readFileSync(path, 'utf8')) as Enrichment[];
  console.log(`=== E2 root headroom (${rows.length} oracle-labelled positions) ===\n`);
  console.log(summarise('ALL', rows));
  for (const phase of ['opening', 'midgame', 'endgame'] as const) {
    console.log(summarise(phase, rows.filter((row) => row.phase === (phase as PhaseName))));
  }

  // Rows enriched before `ownMove` existed do not carry it; report the finer split only when the
  // labels actually have it, rather than silently bucketing everything into move 1.
  if (rows.every((row) => typeof row.ownMove === 'number')) {
    console.log('\nBy own move — the axis a compute schedule is indexed by:');
    for (const [label, from, to] of [
      ['1-3', 1, 3],
      ['4-6', 4, 6],
      ['7-9', 7, 9],
      ['10-12', 10, 12],
      ['13-15', 13, 15],
      ['16-18', 16, 18],
      ['19-21', 19, 21],
    ] as const) {
      const band = rows.filter((row) => row.ownMove >= from && row.ownMove <= to);
      if (band.length > 0) {
        console.log(summarise(`mv ${label}`, band));
      }
    }
  } else {
    console.log(
      '\n(no own-move split: these labels predate the `ownMove` field — re-run enrichCorpus.ts)',
    );
  }

  const regrets = rows.map(regretOf).filter((value): value is number => value !== null);
  const games = new Set(rows.map((row) => row.game)).size;
  console.log(
    `\n${rows.length - regrets.length}/${rows.length} positions excluded from regret: the deployed ` +
      `move was outside the oracle's stored top children. Those are the largest disagreements, so ` +
      `the reported mean understates headroom slightly.`,
  );
  console.log(
    `Mean regret over the ${regrets.length} scorable positions: ` +
      `${(regrets.reduce((sum, value) => sum + value, 0) / Math.max(1, regrets.length)).toFixed(4)} ` +
      `squares per move, over ${games} games.`,
  );
  console.log(
    '\nTwo cautions. The oracle is a ~7x search, not ground truth, and taking a max over ~16 noisy ' +
      'child values inflates regret by a winner\'s-curse margin — so this is an upper bound on the ' +
      'root-ranking channel, not an estimate of it. And per-move regret does not sum over a game: ' +
      'the oracle value already prices future play. The trustworthy number for that channel is the ' +
      'E1 match (-0.12 [-1.09, 0.89] for deleting the prior outright).',
  );
}

main();
