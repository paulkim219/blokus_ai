/**
 * Workstream B, gate 0 — is the oracle's move inside the set a racer would race?
 *
 * Arm B restricts the *added* tranche to the empirical leader and its most plausible challenger. Its
 * own W3 gate 3 says: "At least 80% of stable oracle winners are inside the raced set at nominal
 * budget." If the oracle's move is routinely outside the top two the search has found by then, racing
 * those two cannot reach it, and the arm has no fuel regardless of how well the racer allocates.
 *
 * This is the cheap version of that gate: no racer is implemented, nothing is trained. It asks only
 * where the oracle's move sits in the deployed search's visit ranking at nominal budget.
 *
 * Arm A already died on the neighbouring question — nothing observable at a checkpoint predicts
 * *whether* another tranche helps. B is a different question (*how* to spend one), so it gets its own
 * measurement rather than inheriting A's verdict.
 *
 *   node --import tsx scripts/v37RootRaceGate.ts --positions 150
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { moveKey } from '../src/engine/game.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
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

interface Row {
  game: number;
  ownMove: number;
  phase: string;
  /** Rank of the oracle's move in the deployed search's visit ordering; -1 if never visited. */
  oracleRank: number;
  children: number;
  /** Visit share of the leader — how concentrated the search already is. */
  leaderShare: number;
}

async function main(): Promise<void> {
  preloadNets();
  const corpusPath = arg('corpus', 'tmp/corpus.json')!;
  const deployedArg = arg('deployed', 'v3.5-pro')!;
  const oracleArg = arg('oracle', 'v3.6-pro-max')!;
  const iterations = Number(arg('iterations', '300'));
  const oracleIterations = Number(arg('oracle-iterations', '1200'));
  const maxPositions = Number(arg('positions', '150'));
  const seedBase = Number(arg('seed-base', '42000000'));
  const outPath = arg('out', 'selfplay-results/v37-root-race-gate.json')!;

  if (!isAlgoVersionId(deployedArg) || !isAlgoVersionId(oracleArg)) {
    throw new Error(`unknown version: ${deployedArg} / ${oracleArg}`);
  }
  if (!existsSync(corpusPath)) throw new Error(`no corpus at ${corpusPath}`);

  const all = loadCorpus(corpusPath);
  const step = Math.max(1, Math.floor(all.length / maxPositions));
  const samples = all.filter((_, i) => i % step === 0).slice(0, maxPositions);
  console.log(
    `Workstream B gate — where the oracle's move sits in the deployed visit ranking\n` +
      `${samples.length} positions, ${new Set(samples.map((s) => s.game)).size} games\n`,
  );

  const rows: Row[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const { state, player, game, phase } = samples[i];

    // Two oracle runs; unstable positions are dropped rather than graded against a coin flip.
    const tops: string[] = [];
    for (let o = 0; o < 2; o += 1) {
      clearLegalMoveCache();
      resetV12();
      setSeed(seedBase + 900_000 + i * 19 + o);
      const r = await searchBestMove(state, player, 600_000, undefined, {
        version: oracleArg as AlgoVersionId,
        iterationBudget: oracleIterations,
        skipWinOddsRefinement: true,
      });
      if (!r.bestMove) break;
      tops.push(moveKey(r.bestMove));
    }
    if (tops.length < 2 || tops[0] !== tops[1]) continue;

    clearLegalMoveCache();
    resetV12();
    setSeed(seedBase + i);
    const deployed = await searchBestMove(state, player, 600_000, undefined, {
      version: deployedArg as AlgoVersionId,
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
    });
    if (!deployed.bestMove) continue;

    // rankedMoves is the engine's own ordering, which is by visits — the quantity a racer races.
    const rank = deployed.rankedMoves.findIndex((e) => moveKey(e.move) === tops[0]);
    const totalVisits = deployed.rankedMoves.reduce((s, e) => s + e.visits, 0);
    rows.push({
      game,
      ownMove: 21 - state.remainingPieces[player].length + 1,
      phase,
      oracleRank: rank,
      children: deployed.rankedMoves.length,
      leaderShare: totalVisits > 0 ? (deployed.rankedMoves[0]?.visits ?? 0) / totalVisits : 0,
    });
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${samples.length} — ${rows.length} labelled`);
  }

  const n = rows.length;
  const share = (pred: (r: Row) => boolean) =>
    `${((100 * rows.filter(pred).length) / Math.max(1, n)).toFixed(1)}%`;
  console.log(`\n=== ${n} oracle-stable positions ===\n`);
  console.log(`  oracle move is the leader (rank 0)        ${share((r) => r.oracleRank === 0)}`);
  console.log(`  inside the raced set (top 2)              ${share((r) => r.oracleRank >= 0 && r.oracleRank < 2)}   <- gate needs >= 80%`);
  console.log(`  inside top 4                              ${share((r) => r.oracleRank >= 0 && r.oracleRank < 4)}`);
  console.log(`  outside top 4                             ${share((r) => r.oracleRank < 0 || r.oracleRank >= 4)}`);
  console.log(`  never visited by the deployed search      ${share((r) => r.oracleRank < 0)}`);

  console.log('\n  by phase (top-2 containment):');
  for (const p of ['opening', 'midgame', 'endgame']) {
    const sel = rows.filter((r) => r.phase === p);
    if (sel.length === 0) continue;
    const inSet = sel.filter((r) => r.oracleRank >= 0 && r.oracleRank < 2).length;
    console.log(`    ${p.padEnd(9)} n=${String(sel.length).padStart(3)}  ${((100 * inSet) / sel.length).toFixed(1)}%`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ deployed: deployedArg, oracle: oracleArg, rows }, null, 2)}\n`);
  console.log(
    `\nWrote ${outPath}\n\n` +
      'Below 80% top-2 containment the racer cannot reach the oracle move often enough for the\n' +
      'allocation to matter, and the arm stops here rather than at a match.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
