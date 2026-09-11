/**
 * v3.5 workstream A, step 0 — does the committee have anything to decide?
 *
 * This is the gate in front of every expensive run in `v35Batch.ts`, and it exists to answer two
 * questions in minutes rather than hours:
 *
 *   1. **How often is the root decision actually contested?** If the primary's best child is
 *      separated from the runner-up by more than the band almost every time, arbitration can only
 *      touch a handful of moves per game and the ceiling on the whole workstream is low. That is a
 *      reason to stop, and it costs one run to find out.
 *   2. **On the contested positions, is the primary already right?** A long-budget oracle picks
 *      among the same contested children. If the primary's choice matches the oracle as often as any
 *      combination of arbiters does, the second opinion has nothing to add and the workstream stops.
 *
 * The oracle is a *common* one — the same version and budget judges every combiner — because an
 * engine judged by a long-time-control copy of itself measures its own consistency rather than its
 * quality. `oracleLoss.ts` learned that the hard way and carries the same `--common-oracle` rule.
 *
 * **This is a diagnostic, not a significance test.** Positions within a game are correlated
 * observations, and the oracle is a stronger search rather than ground truth. Where a diagnostic and
 * a match have disagreed in this repo, the match was right — twice. Use this to decide what to
 * measure, never to report an effect.
 *
 *   npm run agreement -- --games 30 --positions 120 --primary v3.1-pro-max
 */

import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlaceMove, PlayerColor } from '../src/engine/types.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { moveKey } from '../src/engine/game.ts';
import {
  DEFAULT_COMMITTEE,
  arbitrate,
  type CommitteeMember,
  type CombineRule,
} from '../src/ai/committee.ts';
import { preloadNets } from './lib/netPreload.ts';
import { createRng } from '../src/ai/rng.ts';

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
  if (played < 5) {
    return 'opening';
  }
  return played < 15 ? 'midgame' : 'endgame';
}

interface Sample {
  state: GameState;
  player: PlayerColor;
  phase: PhaseName;
}

/** One contested decision, with every voter's answer already resolved to a move key. */
interface Decision {
  phase: PhaseName;
  size: number;
  primary: string;
  oracle: string | null;
  byArbiter: Record<string, string>;
  byRule: Record<CombineRule, string>;
}

const BANDS = (arg('bands', '0.02,0.05,0.10') ?? '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

async function collectSamples(
  games: number,
  seedBase: number,
  stride: number,
  generators: AlgoVersionId[],
  policy: PolicyId,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let g = 0; g < games; g += 1) {
    const generator = generators[g % generators.length];
    resetV12();
    const seatVersions = Object.fromEntries(PLAYER_COLORS.map((c) => [c, generator])) as Record<
      PlayerColor,
      AlgoVersionId
    >;
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
          samples.push({
            state,
            player: state.currentTurn,
            phase: phaseOf(state, state.currentTurn),
          });
        }
      },
    });
    if ((g + 1) % 10 === 0) {
      console.log(`  ${g + 1}/${games} games — ${samples.length} positions`);
    }
  }
  return samples;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '   —  ' : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
}

async function main(): Promise<void> {
  preloadNets();

  const games = Math.max(1, Number(arg('games', '30')));
  const seedBase = Number(arg('seed-base', '7900000'));
  const stride = Math.max(1, Number(arg('stride', '6')));
  const maxPositions = Math.max(1, Number(arg('positions', '120')));
  const primary = arg('primary', 'v3.1-pro-max') as AlgoVersionId;
  const iterations = Number(arg('iterations', '300'));
  const oracleId = arg('oracle', 'v3.1-pro-max');
  const oracleIterations = Number(arg('oracle-iterations', '2400'));
  const maxArbitrated = Math.max(2, Number(arg('max-arbitrated', '4')));

  const generators = (arg('generators', 'v2-pro,v3.1-lite') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is AlgoVersionId => isAlgoVersionId(v));

  const arbiters: CommitteeMember[] = (arg('arbiters', 'v2-pro,v3.1-lite,v4') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is AlgoVersionId => isAlgoVersionId(v))
    .map((version) => ({ version, weight: 1 }));

  console.log(
    `Root agreement — primary ${primary} @ ${iterations} base iterations, ` +
      `arbiters {${arbiters.map((a) => a.version).join(', ')}}\n` +
      `Oracle: ${oracleId ?? 'none'} @ ${oracleIterations} base iterations\n`,
  );

  console.log(`Generating positions from {${generators.join(', ')}}…`);
  const all = await collectSamples(games, seedBase, stride, generators, 'greedy');

  // Subsample deterministically: the expensive part is one pro-max search per position, and a
  // strided sample over whole games would over-weight the openings of the first few seeds.
  const rng = createRng(seedBase);
  const shuffled = [...all];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const samples = shuffled.slice(0, maxPositions);
  console.log(`\n${all.length} positions sampled, ${samples.length} searched.\n`);

  // band -> decisions
  const decisions = new Map<number, Decision[]>(BANDS.map((band) => [band, []]));
  let searched = 0;

  for (const sample of samples) {
    resetV12();
    const result = await searchBestMove(sample.state, sample.player, 60_000, undefined, {
      version: primary,
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
    });
    if (!result.bestMove || result.rankedMoves.length < 2) {
      continue;
    }
    searched += 1;

    // The oracle is by far the most expensive call here — it runs at several times the primary's
    // budget — and its answer is a property of the position, not of the band. Compute it at most
    // once per position, and only if some band actually produced a contested decision.
    let oracle: string | null = null;
    let oracleDone = false;
    const judgePosition = async (): Promise<string | null> => {
      if (oracleDone || !oracleId || oracleId === 'none') {
        return oracle;
      }
      oracleDone = true;
      resetV12();
      const judged = await searchBestMove(sample.state, sample.player, 600_000, undefined, {
        version: oracleId as AlgoVersionId,
        iterationBudget: oracleIterations,
        skipWinOddsRefinement: true,
      });
      oracle = judged.bestMove ? moveKey(judged.bestMove) : null;
      return oracle;
    };

    for (const band of BANDS) {
      const params = { ...DEFAULT_COMMITTEE, primary, arbiters, band, maxArbitrated };
      // `arbitrate` with a single member reproduces that member's own choice, which is how each
      // voter's answer is read out without duplicating the scoring code here.
      const byArbiter: Record<string, string> = {};
      for (const arbiter of arbiters) {
        const solo = arbitrate(sample.state, sample.player, result, {
          ...params,
          arbiters: [arbiter],
          primaryWeight: 0,
        });
        byArbiter[arbiter.version] = moveKey(solo.bestMove as PlaceMove);
      }

      const byRule = {} as Record<CombineRule, string>;
      for (const rule of ['borda', 'geomMean'] as const) {
        const pooled = arbitrate(sample.state, sample.player, result, { ...params, combine: rule });
        byRule[rule] = moveKey(pooled.bestMove as PlaceMove);
      }

      // Contested only: if every voter had the same candidate set of one, there was no decision.
      const votes = new Set([moveKey(result.bestMove), ...Object.values(byArbiter)]);
      if (votes.size < 2) {
        continue;
      }

      decisions.get(band)!.push({
        phase: sample.phase,
        size: votes.size,
        primary: moveKey(result.bestMove),
        oracle: await judgePosition(),
        byArbiter,
        byRule,
      });
    }

    if (searched % 20 === 0) {
      console.log(`  ${searched}/${samples.length} searched`);
    }
  }

  console.log('\n=== How often the root decision is contested ===\n');
  console.log('band     contested   opening  midgame  endgame');
  for (const band of BANDS) {
    const rows = decisions.get(band)!;
    const byPhase = (phase: PhaseName): string =>
      pct(rows.filter((d) => d.phase === phase).length, samples.filter((s) => s.phase === phase).length);
    console.log(
      `${band.toFixed(2).padStart(4)}   ${pct(rows.length, searched)}     ` +
        `${byPhase('opening')}   ${byPhase('midgame')}  ${byPhase('endgame')}`,
    );
  }

  if (!oracleId || oracleId === 'none') {
    console.log('\nNo oracle requested, so no regret table. Re-run with --oracle to get the gate.');
    return;
  }

  console.log('\n=== On contested decisions only: agreement with the common oracle ===\n');
  console.log('The gate. If no combiner beats "primary", the second opinion adds nothing.\n');
  type Voter =
    | { kind: 'primary'; name: string }
    | { kind: 'arbiter'; name: AlgoVersionId }
    | { kind: 'rule'; name: CombineRule };
  const voters: Voter[] = [
    { kind: 'primary', name: 'primary' },
    ...arbiters.map((a): Voter => ({ kind: 'arbiter', name: a.version })),
    ...(['borda', 'geomMean'] as const).map((rule): Voter => ({ kind: 'rule', name: rule })),
  ];

  console.log(['band'.padEnd(6), ...voters.map((v) => v.name.padStart(12))].join(''));
  for (const band of BANDS) {
    const rows = decisions.get(band)!.filter((d) => d.oracle !== null);
    const cells = voters.map((voter) => {
      const hits = rows.filter((d) => {
        const pick =
          voter.kind === 'primary'
            ? d.primary
            : voter.kind === 'rule'
              ? d.byRule[voter.name]
              : d.byArbiter[voter.name];
        return pick === d.oracle;
      }).length;
      return pct(hits, rows.length).padStart(12);
    });
    console.log([`${band.toFixed(2)}`.padEnd(6), ...cells].join(''));
    console.log(`      (n = ${rows.length} contested decisions)`);
  }

  console.log(
    '\nRead this as a ranking of what to measure, not as a result. Positions within a game are\n' +
      'correlated, and the oracle is a stronger search rather than the truth.',
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
