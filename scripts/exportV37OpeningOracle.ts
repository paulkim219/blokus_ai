/**
 * Workstream C, W1 — the opening oracle corpus.
 *
 * Gate 0 established the head start (+31.0 pp [10.3, 51.7] for an already-trained policy net over the
 * deployed search at picking the oracle's opening move) on 29 positions. That is enough to justify
 * building this and not enough to build anything on. This collects the corpus at a scale that can
 * (a) tighten that interval, (b) train the confidence head gate 0 showed does not exist for free, and
 * (c) measure the addressable share, given that only ~24% of opening positions had a settled answer.
 *
 * Differences from the shared corpus (`tmp/corpus.json`), which has only 120 opening positions:
 *
 * - **every** own-move 1..N position from each game, not a strided sample — the opening is the whole
 *   subject here, so sampling it thinly wastes the games;
 * - randomised openings matching the match harness, so the distribution is the one the apprentice
 *   would actually be asked about;
 * - `--oracle-runs` independent searches per position, storing the full ranked head rather than only
 *   the winner, so top-one *and* top-three stability can be read separately later;
 * - resumable after every position, because long jobs on this machine are routinely reaped.
 *
 *   node --import tsx scripts/exportV37OpeningOracle.ts --games 40 --oracle-runs 2
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { playSeatedGame } from '../src/ai/selfplay.ts';
import { setSeed } from '../src/ai/rng.ts';
import { placementFor, resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface OracleHead {
  placement: number;
  visits: number;
  value: number;
}

export interface OpeningRow {
  game: number;
  /**
   * The board this row is about.
   *
   * The first version of this exporter stored placement ids and metadata but no position, which made
   * the corpus fine for measuring stability and regret and useless for training anything — features
   * have to be extracted from a board. Replaying the games to recover them costs as much as
   * generating them did, because every move came from a real search. Storing the state is a few KB a
   * row and removes the whole problem.
   */
  state?: GameState;
  seed: number;
  seat: PlayerColor;
  ownMove: number;
  ply: number;
  legal: number;
  /** Each independent oracle run's top move, so stability is recomputable rather than baked in. */
  oracleTopPerRun: number[];
  stableTop1: boolean;
  stableTop3: boolean;
  /** Run 0's ranked head: the training target is a distribution, not a winner. */
  head: OracleHead[];
  /** What the deployed search played, and what the oracle thinks that cost. */
  deployed: number;
  deployedRegret: number | null;
}

interface Payload {
  deployed: string;
  oracle: string;
  oracleIterations: number;
  deployedIterations: number;
  oracleRuns: number;
  maxOwnMove: number;
  seedBase: number;
  rows: OpeningRow[];
}

async function main(): Promise<void> {
  preloadNets();
  const deployedArg = arg('deployed', 'v3.5-pro')!;
  const oracleArg = arg('oracle', 'v3.6-pro-max')!;
  const games = Number(arg('games', '40'));
  const oracleRuns = Number(arg('oracle-runs', '2'));
  const oracleIterations = Number(arg('oracle-iterations', '1200'));
  const deployedIterations = Number(arg('iterations', '300'));
  const maxOwnMove = Number(arg('max-own-move', '5'));
  const topK = Number(arg('top-k', '8'));
  const seedBase = Number(arg('seed-base', '41000000'));
  const outPath = arg('out', 'selfplay-results/v37-opening-oracle.json')!;

  if (!isAlgoVersionId(deployedArg) || !isAlgoVersionId(oracleArg)) {
    throw new Error(`unknown version: ${deployedArg} / ${oracleArg}`);
  }
  const deployed = deployedArg;
  const oracle = oracleArg;

  const existing: Payload = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf8')) as Payload)
    : {
        deployed, oracle, oracleIterations, deployedIterations, oracleRuns, maxOwnMove,
        seedBase, rows: [],
      };
  const done = new Set(existing.rows.map((r) => r.game));
  if (done.size > 0) console.log(`resuming: ${done.size} games already labelled\n`);

  console.log(
    [
      'W1 — opening oracle corpus',
      `deployed ${deployed}@${deployedIterations}   oracle ${oracle}@${oracleIterations} x ${oracleRuns} runs`,
      `own moves 1-${maxOwnMove}, every position, randomised openings (8 plies from the top 3)`,
      `${games} games from seed ${seedBase}`,
      '',
    ].join('\n'),
  );

  for (let g = 0; g < games; g += 1) {
    if (done.has(g)) continue;
    const pending: Array<{ state: GameState; player: PlayerColor; ply: number; ownMove: number }> = [];
    resetV12();
    await playSeatedGame({
      hero: 'mcts-bench',
      opponents: 'mcts-bench',
      seatVersions: Object.fromEntries(
        PLAYER_COLORS.map((c) => [c, deployed]),
      ) as Record<PlayerColor, AlgoVersionId>,
      seatPolicies: Object.fromEntries(PLAYER_COLORS.map((c) => [c, 'mcts-bench'])) as never,
      seed: seedBase + g,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: { iterationBudget: deployedIterations, skipWinOddsRefinement: true },
      onPly: (state, ply) => {
        if (state.finished) return;
        const player = state.currentTurn;
        const ownMove = 21 - state.remainingPieces[player].length + 1;
        if (ownMove <= maxOwnMove) pending.push({ state, player, ply, ownMove });
      },
    });

    let labelled = 0;
    for (let i = 0; i < pending.length; i += 1) {
      const { state, player, ply, ownMove } = pending[i];

      const heads: OracleHead[][] = [];
      for (let run = 0; run < oracleRuns; run += 1) {
        clearLegalMoveCache();
        resetV12();
        setSeed(seedBase + 2_000_000 + g * 997 + i * 31 + run);
        const r = await searchBestMove(state, player, 600_000, undefined, {
          version: oracle,
          iterationBudget: oracleIterations,
          skipWinOddsRefinement: true,
        });
        if (!r.bestMove) break;
        heads.push(
          r.rankedMoves.slice(0, topK).map((e) => ({
            placement: placementFor(e.move),
            visits: e.visits,
            value: e.value,
          })),
        );
      }
      if (heads.length < oracleRuns) continue;

      const tops = heads.map((h) => h[0].placement);
      const stableTop1 = tops.every((t) => t === tops[0]);
      const setOf = (h: OracleHead[]) => new Set(h.slice(0, 3).map((e) => e.placement));
      const first = setOf(heads[0]);
      const stableTop3 = heads
        .slice(1)
        .every((h) => [...setOf(h)].filter((x) => first.has(x)).length === first.size);

      clearLegalMoveCache();
      resetV12();
      setSeed(seedBase + g * 991 + i);
      const play = await searchBestMove(state, player, 600_000, undefined, {
        version: deployed,
        iterationBudget: deployedIterations,
        skipWinOddsRefinement: true,
      });
      if (!play.bestMove) continue;
      const deployedId = placementFor(play.bestMove);
      const byId = new Map(heads[0].map((e) => [e.placement, e.value] as const));
      const top = heads[0][0]?.value ?? 0;
      const deployedValue = byId.get(deployedId);

      existing.rows.push({
        game: g,
        state,
        seed: seedBase + g,
        seat: player,
        ownMove,
        ply,
        legal: play.rankedMoves.length,
        oracleTopPerRun: tops,
        stableTop1,
        stableTop3,
        head: heads[0],
        deployed: deployedId,
        deployedRegret: deployedValue === undefined ? null : top - deployedValue,
      });
      labelled += 1;
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(existing, null, 2)}\n`);
    const stable = existing.rows.filter((r) => r.stableTop1).length;
    console.log(
      `  game ${g + 1}/${games}: +${labelled} positions — ${existing.rows.length} total, ` +
        `${stable} stable-top1 (${((100 * stable) / Math.max(1, existing.rows.length)).toFixed(0)}%)`,
    );
  }

  console.log(`\nWrote ${outPath} — ${existing.rows.length} positions from ${new Set(existing.rows.map((r) => r.game)).size} games`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
