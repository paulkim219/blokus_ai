/**
 * Seed-replay identity harness — the gate for workstream D.
 *
 * A per-iteration optimisation is only in scope if it plays *identical moves on identical seeds*.
 * That makes strength inherited rather than re-measured, and it is the entire reason the speed arm
 * needs no 540-seed ladder.
 *
 * `src/ai/bitboard/search.test.ts` already asserts this invariant, but at 60-80 iterations on two
 * positions. This runs it at real budgets across phase-representative fixtures and, crucially, can
 * compare against a snapshot taken *before* a refactor:
 *
 *   node --import tsx scripts/v37ReplayDiff.ts --save tmp/replay-before.json
 *   ...optimise...
 *   node --import tsx scripts/v37ReplayDiff.ts --check tmp/replay-before.json
 *
 * The compared object is the full ranked list — move, visits, and value for every root child — not
 * merely the selected move. A refactor that changes visit *allocation* while happening to leave the
 * argmax alone has changed the search, and this catches it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { moveKey } from '../src/engine/game.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { benchmarkFixtures } from './lib/benchFixtures.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Signature {
  version: string;
  phase: string;
  ply: number;
  seed: number;
  iterations: number;
  best: string;
  /** `move|visits|value` per root child, in the engine's own ranked order. */
  ranked: string[];
}

async function signatures(versions: AlgoVersionId[], iterations: number, seedBase: number) {
  const fixtures = benchmarkFixtures();
  const out: Signature[] = [];
  for (const version of versions) {
    for (let f = 0; f < fixtures.length; f += 1) {
      const fixture = fixtures[f];
      // Same reset discipline the determinism tests use: a stale cache or a live tree would make
      // the signature depend on execution order rather than on the seed.
      clearLegalMoveCache();
      resetV12();
      const seed = seedBase + f;
      setSeed(seed);
      const result = await searchBestMove(
        fixture.state,
        fixture.state.currentTurn,
        600_000,
        undefined,
        { version, iterationBudget: iterations, skipWinOddsRefinement: true },
      );
      out.push({
        version,
        phase: fixture.phase,
        ply: fixture.ply,
        seed,
        iterations,
        best: result.bestMove ? moveKey(result.bestMove) : 'none',
        ranked: result.rankedMoves.map(
          (entry) => `${moveKey(entry.move)}|${entry.visits}|${entry.value.toFixed(9)}`,
        ),
      });
    }
  }
  return out;
}

function compare(before: Signature[], after: Signature[]): string[] {
  const problems: string[] = [];
  if (before.length !== after.length) {
    problems.push(`snapshot has ${before.length} signatures, this run produced ${after.length}`);
    return problems;
  }
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i];
    const b = after[i];
    const where = `${b.version} ${b.phase}@ply${b.ply}`;
    if (a.version !== b.version || a.ply !== b.ply || a.seed !== b.seed) {
      problems.push(`${where}: snapshot is not aligned with this run — regenerate it`);
      continue;
    }
    if (a.best !== b.best) {
      problems.push(`${where}: selected move changed, ${a.best} -> ${b.best}`);
    }
    if (a.ranked.length !== b.ranked.length) {
      problems.push(`${where}: ranked width ${a.ranked.length} -> ${b.ranked.length}`);
      continue;
    }
    // Report the first differing child rather than all of them: the first divergence is where the
    // change entered, and everything after it is downstream noise.
    for (let c = 0; c < a.ranked.length; c += 1) {
      if (a.ranked[c] !== b.ranked[c]) {
        problems.push(`${where}: root child ${c} differs, ${a.ranked[c]} -> ${b.ranked[c]}`);
        break;
      }
    }
  }
  return problems;
}

async function main(): Promise<void> {
  preloadNets();
  const versions = (arg('versions', 'v3.5-lite,v3.5-pro,v3.6-pro-max') as string)
    .split(',')
    .map((v) => v.trim());
  for (const v of versions) {
    if (!isAlgoVersionId(v)) throw new Error(`unknown version: ${v}`);
  }
  const iterations = Number(arg('iterations', '300'));
  const seedBase = Number(arg('seed-base', '37900000'));
  const savePath = arg('save');
  const checkPath = arg('check');

  const now = await signatures(versions as AlgoVersionId[], iterations, seedBase);
  console.log(
    `replay signatures: ${now.length} (${versions.length} versions x ${now.length / versions.length} fixtures) ` +
      `at ${iterations} base iterations\n`,
  );
  for (const sig of now) {
    console.log(
      `  ${sig.version.padEnd(14)} ${sig.phase.padEnd(8)} ply ${String(sig.ply).padStart(2)}  ` +
        `${sig.ranked.length} children  best ${sig.best}`,
    );
  }

  if (savePath) {
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`\nWrote ${savePath}. Re-run with --check ${savePath} after changing the engine.`);
    return;
  }

  if (checkPath) {
    if (!existsSync(checkPath)) throw new Error(`no snapshot at ${checkPath}`);
    const before = JSON.parse(readFileSync(checkPath, 'utf8')) as Signature[];
    const problems = compare(before, now);
    if (problems.length === 0) {
      console.log(`\nIDENTICAL to ${checkPath}. The change is behaviour-preserving; strength is inherited.`);
      return;
    }
    console.error(`\n${problems.length} DIFFERENCE(S) against ${checkPath}:\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      '\nThis change alters the search. It is out of scope for the speed workstream and must be' +
        '\nreverted or re-scoped as an ordinary candidate under the master ladder.',
    );
    process.exit(1);
  }

  console.log('\n(no --save or --check given; nothing compared)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
