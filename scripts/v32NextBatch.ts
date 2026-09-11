/** Post-cliff v3.2 combinations, in the order recorded in the research roadmap. */
import { minimumDetectableEffect, runBatch, type MatchResult, type MatchSpec } from './lib/matchRunner.ts';

const specs: MatchSpec[] = [
  {
    candidate: 'v3.2-policy-audit-pro',
    baseline: 'v3.1-pro',
    seeds: 100,
    seedBase: 981000,
    label: 'v32-next-policy-paired-audit-pro',
  },
  {
    candidate: 'v3.2-audit-race-pro',
    baseline: 'v3.1-pro',
    seeds: 100,
    seedBase: 982000,
    label: 'v32-next-paired-variance-race-pro',
  },
  {
    candidate: 'v3.2-policy-groups-pro',
    baseline: 'v3.1-pro',
    seeds: 100,
    seedBase: 983000,
    label: 'v32-next-policy-spatial-groups-pro',
  },
];

function render(results: MatchResult[]): string {
  return [
    '',
    'label                                      advantage (95% CI)        MDE   first',
    ...results.map((result) => {
      const estimate = result.advantage === null
        ? 'no result'
        : `${result.advantage.toFixed(2)} [${result.low?.toFixed(2)}, ${result.high?.toFixed(2)}]`;
      return [
        result.label.padEnd(42),
        estimate.padStart(24),
        minimumDetectableEffect(result.seeds).toFixed(2).padStart(6),
        `${result.firstPlace?.toFixed(1) ?? '—'}%`.padStart(7),
      ].join('  ');
    }),
  ].join('\n');
}

await runBatch('v3.2 post-cliff combinations', specs, 'v32-next-results.json', render);
