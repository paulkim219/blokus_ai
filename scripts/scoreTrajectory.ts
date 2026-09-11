import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import { calculateScores } from '../src/engine/game.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';

/**
 * Score trajectory over a game: hero versus the mean of its three opponents, ply by ply.
 *
 * Blokus score is `−(squares still in hand)`, so every trajectory starts at −89 and climbs toward 0
 * as pieces go down. The *shape* is what distinguishes engines — where they stop climbing is where
 * they run out of placeable space — and the gap at the end is the match statistic.
 *
 * Also records per-move wall clock per seat, which is what justifies the lite/pro naming.
 *
 *   npm run trajectory -- --hero v1 --opponents greedy --games 8
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export interface TrajectoryResult {
  label: string;
  heroVersion: string;
  heroPolicy: PolicyId;
  opponentVersion: string;
  opponentPolicy: PolicyId;
  games: number;
  iterations: number | null;
  /** Mean hero score at each ply index, averaged over games. */
  hero: number[];
  /** Mean of the three opponents' scores at each ply index. */
  opponents: number[];
  /** Mean ms per move. */
  heroMsPerMove: number;
  opponentMsPerMove: number;
  finalHero: number;
  finalOpponents: number;
}

async function run(
  label: string,
  heroVersion: AlgoVersionId,
  opponentVersion: AlgoVersionId,
  heroPolicy: PolicyId,
  opponentPolicy: PolicyId,
  games: number,
  seedBase: number,
  iterations: number | undefined,
): Promise<TrajectoryResult> {
  const heroColor: PlayerColor = 'blue';
  // Indexed by the hero's own turn, not by ply: a seat's score only moves when that seat plays, so
  // a per-ply curve is a staircase with three flat steps between every rise. 22 turns covers the
  // 21 pieces plus the final state.
  const maxPly = 22;
  const heroSum = new Float64Array(maxPly);
  const oppSum = new Float64Array(maxPly);
  let longest = 0;
  let heroMs = 0;
  let heroMoves = 0;
  let oppMs = 0;
  let oppMoves = 0;

  for (let g = 0; g < games; g += 1) {
    resetV12();
    const seatVersions = Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, c === heroColor ? heroVersion : opponentVersion]),
    ) as Record<PlayerColor, AlgoVersionId>;
    const seatPolicies = Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, c === heroColor ? heroPolicy : opponentPolicy]),
    ) as Record<PlayerColor, PolicyId>;

    let lastAt = Date.now();
    const gameHero = new Float64Array(maxPly);
    const gameOpp = new Float64Array(maxPly);
    let plies = 0;
    const record = await playSeatedGame({
      hero: heroPolicy,
      opponents: opponentPolicy,
      heroColor,
      seatVersions,
      seatPolicies,
      seed: seedBase + g,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: {
        iterationBudget: iterations,
        skipWinOddsRefinement: true,
        lightRollouts: true,
      },
      onPly: (state: GameState) => {
        // Sample once per round, at the point the hero is on move.
        if (state.currentTurn === heroColor && plies < maxPly) {
          const scores = calculateScores(state);
          gameHero[plies] = scores.find((s) => s.color === heroColor)!.score;
          gameOpp[plies] =
            scores.filter((s) => s.color !== heroColor).reduce((sum, s) => sum + s.score, 0) / 3;
          plies += 1;
        }
        lastAt = Date.now();
      },
      onMove: (state: GameState) => {
        const elapsed = Date.now() - lastAt;
        if (state.currentTurn === heroColor) {
          heroMs += elapsed;
          heroMoves += 1;
        } else {
          oppMs += elapsed;
          oppMoves += 1;
        }
      },
    });

    // Games end at different plies. Carry each game's *final* score forward to the full width, so
    // every game contributes at every ply — otherwise the tail averages only the long games, which
    // are exactly the ones where somebody still had space, and the curve bends upward for free.
    const finalHero = record.scores[heroColor];
    const finalOpp =
      PLAYER_COLORS.filter((c) => c !== heroColor).reduce((sum, c) => sum + record.scores[c], 0) / 3;
    for (let ply = 0; ply < maxPly; ply += 1) {
      heroSum[ply] += ply < plies ? gameHero[ply] : finalHero;
      oppSum[ply] += ply < plies ? gameOpp[ply] : finalOpp;
    }
    longest = Math.max(longest, plies);
  }

  const hero: number[] = [];
  const opponents: number[] = [];
  for (let ply = 0; ply < longest; ply += 1) {
    hero.push(heroSum[ply] / games);
    opponents.push(oppSum[ply] / games);
  }

  return {
    label,
    heroVersion,
    heroPolicy,
    opponentVersion,
    opponentPolicy,
    games,
    iterations: iterations ?? null,
    hero,
    opponents,
    heroMsPerMove: heroMoves ? heroMs / heroMoves : 0,
    opponentMsPerMove: oppMoves ? oppMs / oppMoves : 0,
    finalHero: hero[hero.length - 1] ?? 0,
    finalOpponents: opponents[opponents.length - 1] ?? 0,
  };
}

async function main(): Promise<void> {
  const games = Math.max(1, Number(arg('games', '8')));
  const seedBase = Number(arg('seed-base', '9100000'));
  const iterationsRaw = arg('iterations', '300');
  const iterations = iterationsRaw === 'none' ? undefined : Number(iterationsRaw);
  const outPath = arg('out', 'selfplay-results/trajectories.json')!;

  // hero, opponent, heroPolicy, opponentPolicy, label
  const matchups: Array<[string, string, PolicyId, PolicyId, string]> = [
    ['v1', 'v1', 'mcts-bench', 'greedy', 'v1 vs 3× greedy'],
    ['v2-lite', 'v2-lite', 'mcts-bench', 'greedy', 'v2-lite vs 3× greedy'],
    ['v2-pro', 'v1', 'mcts-bench', 'mcts-bench', 'v2-pro vs 3× v1'],
    ['v3', 'v3', 'mcts-bench', 'greedy', 'v3 vs 3× greedy'],
    ['v3.1-lite', 'v3', 'mcts-bench', 'mcts-bench', 'v3.1-lite vs 3× v3'],
    ['v3.1', 'v3', 'mcts-bench', 'mcts-bench', 'v3.1 vs 3× v3'],
  ];

  const results: TrajectoryResult[] = [];
  for (const [hero, opp, hp, op, label] of matchups) {
    if (!isAlgoVersionId(hero) || !isAlgoVersionId(opp)) {
      console.error(`skipping ${label}: unknown version`);
      continue;
    }
    process.stdout.write(`${label} … `);
    const started = Date.now();
    const r = await run(label, hero, opp, hp, op, games, seedBase, iterations);
    results.push(r);
    console.log(
      `hero ${r.finalHero.toFixed(1)} vs opp ${r.finalOpponents.toFixed(1)}  ` +
        `(${r.heroMsPerMove.toFixed(0)} ms/move vs ${r.opponentMsPerMove.toFixed(0)})  ` +
        `[${((Date.now() - started) / 1000).toFixed(0)}s]`,
    );
  }

  mkdirSync(join(process.cwd(), 'selfplay-results'), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ games, iterations, results }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
