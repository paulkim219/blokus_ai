/**
 * v3.5 workstream B — the aggression frontier.
 *
 * **Read this before reading the output.** The promote statistic is `own − mean(the three opponent
 * seats)`, which is precisely what `aggressionScale: 1` optimises. Every other setting is therefore
 * handicapped on that statistic *by construction*, and ranking the sweep by advantage would be the
 * same category error as judging an engine by an oracle that is a copy of itself.
 *
 * The dial is read on three numbers together:
 *
 *   advantage       what the setting costs in strength
 *   own score       the EFFICIENT axis — did it place more of its own squares
 *   opponent score  the GREEDY axis — did it cost the other three more
 *
 * A dial that works looks like: own score falls and opponents' score falls faster as the scale
 * rises, with advantage roughly flat across the middle. A dial that does nothing looks like three
 * flat columns, and should be reported as a null rather than shipped as a feature.
 *
 * **Both tiers are swept on purpose.** With `playoutCutoff: 84` nearly every leaf is terminal and
 * its value is σ(score margin) whatever λ is set to, so at pro-max the dial shapes what the search
 * explores rather than what it optimises. At `--policy greedy` it is fully load-bearing —
 * `rankMovesGreedyV12` ranks by ΔE, which carries the whole λ block. The gap between the two arms
 * measures how much of the dial the tree absorbs, and that number decides whether the backup-side
 * term is worth building.
 */

import { runBatch, minimumDetectableEffect, type MatchResult, type MatchSpec } from './lib/matchRunner.ts';

/** Search level: all five points are the pro-max tier, so wall-clock is matched throughout. */
const searchArm: MatchSpec[] = [
  { candidate: 'v3.5-a00', baseline: 'v3.1-pro-max', seeds: 200, seedBase: 7810000, label: 'v35-b-scale0.0-search' },
  { candidate: 'v3.5-a05', baseline: 'v3.1-pro-max', seeds: 200, seedBase: 7820000, label: 'v35-b-scale0.5-search' },
  // The in-family control. Differs from the baseline on nothing, so it must print 0.00 — the sweep's
  // own validity check, in the same position the crosstable's untouched diagonal occupies.
  { candidate: 'v3.5-a10', baseline: 'v3.1-pro-max', seeds: 10, seedBase: 7830000, label: 'v35-b-scale1.0-control' },
  { candidate: 'v3.5-a16', baseline: 'v3.1-pro-max', seeds: 200, seedBase: 7840000, label: 'v35-b-scale1.6-search' },
  { candidate: 'v3.5-a25', baseline: 'v3.1-pro-max', seeds: 200, seedBase: 7850000, label: 'v35-b-scale2.5-search' },
];

/** Eval level: no tree, so the dial reaches the decision undiluted. Cheap, so run more seeds. */
const evalArm: MatchSpec[] = [
  { candidate: 'v3.5-a00-eval', baseline: 'v3.1-lite', seeds: 400, seedBase: 7860000, policy: 'greedy', label: 'v35-b-scale0.0-eval' },
  { candidate: 'v3.5-a25-eval', baseline: 'v3.1-lite', seeds: 400, seedBase: 7870000, policy: 'greedy', label: 'v35-b-scale2.5-eval' },
];

function render(results: MatchResult[]): string {
  const header =
    'label                       advantage vs baseline      own   opps  placed   MDE';
  const rows = results.map((result) => {
    const ci =
      result.advantage === null
        ? 'no result'
        : `${result.advantage.toFixed(2)} [${result.low?.toFixed(2)}, ${result.high?.toFixed(2)}]`;
    const cell = (value: number | null, width: number): string =>
      (value === null ? '—' : value.toFixed(2)).padStart(width);
    return [
      result.label.padEnd(26),
      ci.padStart(22),
      cell(result.ownScore, 7),
      cell(result.opponentScore, 6),
      cell(result.squaresPlaced, 7),
      minimumDetectableEffect(result.seeds).toFixed(2).padStart(6),
    ].join(' ');
  });
  return [
    '',
    header,
    ...rows,
    '',
    'Advantage is `own − mean(opponents)`, which scale 1.0 optimises by definition. Read the dial on',
    'the own/opps columns; use advantage only to say what a setting costs, never to rank the sweep.',
  ].join('\n');
}

async function main(): Promise<void> {
  const results = await runBatch(
    'v3.5 aggression frontier',
    [...searchArm, ...evalArm],
    'v35-aggression-frontier.json',
    render,
  );

  const control = results.find((result) => result.label.endsWith('control'));
  if (control && control.advantage !== null && Math.abs(control.advantage) > 1e-9) {
    console.error(
      `\nCONTROL FAILED: scale 1.0 scored ${control.advantage} against a config it should equal.\n` +
        'The dial is not a pure multiplier on the fitted λ, so the frontier is measuring two things.',
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
