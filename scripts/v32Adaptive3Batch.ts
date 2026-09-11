import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 adaptive search round 3',
  [
    {
      candidate: 'v3.2-piecediverse-pro',
      baseline: 'v3.1-pro',
      seeds: 16,
      seedBase: 991000,
      label: 'v32-shift-piece-diversity-screen',
    },
    {
      candidate: 'v3.2-policy-pro',
      baseline: 'v3.1-pro',
      seeds: 40,
      seedBase: 991100,
      label: 'v32-shift-policy-only-clean-ablation',
    },
  ],
  'v32-adaptive3-results.json',
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
