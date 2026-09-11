import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.6d pooled-spatial distributional leaf triage',
  [
    { candidate: 'v4.6d-pooled-leaf-sampled05', label: 'v46d-pooled-sampled05', seedBase: 46_700_000 },
    {
      candidate: 'v4.6d-pooled-leaf-sampled05-real25',
      label: 'v46d-pooled-sampled05-real25',
      seedBase: 46_701_000,
    },
  ].map((arm) => ({ ...arm, baseline: 'v3.2', seeds: 16, iterations: 300 })),
  'v46d-leaf-triage.json',
  (results) => [
    'label                               advantage (95% CI)        MDE   first',
    ...results.map((row) =>
      `${row.label.padEnd(35)} ${(row.advantage ?? 0).toFixed(2).padStart(7)} ` +
      `[${(row.low ?? 0).toFixed(2)}, ${(row.high ?? 0).toFixed(2)}]  ` +
      `${minimumDetectableEffect(row.seeds).toFixed(2).padStart(5)}  ` +
      `${(row.firstPlace ?? 0).toFixed(1).padStart(6)}%`,
    ),
  ].join('\n'),
);
