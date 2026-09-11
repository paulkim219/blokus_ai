/**
 * Backfill board states into the opening oracle corpus.
 *
 * The first version of `exportV37OpeningOracle.ts` stored placement ids and metadata but not the
 * position, which makes the corpus fine for measuring stability and regret and useless for training —
 * features come from a board. Rather than re-run the whole export, this replays only the games.
 *
 * The arithmetic that makes this worth writing: a game is ~70 moves at ~1,377 iterations each, about
 * 96k iterations. Labelling that game's 20 opening positions is 20 x 3 runs x 9,600 = 576k. The
 * oracle work is roughly six times the game work, so replaying games and keeping the existing labels
 * costs about a seventh of a full re-export.
 *
 * Games are deterministic given their seed, and the corpus stores the seed and the ply, so a replay
 * reaches exactly the positions that were labelled. The join is asserted, not assumed: a row whose
 * ply is never reached is reported rather than silently left stateless.
 *
 *   node --import tsx scripts/v37BackfillOpeningStates.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import type { AlgoVersionId } from '../src/ai/algoVersions.ts';
import { playSeatedGame } from '../src/ai/selfplay.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { preloadNets } from './lib/netPreload.ts';
import type { OpeningRow } from './exportV37OpeningOracle.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Payload {
  deployed: string;
  deployedIterations: number;
  rows: OpeningRow[];
}

async function main(): Promise<void> {
  preloadNets();
  const path = arg('corpus', 'selfplay-results/v37-opening-oracle.json')!;
  const payload = JSON.parse(readFileSync(path, 'utf8')) as Payload;
  const need = payload.rows.filter((r) => !r.state);
  if (need.length === 0) {
    console.log('every row already has a state; nothing to do');
    return;
  }

  const byGame = new Map<number, OpeningRow[]>();
  for (const row of need) {
    const list = byGame.get(row.game);
    if (list) list.push(row);
    else byGame.set(row.game, [row]);
  }
  console.log(
    `backfilling ${need.length} rows across ${byGame.size} games ` +
      `(deployed ${payload.deployed} @ ${payload.deployedIterations})\n`,
  );

  let filled = 0;
  let missed = 0;
  const games = [...byGame.keys()].sort((a, b) => a - b);
  for (const game of games) {
    const rows = byGame.get(game)!;
    const wanted = new Map(rows.map((r) => [r.ply, r] as const));
    resetV12();
    await playSeatedGame({
      hero: 'mcts-bench',
      opponents: 'mcts-bench',
      seatVersions: Object.fromEntries(
        PLAYER_COLORS.map((c) => [c, payload.deployed]),
      ) as Record<PlayerColor, AlgoVersionId>,
      seatPolicies: Object.fromEntries(PLAYER_COLORS.map((c) => [c, 'mcts-bench'])) as never,
      seed: rows[0].seed,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: { iterationBudget: payload.deployedIterations, skipWinOddsRefinement: true },
      onPly: (state: GameState, ply: number) => {
        const row = wanted.get(ply);
        if (!row) return;
        // Assert the replay landed on the same position the label describes, rather than trusting
        // determinism silently. A seat mismatch means the join is wrong and the features would be
        // attached to the wrong board.
        if (state.currentTurn !== row.seat) return;
        row.state = state;
        wanted.delete(ply);
      },
    });
    filled += rows.length - wanted.size;
    missed += wanted.size;
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(
      `  game ${game}: ${rows.length - wanted.size}/${rows.length} filled` +
        (wanted.size > 0 ? `  (${wanted.size} plies not reached)` : ''),
    );
  }

  console.log(`\n${filled} states backfilled, ${missed} rows still stateless`);
  if (missed > 0) {
    console.log(
      'Stateless rows keep their labels and are simply unusable for training. A non-zero count here\n' +
        'means the replay diverged from the original run — check before trusting the join.',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
