import { PLAYER_COLORS, type PlayerColor } from '../src/engine/types.ts';
import { getV12ReuseDiagnostics } from '../src/ai/bitboard/index.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import type { AlgoVersionId } from '../src/ai/algoVersions.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const games = Math.max(1, Number(arg('games', '4')));
const iterations = Math.max(1, Number(arg('iterations', '100')));
const seedBase = Number(arg('seed-base', '984000'));
const version = 'v3.2-reuse-pro' as AlgoVersionId;
const seatVersions = Object.fromEntries(
  PLAYER_COLORS.map((color) => [color, version]),
) as Record<PlayerColor, AlgoVersionId>;
const seatPolicies = Object.fromEntries(
  PLAYER_COLORS.map((color) => [color, 'mcts-bench']),
) as Record<PlayerColor, PolicyId>;

let searches = 0;
let hits = 0;
let retainedVisits = 0;
let retainedChildren = 0;
for (let game = 0; game < games; game += 1) {
  const record = await playSeatedGame({
    hero: 'mcts-bench',
    opponents: 'mcts-bench',
    seatVersions,
    seatPolicies,
    seed: seedBase + game,
    openingRandomPlies: 8,
    openingTopK: 3,
    searchOptions: { iterationBudget: iterations, skipWinOddsRefinement: true, lightRollouts: true },
  });
  const stats = getV12ReuseDiagnostics();
  searches += stats.searches;
  hits += stats.hits;
  retainedVisits += stats.retainedVisits;
  retainedChildren += stats.retainedChildren;
  console.log(
    `game ${game + 1}: ${record.plies} plies, ${stats.hits}/${stats.searches} reuse hits, ` +
      `${stats.retainedVisits} retained visits`,
  );
}

console.log(`\n${hits}/${searches} searches reused a root (${(100 * hits / searches).toFixed(1)}%)`);
console.log(`mean retained visits/search: ${(retainedVisits / searches).toFixed(2)}`);
console.log(`mean retained visits/hit: ${(retainedVisits / Math.max(1, hits)).toFixed(2)}`);
console.log(`mean retained children/hit: ${(retainedChildren / Math.max(1, hits)).toFixed(2)}`);
