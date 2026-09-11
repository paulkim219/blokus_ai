/**
 * W1 — which of a seat's 21 moves converts compute into score.
 *
 * The allocation criterion is a *slope*, not a regret. If a seat's contribution to the final margin
 * is `a_k + c_k*log(n_k)` at own-move `k`, and the per-game total `sum(n_k)` is fixed, then the
 * optimum is `n_k` proportional to `c_k` — the local points per doubling. Two consequences decide
 * what this script measures:
 *
 *   - A move with large oracle regret but a flat compute ladder cannot repay iterations. Regret is
 *     the *ceiling* on what better play at move k is worth; it is not what a bigger budget buys.
 *   - If every `c_k` is equal, reallocation is worth exactly zero, and a concave ladder makes an
 *     uneven shape marginally worse. So a flat profile here is a real result that stops the
 *     programme, not an inconclusive one.
 *
 * The measurement is a paired doubling. At each position: search at the deployed budget, search at
 * twice it, and ask a deeper oracle what each of the two chosen moves is worth. The difference in
 * oracle regret is what the doubling bought, in squares, at that move number.
 *
 * Two arms share the same RNG seed on purpose. The 2x search is then the 1x search continued rather
 * than an independent draw, which removes most of the seed variance from a difference that is
 * expected to be a fraction of a square.
 *
 * `rootHeadroom.ts` answers "how much is left at the root"; this answers "where in the game is a
 * bigger budget the thing that collects it". They share the cached corpus.
 *
 *   node --import tsx scripts/moveImportance.ts --oracle-iterations 1200
 *   node --import tsx scripts/moveImportance.ts --positions 120 --out selfplay-results/move-importance.json
 */

import { existsSync, writeFileSync } from 'node:fs';
import { moveKey } from '../src/engine/game.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import {
  bitboardParamsFor,
  getAlgo,
  isAlgoVersionId,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { loadCorpus } from './lib/rolloutCorpus.ts';
import { bootstrapCI, mean } from './lib/stats.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

/** 1-based, as a player counts their own moves: the move about to be played is `played + 1`. */
function ownMoveOf(state: GameState, color: PlayerColor): number {
  return 21 - state.remainingPieces[color].length + 1;
}

interface Row {
  game: number;
  ownMove: number;
  legal: number;
  /** Oracle's value of its own best move minus its value for the 1x arm's move, in squares. */
  regret1x: number;
  /** Same for the 2x arm. */
  regret2x: number;
  /** regret1x − regret2x: what the doubling bought here. This is the allocation criterion. */
  slope: number;
  agree1x: boolean;
  agree2x: boolean;
  /** The two arms picked the same move, so the doubling changed nothing at all. */
  sameMove: boolean;
}

interface BandSummary {
  label: string;
  n: number;
  games: number;
  slope: number;
  slopeLow: number;
  slopeHigh: number;
  regret1x: number;
  agree1x: number;
  changedMove: number;
}

/**
 * Bootstrap over *games*, not positions.
 *
 * Positions inside one game share a board, an opponent set and a game-level difficulty; resampling
 * them independently would report an interval several times tighter than the data supports. This is
 * the same by-game discipline `rolloutCorpus.ts` enforces on train/holdout splits.
 */
function byGame(rows: Row[], value: (row: Row) => number): number[] {
  const groups = new Map<number, number[]>();
  for (const row of rows) {
    const list = groups.get(row.game);
    if (list) list.push(value(row));
    else groups.set(row.game, [value(row)]);
  }
  return [...groups.values()].map((values) => mean(values));
}

function summarise(label: string, rows: Row[]): BandSummary | null {
  if (rows.length === 0) {
    return null;
  }
  const perGame = byGame(rows, (row) => row.slope);
  const ci = bootstrapCI(perGame);
  return {
    label,
    n: rows.length,
    games: perGame.length,
    slope: ci.mean,
    slopeLow: ci.low,
    slopeHigh: ci.high,
    regret1x: mean(rows.map((row) => row.regret1x)),
    agree1x: rows.filter((row) => row.agree1x).length / rows.length,
    changedMove: rows.filter((row) => !row.sameMove).length / rows.length,
  };
}

function formatRow(summary: BandSummary): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`.padStart(6);
  return [
    `  ${summary.label.padEnd(10)}`,
    `n=${String(summary.n).padStart(4)}`,
    `games=${String(summary.games).padStart(3)}`,
    `slope=${summary.slope.toFixed(3).padStart(7)}`,
    `[${summary.slopeLow.toFixed(3).padStart(7)},${summary.slopeHigh.toFixed(3).padStart(7)}]`,
    `regret@1x=${summary.regret1x.toFixed(3).padStart(6)}`,
    `agree=${pct(summary.agree1x)}`,
    `moved=${pct(summary.changedMove)}`,
  ].join('  ');
}

const BANDS: Array<[string, number, number]> = [
  ['moves 1-3', 1, 3],
  ['moves 4-6', 4, 6],
  ['moves 7-9', 7, 9],
  ['moves 10-12', 10, 12],
  ['moves 13-15', 13, 15],
  ['moves 16-18', 16, 18],
  ['moves 19-21', 19, 21],
];

async function main(): Promise<void> {
  preloadNets();

  const corpusPath = arg('corpus', 'tmp/corpus.json')!;
  const deployedArg = arg('deployed', 'v3.2-pro')!;
  const oracleArg = arg('oracle', 'v3.2-pro-max')!;
  const iterations = Number(arg('iterations', '300'));
  const oracleIterations = Number(arg('oracle-iterations', '1200'));
  const maxPositions = Number(arg('positions', '10000'));
  const seedBase = Number(arg('seed-base', '36100000'));
  const outPath = arg('out', 'selfplay-results/move-importance.json')!;

  if (!isAlgoVersionId(deployedArg) || !isAlgoVersionId(oracleArg)) {
    throw new Error(`unknown version: ${deployedArg} / ${oracleArg}`);
  }
  if (!existsSync(corpusPath)) {
    throw new Error(
      `no corpus at ${corpusPath} — build one with: node --import tsx scripts/buildCorpus.ts`,
    );
  }
  const deployed = deployedArg;
  const oracle = oracleArg;

  const deployedScale = bitboardParamsFor(getAlgo(deployed)).search.iterationScale;
  const oracleScale = bitboardParamsFor(getAlgo(oracle)).search.iterationScale;
  const effective1x = Math.round(iterations * deployedScale);
  const effectiveOracle = Math.round(oracleIterations * oracleScale);

  const all = loadCorpus(corpusPath);
  const step = Math.max(1, Math.floor(all.length / maxPositions));
  const samples = all.filter((_, index) => index % step === 0).slice(0, maxPositions);

  console.log(
    [
      'W1 — compute sensitivity by own-move index',
      `deployed ${deployed} @ ${effective1x} iters, doubled arm @ ${effective1x * 2}`,
      `oracle ${oracle} @ ${effectiveOracle} iters (${(effectiveOracle / effective1x).toFixed(1)}x the 1x arm)`,
      `${samples.length} positions from ${new Set(samples.map((s) => s.game)).size} games (${corpusPath})`,
      '',
    ].join('\n'),
  );

  const rows: Row[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const { state, player, game } = samples[i];

    // Paired: both arms replay the same stream, so the 2x arm continues the 1x arm's search rather
    // than drawing an independent one. The oracle gets its own seed — it is the referee, and
    // sharing a stream with a contestant is how a self-oracle flatters itself.
    const armSeed = seedBase + i;
    resetV12();
    setSeed(armSeed);
    const at1x = await searchBestMove(state, player, 600_000, undefined, {
      version: deployed,
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
    });
    resetV12();
    setSeed(armSeed);
    const at2x = await searchBestMove(state, player, 600_000, undefined, {
      version: deployed,
      iterationBudget: iterations * 2,
      skipWinOddsRefinement: true,
    });
    resetV12();
    setSeed(armSeed + 7_000_000);
    const judged = await searchBestMove(state, player, 600_000, undefined, {
      version: oracle,
      iterationBudget: oracleIterations,
      skipWinOddsRefinement: true,
    });

    if (!at1x.bestMove || !at2x.bestMove || !judged.bestMove) continue;

    const byKey = new Map(judged.rankedMoves.map((entry) => [moveKey(entry.move), entry.value]));
    const top = judged.rankedMoves[0]?.value ?? 0;
    const key1x = moveKey(at1x.bestMove);
    const key2x = moveKey(at2x.bestMove);
    const value1x = byKey.get(key1x);
    const value2x = byKey.get(key2x);
    // A move the oracle never visited has no value to compare. Dropping those biases the slope
    // *against* the arm that plays them, and the 1x arm plays more of them, so this is conservative
    // in the direction that matters.
    if (value1x === undefined || value2x === undefined) continue;

    const regret1x = top - value1x;
    const regret2x = top - value2x;
    const oracleKey = moveKey(judged.bestMove);

    rows.push({
      game,
      ownMove: ownMoveOf(state, player),
      legal: at1x.rankedMoves.length,
      regret1x,
      regret2x,
      slope: regret1x - regret2x,
      agree1x: key1x === oracleKey,
      agree2x: key2x === oracleKey,
      sameMove: key1x === key2x,
    });

    if ((i + 1) % 25 === 0) {
      console.log(`  ${i + 1}/${samples.length} positions — ${rows.length} scored`);
    }
  }

  const overall = summarise('ALL', rows)!;
  const bands = BANDS.map(([label, from, to]) =>
    summarise(label, rows.filter((row) => row.ownMove >= from && row.ownMove <= to)),
  ).filter((band): band is BandSummary => band !== null);
  const perMove = Array.from({ length: 21 }, (_, k) =>
    summarise(`move ${k + 1}`, rows.filter((row) => row.ownMove === k + 1)),
  ).filter((band): band is BandSummary => band !== null);

  console.log('\n=== Slope: squares of oracle regret recovered per doubling ===\n');
  console.log(formatRow(overall));
  console.log('');
  for (const band of bands) {
    console.log(formatRow(band));
  }

  const spread = Math.max(...bands.map((b) => b.slope)) - Math.min(...bands.map((b) => b.slope));
  console.log(
    [
      '',
      `Spread across bands: ${spread.toFixed(3)} squares/doubling.`,
      'This is the number the whole plan rests on. A flat profile means the optimal shape is the',
      'flat one and there is nothing to reallocate; only a profile whose bands separate by more',
      'than their intervals justifies spending a match ladder on a fitted shape.',
      '',
      'Two cautions, both pushing the *level* up and neither the difference:',
      '  - the oracle is a stronger search, not ground truth;',
      '  - taking a max over noisy children inflates regret (winner’s curse). It inflates both',
      '    arms about equally, which is the reason to read the slope and not the level.',
    ].join('\n'),
  );

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        deployed,
        oracle,
        iterations,
        oracleIterations,
        effective: { arm1x: effective1x, arm2x: effective1x * 2, oracle: effectiveOracle },
        corpus: corpusPath,
        overall,
        bands,
        perMove,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
