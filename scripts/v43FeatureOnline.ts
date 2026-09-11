import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.3 local-interaction policy online gate',
  [
    {
      candidate: 'v4.3-policy-v32-pro',
      baseline: 'v3.2-pro',
      seeds: 40,
      seedBase: 1_181_000,
      label: 'v43-local-policy-online',
    },
  ],
  'v43-feature-online-results.json',
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
