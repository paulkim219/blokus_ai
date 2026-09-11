import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 upper epsilon bracket',
  [
    {
      candidate: 'v3.2-eps45-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_004_000,
      label: 'v32-shift-eps45-screen',
    },
    {
      candidate: 'v3.2-eps60-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_004_100,
      label: 'v32-shift-eps60-screen',
    },
  ],
  'v32-eps-upper-results.json',
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
