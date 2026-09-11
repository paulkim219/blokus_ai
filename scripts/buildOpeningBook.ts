/**
 * Generate the opening book corpus. The mechanism has been wired since the report was implemented;
 * this is the thing that has never existed, and the reason the candidate was never tournamented:
 * "book.ts contains the lookup mechanism but no generated, seed-stable book corpus".
 *
 * Why the opening and not somewhere else. E2 measured the deployed search agreeing with a ~7x oracle
 * **8% of the time** in the opening, against 67% midgame and 78% endgame, with 0.62 squares of
 * regret per move. W1 then measured that doubling the runtime budget there recovers essentially
 * nothing (slope 0.067 [-0.167, 0.274]). That combination — large error, no response to more search —
 * is the textbook case for offline compute, because a book's quality is set by the oracle budget
 * used to build it rather than by the tier that plays it.
 *
 * Three properties the generation has to have, each of which has burned this project before:
 *
 *   1. **Generated from seeds disjoint from any match.** A book built on the seeds it is tested on
 *      is memorising the test set. `--seed-base` is recorded in the file.
 *   2. **Stability-gated.** An entry is kept only when independent searches of the same position
 *      agree, which is what `agreement` records. A book of single noisy searches is a book of
 *      blunders played with total confidence.
 *   3. **Resumable.** Long jobs on this machine are routinely reaped; the book is written after
 *      every position.
 *
 *   node --import tsx scripts/buildOpeningBook.ts --games 120 --max-ply 8 --searches 3
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { playSeatedGame } from '../src/ai/selfplay.ts';
import { setSeed } from '../src/ai/rng.ts';
import { placementFor, resetV12, seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import type { BookEntry, BookFile } from '../src/ai/bitboard/book.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

interface Candidate {
  state: GameState;
  player: PlayerColor;
  hi: number;
  lo: number;
  ply: number;
  /** How often this exact position came up in the harvest — the book's coverage weight. */
  count: number;
}

async function harvest(
  generator: AlgoVersionId,
  games: number,
  seedBase: number,
  maxPly: number,
  iterations: number,
  openingRandomPlies: number,
  openingTopK: number,
): Promise<Candidate[]> {
  const seen = new Map<string, Candidate>();
  for (let g = 0; g < games; g += 1) {
    resetV12();
    await playSeatedGame({
      hero: 'mcts-bench',
      opponents: 'mcts-bench',
      seatVersions: Object.fromEntries(
        PLAYER_COLORS.map((c) => [c, generator]),
      ) as Record<PlayerColor, AlgoVersionId>,
      seatPolicies: Object.fromEntries(PLAYER_COLORS.map((c) => [c, 'mcts-bench'])) as never,
      seed: seedBase + g,
      // Harvest under the same opening sampling the matches use, so the book covers the
      // distribution of positions that will actually be looked up rather than one principal line.
      openingRandomPlies,
      openingTopK,
      searchOptions: { iterationBudget: iterations, skipWinOddsRefinement: true },
      onPly: (state, ply) => {
        if (ply >= maxPly || state.finished) return;
        const position = toPosition(state);
        const key = `${position.hashHi}:${position.hashLo}`;
        const existing = seen.get(key);
        if (existing) existing.count += 1;
        else {
          seen.set(key, {
            state,
            player: state.currentTurn,
            hi: position.hashHi,
            lo: position.hashLo,
            ply,
            count: 1,
          });
        }
      },
    });
    if ((g + 1) % 10 === 0) {
      console.log(`  harvest ${g + 1}/${games} games — ${seen.size} distinct positions`);
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.ply - b.ply);
}

async function main(): Promise<void> {
  preloadNets();

  const generator = arg('generator', 'v3.2-pro-max');
  const oracle = arg('oracle', 'v3.2-pro-max');
  const games = Number(arg('games', '120'));
  const maxPly = Number(arg('max-ply', '8'));
  const searches = Number(arg('searches', '3'));
  const topK = Number(arg('top-k', '3'));
  const minAgreement = Number(arg('min-agreement', '2'));
  const oracleIterations = Number(arg('oracle-iterations', '2400'));
  const harvestIterations = Number(arg('iterations', '300'));
  const openingRandomPlies = Number(arg('opening-random-plies', '8'));
  const openingTopK = Number(arg('opening-top-k', '3'));
  // Deliberately far from every match block used in the v3.5/v3.6 work.
  const seedBase = Number(arg('seed-base', '51000000'));
  const maxPositions = Number(arg('positions', '600'));
  const outPath = arg('out', 'selfplay-results/opening-book.json');

  if (!isAlgoVersionId(generator) || !isAlgoVersionId(oracle)) {
    throw new Error(`unknown version: ${generator} / ${oracle}`);
  }

  const existing: BookFile = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf8')) as BookFile)
    : { entries: [] };
  const done = new Set(existing.entries.map((e) => `${e.hi}:${e.lo}`));
  if (done.size > 0) console.log(`resuming: ${done.size} entries already on disk\n`);

  console.log(
    `Harvesting positions through ply ${maxPly} from ${games} ${generator} games ` +
      `(seeds ${seedBase}..${seedBase + games - 1})\n`,
  );
  const candidates = (
    await harvest(
      generator,
      games,
      seedBase,
      maxPly,
      harvestIterations,
      openingRandomPlies,
      openingTopK,
    )
  ).slice(0, maxPositions);

  console.log(
    `\n${candidates.length} positions to label, ${searches} independent ` +
      `${oracle} searches each at ${oracleIterations} base iterations\n`,
  );

  const entries: BookEntry[] = [...existing.entries];
  let kept = 0;
  let dropped = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (done.has(`${candidate.hi}:${candidate.lo}`)) continue;

    // Independent searches of the same position. Their agreement is the stability gate; their
    // pooled values give the ranking.
    const votes = new Map<number, { first: number; valueSum: number; seen: number }>();
    for (let s = 0; s < searches; s += 1) {
      resetV12();
      setSeed(seedBase + 7_000_000 + i * 101 + s);
      const result = await searchBestMove(candidate.state, candidate.player, 600_000, undefined, {
        version: oracle,
        iterationBudget: oracleIterations,
        skipWinOddsRefinement: true,
      });
      result.rankedMoves.slice(0, Math.max(topK, 4)).forEach((ranked, rank) => {
        const id = placementFor(ranked.move);
        const record = votes.get(id) ?? { first: 0, valueSum: 0, seen: 0 };
        if (rank === 0) record.first += 1;
        record.valueSum += ranked.value;
        record.seen += 1;
        votes.set(id, record);
      });
    }

    const ranked = [...votes.entries()]
      .map(([move, v]) => ({ move, value: v.valueSum / v.seen, agreement: v.first }))
      .sort((a, b) => b.agreement - a.agreement || b.value - a.value);

    // The stability gate. Without it the book records one search's noise as settled theory.
    if (ranked.length === 0 || ranked[0].agreement < minAgreement) {
      dropped += 1;
    } else {
      entries.push({ hi: candidate.hi, lo: candidate.lo, moves: ranked.slice(0, topK) });
      kept += 1;
    }

    const file: BookFile = {
      entries,
      generatorSeedBase: seedBase,
      generatorGames: games,
      oracle,
      oracleIterations,
      maxPly,
    };
    writeFileSync(outPath, `${JSON.stringify(file)}\n`);

    if ((i + 1) % 10 === 0) {
      console.log(
        `  ${i + 1}/${candidates.length} labelled — ${kept} kept, ${dropped} dropped ` +
          `(unstable across ${searches} searches)`,
      );
    }
  }

  console.log(
    [
      '',
      `Book written to ${outPath}`,
      `  entries      ${entries.length}`,
      `  kept         ${kept}`,
      `  dropped      ${dropped} (top move agreed on by fewer than ${minAgreement}/${searches} searches)`,
      `  seeds        ${seedBase}..${seedBase + games - 1}  — assert your match block is disjoint`,
      '',
      'A book must be matched on seeds it has never seen. The generator seed range is stored in the',
      'file so that claim is checkable rather than remembered.',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
