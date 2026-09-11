/**
 * Workstream C, gate 0 — is there a head start, before anything is trained?
 *
 * Arm A died because the channel had capacity and nothing observable could address it. That cost two
 * scripts instead of a fourteen-hour ladder, and the same discipline applies here: establish that an
 * apprentice *could* work before building an oracle corpus, a training contract and a runtime path.
 *
 * The premise of this arm is that the opening is where the engine is most wrong (E2: 8% agreement
 * with a ~7x oracle, 0.62 squares of regret a move) and that a policy net generalises where the exact
 * book could not (9.4% coverage, nothing past ply 2). The cheapest decisive question is:
 *
 *   on the same opening positions, does an already-trained policy net pick the deep oracle's move
 *   more often than the deployed search does?
 *
 * If it does not, the apprentice starts behind the thing it is meant to replace, and no amount of
 * abstention rescues that — abstention improves precision by giving up coverage, and the ceiling
 * calculation shows this arm needs *both*.
 *
 * No training. This reuses the v4 programme's best surviving artifacts, which cost weeks to produce.
 *
 *   node --import tsx scripts/v37OpeningApprenticeGate.ts --positions 120
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { moveKey } from '../src/engine/game.ts';
import {
  bitboardParamsFor,
  getAlgo,
  isAlgoVersionId,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { placementFor, resetV12, seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { writeFeatures, FEATURE_COUNT } from '../src/ai/bitboard/netFeatures.ts';
import { writePolicyFeaturesV2, POLICY_V2_FEATURE_COUNT } from '../src/ai/bitboard/policyFeaturesV2.ts';
import {
  pooledPolicyNetFor,
  preparePooledPosition,
  scorePooledPlacement,
} from '../src/ai/bitboard/spatialNet.ts';
import { MoveOrderer, sortByScore } from '../src/ai/bitboard/ordering.ts';
import { newMoveBuffer } from '../src/ai/bitboard/position.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { loadCorpus } from './lib/rolloutCorpus.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Row {
  game: number;
  ownMove: number;
  legal: number;
  searchAgrees: boolean;
  netAgrees: boolean;
  /** Rank the net gave the oracle's move among the shortlist; -1 if the funnel dropped it. */
  netRankOfOracle: number;
  /** The net's own confidence: softmax-free margin between its top two candidates. */
  netMargin: number;
}

async function main(): Promise<void> {
  preloadNets();
  const corpusPath = arg('corpus', 'tmp/corpus.json')!;
  const deployedArg = arg('deployed', 'v3.5-pro')!;
  const oracleArg = arg('oracle', 'v3.6-pro-max')!;
  const netVersionArg = arg('net-version', 'v3.2-pro-spatial-ensemble')!;
  const iterations = Number(arg('iterations', '300'));
  const oracleIterations = Number(arg('oracle-iterations', '1200'));
  const maxOwnMove = Number(arg('max-own-move', '5'));
  const maxPositions = Number(arg('positions', '120'));
  const seedBase = Number(arg('seed-base', '40000000'));
  const outPath = arg('out', 'selfplay-results/v37-opening-apprentice-gate.json')!;

  for (const v of [deployedArg, oracleArg, netVersionArg]) {
    if (!isAlgoVersionId(v)) throw new Error(`unknown version: ${v}`);
  }
  if (!existsSync(corpusPath)) throw new Error(`no corpus at ${corpusPath}`);

  const netParams = bitboardParamsFor(getAlgo(netVersionArg as AlgoVersionId));
  const pooled = pooledPolicyNetFor(netParams.search.pooledNetPath);
  if (!pooled) {
    throw new Error(
      `${netVersionArg} has no pooled policy net registered ` +
        `(pooledNetPath=${netParams.search.pooledNetPath}). Nothing to gate.`,
    );
  }

  const all = loadCorpus(corpusPath).filter((s) => {
    const played = 21 - s.state.remainingPieces[s.player].length;
    return played < maxOwnMove;
  });
  const step = Math.max(1, Math.floor(all.length / maxPositions));
  const samples = all.filter((_, i) => i % step === 0).slice(0, maxPositions);

  console.log(
    [
      'Workstream C gate 0 — head start before training',
      `deployed ${deployedArg}   oracle ${oracleArg}@${oracleIterations}   net ${netVersionArg}`,
      `${samples.length} opening positions (own moves 1-${maxOwnMove}) from ` +
        `${new Set(samples.map((s) => s.game)).size} games`,
      '',
    ].join('\n'),
  );

  const context = createEvalContext();
  const priorContext = createEvalContext();
  const parentFeatures = new Float32Array(FEATURE_COUNT);
  const netInput = new Float32Array(POLICY_V2_FEATURE_COUNT);
  const rows: Row[] = [];

  for (let i = 0; i < samples.length; i += 1) {
    const { state, player, game } = samples[i];

    // Oracle: two independent searches, position dropped unless they agree. Same discipline as the
    // checkpoint corpus — a reference that is not settled cannot grade anything.
    const oracleMoves: string[] = [];
    for (let o = 0; o < 2; o += 1) {
      clearLegalMoveCache();
      resetV12();
      setSeed(seedBase + 3_000_000 + i * 13 + o);
      const r = await searchBestMove(state, player, 600_000, undefined, {
        version: oracleArg as AlgoVersionId,
        iterationBudget: oracleIterations,
        skipWinOddsRefinement: true,
      });
      if (!r.bestMove) break;
      oracleMoves.push(moveKey(r.bestMove));
    }
    if (oracleMoves.length < 2 || oracleMoves[0] !== oracleMoves[1]) continue;
    const oracleKey = oracleMoves[0];

    clearLegalMoveCache();
    resetV12();
    setSeed(seedBase + i);
    const deployed = await searchBestMove(state, player, 600_000, undefined, {
      version: deployedArg as AlgoVersionId,
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
    });
    if (!deployed.bestMove) continue;

    // Rebuild the root shortlist the search would see, then score it with the net alone.
    const position = toPosition(state);
    const seat = seatOf(player);
    if (position.turn !== seat) position.forceTurn(seat);
    context.fractionalTies = netParams.fractionalTerritoryTies;
    refreshContext(context, position, true);
    const phase = detectPhase(position, context, netParams, seat);
    const buffer = newMoveBuffer();
    const legal = position.generateMoves(seat, buffer);
    if (legal === 0) continue;

    // Reproduce both funnels exactly as `BitboardSearch.initialise` does, or the net is being asked
    // to rank a candidate set the engine would never have shown it.
    const ordering = netParams.ordering[phase];
    const tier0 = Array.from({ length: legal }, (_, k) => buffer[k]).sort(
      (a, b) =>
        PLACEMENTS.size[b] * ordering.pieceSize -
        PLACEMENTS.centreDistance[b] * ordering.centrePull -
        (PLACEMENTS.size[a] * ordering.pieceSize -
          PLACEMENTS.centreDistance[a] * ordering.centrePull),
    );
    const funnel = Math.max(netParams.search.rootShortlist * 2, 96);
    const kept = Math.min(funnel, tier0.length);
    const moves = new Int32Array(kept);
    for (let k = 0; k < kept; k += 1) moves[k] = tier0[k];
    const scores = new Float64Array(kept);
    const orderer = new MoveOrderer(netParams);
    orderer.scoreMoves(position, context, seat, moves, kept, scores, phase, {
      withSplit: true,
      splitBudget: 24,
    });
    sortByScore(moves, scores, kept);
    const shortlist = Math.min(netParams.search.rootShortlist, kept);

    writeFeatures(parentFeatures, 0, position, context, seat);
    preparePooledPosition(pooled, position, seat);
    const netScores: Array<{ key: string; score: number }> = [];
    for (let k = 0; k < shortlist; k += 1) {
      const undo = position.apply(moves[k]);
      refreshContext(priorContext, position, false);
      writePolicyFeaturesV2(netInput, position, priorContext, seat, moves[k], parentFeatures);
      // Placement id is the canonical identity here; `moveKey` is the object-engine's string form and
      // the two funnels speak in ids, so compare ids and convert the oracle's move once.
      netScores.push({
        key: String(moves[k]),
        score: scorePooledPlacement(pooled, moves[k], seat, netInput),
      });
      position.undo(undo);
    }
    const ranked = [...netScores].sort((a, b) => b.score - a.score);

    // The oracle's move expressed in the same key space as the shortlist entries.
    const oracleRun = deployed.rankedMoves.find((e) => moveKey(e.move) === oracleKey);
    const oracleId = oracleRun ? placementFor(oracleRun.move) : -1;
    const oracleShortKey = oracleId >= 0 ? String(oracleId) : null;

    rows.push({
      game,
      ownMove: 21 - state.remainingPieces[player].length + 1,
      legal,
      searchAgrees: moveKey(deployed.bestMove) === oracleKey,
      netAgrees: oracleShortKey !== null && ranked[0]?.key === oracleShortKey,
      netRankOfOracle:
        oracleShortKey === null ? -1 : ranked.findIndex((e) => e.key === oracleShortKey),
      netMargin: (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0),
    });

    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${samples.length} — ${rows.length} labelled`);
  }

  const n = rows.length;
  const pct = (c: number) => `${((100 * c) / Math.max(1, n)).toFixed(1)}%`;
  console.log(`\n=== ${n} oracle-stable opening positions ===\n`);
  console.log(`  deployed search picks the oracle's move   ${pct(rows.filter((r) => r.searchAgrees).length)}`);
  console.log(`  policy net picks the oracle's move        ${pct(rows.filter((r) => r.netAgrees).length)}`);
  console.log(`  net ranks it top-3                        ${pct(rows.filter((r) => r.netRankOfOracle >= 0 && r.netRankOfOracle < 3).length)}`);
  console.log(`  oracle move outside the 40-move shortlist ${pct(rows.filter((r) => r.netRankOfOracle < 0).length)}`);

  // Abstention: does the net's own margin identify the positions it gets right?
  const sorted = [...rows].sort((a, b) => b.netMargin - a.netMargin);
  console.log('\n  net accuracy by its own confidence (abstention is the arm\'s whole design):');
  for (const frac of [0.25, 0.5, 0.75, 1.0]) {
    const take = sorted.slice(0, Math.max(1, Math.round(frac * n)));
    const acc = take.filter((r) => r.netAgrees).length / take.length;
    const searchAcc = take.filter((r) => r.searchAgrees).length / take.length;
    console.log(
      `    top ${`${(frac * 100).toFixed(0)}%`.padStart(4)} by margin: net ${(100 * acc).toFixed(1)}%   search ${(100 * searchAcc).toFixed(1)}%`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ deployed: deployedArg, oracle: oracleArg, net: netVersionArg, rows }, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
  console.log(
    [
      '',
      'The arm needs coverage x accuracy >= 40% of opening regret to clear a 200-seed MDE of 0.95.',
      'If the net does not already beat the deployed search here, an apprentice would have to be',
      'substantially better than anything the v4 programme produced in five generations.',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
