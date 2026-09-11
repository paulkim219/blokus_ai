import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 phase-specific epsilon screens',
  [
    {
      candidate: 'v3.2-eps30-mid-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_001_500,
      label: 'v32-shift-eps30-mid-screen',
    },
    {
      candidate: 'v3.2-eps30-early-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_001_600,
      label: 'v32-shift-eps30-early-screen',
    },
    {
      candidate: 'v3.2-eps30-late-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 1_001_700,
      label: 'v32-shift-eps30-late-screen',
    },
  ],
  'v32-eps-phase-results.json',
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
