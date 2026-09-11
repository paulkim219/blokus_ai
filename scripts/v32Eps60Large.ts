import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 epsilon 0.60 decisive block',
  [{
    candidate: 'v3.2-eps60-pro', baseline: 'v3.1-pro', seeds: 100, seedBase: 1_013_000,
    label: 'v32-shift-eps60-large',
  }],
  'v32-eps60-large-results.json',
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
