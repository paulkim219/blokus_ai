import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 opening+midgame epsilon 0.60 confirmation',
  [{
    candidate: 'v3.2-eps60-early-pro', baseline: 'v3.2-pro', seeds: 40, seedBase: 1_018_000,
    label: 'v32-shift-eps60-early-confirm',
  }],
  'v32-eps60-early-confirm-results.json',
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
