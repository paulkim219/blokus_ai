import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 epsilon 0.60 phase localization',
  [
    {
      candidate: 'v3.2-eps60-mid-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_016_000,
      label: 'v32-shift-eps60-mid-screen',
    },
    {
      candidate: 'v3.2-eps60-early-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_016_100,
      label: 'v32-shift-eps60-early-screen',
    },
    {
      candidate: 'v3.2-eps60-late-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_016_200,
      label: 'v32-shift-eps60-late-screen',
    },
  ],
  'v32-eps60-phase-results.json',
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
