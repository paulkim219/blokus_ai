/**
 * v3.5 workstream A — the committee band sweep.
 *
 * The ladder, in the order it has to be run:
 *
 *   1. The identity gate. `v3.5-balanced` is the committee layer with `band: 0`, so it must play
 *      byte-identical games to `v3.1-pro-max` and print exactly 0.00. A mirror-match signature is
 *      normally the warning that a flag never reached the code path; here it is the *pass* condition,
 *      and it is checked first because every number below is worthless if the layer is not inert when
 *      switched off.
 *   2. The eval-level arm. At `--policy greedy` the primary is itself a one-ply evaluator, so the
 *      committee reduces to a rank combination with no tree and no budget question — 400 seeds in
 *      minutes, and the cheapest possible read on whether a second opinion helps at all.
 *   3. The band sweep at the pro-max tier, 200 seeds each (MDE 0.95).
 *   4. Attribution probes for the band that wins, and a confirmation on a disjoint seed block.
 *
 * Seed bases avoid the tuner's `g · 100_000 + i` lattice.
 */

import { runBatch, minimumDetectableEffect, type MatchResult, type MatchSpec } from './lib/matchRunner.ts';

const specs: MatchSpec[] = [
  // 1. Identity gate — must be exactly 0.00. Cheap, and it fails fast.
  {
    candidate: 'v3.5-balanced',
    baseline: 'v3.1-pro-max',
    seeds: 10,
    seedBase: 7710000,
    label: 'v35-a0-identity-band0',
  },

  // 2. Eval level: the whole hypothesis for the price of a coffee.
  {
    candidate: 'v3.5-arb-eval',
    baseline: 'v3.1-lite',
    seeds: 400,
    seedBase: 7777777,
    policy: 'greedy',
    label: 'v35-a1a-committee-eval-level',
  },

  // 3. The band sweep. One axis: how close two children must be to be arbitrated.
  {
    candidate: 'v3.5-arb02',
    baseline: 'v3.1-pro-max',
    seeds: 200,
    seedBase: 7720000,
    label: 'v35-a1-band02',
  },
  {
    candidate: 'v3.5-arb05',
    baseline: 'v3.1-pro-max',
    seeds: 200,
    seedBase: 7730000,
    label: 'v35-a1-band05',
  },
  {
    candidate: 'v3.5-arb10',
    baseline: 'v3.1-pro-max',
    seeds: 200,
    seedBase: 7740000,
    label: 'v35-a1-band10',
  },

  // 4. Attribution. `-self` drops the diverse member: if it matches the full committee, the gain is
  // the arbitration rule and not the second opinion, which is a different finding and a weaker one.
  // `-geom` swaps Borda for the rule that punishes a single dissenting opinion hardest.
  {
    candidate: 'v3.5-arb05-self',
    baseline: 'v3.1-pro-max',
    seeds: 200,
    seedBase: 7750000,
    label: 'v35-a2-band05-no-diversity',
  },
  {
    candidate: 'v3.5-arb05-geom',
    baseline: 'v3.1-pro-max',
    seeds: 200,
    seedBase: 7760000,
    label: 'v35-a2-band05-geomMean',
  },
];

function render(results: MatchResult[]): string {
  const rows = results.map((result) => {
    const ci =
      result.advantage === null
        ? 'no result'
        : `${result.advantage.toFixed(2)} [${result.low?.toFixed(2)}, ${result.high?.toFixed(2)}]`;
    return [
      result.label.padEnd(34),
      ci.padStart(22),
      `MDE ${minimumDetectableEffect(result.seeds).toFixed(2)}`.padStart(10),
      `${result.firstPlace?.toFixed(1) ?? '—'}%`.padStart(7),
    ].join('  ');
  });
  return ['', 'label                               advantage vs baseline         MDE  first', ...rows].join(
    '\n',
  );
}

async function main(): Promise<void> {
  const results = await runBatch('v3.5 committee', specs, 'v35-batch-results.json', render);

  const identity = results[0];
  if (identity.advantage !== null && Math.abs(identity.advantage) > 1e-9) {
    console.error(
      `\nIDENTITY GATE FAILED: v3.5-balanced scored ${identity.advantage} against its own primary.\n` +
        'The committee layer is not inert at band 0, so every band result below is confounded.',
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
