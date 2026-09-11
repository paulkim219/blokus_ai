import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.6e canonical pooled-spatial 25% value-blend triage',
  [{
    candidate: 'v4.6e-canonical-pooled-blend25',
    baseline: 'v3.2',
    seeds: 16,
    seedBase: 46_800_000,
    iterations: 300,
    label: 'v46e-canonical-pooled-blend25',
  }],
  'v46e-canonical-leaf-triage.json',
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
