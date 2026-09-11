/**
 * Workstream A, W1 — the checkpoint corpus.
 *
 * Gate 0 established that a *perfect* continue/stop controller is worth +1.71 [1.24, 2.94] points
 * over spending the same compute uniformly, against a 200-seed MDE of 0.95. That is the ceiling. This
 * corpus is what a *real* controller would have to predict from, and it decides what fraction of the
 * ceiling is reachable.
 *
 * The question at each checkpoint is not "is the root spread narrow" — that was the banking arm, and
 * it was incoherent across six measurements. It is:
 *
 *   given what this search has done so far, will the next tranche change the move, and for the better?
 *
 * **Checkpoints without an engine change.** The search is deterministic under a seed — asserted by
 * `search.test.ts` on the full visit vector and by the mirror match printing 0.00 — so running the
 * same position at increasing budgets with the same seed replays one trajectory and reads it at
 * successive points. That costs 6.25x nominal per position instead of 2.0x, and buys not having to
 * thread a callback through `V12Search`.
 *
 * Two features from the plan are approximated, and it is worth being explicit: empirical per-child
 * return *variance* is not exposed on the public result, and `decided()`'s exact threshold is
 * recomputed here from visits rather than read from the search. Both are recorded as derived, and if
 * the fitted controller leans on them the engine should expose the real ones before anything is
 * matched.
 *
 *   node --import tsx scripts/v37VocCorpus.ts --positions 200
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { moveKey } from '../src/engine/game.ts';
import { isAlgoVersionId, bitboardParamsFor, getAlgo, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { loadCorpus } from './lib/rolloutCorpus.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Cumulative fractions of the nominal budget at which the trajectory is read. */
const CHECKPOINTS = [0.5, 1.0, 1.25, 1.5, 2.0] as const;

interface Checkpoint {
  fraction: number;
  iterations: number;
  /** Features a controller could actually see at decision time. */
  bestKey: string;
  leaderChanged: boolean;
  topVisits: number[];
  visitGap: number;
  visitShare: number;
  /** Shannon entropy of the root visit distribution, normalised by log(children). */
  entropy: number;
  topValueGap: number;
  children: number;
  /** Derived `decided()`: the runner-up provably cannot catch the leader in the remaining budget. */
  decidedAtNominal: boolean;
  /** Oracle regret of the move this checkpoint would have played. Null if the oracle never saw it. */
  regret: number | null;
}

interface Row {
  game: number;
  ownMove: number;
  phase: string;
  legal: number;
  oracleStable: boolean;
  checkpoints: Checkpoint[];
}

function entropyOf(visits: number[]): number {
  const total = visits.reduce((a, b) => a + b, 0);
  if (total <= 0 || visits.length < 2) return 0;
  let h = 0;
  for (const v of visits) {
    if (v <= 0) continue;
    const p = v / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(visits.length);
}

async function main(): Promise<void> {
  preloadNets();
  const corpusPath = arg('corpus', 'tmp/corpus.json')!;
  const versionArg = arg('version', 'v3.5-pro')!;
  const oracleArg = arg('oracle', 'v3.6-pro-max')!;
  const baseIterations = Number(arg('iterations', '300'));
  const oracleIterations = Number(arg('oracle-iterations', '1200'));
  const maxPositions = Number(arg('positions', '200'));
  const seedBase = Number(arg('seed-base', '39000000'));
  const outPath = arg('out', 'selfplay-results/v37-voc-corpus.json')!;

  if (!isAlgoVersionId(versionArg) || !isAlgoVersionId(oracleArg)) {
    throw new Error(`unknown version: ${versionArg} / ${oracleArg}`);
  }
  if (!existsSync(corpusPath)) throw new Error(`no corpus at ${corpusPath}`);
  const version = versionArg;
  const oracle = oracleArg;

  const all = loadCorpus(corpusPath);
  const step = Math.max(1, Math.floor(all.length / maxPositions));
  const samples = all.filter((_, i) => i % step === 0).slice(0, maxPositions);
  const scale = bitboardParamsFor(getAlgo(version)).search.iterationScale;

  console.log(
    [
      'W1 — checkpoint corpus for the value-of-computation controller',
      `deployed ${version} at ${Math.round(baseIterations * scale)} nominal iterations`,
      `checkpoints ${CHECKPOINTS.join(', ')} x nominal`,
      `oracle ${oracle}, 2 independent searches, label kept only when their top move agrees`,
      `${samples.length} positions from ${new Set(samples.map((s) => s.game)).size} games`,
      '',
    ].join('\n'),
  );

  const rows: Row[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const { state, player, game, phase } = samples[i];

    // Two independent oracle searches. A checkpoint's regret is only interpretable against a
    // reference that is itself settled; where the two disagree the position is unlabelled rather
    // than labelled noisily, which is the failure the v4 distillation programme kept hitting.
    const oracleRuns = [];
    for (let o = 0; o < 2; o += 1) {
      clearLegalMoveCache();
      resetV12();
      setSeed(seedBase + 5_000_000 + i * 17 + o);
      oracleRuns.push(
        await searchBestMove(state, player, 600_000, undefined, {
          version: oracle,
          iterationBudget: oracleIterations,
          skipWinOddsRefinement: true,
        }),
      );
    }
    if (!oracleRuns[0].bestMove || !oracleRuns[1].bestMove) continue;
    const oracleStable =
      moveKey(oracleRuns[0].bestMove) === moveKey(oracleRuns[1].bestMove);
    const values = new Map(
      oracleRuns[0].rankedMoves.map((e) => [moveKey(e.move), e.value] as const),
    );
    const oracleTop = oracleRuns[0].rankedMoves[0]?.value ?? 0;

    const checkpoints: Checkpoint[] = [];
    let previousBest: string | null = null;
    for (const fraction of CHECKPOINTS) {
      const iterations = Math.max(1, Math.round(baseIterations * fraction));
      clearLegalMoveCache();
      resetV12();
      // Same seed at every checkpoint: the longer run replays the shorter one and continues it.
      setSeed(seedBase + i);
      const result = await searchBestMove(state, player, 600_000, undefined, {
        version,
        iterationBudget: iterations,
        skipWinOddsRefinement: true,
      });
      if (!result.bestMove) break;

      const ranked = result.rankedMoves;
      const visits = ranked.map((e) => e.visits);
      const bestKey = moveKey(result.bestMove);
      const top = visits[0] ?? 0;
      const second = visits[1] ?? 0;
      const totalVisits = visits.reduce((a, b) => a + b, 0);
      const nominal = Math.round(baseIterations * scale);
      const spentHere = Math.round(iterations * scale);
      const value = values.get(bestKey);

      checkpoints.push({
        fraction,
        iterations: spentHere,
        bestKey,
        leaderChanged: previousBest !== null && previousBest !== bestKey,
        topVisits: visits.slice(0, 4),
        visitGap: top - second,
        visitShare: totalVisits > 0 ? top / totalVisits : 0,
        entropy: entropyOf(visits),
        topValueGap: (ranked[0]?.value ?? 0) - (ranked[1]?.value ?? 0),
        children: ranked.length,
        decidedAtNominal: second + Math.max(0, nominal - spentHere) < top,
        regret: value === undefined ? null : oracleTop - value,
      });
      previousBest = bestKey;
    }

    if (checkpoints.length === CHECKPOINTS.length) {
      rows.push({
        game,
        ownMove: 21 - state.remainingPieces[player].length + 1,
        phase,
        legal: checkpoints[0].children,
        oracleStable,
        checkpoints,
      });
    }
    if ((i + 1) % 20 === 0) {
      console.log(`  ${i + 1}/${samples.length} positions — ${rows.length} usable`);
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ version, oracle, baseIterations, oracleIterations, checkpoints: CHECKPOINTS, rows }, null, 2)}\n`,
  );

  const stable = rows.filter((r) => r.oracleStable).length;
  console.log(
    [
      '',
      `${rows.length} positions recorded, ${stable} (${((100 * stable) / Math.max(1, rows.length)).toFixed(0)}%) with a stable oracle label`,
      `Wrote ${outPath}`,
      '',
      'Next: fit a controller on these features and compare its realised regret reduction with the',
      'perfect-foresight ceiling gate 0 measured. Anything below ~55% of perfect falls under MDE.',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
