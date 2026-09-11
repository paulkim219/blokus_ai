import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 adaptive search round 4',
  [
    {
      candidate: 'v3.2-policy25-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 992000,
      label: 'v32-shift-policy25-screen',
    },
    {
      candidate: 'v3.2-policy50-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 992100,
      label: 'v32-shift-policy50-screen',
    },
    {
      candidate: 'v3.2-policy-end-pro', baseline: 'v3.1-pro', seeds: 24, seedBase: 992150,
      label: 'v32-shift-policy-endgame-screen',
    },
    {
      candidate: 'v3.2-eps05-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 992200,
      label: 'v32-shift-eps05-screen',
    },
    {
      candidate: 'v3.2-eps30-pro', baseline: 'v3.1-pro', seeds: 16, seedBase: 992300,
      label: 'v32-shift-eps30-screen',
    },
  ],
  'v32-adaptive4-results.json',
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
