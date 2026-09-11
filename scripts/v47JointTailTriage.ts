/** Gross-failure screen for the preregistered coherent four-seat rollout-tail samples. */

import { minimumDetectableEffect, runBatch } from './lib/matchRunner.ts';

const seeds = 8;
await runBatch(
  'v4.7 joint stochastic tail triage',
  [
    {
      candidate: 'v4.7-tail16-joint', baseline: 'v3.7', seeds, seedBase: 47_410_000,
      iterations: 300, policy: 'mcts-bench', label: 'v47-tail16-joint-screen',
    },
    {
      candidate: 'v4.7-tail24-joint', baseline: 'v3.7', seeds, seedBase: 47_411_000,
      iterations: 300, policy: 'mcts-bench', label: 'v47-tail24-joint-screen',
    },
  ],
  'v47-joint-tail-triage.json',
  (results) => [
    `GROSS-FAILURE SCREEN — ${seeds} seeds, approximate MDE ${minimumDetectableEffect(seeds).toFixed(2)}`,
    ...results.map((row) => `${row.candidate}: ${row.advantage} [${row.low}, ${row.high}]`),
  ].join('\n'),
);
