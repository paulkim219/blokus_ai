import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 exact-placement MAST decisive block',
  [{
    candidate: 'v3.2-mast-placement-pro', baseline: 'v3.1-pro', seeds: 100, seedBase: 1_009_000,
    label: 'v32-shift-mast-placement-large',
  }],
  'v32-mast-placement-large-results.json',
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
