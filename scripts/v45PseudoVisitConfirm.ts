import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.5 spatial pseudo-visit fresh confirmation',
  [{
    candidate: 'v4.5-spatial-pv128-v32-pro',
    baseline: 'v3.2-pro',
    seeds: 40,
    seedBase: 1_345_000,
    label: 'v45-spatial-pv128-confirm',
  }],
  'v45-spatial-pseudovisit-confirm.json',
  (results) => [
    'label                                      advantage (95% CI)        MDE   first',
    ...results.map(
      (row) =>
        `${row.label.padEnd(42)} ${(row.advantage ?? 0).toFixed(2).padStart(7)} ` +
        `[${(row.low ?? 0).toFixed(2)}, ${(row.high ?? 0).toFixed(2)}]  ` +
        `${minimumDetectableEffect(row.seeds).toFixed(2).padStart(5)}  ` +
        `${(row.firstPlace ?? 0).toFixed(1).padStart(6)}%`,
    ),
  ].join('\n'),
);
