import { readFileSync } from 'node:fs';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { PIECES } from '../src/engine/pieces.ts';
import {
  isAlgoVersionId,
  registerAlgoConfig,
  type AlgoConfig,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';

/**
 * Piece-size-by-own-move-index, per version.
 *
 * The diagnostic for a piece-management failure: v12 ends games with ~4.5 more squares in hand than
 * v11 on identical seeds. Either it holds large pieces too long, or it spends them into shapes it
 * cannot finish. Both show up here as a lag in the mean size of the piece played at own move k.
 *
 * Self-play with all four seats on one version, so the curve is that version's own behaviour rather
 * than its behaviour against a particular opponent.
 *
 *   npm run piece-schedule -- --versions v11,v12 --games 40 --policy greedy
 */

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

interface Profile {
  version: AlgoVersionId;
  /** sizeSum[k] / sizeCount[k] = mean size of the piece played at own move k. */
  sizeSum: Float64Array;
  sizeCount: Int32Array;
  /** Squares left in hand at the end, averaged over seats and games. */
  leftover: number;
  piecesPlayed: number;
  games: number;
}

async function profileVersion(
  version: AlgoVersionId,
  games: number,
  seedBase: number,
  policy: PolicyId,
  iterationBudget: number | undefined,
): Promise<Profile> {
  const sizeSum = new Float64Array(21);
  const sizeCount = new Int32Array(21);
  let leftover = 0;
  let piecesPlayed = 0;

  const seatVersions = Object.fromEntries(
    PLAYER_COLORS.map((c) => [c, version]),
  ) as Record<PlayerColor, AlgoVersionId>;
  const seatPolicies = Object.fromEntries(
    PLAYER_COLORS.map((c) => [c, policy]),
  ) as Record<PlayerColor, PolicyId>;

  for (let g = 0; g < games; g += 1) {
    resetV12();
    const ownMove: Record<string, number> = { blue: 0, yellow: 0, purple: 0, green: 0 };

    const record = await playSeatedGame({
      hero: policy,
      opponents: policy,
      seatVersions,
      seatPolicies,
      seed: seedBase + g,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: {
        iterationBudget,
        skipWinOddsRefinement: true,
        lightRollouts: true,
      },
      onMove: (_state, move) => {
        if (!move) {
          return;
        }
        const k = ownMove[move.color];
        if (k < 21) {
          sizeSum[k] += PIECES[move.pieceId].size;
          sizeCount[k] += 1;
        }
        ownMove[move.color] = k + 1;
        piecesPlayed += 1;
      },
    });

    // score = -(squares left) unless everything was placed, so recover leftover from the score.
    for (const color of PLAYER_COLORS) {
      const score = record.scores[color];
      leftover += score > 0 ? 0 : -score;
    }
  }

  return {
    version,
    sizeSum,
    sizeCount,
    leftover: leftover / (games * PLAYER_COLORS.length),
    piecesPlayed: piecesPlayed / (games * PLAYER_COLORS.length),
    games,
  };
}

function bar(value: number, scale = 12): string {
  return '█'.repeat(Math.max(0, Math.round(value * scale)));
}

async function main(): Promise<void> {
  // Generated configs (tuner output) are registered under their own id so they can be profiled
  // beside the named versions — the tuned engine is the one that matters for a diagnosis.
  const files = (arg('files') ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  const fileIds: AlgoVersionId[] = files.map((path) => {
    const config = JSON.parse(readFileSync(path, 'utf8')) as AlgoConfig;
    registerAlgoConfig(config);
    return config.id;
  });

  const versions = [
    ...(arg('versions', 'v11,v12') ?? 'v11,v12')
      .split(',')
      .map((v) => v.trim())
      .filter((v): v is AlgoVersionId => isAlgoVersionId(v)),
    ...fileIds,
  ];
  const games = Math.max(1, Number(arg('games', '40')));
  const seedBase = Number(arg('seed-base', '4200000'));
  const policy = (arg('policy', 'greedy') ?? 'greedy') as PolicyId;
  const iterationsRaw = arg('iterations');
  const iterationBudget = iterationsRaw ? Number(iterationsRaw) : undefined;

  console.log(
    `Piece-size schedule — ${versions.join(' vs ')}, ${games} self-play games each, ` +
      `policy ${policy}${iterationBudget ? ` (${iterationBudget} iterations)` : ''}\n`,
  );

  const profiles: Profile[] = [];
  for (const version of versions) {
    profiles.push(await profileVersion(version, games, seedBase, policy, iterationBudget));
    console.log(`  ${version} done`);
  }

  console.log('\nMean size of piece played at own move k:\n');
  const header = ['  k'.padEnd(4), ...profiles.map((p) => p.version.padStart(8))].join('  ');
  console.log(header + '     delta');
  console.log('-'.repeat(header.length + 12));

  for (let k = 0; k < 21; k += 1) {
    const means = profiles.map((p) =>
      p.sizeCount[k] > 0 ? p.sizeSum[k] / p.sizeCount[k] : Number.NaN,
    );
    if (means.every((m) => Number.isNaN(m))) {
      continue;
    }
    const delta = means.length === 2 ? means[1] - means[0] : Number.NaN;
    const cells = means.map((m) => (Number.isNaN(m) ? '     —  ' : m.toFixed(2).padStart(8)));
    const marker =
      Number.isNaN(delta) || Math.abs(delta) < 0.005
        ? ''
        : delta > 0
          ? `+${delta.toFixed(2)} ${bar(delta)}`
          : `${delta.toFixed(2)} ${bar(-delta)}`;
    console.log([String(k).padStart(3).padEnd(4), ...cells].join('  ') + '     ' + marker);
  }

  console.log('\nSummary (per seat, per game):');
  for (const p of profiles) {
    console.log(
      `  ${p.version.padEnd(10)} pieces played ${p.piecesPlayed.toFixed(2).padStart(6)}   ` +
        `squares left ${p.leftover.toFixed(2).padStart(6)}`,
    );
  }
  if (profiles.length === 2) {
    console.log(
      `\n  ${profiles[1].version} leaves ` +
        `${(profiles[1].leftover - profiles[0].leftover).toFixed(2)} more squares in hand than ` +
        `${profiles[0].version}, and plays ` +
        `${(profiles[1].piecesPlayed - profiles[0].piecesPlayed).toFixed(2)} fewer pieces.`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
