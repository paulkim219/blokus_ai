import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import {
  ALGO_VERSIONS,
  isAlgoVersionId,
  type AlgoConfig,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';
import { GamePool, defaultWorkerCount, type GameAssignment } from './lib/pool.ts';
import { rotationAdvantage, type RotationGame } from './lib/stats.ts';
import {
  SPACES,
  buildCandidate,
  clampToSpace,
  readParams,
  type ParamSpec,
} from './lib/paramSpace.ts';
import { createRng } from '../src/ai/rng.ts';

/**
 * Cross-entropy-method tuner.
 *
 * Fitness is a paired, seat-rotated match against a fixed reference, and every candidate in a
 * generation plays the *same* seeds — common random numbers, so two candidates are separated by
 * their decisions rather than by their luck. The reference stays fixed (plus a hall of fame) so
 * the population cannot drift by beating a moving target.
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

interface Candidate {
  id: string;
  values: number[];
  config: AlgoConfig;
  fitness: number;
}

function gaussian(rng: () => number): number {
  // Box-Muller; the tuner needs normal samples and the engine rng only gives uniforms.
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function seatAssignment(
  challenger: AlgoVersionId,
  champion: AlgoVersionId,
  seat: PlayerColor,
): Record<PlayerColor, AlgoVersionId> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, color === seat ? challenger : champion]),
  ) as Record<PlayerColor, AlgoVersionId>;
}

async function main(): Promise<void> {
  const baseId = arg('base', 'v10')!;
  const championId = arg('champion', 'v1')!;
  if (!isAlgoVersionId(baseId) || !isAlgoVersionId(championId)) {
    throw new Error(`unknown version: ${baseId} / ${championId}`);
  }

  const spaceName = arg('space', 'eval')!;
  const specs: ParamSpec[] = SPACES[spaceName];
  if (!specs) {
    throw new Error(`unknown space "${spaceName}" (have: ${Object.keys(SPACES).join(', ')})`);
  }

  const policy = (arg('policy', 'greedy') ?? 'greedy') as PolicyId;
  const population = Math.max(4, Number(arg('population', '16')));
  const generations = Math.max(1, Number(arg('generations', '10')));
  const seedsPerCandidate = Math.max(2, Number(arg('seeds', '24')));
  const eliteFraction = Number(arg('elite', '0.25'));
  const smoothing = Number(arg('smoothing', '0.7'));
  const workers = Math.max(1, Number(arg('workers', String(defaultWorkerCount()))));
  const iterationsRaw = arg('iterations');
  const iterationBudget = iterationsRaw ? Number(iterationsRaw) : undefined;
  const openingRandomPlies = Number(arg('opening-random-plies', '8'));
  const openingTopK = Number(arg('opening-top-k', '3'));
  const rng = createRng(Number(arg('tuner-seed', '20260817')));

  const base = ALGO_VERSIONS[baseId];
  const eliteCount = Math.max(2, Math.round(population * eliteFraction));
  let mu = clampToSpace(specs, readParams(base, specs));
  let sigma = specs.map((spec) => spec.sigma);

  const outDir = join(process.cwd(), 'tuning');
  mkdirSync(outDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(outDir, `tune-${runId}.jsonl`);
  const bestPath = join(outDir, `tune-${runId}-best.json`);

  const header = [
    'CEM tuning run',
    `Base: ${baseId}   Reference: ${championId}`,
    `Space: ${spaceName} (${specs.length} parameters)`,
    `Policy: ${policy}${iterationBudget ? ` @ ${iterationBudget} iterations/move` : ''}`,
    `Population ${population}, elite ${eliteCount}, ${generations} generations, ${seedsPerCandidate} seeds each`,
    `Games per generation: ${population * seedsPerCandidate * 4}`,
    `Workers: ${workers}`,
  ].join('\n');
  console.log(`${header}\n`);

  const pool = new GamePool(workers);
  const seatPolicies = Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, policy]),
  ) as Record<PlayerColor, PolicyId>;

  let best: Candidate | null = null;

  for (let generation = 1; generation <= generations; generation += 1) {
    const startedAt = Date.now();
    // One seed block per generation, shared by every candidate.
    //
    // NOTE for held-out validation: this lattice is `g * 100_000 + i` for g = 1…generations and
    // i < seedsPerCandidate, so any `--seed-base` that is a multiple of 100,000 within the
    // generation count **collides with seeds this tuner optimised on**. The repo documented
    // `--seed-base 900000` as "held out" for a long time; a 20-generation run makes 900,000–900,023
    // part of generation 9. Use a base that is not of that form (the docs now say 7777777).
    const seeds = Array.from(
      { length: seedsPerCandidate },
      (_, i) => generation * 100_000 + i,
    );

    const candidates: Candidate[] = [];
    for (let i = 0; i < population; i += 1) {
      const values =
        generation === 1 && i === 0
          ? [...mu] // always carry the unmodified base as a control
          : mu.map((m, j) => m + sigma[j] * gaussian(rng));
      const id = `cand-g${generation}-${i}`;
      candidates.push({
        id,
        values: clampToSpace(specs, values),
        config: buildCandidate(base, specs, values, id),
        fitness: Number.NEGATIVE_INFINITY,
      });
    }

    const assignments: GameAssignment[] = [];
    for (const candidate of candidates) {
      for (const seed of seeds) {
        for (const seat of PLAYER_COLORS) {
          assignments.push({
            id: `${candidate.id}|${seed}|${seat}`,
            seatVersions: seatAssignment(candidate.id, championId, seat),
            seatPolicies,
            seed,
            iterationBudget,
            openingRandomPlies,
            openingTopK,
            configs: [candidate.config],
          });
        }
      }
    }

    const outcomes = await pool.run(assignments);
    const gamesByCandidate = new Map<string, RotationGame[]>();
    // Failed games used to be skipped in silence, and `rotationAdvantage([])` is 0 — so a run in
    // which *every* game failed reported a tidy "best 0.00" for twelve generations and looked like
    // a search that had converged. Surface them.
    const errors = outcomes.filter((outcome) => outcome.error);
    if (errors.length > 0) {
      console.error(
        `  !! ${errors.length}/${outcomes.length} games failed this generation — ` +
          `first: ${errors[0].error}`,
      );
      if (errors.length === outcomes.length) {
        throw new Error('every game failed; refusing to report fitness for a generation with no data');
      }
    }
    for (const outcome of outcomes) {
      if (outcome.error) {
        continue;
      }
      const [candidateId, seedText, seat] = outcome.id.split('|');
      const bucket = gamesByCandidate.get(candidateId) ?? [];
      bucket.push({
        seed: Number(seedText),
        seat: seat as PlayerColor,
        scores: outcome.scores,
        winner: outcome.winner,
      });
      gamesByCandidate.set(candidateId, bucket);
    }

    for (const candidate of candidates) {
      candidate.fitness = rotationAdvantage(gamesByCandidate.get(candidate.id) ?? []);
    }
    candidates.sort((a, b) => b.fitness - a.fitness);
    const elite = candidates.slice(0, eliteCount);

    // CEM update: recentre on the elite, and let their spread set the next sigma.
    const nextMu = specs.map(
      (_, j) => elite.reduce((sum, candidate) => sum + candidate.values[j], 0) / elite.length,
    );
    const nextSigma = specs.map((spec, j) => {
      const m = nextMu[j];
      const variance =
        elite.reduce((sum, candidate) => sum + (candidate.values[j] - m) ** 2, 0) / elite.length;
      // A floor keeps the population from collapsing onto one point after a lucky generation.
      return Math.max(Math.sqrt(variance), spec.sigma * 0.15);
    });
    mu = mu.map((value, j) => value * (1 - smoothing) + nextMu[j] * smoothing);
    sigma = sigma.map((value, j) => value * (1 - smoothing) + nextSigma[j] * smoothing);

    if (!best || candidates[0].fitness > best.fitness) {
      best = candidates[0];
      writeFileSync(
        bestPath,
        `${JSON.stringify(
          {
            ...buildCandidate(base, specs, candidates[0].values, `${baseId}-tuned`),
            summary: `CEM-tuned from ${baseId} over the ${spaceName} space (generation ${generation}, fitness ${candidates[0].fitness.toFixed(3)} vs ${championId})`,
          },
          null,
          2,
        )}\n`,
      );
    }

    const record = {
      generation,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      bestFitness: candidates[0].fitness,
      eliteMeanFitness:
        elite.reduce((sum, candidate) => sum + candidate.fitness, 0) / elite.length,
      populationMeanFitness:
        candidates.reduce((sum, candidate) => sum + candidate.fitness, 0) / candidates.length,
      mu: Object.fromEntries(specs.map((spec, j) => [spec.path, Number(mu[j].toFixed(4))])),
      sigma: Object.fromEntries(specs.map((spec, j) => [spec.path, Number(sigma[j].toFixed(4))])),
    };
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    console.log(
      `gen ${generation}/${generations}  best ${record.bestFitness.toFixed(2)}  ` +
        `elite ${record.eliteMeanFitness.toFixed(2)}  pop ${record.populationMeanFitness.toFixed(2)}  ` +
        `(${record.seconds}s)`,
    );
  }

  pool.close();
  console.log(`\nBest config: ${bestPath}\nGeneration log: ${logPath}`);
  console.log(
    'Validate it on held-out seeds before promoting:\n' +
      `  npx tsx scripts/tournament.ts --challenger-file ${bestPath} --champion ${championId} --policy mcts-bench --seeds 60`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
