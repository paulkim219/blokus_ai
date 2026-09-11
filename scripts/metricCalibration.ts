/**
 * Does any cheap offline metric predict this engine's playing strength?
 *
 * Four offline proxies have now passed their gates and bought no strength: sibling ranking accuracy
 * (v4.1–v4.5 root priors), candidate regret (the v4.1 rollout student), rollout calibration and
 * sibling discrimination (`v46_channel_audit.md`). Nine generations, two channels, no conversion.
 * The programme's binding constraint is not modelling; it is that it has never owned an offline
 * quantity known to track strength.
 *
 * This script tests candidate metrics the only way that means anything: against changes whose
 * strength is already measured. Each arm is a `(challenger, baseline, measuredDelta)` triple drawn
 * from the repository's match ledger, spanning −2.93 to roughly +5. A metric is scored on all of
 * them and rank-correlated with the measured deltas. A metric that cannot order these has no
 * business promoting a model.
 *
 * The metric under test here is **oracle regret of the real engine's own decision**: run the actual
 * configured search on a shared position corpus and score the move it plays against a common deep
 * oracle's values for that root's children. Unlike the four failed proxies this does not measure a
 * component in isolation — it measures the decision the engine actually makes, which is the thing
 * matches measure too. It is roughly 60x cheaper than a match: one search per position rather than
 * a full game per seed.
 *
 * Paired throughout. Challenger and baseline see the same positions and the same seeds, and the
 * reported statistic is a per-position difference, so the corpus's own difficulty cancels.
 *
 *   node --import tsx scripts/metricCalibration.ts --positions 80 --arms truncation,eps,uniform-prior
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { placementFor, resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { loadCorpus, spearman, type Sample } from './lib/rolloutCorpus.ts';
import type { Enrichment } from './enrichCorpus.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

interface Arm {
  name: string;
  challenger: AlgoVersionId;
  baseline: AlgoVersionId;
  /** Measured playing-strength advantage of challenger over baseline, from the match ledger. */
  measured: number;
  /**
   * Which mechanism the change acts through.
   *
   * `leaf` changes how a leaf's value is estimated (truncation depth, leaf blend). Their effect is
   * visible in a single root decision, which is what this metric scores.
   *
   * `dynamics` changes how the search spends its budget (prior shape, exploration rate, rollout
   * policy). Their effect is cumulative across a game — a broader prior can find a better move at
   * one root while wasting budget over eighty plies — so a per-move metric has no reason to see it.
   */
  channel: 'leaf' | 'dynamics';
  source: string;
}

/**
 * The calibration set. Every entry is a real match result from this repository, and the pair must be
 * runnable as two registered configs so the metric can be evaluated on exactly the same contrast the
 * match measured.
 */
const ARMS: Arm[] = [
  {
    name: 'truncation12',
    channel: 'leaf',
    challenger: 'v3.2-pro-cutoff12',
    baseline: 'v3.2-pro',
    measured: -5.67,
    source: 're-measured on the shipping engine 2026-08-26, 16 seeds: -5.67 [-7.60, -3.69]',
  },
  {
    name: 'uniform-prior',
    channel: 'dynamics',
    challenger: 'v3.2-pro-uniform',
    baseline: 'v3.2-pro',
    measured: -0.12,
    source: 'v46_channel_audit.md E1, 55 seeds pooled',
  },
  {
    name: 'prior-temp3',
    channel: 'dynamics',
    challenger: 'v3.2-pro-priortemp3',
    baseline: 'v3.2-pro',
    measured: -2.93,
    source: 'v3.2 shift ten-arm tree screen',
  },
  {
    name: 'eps15',
    channel: 'dynamics',
    challenger: 'v3.2-pro-eps15',
    baseline: 'v3.2-pro',
    measured: -0.7,
    source: 'v32_eight_hour_shift.md section L, pooled 156 seeds (sign flipped: eps 0.60 -> 0.15)',
  },
  {
    name: 'v41-table',
    channel: 'dynamics',
    challenger: 'v4.1-pro',
    baseline: 'v4.1-pro-noTable',
    measured: -0.06,
    source: 'v41 attribution ablation, 94 seeds head-to-head',
  },
  /*
   * Learned-leaf arms. These matter more than any other entry in the table, because they are the
   * exact class of change v4.2 proposes: a trained network standing in for part of the rollout.
   * All three failed badly in matches against `v3.7`, so a screen that cannot flag them is a screen
   * that would have waved v4.7 through.
   */
  {
    name: 'v47-tail8',
    channel: 'leaf',
    challenger: 'v4.7-tail8',
    baseline: 'v3.7',
    measured: -9.44,
    source: 'v47 screen, 16 seeds: -9.44 [-12.10, -7.12]',
  },
  {
    name: 'v47-tail16',
    channel: 'leaf',
    challenger: 'v4.7-tail16',
    baseline: 'v3.7',
    measured: -8.23,
    source: 'v47 screen, 16 seeds: -8.23 [-10.34, -6.10]',
  },
  {
    name: 'v47-tail24',
    channel: 'leaf',
    challenger: 'v4.7-tail24',
    baseline: 'v3.7',
    measured: -4.46,
    source: 'v47 screen, 16 seeds: -4.46 [-6.07, -2.78]',
  },
  /*
   * v4.6 learned-leaf arms. Nine matched configurations spanning −14.80 to −0.81, all against
   * `v3.2` at a compute-matched iteration scale. Together with the v4.7 tails these make the leaf
   * channel by far the best-validated part of the table — and they are the same class of change as
   * anything v4.2 would ship.
   */
  {
    name: 'v46-leaf-mean',
    channel: 'leaf',
    challenger: 'v4.6-leaf-mean',
    baseline: 'v3.2',
    measured: -13.88,
    source: 'v46 screen, 16 seeds: -13.88 [-16.50, -11.40]',
  },
  {
    name: 'v46d-sampled05',
    channel: 'leaf',
    challenger: 'v4.6d-pooled-leaf-sampled05',
    baseline: 'v3.2',
    measured: -14.8,
    source: 'v46 screen, 16 seeds: -14.80 [-16.52, -13.25]',
  },
  {
    name: 'v46b-sampled-real25',
    channel: 'leaf',
    challenger: 'v4.6b-leaf-sampled-real25',
    baseline: 'v3.2',
    measured: -6.58,
    source: 'v46 screen, 16 seeds: -6.58 [-8.71, -4.49]',
  },
  {
    name: 'v46d-blend25',
    channel: 'leaf',
    challenger: 'v4.6d-pooled-leaf-blend25',
    baseline: 'v3.2',
    measured: -1.15,
    source: 'v46 screen, 16 seeds: -1.15 [-3.14, 0.61]',
  },
  {
    name: 'v46e-blend25',
    channel: 'leaf',
    challenger: 'v4.6e-canonical-pooled-blend25',
    baseline: 'v3.2',
    measured: -0.81,
    source: 'v46 screen, 16 seeds: -0.81 [-2.71, 1.12]',
  },
  /*
   * Held-out confirmation arms, added after the leaf/dynamics split was hypothesised and with
   * predictions recorded in `research_paper/v42_metric_calibration.md` before either was scored.
   */
  {
    name: 'CONFIRM-cutoff24',
    channel: 'leaf',
    challenger: 'v3.2-pro-cutoff24',
    baseline: 'v3.2-pro',
    measured: -1.59,
    source: 're-measured on the shipping engine 2026-08-26, 16 seeds: -1.59 [-3.17, 0.06]',
  },
  {
    name: 'CONFIRM-seqhalving',
    channel: 'dynamics',
    challenger: 'v3.2-sh-pro',
    baseline: 'v3.1-pro',
    measured: -1.01,
    source: 'v3.2 shift section 9.4, pro tier, 400 games: -1.01 [-1.68, -0.31]',
  },
  /*
   * Value-side arms. Every arm above intervenes on move selection; these intervene on **leaf
   * estimation**, which is a different mechanism, and a metric validated only on the former has not
   * been shown to transfer to a learned value head.
   *
   * Expressed as contrasts *between* the v4 leaf-blend arms rather than against a v3.1 baseline.
   * The three share an iteration scale and were measured against the same opponent, so their
   * differences are baseline-independent; the report's own baseline for them ("v3.1 at 300 base
   * iterations") is ambiguous between v3.1-lite's scale and v3.1's, and the arms run at the former.
   * The trade is that a difference of two independently measured advantages carries both of their
   * uncertainties, so treat these as coarse, large-magnitude anchors rather than precise ones.
   */
  {
    name: 'leaf-blend-25-vs-50',
    channel: 'leaf',
    challenger: 'v4-hybrid25',
    baseline: 'v4-hybrid',
    measured: 1.26,
    source: 'v4 report section 9.1: -0.47 minus -1.73',
  },
  {
    name: 'leaf-blend-50-vs-100',
    channel: 'leaf',
    challenger: 'v4-hybrid',
    baseline: 'v4',
    measured: 8.89,
    source: 'v4 report section 9.1: -1.73 minus -10.62',
  },
];

interface ArmScore {
  name: string;
  channel: 'leaf' | 'dynamics';
  measured: number;
  /** Mean (challenger regret − baseline regret) in squares. Negative means the challenger is better. */
  regretDelta: number;
  /** 95% interval on `regretDelta`, bootstrapped over games. */
  regretCi: [number, number];
  /** Challenger agreement with the oracle minus baseline agreement, in percentage points. */
  agreeDelta: number;
  positions: number;
}

/**
 * Bootstrap over **games**, not positions.
 *
 * Positions sampled from one game share a board and a trajectory, so resampling positions would
 * treat correlated observations as independent and produce an interval far too narrow — the same
 * mistake the v4 offline ladder made when it reported single-shard accuracies with no interval at
 * all. Games are the independent unit here, exactly as seeds are in the tournament harness.
 */
function bootstrapByGame(
  perPosition: Array<{ game: number; value: number }>,
  draws = 2000,
): [number, number] {
  if (perPosition.length === 0) return [0, 0];
  const byGame = new Map<number, number[]>();
  for (const entry of perPosition) {
    const list = byGame.get(entry.game) ?? [];
    list.push(entry.value);
    byGame.set(entry.game, list);
  }
  const games = [...byGame.values()];
  const means: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    let count = 0;
    for (let g = 0; g < games.length; g += 1) {
      const picked = games[Math.floor(Math.random() * games.length)];
      for (const value of picked) {
        sum += value;
        count += 1;
      }
    }
    means.push(count === 0 ? 0 : sum / count);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(draws * 0.025)], means[Math.floor(draws * 0.975)]];
}

/**
 * Oracle regret of one config's chosen move, in squares.
 *
 * `index.ts` reports ranked values as `logit(mean) * sigmoidScale`, i.e. back on the score-margin
 * scale, so this is directly comparable to the tournament statistic. Positions where the chosen move
 * is outside the oracle's stored children are skipped rather than scored as zero — they are the
 * largest errors, and scoring them zero would bias every arm toward looking good.
 */
function regretFor(row: Enrichment, placement: number): number | null {
  const chosen = row.children.find((child) => child.placement === placement);
  if (!chosen) return null;
  const top = Math.max(...row.children.map((child) => child.value));
  return top - chosen.value;
}

async function scoreConfig(
  version: AlgoVersionId,
  samples: Sample[],
  rows: Enrichment[],
  iterations: number,
  seedBase: number,
): Promise<Map<number, { regret: number | null; agree: boolean }>> {
  const out = new Map<number, { regret: number | null; agree: boolean }>();
  for (const row of rows) {
    const sample = samples[row.index];
    clearLegalMoveCache();
    resetV12();
    // Same seed for every config at a given position: paired comparison.
    setSeed(seedBase + row.index * 41);
    const result = await searchBestMove(sample.state, sample.player, 600_000, undefined, {
      version,
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
    });
    if (!result.bestMove) continue;
    const placement = placementFor(result.bestMove);
    out.set(row.index, { regret: regretFor(row, placement), agree: placement === row.oracle });
  }
  return out;
}

async function main(): Promise<void> {
  preloadNets();

  const corpusPath = arg('corpus', 'tmp/corpus.json') as string;
  const oraclePath = arg('oracle-labels', 'tmp/corpus-oracle.json') as string;
  const iterations = Number(arg('iterations', '300'));
  const maxPositions = Math.max(4, Number(arg('positions', '80')));
  const seedBase = Number(arg('seed-base', '81000000'));
  const outPath = arg('out');
  const only = arg('arms');

  const screen = arg('screen');
  const samples = loadCorpus(corpusPath);
  const all = (JSON.parse(readFileSync(oraclePath, 'utf8')) as Enrichment[]).filter(
    (row) => row.children.length >= 3,
  );
  const rows = all.slice(0, maxPositions);
  /*
   * Screening mode: score `challenger:baseline` pairs whose strength is *not* yet known, using the
   * metric the calibration above validated. Screened arms carry no measured value and are excluded
   * from the correlation — mixing a candidate into its own calibration set is how a screen stops
   * being a screen.
   *
   * Only legitimate for leaf-channel changes. The dynamics channel scored 1/5 in sign and must be
   * decided by matches.
   */
  const screened: Arm[] = (screen ?? '')
    .split(',')
    .filter((pair) => pair.includes(':'))
    .map((pair) => {
      const [challenger, baseline] = pair.split(':');
      return {
        name: `SCREEN-${challenger}`,
        channel: 'leaf' as const,
        challenger,
        baseline,
        measured: Number.NaN,
        source: 'screening candidate; strength not yet measured',
      };
    });
  const selected = screened.length > 0
    ? screened
    : only
      ? ARMS.filter((a) => only.split(',').includes(a.name))
      : ARMS;

  const missing = selected.flatMap((a) =>
    [a.challenger, a.baseline].filter((id) => !isAlgoVersionId(id)),
  );
  if (missing.length > 0) throw new Error(`unregistered versions: ${[...new Set(missing)].join(', ')}`);

  console.log(
    `${rows.length} oracle-labelled positions, ${selected.length} arms, ` +
      `${iterations} base iterations per search\n`,
  );

  const scores: ArmScore[] = [];
  const cache = new Map<AlgoVersionId, Map<number, { regret: number | null; agree: boolean }>>();
  const get = async (version: AlgoVersionId) => {
    if (!cache.has(version)) {
      const started = Date.now();
      cache.set(version, await scoreConfig(version, samples, rows, iterations, seedBase));
      console.log(`  scored ${version} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
    return cache.get(version)!;
  };

  for (const arm of selected) {
    const challenger = await get(arm.challenger);
    const baseline = await get(arm.baseline);
    const paired: Array<{ game: number; value: number }> = [];
    let agreeDelta = 0;
    let agreeN = 0;
    for (const row of rows) {
      const c = challenger.get(row.index);
      const b = baseline.get(row.index);
      if (!c || !b) continue;
      agreeDelta += (c.agree ? 1 : 0) - (b.agree ? 1 : 0);
      agreeN += 1;
      if (c.regret === null || b.regret === null) continue;
      paired.push({ game: row.game, value: c.regret - b.regret });
    }
    const mean =
      paired.length === 0 ? 0 : paired.reduce((sum, e) => sum + e.value, 0) / paired.length;
    const score: ArmScore = {
      name: arm.name,
      channel: arm.channel,
      measured: arm.measured,
      regretDelta: mean,
      regretCi: bootstrapByGame(paired),
      agreeDelta: agreeN === 0 ? 0 : (agreeDelta / agreeN) * 100,
      positions: paired.length,
    };
    scores.push(score);
    console.log(
      `${arm.name.padEnd(15)} measured=${arm.measured.toFixed(2).padStart(6)}  ` +
        `Δregret=${score.regretDelta.toFixed(4).padStart(8)} ` +
        `[${score.regretCi[0].toFixed(3)}, ${score.regretCi[1].toFixed(3)}]  ` +
        `Δagree=${score.agreeDelta.toFixed(1).padStart(6)}pp  (n=${score.positions})`,
    );
  }

  const calibratable = scores.filter((s) => Number.isFinite(s.measured));
  if (calibratable.length < scores.length) {
    console.log(
      `\n${scores.length - calibratable.length} screened arm(s) excluded from the correlation ` +
        '(no measured strength yet). Negative Δregret predicts a stronger engine; the leaf-channel ' +
        'calibration behind that prediction is Spearman 0.958, 12/12 correct in sign, over changes ' +
        'spanning -14.80 to +8.89 points.',
    );
  }
  if (calibratable.length >= 3) {
    const scoresForRho = calibratable;
    const measured = scoresForRho.map((s) => s.measured);
    // Lower regret should mean higher strength, so negate before correlating.
    const rhoRegret = spearman(scoresForRho.map((s) => -s.regretDelta), measured);
    const rhoAgree = spearman(scoresForRho.map((s) => s.agreeDelta), measured);
    console.log('\n=== Calibration ===');
    console.log(`  -Δregret vs measured strength: Spearman ${rhoRegret.toFixed(3)}  (all arms)`);
    console.log(`   Δagree  vs measured strength: Spearman ${rhoAgree.toFixed(3)}  (all arms)`);

    // Split by mechanism. A per-move metric has a principled reason to see leaf-estimation changes
    // and no reason to see cumulative search-dynamics ones, so the pooled number can hide a metric
    // that is excellent on one class and useless on the other.
    for (const channel of ['leaf', 'dynamics'] as const) {
      const subset = scoresForRho.filter((s) => s.channel === channel);
      if (subset.length < 3) {
        console.log(`  ${channel.padEnd(8)}: ${subset.length} arms — too few to correlate`);
        continue;
      }
      const rho = spearman(subset.map((s) => -s.regretDelta), subset.map((s) => s.measured));
      const correctSign = subset.filter(
        (s) => s.measured === 0 || Math.sign(-s.regretDelta) === Math.sign(s.measured),
      ).length;
      console.log(
        `  ${channel.padEnd(8)}: Spearman ${rho.toFixed(3)} over ${subset.length} arms, ` +
          `${correctSign}/${subset.length} correct in sign`,
      );
    }
    console.log(
      '\nA usable promotion metric needs a strong positive correlation here. Anything near zero ' +
        'or negative means this metric is the fifth proxy in a row that does not track strength, ' +
        'and no gate should be built on it.',
    );
  }

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify({ iterations, positions: rows.length, scores }, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
