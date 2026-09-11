/**
 * W2 — the local compute exchange rate, measured in matches rather than against an oracle.
 *
 * `moveImportance.ts` estimates the per-move slope from a deeper search's opinion of the move
 * played. That is a proxy, and E14b is the standing warning that an offline proxy for a search
 * property can be *anti*-correlated with playing strength. This is the same question asked the way
 * the promotion rule asks it.
 *
 * Each probe doubles the iteration budget over five or six of the seat's own moves and changes
 * nothing else, so it is deliberately compute-*positive*: its advantage divided by the fraction of
 * the game it boosted is the local points per doubling. The budget-neutral candidate is fitted from
 * those four numbers afterwards; nothing here is a version candidate.
 *
 * Run at the pro tier. At 300 iterations the ladder is nearly flat — cutting the budget 55% cost
 * +5.00 -> +4.86 — while pro -> pro-max is worth +1.02 [0.24, 1.84]. A probe at the standard tier
 * would measure the flat part of the curve and report a null about the wrong thing.
 *
 * 40 seeds is an MDE of 2.12 against boosts whose whole-game equivalent is around one doubling.
 * These rank four blocks. They do not promote anything, and a leader here is a hypothesis — the
 * record has cost this project two wrong claims that were screen winners quoted as results.
 *
 *   node --import tsx scripts/v36ShapeProbe.ts
 *   node --import tsx scripts/v36ShapeProbe.ts --seeds 16      # cheaper triage first
 */

import { minimumDetectableEffect, runBatch, type MatchSpec } from './lib/matchRunner.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const seeds = Number(arg('seeds', '40'));

/** Own moves each probe doubles, used to turn its advantage into points per doubling. */
const BOOSTED: Record<string, number> = {
  'v36-boost-1-5': 5,
  'v36-boost-6-10': 5,
  'v36-boost-11-15': 5,
  'v36-boost-16-21': 6,
};

// Disjoint, pre-registered, and off the tuner's `g * 100_000 + i` lattice so nothing here overlaps
// a generation of held-out seeds.
const specs: MatchSpec[] = [
  {
    candidate: 'v3.6-boost-1-5',
    baseline: 'v3.2-pro',
    seeds,
    seedBase: 36210000,
    label: 'v36-boost-1-5',
  },
  {
    candidate: 'v3.6-boost-6-10',
    baseline: 'v3.2-pro',
    seeds,
    seedBase: 36220000,
    label: 'v36-boost-6-10',
  },
  {
    candidate: 'v3.6-boost-11-15',
    baseline: 'v3.2-pro',
    seeds,
    seedBase: 36230000,
    label: 'v36-boost-11-15',
  },
  {
    candidate: 'v3.6-boost-16-21',
    baseline: 'v3.2-pro',
    seeds,
    seedBase: 36240000,
    label: 'v36-boost-16-21',
  },
  /**
   * The report's own hand-authored curve, normalised to budget-neutral. It is here as a control,
   * not as a candidate: it predates the audit and predicts the opposite of what E2 measured, so it
   * is the cheapest available test of whether the prior guess was right.
   */
  {
    candidate: 'v3.6-legacy-shape-pro',
    baseline: 'v3.2-pro',
    seeds,
    seedBase: 36250000,
    label: 'v36-legacy-shape',
  },
];

await runBatch('v3.6 iteration-shape probes', specs, 'v36-shape-probe-results.json', (results) =>
  [
    'label                     advantage (95% CI)          MDE   pts/doubling   first',
    ...results.map((row) => {
      const boosted = BOOSTED[row.label];
      // A probe that doubles k of 21 moves buys k/21 of a whole-game doubling, so scaling by 21/k
      // puts every arm on the same axis: what one doubling would be worth if applied everywhere in
      // that band's regime. It is not what the band is worth in a budget-neutral shape — that
      // depends on what the *other* moves give up — but it is what ranks the bands.
      const rate =
        boosted === undefined || row.advantage === null
          ? '          —'
          : ((row.advantage * 21) / boosted).toFixed(2).padStart(11);
      return (
        `${row.label.padEnd(24)} ${(row.advantage ?? 0).toFixed(2).padStart(6)} ` +
        `[${(row.low ?? 0).toFixed(2)}, ${(row.high ?? 0).toFixed(2)}]  ` +
        `${minimumDetectableEffect(row.seeds).toFixed(2).padStart(5)}  ${rate}  ` +
        `${(row.firstPlace ?? 0).toFixed(1).padStart(6)}%`
      );
    }),
    '',
    'Read the pts/doubling column for the *ordering* of the bands, not for its level: each arm',
    'spends extra compute, so its raw advantage is already the ladder plus the placement, and the',
    'extrapolation to a whole-game doubling assumes a locally constant slope it does not verify.',
    '',
    'The budget-neutral candidate is worth building only if the bands separate. If all four arms',
    'land on the same rate, the optimal allocation is the flat one and there is nothing to move.',
  ].join('\n'),
);
