/**
 * v4.1 gate 3 — overall move wall time against the matched v3.1 tier.
 *
 * The recorded cost work for v4.1 compared it against the *v3.2 identity*, which is the right
 * control for the learned policy's per-iteration overhead but is not what gate 3 asks. Gate 3 is a
 * claim about the deployed engine being cheaper than the v3.1 lineup it wants to beat, and v4.1
 * differs from v3.1 in three ways that pull in opposite directions: 60% rollout exploration, the
 * table policy's per-candidate lookup, and the own-moves-1–3 opening shortcut that skips the tree
 * entirely.
 *
 * Fixed-ply benchmarks cannot answer that. A three-position fixture at plies 8/24/40 weights the
 * phases equally, and v4.1 executes no tree at all in the opening, so such a fixture would credit
 * the shortcut roughly ten times more than a real game does. This plays **whole games** and divides
 * total search time by moves, which weights each phase by how often it actually occurs.
 *
 * Both versions play the same seeds. Their games diverge after the first differing move, so this is
 * an average over comparable game populations rather than a paired position-for-position timing.
 *
 *   node --import tsx scripts/gate3Cost.ts --a v4.1-candidate --b v3.1 --games 4
 */

import { writeFileSync } from 'node:fs';
import { applyMove, createInitialState, generateLegalMoves } from '../src/engine/game.ts';
import type { GameState } from '../src/engine/types.ts';
import { isAlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed } from '../src/ai/rng.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';
import { clearLegalMoveCache } from '../src/ai/legalMoveCache.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

type Phase = 'opening' | 'midgame' | 'endgame';

function phaseOf(state: GameState): Phase {
  const played = 21 - state.remainingPieces[state.currentTurn].length;
  if (played < 5) return 'opening';
  return played < 15 ? 'midgame' : 'endgame';
}

interface Timing {
  total: number;
  moves: number;
  byPhase: Record<Phase, { total: number; moves: number }>;
}

function emptyTiming(): Timing {
  return {
    total: 0,
    moves: 0,
    byPhase: {
      opening: { total: 0, moves: 0 },
      midgame: { total: 0, moves: 0 },
      endgame: { total: 0, moves: 0 },
    },
  };
}

async function playTimedGame(
  version: string,
  seed: number,
  iterations: number,
  timing: Timing,
): Promise<void> {
  clearLegalMoveCache();
  resetV12();
  setSeed(seed);
  let state = createInitialState('corner');
  let guard = 0;
  while (!state.finished && guard < 200) {
    guard += 1;
    const legal = generateLegalMoves(state, state.currentTurn, 1);
    if (legal.length === 0) {
      // No legal move means this seat passes; passes cost no search and must not enter the average.
      state = applyMove(state, { type: 'pass', color: state.currentTurn });
      continue;
    }
    const phase = phaseOf(state);
    const started = performance.now();
    const result = await searchBestMove(state, state.currentTurn, 600_000, undefined, {
      version,
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
    });
    const elapsed = performance.now() - started;
    timing.total += elapsed;
    timing.moves += 1;
    timing.byPhase[phase].total += elapsed;
    timing.byPhase[phase].moves += 1;
    state = applyMove(state, result.bestMove ?? legal[0]);
  }
}

function report(label: string, timing: Timing): string {
  const per = (t: { total: number; moves: number }) =>
    t.moves === 0 ? '   —  ' : `${(t.total / t.moves).toFixed(1).padStart(6)}`;
  return (
    `${label.padEnd(24)} ${per(timing)} ms/move over ${String(timing.moves).padStart(4)} moves   ` +
    `open=${per(timing.byPhase.opening)} mid=${per(timing.byPhase.midgame)} end=${per(timing.byPhase.endgame)}`
  );
}

async function main(): Promise<void> {
  preloadNets();
  const a = arg('a', 'v4.1-candidate') as string;
  const b = arg('b', 'v3.1') as string;
  const games = Math.max(1, Number(arg('games', '4')));
  const iterations = Number(arg('iterations', '300'));
  const seedBase = Number(arg('seed-base', '55000000'));
  const outPath = arg('out');
  if (!isAlgoVersionId(a) || !isAlgoVersionId(b)) throw new Error(`unknown version ${a} / ${b}`);

  const timings: Record<string, Timing> = { [a]: emptyTiming(), [b]: emptyTiming() };
  // One untimed game each, so JIT warm-up does not land entirely on whichever version runs first.
  for (const version of [a, b]) await playTimedGame(version, seedBase - 1, iterations, emptyTiming());

  for (let g = 0; g < games; g += 1) {
    // Alternate which version is timed first, so any thermal or scheduler drift is shared.
    const order = g % 2 === 0 ? [a, b] : [b, a];
    for (const version of order) {
      await playTimedGame(version, seedBase + g, iterations, timings[version]);
    }
    console.log(`  game ${g + 1}/${games}`);
  }

  console.log('');
  console.log(report(a, timings[a]));
  console.log(report(b, timings[b]));
  const ratio = timings[a].total / timings[a].moves / (timings[b].total / timings[b].moves);
  const delta = (ratio - 1) * 100;
  console.log(
    `\n${a} is ${Math.abs(delta).toFixed(1)}% ${delta < 0 ? 'cheaper' : 'more expensive'} per move ` +
      `than ${b}. Gate 3 requires cheaper: ${delta < 0 ? 'PASS' : 'FAIL'}.`,
  );

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify({ a, b, games, iterations, timings, deltaPct: delta }, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
