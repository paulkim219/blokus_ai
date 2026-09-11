/** Whole-game wall-clock comparison for the v4.1 efficiency promotion gate. */

import { writeFileSync } from 'node:fs';
import { ALGO_VERSIONS, isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { getV12BudgetDiagnostics, resetV12 } from '../src/ai/bitboard/index.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import { PLAYER_COLORS, type PlayerColor } from '../src/engine/types.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function play(version: AlgoVersionId, seed: number) {
  resetV12();
  const seatVersions = Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, version]),
  ) as Record<PlayerColor, AlgoVersionId>;
  const seatPolicies = Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, 'mcts-bench']),
  ) as Record<PlayerColor, PolicyId>;
  const record = await playSeatedGame({
    hero: 'mcts-bench',
    opponents: 'mcts-bench',
    seatVersions,
    seatPolicies,
    seed,
    openingRandomPlies: 8,
    openingTopK: 3,
    searchOptions: { iterationBudget: 300, skipWinOddsRefinement: true },
  });
  const budget = getV12BudgetDiagnostics();
  return { ...record, budget };
}

async function main(): Promise<void> {
  preloadNets();
  const versions = arg('versions', 'v3.1,v4.1-candidate').split(',').map((value) => value.trim());
  const games = Number(arg('games', '6'));
  const seedBase = Number(arg('seed-base', '48400000'));
  const out = arg('out', 'selfplay-results/v41-full-game-cost.json');
  for (const version of versions) {
    if (!isAlgoVersionId(version) || !ALGO_VERSIONS[version]) {
      throw new Error(`unknown version ${version}`);
    }
  }

  // One unreported warm-up game per arm. Alternate measured order by seed to share thermal drift.
  for (const version of versions) await play(version, seedBase - 1);
  const rows: Array<{
    version: string; seed: number; durationMs: number; plies: number;
    allocated: number; spent: number; zeroSearchMoves: number;
  }> = [];
  for (let game = 0; game < games; game += 1) {
    const order = versions.map((_, index) => versions[(index + game) % versions.length]);
    for (const version of order) {
      const record = await play(version, seedBase + game);
      rows.push({
        version,
        seed: seedBase + game,
        durationMs: record.durationMs,
        plies: record.plies,
        allocated: record.budget.allocated,
        spent: record.budget.spent,
        zeroSearchMoves: record.budget.zeroSearchMoves,
      });
      console.log(
        `${version.padEnd(24)} seed ${seedBase + game}: ${record.durationMs} ms, ${record.plies} plies`,
      );
    }
  }

  const summary = versions.map((version) => {
    const selected = rows.filter((row) => row.version === version);
    const durationMs = selected.reduce((sum, row) => sum + row.durationMs, 0) / selected.length;
    const msPerPly =
      selected.reduce((sum, row) => sum + row.durationMs, 0) /
      selected.reduce((sum, row) => sum + row.plies, 0);
    const allocated = selected.reduce((sum, row) => sum + row.allocated, 0);
    const spent = selected.reduce((sum, row) => sum + row.spent, 0);
    const zeroSearchMoves = selected.reduce((sum, row) => sum + row.zeroSearchMoves, 0) / selected.length;
    return { version, games: selected.length, durationMs, msPerPly, allocated, spent, zeroSearchMoves };
  });
  console.log('\nSummary');
  for (const row of summary) {
    console.log(
      `${row.version.padEnd(28)} ${row.durationMs.toFixed(1)} ms/game  ${row.msPerPly.toFixed(2)} ms/ply  ` +
      `${row.zeroSearchMoves.toFixed(1)} zero-search/game  ${row.spent}/${row.allocated} iterations`,
    );
  }
  writeFileSync(out, `${JSON.stringify({ games, seedBase, rows, summary }, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
