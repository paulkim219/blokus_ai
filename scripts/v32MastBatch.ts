import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 piece-MAST screens',
  [
    {
      candidate: 'v3.2-mast05-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 997000,
      label: 'v32-shift-mast05-screen',
    },
    {
      candidate: 'v3.2-mast10-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 997100,
      label: 'v32-shift-mast10-screen',
    },
  ],
  'v32-mast-results.json',
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
