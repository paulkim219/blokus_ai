/** First equal-iteration playing-strength screen for the preregistered v4.7 prefix arms. */

import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

const seeds = 16;
const specs = [
  { candidate: 'v4.7-tail8', seedBase: 47_300_000, label: 'v47-tail8-equal-iterations' },
  { candidate: 'v4.7-tail8-linear', seedBase: 47_301_000, label: 'v47-tail8-linear-equal-iterations' },
  { candidate: 'v4.7-tail16', seedBase: 47_302_000, label: 'v47-tail16-equal-iterations' },
  { candidate: 'v4.7-tail24', seedBase: 47_303_000, label: 'v47-tail24-equal-iterations' },
].map((spec) => ({
  ...spec,
  baseline: 'v3.7',
  seeds,
  iterations: 300,
  policy: 'mcts-bench' as const,
}));

await runBatch('v4.7 learned rollout-tail triage', specs, 'v47-tail-triage.json', (results) =>
  [
    `TRIAGE ONLY — ${seeds} seeds, approximate MDE ${minimumDetectableEffect(seeds).toFixed(2)}`,
    ...results.map(
      (result) =>
        `${result.candidate}: ${result.advantage?.toFixed(2)} ` +
        `[${result.low?.toFixed(2)}, ${result.high?.toFixed(2)}]`,
    ),
  ].join('\n'),
);
