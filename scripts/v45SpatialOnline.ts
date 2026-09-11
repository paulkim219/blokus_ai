import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.5 shared spatial policy online gate',
  [
    {
      candidate: 'v4.5-spatial-single-v32-pro',
      baseline: 'v3.2-pro',
      seeds: 40,
      seedBase: 1_340_000,
      label: 'v45-spatial-single-online',
    },
    {
      candidate: 'v4.5-spatial-ensemble-v32-pro',
      baseline: 'v3.2-pro',
      seeds: 40,
      seedBase: 1_341_000,
      label: 'v45-spatial-ensemble-online',
    },
  ],
  'v45-spatial-online-results.json',
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
