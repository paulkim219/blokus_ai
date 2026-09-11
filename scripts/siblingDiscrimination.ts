/**
 * E14b — does the rollout policy rank *siblings* the way a deep search does, at the sample counts a
 * tree actually spends?
 *
 * E14a measured the rollout estimator's absolute calibration against realized outcomes and found it
 * essentially flat across the whole ε ladder — bias moved 1% while playing strength moved 1.7
 * points. That rules out bias as the mechanism behind the ε=0.60 promotion and rules out simulation
 * balancing as the way to find more of it.
 *
 * What a 200-rollout mean hides is what MCTS actually consumes. A freshly expanded leaf gets *one*
 * rollout, and the tree's job is to order siblings from small samples. So this script measures the
 * decision rather than the estimate: take a root's children, give each of them a realistic handful
 * of rollouts under a candidate policy, rank them, and compare against a deep oracle's ordering of
 * the same children.
 *
 * Budgets are swept, because the answer plausibly depends on them: a policy that ranks well with 16
 * samples per child and badly with 1 is telling you the tree's interior is where the loss is.
 *
 *   node --import tsx scripts/siblingDiscrimination.ts --budgets 1,4,16 --children 8
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bitboardParamsFor, getAlgo, isAlgoVersionId } from '../src/ai/algoVersions.ts';
import { setSeed } from '../src/ai/rng.ts';
import { seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import { withOverrides, type BitboardParams, type DeepPartial, type PhaseId } from '../src/ai/bitboard/config.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { Playout, createOutcome } from '../src/ai/bitboard/playout.ts';
import { SEAT_COUNT } from '../src/ai/bitboard/seats.ts';
import { loadCorpus, seatValue, spearman, type Sample } from './lib/rolloutCorpus.ts';
import type { Enrichment } from './enrichCorpus.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const MEASURED_STRENGTH: Record<string, number> = {
  '0.05': -1.01,
  '0.15': 0,
  '0.30': 0.29,
  '0.45': 0.28,
  '0.60': 0.7,
  '1.00': 0.36,
};

interface ArmScore {
  label: string;
  /** Mean Spearman between the rollout ordering and the oracle ordering, over roots. */
  rho: number;
  /** Fraction of roots where the rollout ranking's top choice is the oracle's top choice. */
  top1: number;
  /** Mean oracle-value gap between the oracle's best child and the rollout's pick. Lower is better. */
  regret: number;
  roots: number;
}

function evaluateArm(
  label: string,
  base: BitboardParams,
  overrides: DeepPartial<BitboardParams>,
  samples: Sample[],
  rows: Enrichment[],
  budget: number,
  maxChildren: number,
  seedBase: number,
): ArmScore {
  const params = withOverrides(base, overrides);
  const playout = new Playout(params);
  const outcome = createOutcome();
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  const scratch = new Float64Array(SEAT_COUNT);

  let rhoSum = 0;
  let top1 = 0;
  let regretSum = 0;
  let roots = 0;

  for (const row of rows) {
    const children = row.children.slice(0, maxChildren);
    if (children.length < 3) continue;
    const sample = samples[row.index];
    const seat = seatOf(sample.player);
    const position = toPosition(sample.state);
    if (position.turn !== seat) position.forceTurn(seat);

    const estimates: number[] = [];
    for (let c = 0; c < children.length; c += 1) {
      const undo = position.apply(children[c].placement);
      refreshContext(context, position, false);
      const phase: PhaseId = detectPhase(position, context, params, seat);
      // Paired across arms and across children: same stream for the same (root, child).
      setSeed(seedBase + row.index * 1013 + c * 17);
      let total = 0;
      for (let r = 0; r < budget; r += 1) {
        playout.run(position, context, phase, outcome);
        total += seatValue(outcome.values, params, seat, scratch);
      }
      estimates.push(total / budget);
      position.undo(undo);
    }

    const reference = children.map((child) => child.value);
    rhoSum += spearman(estimates, reference);
    let pick = 0;
    for (let c = 1; c < estimates.length; c += 1) {
      if (estimates[c] > estimates[pick]) pick = c;
    }
    let bestRef = 0;
    for (let c = 1; c < reference.length; c += 1) {
      if (reference[c] > reference[bestRef]) bestRef = c;
    }
    if (pick === bestRef) top1 += 1;
    regretSum += reference[bestRef] - reference[pick];
    roots += 1;
  }

  const n = Math.max(1, roots);
  return { label, rho: rhoSum / n, top1: top1 / n, regret: regretSum / n, roots };
}

async function main(): Promise<void> {
  preloadNets();

  const corpusPath = arg('corpus', 'tmp/corpus.json') as string;
  const oraclePath = arg('oracle-labels', 'tmp/corpus-oracle.json') as string;
  const versionArg = arg('version', 'v3.2-pro');
  const seedBase = Number(arg('seed-base', '71000000'));
  const maxChildren = Math.max(3, Number(arg('children', '8')));
  const outPath = arg('out');
  const budgets = (arg('budgets', '1,4,16') ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const epsilons = (arg('epsilons', '0.05,0.15,0.30,0.45,0.60,1.00') ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));

  if (!isAlgoVersionId(versionArg)) throw new Error(`unknown version ${versionArg}`);
  if (!existsSync(oraclePath)) throw new Error(`no oracle labels at ${oraclePath}; run enrichCorpus`);
  const base = bitboardParamsFor(getAlgo(versionArg));
  const samples = loadCorpus(corpusPath);
  const rows = (JSON.parse(readFileSync(oraclePath, 'utf8')) as Enrichment[]).filter(
    (row) => row.children.length >= 3,
  );
  console.log(
    `${rows.length} enriched roots, up to ${maxChildren} children each, ` +
      `budgets ${budgets.join('/')} rollouts per child\n`,
  );

  const all: Record<number, ArmScore[]> = {};
  for (const budget of budgets) {
    const scores: ArmScore[] = [];
    for (const epsilon of epsilons) {
      const started = Date.now();
      const score = evaluateArm(
        epsilon.toFixed(2),
        base,
        { search: { playoutPolicy: 'legacy', playoutEps: epsilon, playoutEpsByPhase: null } },
        samples,
        rows,
        budget,
        maxChildren,
        seedBase,
      );
      scores.push(score);
      console.log(
        `budget=${String(budget).padStart(2)}  ε=${score.label}  ` +
          `rho=${score.rho.toFixed(4).padStart(7)}  top1=${(score.top1 * 100).toFixed(1).padStart(5)}%  ` +
          `regret=${score.regret.toFixed(5).padStart(8)}  (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
    }
    all[budget] = scores;

    const known = scores.filter((score) => MEASURED_STRENGTH[score.label] !== undefined);
    if (known.length >= 3) {
      const strength = known.map((score) => MEASURED_STRENGTH[score.label]);
      console.log(
        `  calibration @${budget}: rho ${spearman(known.map((s) => s.rho), strength).toFixed(3)}  ` +
          `top1 ${spearman(known.map((s) => s.top1), strength).toFixed(3)}  ` +
          `-regret ${spearman(known.map((s) => -s.regret), strength).toFixed(3)}\n`,
      );
    }
  }

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify({ version: versionArg, maxChildren, all }, null, 2)}\n`);
    console.log(`Wrote ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
