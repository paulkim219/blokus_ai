import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v3.2 adaptive search round 2',
  [
    {
      candidate: 'v3.2-piecegroups-pro',
      baseline: 'v3.1-pro',
      seeds: 16,
      seedBase: 990000,
      label: 'v32-shift-piece-groups-screen',
    },
    {
      candidate: 'v3.2-varucb-pro',
      baseline: 'v3.1-pro',
      seeds: 16,
      seedBase: 990100,
      label: 'v32-shift-varucb-screen',
    },
  ],
  'v32-adaptive2-results.json',
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
