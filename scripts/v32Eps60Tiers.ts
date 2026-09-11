import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 epsilon 0.60 tier transfer',
  [
    {
      candidate: 'v3.2-eps60', baseline: 'v3.1', seeds: 40, seedBase: 1_014_000,
      label: 'v32-shift-eps60-standard-tier',
    },
    {
      candidate: 'v3.2-eps60-pro-max', baseline: 'v3.1-pro-max', seeds: 40, seedBase: 1_014_100,
      label: 'v32-shift-eps60-pro-max-tier',
    },
  ],
  'v32-eps60-tiers-results.json',
  (results) => [
    'label                                      advantage (95% CI)        MDE   first',
    ...results.map((row) =>
      `${row.label.padEnd(42)} ${(row.advantage ?? 0).toFixed(2).padStart(7)} ` +
      `[${(row.low ?? 0).toFixed(2)}, ${(row.high ?? 0).toFixed(2)}]  ` +
      `${minimumDetectableEffect(row.seeds).toFixed(2).padStart(5)}  ` +
      `${(row.firstPlace ?? 0).toFixed(1).padStart(6)}%`,
    ),
  ].join('\n'),
);
