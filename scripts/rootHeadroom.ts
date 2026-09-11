/**
 * E2 — root-decision headroom, and the shortlist ceiling.
 *
 * Four generations of learned root priors (v4.1–v4.5) have measured null, and nobody has asked how
 * much score is available at the root at all. This script answers three questions that jointly bound
 * every root-only mechanism, learned or hand-written, and it costs minutes rather than a match:
 *
 *   (a) How often does the deployed search disagree with a ~10x oracle about the root move?
 *   (b) When it disagrees, what does the oracle think that costs? Summed over a game, this is an
 *       upper bound on the score any better root *ranking* could recover.
 *   (c) Where does the oracle's move sit in the two hand funnels that run before the network?
 *       Tier 0 cuts every legal move to 96 on piece size and centre distance alone; tier 1 sorts
 *       those with `MoveOrderer.scoreMoves` and truncates to `rootShortlist` (40). A learned prior
 *       reranks the survivors and *cannot* recover anything either funnel discarded. If the oracle's
 *       move is regularly outside them, the useful job for a learned policy is candidate generation,
 *       not reranking — a different deployment from any tried so far.
 *
 * This is a diagnostic, not a significance test: positions within a game are correlated and the
 * oracle is a stronger search rather than ground truth. Use it to decide what to measure.
 *
 *   node --import tsx scripts/rootHeadroom.ts --games 12 --stride 5 --positions 150
 */

import { existsSync, writeFileSync } from 'node:fs';
import { loadCorpus } from './lib/rolloutCorpus.ts';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import { moveKey } from '../src/engine/game.ts';
import {
  bitboardParamsFor,
  getAlgo,
  isAlgoVersionId,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import { setSeed } from '../src/ai/rng.ts';
import { placementFor, resetV12, seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import { MoveOrderer, sortByScore } from '../src/ai/bitboard/ordering.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { newMoveBuffer } from '../src/ai/bitboard/position.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

type PhaseName = 'opening' | 'midgame' | 'endgame';

function phaseOf(state: GameState, color: PlayerColor): PhaseName {
  const played = 21 - state.remainingPieces[color].length;
  if (played < 5) return 'opening';
  return played < 15 ? 'midgame' : 'endgame';
}

interface Sample {
  state: GameState;
  player: PlayerColor;
  phase: PhaseName;
}

/**
 * Rebuilds the root shortlist exactly as `BitboardSearch.initialise` does, and returns every legal
 * move in the order the two funnels leave them. Index in the returned array is the move's rank; a
 * move dropped by tier 0 is reported separately because tier 1 never sees it.
 */
function shortlistOrder(
  state: GameState,
  player: PlayerColor,
  version: AlgoVersionId,
): { tier0: number[]; tier1: number[]; funnel: number; shortlist: number; legal: number } {
  const params = bitboardParamsFor(getAlgo(version));
  const position = toPosition(state);
  const seat = seatOf(player);
  if (position.turn !== seat) {
    position.forceTurn(seat);
  }

  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  // `withSplit` is true at the root, and Δsplit needs the articulation map.
  refreshContext(context, position, true);
  const phase = detectPhase(position, context, params, seat);

  const buffer = newMoveBuffer();
  const legal = position.generateMoves(seat, buffer);
  if (legal === 0) {
    return { tier0: [], tier1: [], funnel: 0, shortlist: 0, legal: 0 };
  }

  // Tier 0: O(1) per move — piece size and centre pull only. This is the cut that takes hundreds of
  // legal moves down to 96, before any evaluation or network runs.
  const ordering = params.ordering[phase];
  const tier0 = Array.from({ length: legal }, (_, i) => i)
    .map((i) => ({
      move: buffer[i],
      score:
        PLACEMENTS.size[buffer[i]] * ordering.pieceSize -
        PLACEMENTS.centreDistance[buffer[i]] * ordering.centrePull,
    }))
    .sort((a, b) => b.score - a.score);

  const funnel = Math.max(params.search.rootShortlist * 2, 96);
  const kept = Math.min(funnel, tier0.length);
  const moves = new Int32Array(kept);
  const scores = new Float64Array(kept);
  for (let i = 0; i < kept; i += 1) {
    moves[i] = tier0[i].move;
  }

  // Tier 1: the real ordering heuristic, with Δsplit for cut moves — the same call and the same
  // split budget the root uses.
  const orderer = new MoveOrderer(params);
  orderer.scoreMoves(position, context, seat, moves, kept, scores, phase, {
    withSplit: true,
    splitBudget: 24,
  });
  sortByScore(moves, scores, kept);

  return {
    tier0: tier0.map((entry) => entry.move),
    tier1: Array.from(moves.subarray(0, kept)),
    funnel,
    shortlist: Math.min(kept, params.search.rootShortlist),
    legal,
  };
}

async function collectSamples(
  games: number,
  seedBase: number,
  stride: number,
  generator: AlgoVersionId,
  policy: PolicyId,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let g = 0; g < games; g += 1) {
    resetV12();
    const seatVersions = Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, generator]),
    ) as Record<PlayerColor, AlgoVersionId>;
    const seatPolicies = Object.fromEntries(PLAYER_COLORS.map((c) => [c, policy])) as Record<
      PlayerColor,
      PolicyId
    >;
    await playSeatedGame({
      hero: policy,
      opponents: policy,
      seatVersions,
      seatPolicies,
      seed: seedBase + g,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: { skipWinOddsRefinement: true, lightRollouts: true },
      onPly: (state, ply) => {
        if (ply % stride === 0) {
          samples.push({ state, player: state.currentTurn, phase: phaseOf(state, state.currentTurn) });
        }
      },
    });
    console.log(`  ${g + 1}/${games} games — ${samples.length} positions`);
  }
  return samples;
}

interface Row {
  phase: PhaseName;
  legal: number;
  agree: boolean;
  /** Oracle value of its own move minus its value for the deployed move; null if unvisited. */
  regret: number | null;
  tier0Rank: number;
  tier1Rank: number;
  survivedFunnel: boolean;
  inShortlist: boolean;
  inTop12: boolean;
}

function summarise(label: string, rows: Row[]): string {
  if (rows.length === 0) return `${label.padEnd(10)} — no positions`;
  const n = rows.length;
  const pct = (count: number) => `${((count / n) * 100).toFixed(1)}%`.padStart(6);
  const scored = rows.filter((row) => row.regret !== null);
  const meanRegret =
    scored.length === 0 ? 0 : scored.reduce((sum, row) => sum + (row.regret ?? 0), 0) / scored.length;
  const disagreeRegret = scored.filter((row) => !row.agree);
  const meanDisagree =
    disagreeRegret.length === 0
      ? 0
      : disagreeRegret.reduce((sum, row) => sum + (row.regret ?? 0), 0) / disagreeRegret.length;
  const meanLegal = rows.reduce((sum, row) => sum + row.legal, 0) / n;
  const medianTier1 = [...rows].sort((a, b) => a.tier1Rank - b.tier1Rank)[Math.floor(n / 2)].tier1Rank;
  return [
    `${label.padEnd(10)} n=${String(n).padStart(4)}  legal=${meanLegal.toFixed(0).padStart(4)}`,
    `agree=${pct(rows.filter((row) => row.agree).length)}`,
    `regret(all)=${meanRegret.toFixed(3).padStart(7)}`,
    `regret(disagree)=${meanDisagree.toFixed(3).padStart(7)}`,
    `oracle-move: outside-96=${pct(rows.filter((row) => !row.survivedFunnel).length)}`,
    `outside-40=${pct(rows.filter((row) => !row.inShortlist).length)}`,
    `outside-12=${pct(rows.filter((row) => !row.inTop12).length)}`,
    `medianRank=${String(medianTier1).padStart(3)}`,
  ].join('  ');
}

async function main(): Promise<void> {
  preloadNets();

  const games = Math.max(1, Number(arg('games', '12')));
  const stride = Math.max(1, Number(arg('stride', '5')));
  const maxPositions = Math.max(1, Number(arg('positions', '150')));
  const seedBase = Number(arg('seed-base', '20000000'));
  const deployedArg = arg('deployed', 'v3.2-pro');
  const oracleArg = arg('oracle', 'v3.2-pro-max');
  const deployedIterations = Number(arg('iterations', '300'));
  const oracleIterations = Number(arg('oracle-iterations', '1800'));
  const outPath = arg('out');
  const corpusPath = arg('corpus', 'tmp/corpus.json');

  if (!isAlgoVersionId(deployedArg) || !isAlgoVersionId(oracleArg)) {
    throw new Error(`unknown version: ${deployedArg} / ${oracleArg}`);
  }
  const deployed = deployedArg;
  const oracle = oracleArg;

  const deployedScale = bitboardParamsFor(getAlgo(deployed)).search.iterationScale;
  const oracleScale = bitboardParamsFor(getAlgo(oracle)).search.iterationScale;
  console.log(
    `deployed ${deployed} @ ${Math.round(deployedIterations * deployedScale)} iters   ` +
      `oracle ${oracle} @ ${Math.round(oracleIterations * oracleScale)} iters   ` +
      `(${(oracleIterations * oracleScale) / (deployedIterations * deployedScale)}x)`,
  );

  // Shares the cached corpus with `rolloutBalance.ts` / `fitRolloutPolicy.ts`: collecting positions
  // costs real self-play games and is the dominant cost of every one of these diagnostics, while
  // scoring them is cheap. Pay it once.
  let all: Sample[];
  if (corpusPath && existsSync(corpusPath)) {
    all = loadCorpus(corpusPath).map((sample) => ({
      state: sample.state,
      player: sample.player,
      phase: sample.phase,
    }));
    console.log(`\nLoaded ${all.length} positions from ${corpusPath}`);
  } else {
    console.log(`\nCollecting positions from ${games} ${deployed} games...`);
    all = await collectSamples(games, seedBase, stride, deployed, 'mcts-bench');
  }
  // Evenly spaced rather than the first N, so the phase mix matches the games.
  const step = Math.max(1, Math.floor(all.length / maxPositions));
  const samples = all.filter((_, index) => index % step === 0).slice(0, maxPositions);
  console.log(`${samples.length} positions selected of ${all.length}\n`);

  const rows: Row[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const { state, player, phase } = samples[i];
    const order = shortlistOrder(state, player, deployed);
    if (order.legal < 2) continue;

    // Both searches get their own fixed seed so the run replays exactly.
    setSeed(seedBase + 500_000 + i);
    const deployedResult = await searchBestMove(state, player, 600_000, undefined, {
      version: deployed,
      iterationBudget: deployedIterations,
      skipWinOddsRefinement: true,
    });
    setSeed(seedBase + 900_000 + i);
    const oracleResult = await searchBestMove(state, player, 600_000, undefined, {
      version: oracle,
      iterationBudget: oracleIterations,
      skipWinOddsRefinement: true,
    });
    if (!deployedResult.bestMove || !oracleResult.bestMove) continue;

    const oracleBest = oracleResult.bestMove;
    const oracleId = placementFor(oracleBest);
    const tier0Rank = order.tier0.indexOf(oracleId);
    const tier1Rank = order.tier1.indexOf(oracleId);
    const survivedFunnel = tier0Rank >= 0 && tier0Rank < order.funnel;
    const inShortlist = tier1Rank >= 0 && tier1Rank < order.shortlist;

    const deployedKey = moveKey(deployedResult.bestMove);
    const byKey = new Map(oracleResult.rankedMoves.map((entry) => [moveKey(entry.move), entry.value]));
    const oracleTop = oracleResult.rankedMoves[0]?.value ?? 0;
    const deployedValue = byKey.get(deployedKey);

    rows.push({
      phase,
      legal: order.legal,
      agree: deployedKey === moveKey(oracleBest),
      regret: deployedValue === undefined ? null : oracleTop - deployedValue,
      tier0Rank: tier0Rank < 0 ? order.legal : tier0Rank,
      tier1Rank: tier1Rank < 0 ? order.legal : tier1Rank,
      survivedFunnel,
      inShortlist,
      inTop12: tier1Rank >= 0 && tier1Rank < 12,
    });
    if ((i + 1) % 10 === 0) {
      console.log(`  ${i + 1}/${samples.length} positions`);
    }
  }

  console.log(`\n=== Root headroom (${rows.length} positions) ===\n`);
  console.log(summarise('ALL', rows));
  for (const phase of ['opening', 'midgame', 'endgame'] as const) {
    console.log(summarise(phase, rows.filter((row) => row.phase === phase)));
  }

  const unvisited = rows.filter((row) => row.regret === null).length;
  console.log(
    `\nDeployed move absent from the oracle's ranked children in ${unvisited}/${rows.length} positions ` +
      `(regret unmeasurable there; those are the largest disagreements).`,
  );

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify({ deployed, oracle, rows }, null, 2)}\n`);
    console.log(`\nWrote ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
