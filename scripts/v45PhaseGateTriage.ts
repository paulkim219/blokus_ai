import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.5 opening-midgame spatial gate',
  [
    {
      candidate: 'v4.5-spatial-earlymid-v32-pro', baseline: 'v3.2-pro', seeds: 16,
      seedBase: 1_346_000, label: 'v45-spatial-earlymid-triage',
    },
    {
      candidate: 'v4.5-spatial-earlymid-pv128-v32-pro', baseline: 'v3.2-pro', seeds: 16,
      seedBase: 1_347_000, label: 'v45-spatial-earlymid-pv128-triage',
    },
  ],
  'v45-spatial-phase-gate-triage.json',
  (results) => [
    'label                                      advantage (95% CI)        MDE   first',
    ...results.map(
      (row) =>
        `${row.label.padEnd(42)} ${(row.advantage ?? 0).toFixed(2).padStart(7)} ` +
        `[${(row.low ?? 0).toFixed(2)}, ${(row.high ?? 0).toFixed(2)}]  ` +
        `${minimumDetectableEffect(row.seeds).toFixed(2).padStart(5)}  ` +
        `${(row.firstPlace ?? 0).toFixed(1).padStart(6)}%`,
    ),
  ].join('\n'),
);
