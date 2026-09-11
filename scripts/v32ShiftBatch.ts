import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

const specs = [
  {
    candidate: 'v3.2-feas2-pro',
    baseline: 'v3.1-pro',
    seeds: 16,
    seedBase: 987000,
    label: 'v32-shift-feasibility-w2-screen',
  },
  {
    candidate: 'v3.2-feas4-pro',
    baseline: 'v3.1-pro',
    seeds: 16,
    seedBase: 987100,
    label: 'v32-shift-feasibility-w4-screen',
  },
];

await runBatch('v3.2 shift screen', specs, 'v32-shift-screen-results.json', (results) =>
  [
    'label                                      advantage (95% CI)        MDE   first',
    ...results.map((row) =>
      `${row.label.padEnd(42)} ${(row.advantage ?? 0).toFixed(2).padStart(7)} ` +
      `[${(row.low ?? 0).toFixed(2)}, ${(row.high ?? 0).toFixed(2)}]  ` +
      `${minimumDetectableEffect(row.seeds).toFixed(2).padStart(5)}  ` +
      `${(row.firstPlace ?? 0).toFixed(1).padStart(6)}%`,
    ),
  ].join('\n'),
);
