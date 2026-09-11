/**
 * Spawn `scripts/tournament.ts` once per spec and scrape its summary back out.
 *
 * The v3.2 batch grew its own copy of this; a third and fourth copy for the v3.5 sweeps would be
 * where the copies start disagreeing about what they parse. `v32Batch.ts` is deliberately left
 * alone — it is mid-run, and rewriting a script while it is producing results is how a batch ends up
 * with two incompatible halves.
 *
 * Results are appended to disk after every match, so an interrupted sweep leaves a usable partial.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MatchSpec {
  candidate: string;
  baseline: string;
  seeds: number;
  seedBase: number;
  label: string;
  /** Base iteration budget; each side multiplies it by its own `iterationScale`. */
  iterations?: number;
  policy?: 'greedy' | 'mcts-bench';
  challengerPolicy?: 'greedy' | 'mcts-bench';
  championPolicy?: 'greedy' | 'mcts-bench';
}

export interface MatchResult extends MatchSpec {
  advantage: number | null;
  low: number | null;
  high: number | null;
  /** The frontier columns: what the setting actually changed, as opposed to what it cost. */
  ownScore: number | null;
  opponentScore: number | null;
  squaresPlaced: number | null;
  firstPlace: number | null;
  output: string;
}

const ADVANTAGE = /Advantage .*?: (-?\d+\.\d+) \[95% CI (-?\d+\.\d+), (-?\d+\.\d+)\]/;
const PLAYED = /— (\d+) games over (\d+) seeds/;
const SCORES = /Mean score: (-?\d+\.\d+) \(opponents (-?\d+\.\d+)\), squares placed (\d+\.\d+)/;
const FIRST_PLACE = /First place: (\d+\.\d+)%/;

function num(match: RegExpMatchArray | null, group: number): number | null {
  return match ? Number(match[group]) : null;
}

export function runMatch(spec: MatchSpec): Promise<MatchResult> {
  const args = [
    '--import',
    'tsx',
    join(process.cwd(), 'scripts', 'tournament.ts'),
    '--challenger', spec.candidate,
    '--champion', spec.baseline,
    '--policy', spec.policy ?? 'mcts-bench',
    '--seeds', String(spec.seeds),
    '--seed-base', String(spec.seedBase),
    '--workers', '8',
    '--label', spec.label,
  ];
  if (spec.challengerPolicy) {
    args.push('--challenger-policy', spec.challengerPolicy);
  }
  if (spec.championPolicy) {
    args.push('--champion-policy', spec.championPolicy);
  }
  // A greedy-vs-greedy match has no tree. Mixed MCTS/greedy still needs an iteration budget
  // for the searching side.
  const searching =
    (spec.challengerPolicy ?? spec.policy ?? 'mcts-bench') !== 'greedy' ||
    (spec.championPolicy ?? spec.policy ?? 'mcts-bench') !== 'greedy';
  if (searching) {
    args.push('--iterations', String(spec.iterations ?? 300));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${spec.label} exited with ${code}`));
        return;
      }
      // A match that played nothing reports a tidy `0.00 [0.00, 0.00]`, because
      // `rotationAdvantage([])` returns 0 and the bootstrap of an empty sample is degenerate. That is
      // indistinguishable from a passing identity gate, and this repo has already been bitten by it
      // once — the CEM tuner used to skip failed games in silence and read the zeros as fitness.
      // Fail loudly instead: an empty match is never a result.
      const played = output.match(PLAYED);
      const games = played ? Number(played[1]) : 0;
      if (games === 0) {
        reject(
          new Error(
            `${spec.label} played 0 games. The 0.00 it printed is an empty-sample artefact, not a ` +
              'null — check that the version ids and seed count actually reached the harness.',
          ),
        );
        return;
      }

      const advantage = output.match(ADVANTAGE);
      const scores = output.match(SCORES);
      resolve({
        ...spec,
        advantage: num(advantage, 1),
        low: num(advantage, 2),
        high: num(advantage, 3),
        ownScore: num(scores, 1),
        opponentScore: num(scores, 2),
        squaresPlaced: num(scores, 3),
        firstPlace: num(output.match(FIRST_PLACE), 1),
        output,
      });
    });
  });
}

/** The smallest effect an experiment can tell from zero at 80% power, per report §7. */
export function minimumDetectableEffect(seeds: number): number {
  return 13.4 / Math.sqrt(seeds);
}

export async function runBatch(
  title: string,
  specs: MatchSpec[],
  outFile: string,
  render?: (results: MatchResult[]) => string,
): Promise<MatchResult[]> {
  const results: MatchResult[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    console.log(`\n######## ${title} ${index + 1}/${specs.length}: ${spec.label} ########\n`);
    results.push(await runMatch(spec));
    writeFileSync(
      join(process.cwd(), 'selfplay-results', outFile),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    if (render) {
      console.log(`\n${render(results)}\n`);
    }
  }
  return results;
}
