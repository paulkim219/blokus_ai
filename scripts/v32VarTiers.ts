import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 variance-tuned tier transfer',
  [
    {
      candidate: 'v3.2-varucb', baseline: 'v3.1', seeds: 40, seedBase: 998000,
      label: 'v32-shift-varucb-standard-tier',
    },
    {
      candidate: 'v3.2-varucb-pro-max', baseline: 'v3.1-pro-max', seeds: 40, seedBase: 998100,
      label: 'v32-shift-varucb-pro-max-tier',
    },
  ],
  'v32-var-tiers-results.json',
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
