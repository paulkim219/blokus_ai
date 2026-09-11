/**
 * Adds oracle labels to the shared corpus, resumably.
 *
 * One oracle search per position pays for two separate diagnostics, which is why they share a file:
 *
 *   E2  — root headroom. Disagreement between the deployed search and a ~7x oracle, the oracle's
 *         regret on the move actually played, and the oracle move's rank in both hand funnels.
 *   E14b— sibling discrimination. The oracle's ordering of a root's children is the reference a
 *         rollout policy has to reproduce from a handful of samples.
 *
 * Saves after every position, and `--batch` caps the work per invocation: long jobs on this machine
 * are reaped, and an enrichment pass that only writes at the end loses everything.
 *
 *   node --import tsx scripts/enrichCorpus.ts --corpus tmp/corpus.json --batch 60
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { moveKey } from '../src/engine/game.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { placementFor } from '../src/ai/bitboard/index.ts';
import { loadCorpus, type PhaseName } from './lib/rolloutCorpus.ts';
import { shortlistOrder } from './lib/rootFunnel.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

export interface OracleChild {
  placement: number;
  value: number;
  visits: number;
}

export interface Enrichment {
  index: number;
  game: number;
  phase: PhaseName;
  /**
   * Which of this seat's own 21 moves this position is, 1-based.
   *
   * `phase` collapses moves 6-15 into one bucket and switches to `endgame` early on a fragmented
   * board, so it cannot say whether move 6 and move 15 deserve the same iteration budget. This is
   * the axis `search.iterationShape` is indexed by.
   */
  ownMove: number;
  legal: number;
  /** Placement the deployed search played, and the oracle's preferred placement. */
  deployed: number;
  oracle: number;
  /** Oracle value of its own move minus its value for the deployed move; null if unvisited. */
  regret: number | null;
  /** Rank of the oracle's move in each hand funnel; `legal` when it was cut. */
  tier0Rank: number;
  tier1Rank: number;
  funnel: number;
  shortlist: number;
  /** The oracle's ranked children, richest first, as the reference ordering for E14b. */
  children: OracleChild[];
}

function loadEnrichment(path: string): Map<number, Enrichment> {
  if (!existsSync(path)) return new Map();
  const rows = JSON.parse(readFileSync(path, 'utf8')) as Enrichment[];
  return new Map(rows.map((row) => [row.index, row]));
}

async function main(): Promise<void> {
  preloadNets();

  const corpusPath = arg('corpus', 'tmp/corpus.json') as string;
  const outPath = arg('out', 'tmp/corpus-oracle.json') as string;
  const batch = Math.max(1, Number(arg('batch', '60')));
  const deployedArg = arg('deployed', 'v3.2-pro');
  const oracleArg = arg('oracle', 'v3.2-pro-max');
  const deployedIterations = Number(arg('iterations', '300'));
  const oracleIterations = Number(arg('oracle-iterations', '1200'));
  const seedBase = Number(arg('seed-base', '61000000'));
  const topK = Math.max(2, Number(arg('top-k', '16')));
  if (!isAlgoVersionId(deployedArg) || !isAlgoVersionId(oracleArg)) {
    throw new Error(`unknown version: ${deployedArg} / ${oracleArg}`);
  }
  const deployed: AlgoVersionId = deployedArg;
  const oracle: AlgoVersionId = oracleArg;

  const samples = loadCorpus(corpusPath);
  const enriched = loadEnrichment(outPath);
  console.log(
    `corpus ${samples.length} positions; ${enriched.size} already enriched; ` +
      `deployed ${deployed}@${deployedIterations} vs oracle ${oracle}@${oracleIterations}`,
  );

  let done = 0;
  for (let index = 0; index < samples.length && done < batch; index += 1) {
    if (enriched.has(index)) continue;
    const sample = samples[index];
    const order = shortlistOrder(sample.state, sample.player, deployed);
    if (order.legal < 2) {
      continue;
    }

    setSeed(seedBase + index * 31 + 1);
    const deployedResult = await searchBestMove(sample.state, sample.player, 600_000, undefined, {
      version: deployed,
      iterationBudget: deployedIterations,
      skipWinOddsRefinement: true,
    });
    setSeed(seedBase + index * 31 + 2);
    const oracleResult = await searchBestMove(sample.state, sample.player, 600_000, undefined, {
      version: oracle,
      iterationBudget: oracleIterations,
      skipWinOddsRefinement: true,
    });
    if (!deployedResult.bestMove || !oracleResult.bestMove) continue;

    const oracleId = placementFor(oracleResult.bestMove);
    const deployedId = placementFor(deployedResult.bestMove);
    const tier0Rank = order.tier0.indexOf(oracleId);
    const tier1Rank = order.tier1.indexOf(oracleId);
    const byKey = new Map(
      oracleResult.rankedMoves.map((entry) => [moveKey(entry.move), entry.value]),
    );
    const deployedValue = byKey.get(moveKey(deployedResult.bestMove));
    const top = oracleResult.rankedMoves[0]?.value ?? 0;

    enriched.set(index, {
      index,
      game: sample.game,
      phase: sample.phase,
      ownMove: 21 - sample.state.remainingPieces[sample.player].length + 1,
      legal: order.legal,
      deployed: deployedId,
      oracle: oracleId,
      regret: deployedValue === undefined ? null : top - deployedValue,
      tier0Rank: tier0Rank < 0 ? order.legal : tier0Rank,
      tier1Rank: tier1Rank < 0 ? order.legal : tier1Rank,
      funnel: order.funnel,
      shortlist: order.shortlist,
      children: oracleResult.rankedMoves.slice(0, topK).map((entry) => ({
        placement: placementFor(entry.move),
        value: entry.value,
        visits: entry.visits,
      })),
    });
    done += 1;
    writeFileSync(outPath, `${JSON.stringify([...enriched.values()])}\n`);
    if (done % 10 === 0) {
      console.log(`  enriched ${done}/${batch} this run (${enriched.size}/${samples.length} total)`);
    }
  }

  console.log(`enriched ${enriched.size}/${samples.length} positions → ${outPath}`);
  console.log(enriched.size >= samples.length ? 'COMPLETE' : 'INCOMPLETE — run again');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
