/**
 * How much of the iteration budget is never spent, by tier.
 *
 * Dynamic banking measured +0.40 then +0.36 and stopped under its preregistered +0.50 bar — both
 * blocks positive, neither significant at 40 seeds (MDE 2.12). Before spending another ladder on it,
 * ask the question the mechanism actually rests on: how much free budget is there to harvest, and
 * does it grow with the tier?
 *
 * `time.earlyExit` stops a search once the runner-up cannot catch up on visits, and the sealed-region
 * packer and the opening book return without searching at all. Under an iteration budget every one
 * of those unspent iterations is discarded today. That slack is banking's entire fuel supply.
 *
 * If slack is flat across tiers, banking cannot be the answer to the Pro Max gap. If it grows, the
 * one tier banking was never tested at is the one where it should be strongest.
 *
 *   node --import tsx scripts/v36BudgetSlack.ts --games 4
 */

import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { playSeatedGame } from '../src/ai/selfplay.ts';
import { getV12BudgetDiagnostics, resetV12 } from '../src/ai/bitboard/index.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function measure(
  version: AlgoVersionId,
  games: number,
  iterations: number,
  seedBase: number,
): Promise<{ allocated: number; spent: number; searches: number; zero: number }> {
  let allocated = 0;
  let spent = 0;
  let searches = 0;
  let zero = 0;
  for (let g = 0; g < games; g += 1) {
    resetV12();
    const seatVersions = Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, version]),
    ) as Record<PlayerColor, AlgoVersionId>;
    await playSeatedGame({
      hero: 'mcts-bench',
      opponents: 'mcts-bench',
      seatVersions,
      seatPolicies: Object.fromEntries(PLAYER_COLORS.map((c) => [c, 'mcts-bench'])) as never,
      seed: seedBase + g,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: { iterationBudget: iterations, skipWinOddsRefinement: true },
    });
    const d = getV12BudgetDiagnostics();
    allocated += d.allocated;
    spent += d.spent;
    searches += d.searches;
    zero += d.zeroSearchMoves;
  }
  return { allocated, spent, searches, zero };
}

async function main(): Promise<void> {
  preloadNets();
  const games = Number(arg('games', '4'));
  const iterations = Number(arg('iterations', '300'));
  const seedBase = Number(arg('seed-base', '36800000'));
  const tiers = arg('versions', 'v3.5-lite,v3.5,v3.5-pro,v3.5-pro-max').split(',');

  console.log(`Unspent iteration budget by tier — ${games} self-play games each\n`);
  console.log(
    `${'version'.padEnd(16)}${'iters/move'.padStart(11)}${'searches'.padStart(10)}` +
      `${'allocated'.padStart(11)}${'spent'.padStart(10)}${'slack'.padStart(9)}${'zero-search'.padStart(12)}`,
  );

  for (const version of tiers) {
    if (!isAlgoVersionId(version)) throw new Error(`unknown version: ${version}`);
    const r = await measure(version, games, iterations, seedBase);
    const slack = r.allocated > 0 ? 1 - r.spent / r.allocated : 0;
    const perMove = r.searches > 0 ? r.allocated / r.searches : 0;
    console.log(
      `${version.padEnd(16)}${perMove.toFixed(0).padStart(11)}${String(r.searches).padStart(10)}` +
        `${r.allocated.toFixed(0).padStart(11)}${r.spent.toFixed(0).padStart(10)}` +
        `${`${(slack * 100).toFixed(1)}%`.padStart(9)}${String(r.zero).padStart(12)}`,
    );
  }

  console.log(
    [
      '',
      'slack = the fraction of allocated iterations never executed. Banking can redistribute at',
      'most this much, and only to moves that still want it.',
      '',
      'A flat slack column says banking has the same fuel at every tier, so it cannot explain or',
      'fix a Pro-Max-specific gap. A rising column says banking was tested at the wrong tier.',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
