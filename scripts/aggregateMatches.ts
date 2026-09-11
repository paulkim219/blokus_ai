import { readFileSync } from 'node:fs';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import { formatMatchSummary, summarizeMatch, type RotationGame } from './lib/stats.ts';

/**
 * Combine several match logs into one summary.
 *
 * A seed is the unit of sampling — the four rotations of a seed make one paired observation — so
 * independent runs on *disjoint* seed ranges can be pooled into a single bootstrap. That matters
 * here for a practical reason: long runs on this machine are frequently interrupted, and a 100-seed
 * result assembled from five 20-seed chunks is statistically identical to one 100-seed run, while
 * each chunk is short enough to finish.
 *
 * Refuses to pool overlapping seeds, which would double-count observations and shrink the interval
 * dishonestly.
 *
 *   npm run aggregate -- selfplay-results/match-A.jsonl selfplay-results/match-B.jsonl
 *
 * A mechanism reproduced at two compute tiers has different config ids even though the tested
 * change is the same. Pool that case only with explicit display labels; without both flags the
 * command keeps refusing mixed challengers/champions exactly as before:
 *
 *   npm run aggregate -- --pooled-challenger v3.6-shape --pooled-champion v3.2 \
 *     selfplay-results/match-pro.jsonl selfplay-results/match-pro-max.jsonl
 */

interface LoggedGame extends RotationGame {
  challenger?: string;
  champion?: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const paths = process.argv.slice(2).filter((a) => a.endsWith('.jsonl'));
  if (paths.length === 0) {
    console.error('usage: npm run aggregate -- <match-*.jsonl> [...]');
    process.exitCode = 1;
    return;
  }

  const bySeed = new Map<number, RotationGame[]>();
  const seenIn = new Map<number, string>();
  const pooledChallenger = arg('pooled-challenger');
  const pooledChampion = arg('pooled-champion');
  if ((pooledChallenger === undefined) !== (pooledChampion === undefined)) {
    console.error('mixed-config pooling requires both --pooled-challenger and --pooled-champion');
    process.exitCode = 1;
    return;
  }
  const allowMixedConfigs = pooledChallenger !== undefined && pooledChampion !== undefined;
  const configPairs = new Set<string>();
  let challenger = '';
  let champion = '';
  let duplicates = 0;

  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const game = JSON.parse(line) as LoggedGame;
      challenger ||= game.challenger ?? '';
      champion ||= game.champion ?? '';
      if (!allowMixedConfigs && game.challenger && game.challenger !== challenger) {
        console.error(`refusing to pool: ${path} is ${game.challenger}, expected ${challenger}`);
        process.exitCode = 1;
        return;
      }
      if (!allowMixedConfigs && game.champion && game.champion !== champion) {
        console.error(`refusing to pool: ${path} is vs ${game.champion}, expected ${champion}`);
        process.exitCode = 1;
        return;
      }
      configPairs.add(`${game.challenger ?? '?'} vs ${game.champion ?? '?'}`);
      const owner = seenIn.get(game.seed);
      if (owner !== undefined && owner !== path) {
        duplicates += 1;
        continue;
      }
      seenIn.set(game.seed, path);
      const bucket = bySeed.get(game.seed) ?? [];
      bucket.push({ seed: game.seed, seat: game.seat, scores: game.scores, winner: game.winner });
      bySeed.set(game.seed, bucket);
    }
  }

  if (duplicates > 0) {
    console.error(
      `refusing to pool: ${duplicates} games repeat a seed already present in another log.\n` +
        'Overlapping seeds are not independent observations — re-run the chunks on disjoint bases.',
    );
    process.exitCode = 1;
    return;
  }

  // Only complete rotations are comparable; a partial quad reintroduces the seat bias.
  for (const [seed, games] of bySeed) {
    if (games.length !== PLAYER_COLORS.length) {
      bySeed.delete(seed);
    }
  }

  const seeds = [...bySeed.keys()].sort((a, b) => a - b);
  console.log(
    `Pooled ${paths.length} logs → ${bySeed.size} complete seeds ` +
      `(${bySeed.size * 4} games), seeds ${seeds[0]}–${seeds[seeds.length - 1]}\n`,
  );
  if (allowMixedConfigs) {
    console.log(`Config pairs: ${[...configPairs].join('; ')}\n`);
  }
  console.log(
    formatMatchSummary(
      summarizeMatch(pooledChallenger ?? challenger, pooledChampion ?? champion, bySeed),
    ),
  );
  const mde = 13.4 / Math.sqrt(Math.max(1, bySeed.size));
  console.log(`\nMinimum detectable effect at this sample size (80% power): ~${mde.toFixed(2)}`);
}

void (main as () => void)();
