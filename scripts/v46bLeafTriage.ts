import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.6b exact-backed-value leaf triage',
  [
    { candidate: 'v4.6b-leaf-sampled05', label: 'v46b-leaf-sampled05', seedBase: 46_600_000 },
    { candidate: 'v4.6b-leaf-sampled-real25', label: 'v46b-leaf-sampled-real25', seedBase: 46_601_000 },
  ].map((arm) => ({ ...arm, baseline: 'v3.2', seeds: 16, iterations: 300 })),
  'v46b-leaf-triage.json',
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
