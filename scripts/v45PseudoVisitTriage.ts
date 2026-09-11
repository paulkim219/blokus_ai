import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

await runBatch(
  'v4.5 spatial ensemble pseudo-visit triage',
  [128, 256, 512].map((pseudoVisits, index) => ({
    candidate: `v4.5-spatial-pv${pseudoVisits}-v32-pro`,
    baseline: 'v3.2-pro',
    seeds: 16,
    seedBase: 1_342_000 + index * 1_000,
    label: `v45-spatial-pv${pseudoVisits}-triage`,
  })),
  'v45-spatial-pseudovisit-triage.json',
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
