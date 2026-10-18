/**
 * Golden fixtures for the native engine's parity suite (`engine-rs/tests/parity.rs`).
 *
 * Every number here comes from the TS engine, which stays the reference. The Rust port must match
 * all of it bit-for-bit — placement table, hashes, legal moves, territory, E_i, rollouts, searches
 * and whole seeded games — before a single native match result can be trusted.
 *
 *   npx tsx scripts/dumpGoldens.ts [--out engine-rs/tests/goldens] [--game-budget 20]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRng, random, setSeed } from '../src/ai/rng.ts';
import { getAlgo, bitboardParamsFor } from '../src/ai/algoVersions.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { CELL_KEYS, LAST_PIECE_KEYS, TURN_KEYS } from '../src/ai/bitboard/zobrist.ts';
import { toPosition, placementFor } from '../src/ai/bitboard/adapter.ts';
import { newMoveBuffer, type Position } from '../src/ai/bitboard/position.ts';
import { createEvalContext, detectPhase, evaluate, refreshContext } from '../src/ai/bitboard/features.ts';
import { MoveOrderer } from '../src/ai/bitboard/ordering.ts';
import { Playout, createOutcome } from '../src/ai/bitboard/playout.ts';
import { V12Search } from '../src/ai/bitboard/mcts.ts';
import { rankMovesGreedyV12, resetV12 } from '../src/ai/bitboard/index.ts';
import { rolloutPolicyFor } from '../src/ai/bitboard/rolloutPolicy.ts';
import { playRandomGame } from '../src/ai/bitboard/testUtil.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import type { BitboardParams, PhaseId } from '../src/ai/bitboard/config.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { preloadNets } from './lib/netPreload.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const OUT = arg('out', join('engine-rs', 'tests', 'goldens'));
const GAME_BUDGET = Number(arg('game-budget', '20'));
const PHASES: PhaseId[] = ['opening', 'midgame', 'endgame'];

/** FNV-1a over 32-bit words, so each table section is one comparable number. */
function fnv(values: ArrayLike<number>): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < values.length; i += 1) {
    let v = values[i] >>> 0;
    for (let b = 0; b < 4; b += 1) {
      hash ^= v & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      v >>>= 8;
    }
  }
  return hash >>> 0;
}

function f32Bits(values: Float32Array): Uint32Array {
  return new Uint32Array(values.buffer, values.byteOffset, values.length);
}

function write(name: string, value: unknown): void {
  writeFileSync(join(OUT, name), `${JSON.stringify(value)}\n`);
  console.log(`wrote ${join(OUT, name)}`);
}

function paramsOf(version: string): BitboardParams {
  return bitboardParamsFor(getAlgo(version as never));
}

function encodePosition(position: Position) {
  const owners: number[] = new Array(400).fill(-1);
  for (let seat = 0; seat < 4; seat += 1) {
    for (let cell = 0; cell < 400; cell += 1) {
      if ((position.own[seat][cell >>> 5] & (1 << (cell & 31))) !== 0) owners[cell] = seat;
    }
  }
  return {
    owners,
    hand: Array.from(position.hand),
    lastPiece: Array.from(position.lastPiece),
    turn: position.turn,
  };
}

preloadNets();
mkdirSync(OUT, { recursive: true });

/* --- 1. Static tables ------------------------------------------------------------------------ */
{
  const rng = createRng(12345);
  write('tables.json', {
    placementCount: PLACEMENTS.count,
    cells: fnv(PLACEMENTS.cells),
    edgeHalo: fnv(PLACEMENTS.edgeHalo),
    cornerHalo: fnv(PLACEMENTS.cornerHalo),
    maskLo: fnv(PLACEMENTS.maskLo),
    maskHi: fnv(PLACEMENTS.maskHi),
    pieceId: fnv(PLACEMENTS.pieceId),
    orientation: fnv(PLACEMENTS.orientation),
    anchorX: fnv(PLACEMENTS.anchorX),
    anchorY: fnv(PLACEMENTS.anchorY),
    centreDistance: fnv(f32Bits(PLACEMENTS.centreDistance)),
    cellList: fnv(PLACEMENTS.cellList),
    coverList: fnv(PLACEMENTS.coverList),
    coverPieceStart: fnv(PLACEMENTS.coverPieceStart),
    zobristCells: fnv([...CELL_KEYS.lo, ...CELL_KEYS.hi]),
    zobristTurn: fnv([...TURN_KEYS.lo, ...TURN_KEYS.hi]),
    zobristLast: fnv([...LAST_PIECE_KEYS.lo, ...LAST_PIECE_KEYS.hi]),
    rngPrefix: Array.from({ length: 16 }, () => rng()),
  });
  const policy = rolloutPolicyFor('ml/v41-rollout-policy.json');
  if (!policy) throw new Error('rollout policy did not preload');
  write('rollout-policy.json', {
    staticScores: fnv(f32Bits(policy.staticScores)),
    handSlopes: fnv(f32Bits(policy.handSlopes)),
    pieceSlopes: fnv(f32Bits(policy.pieceSlopes)),
  });
}

/* --- 2. Positions: legality, territory, evaluation, ordering, greedy ------------------------- */
const versions = ['v4.1-ultra', 'v3.5', 'v3.1', 'v12', 'v4.1-ultra-settlefix'];
const params: Record<string, BitboardParams> = Object.fromEntries(versions.map((v) => [v, paramsOf(v)]));
write('params.json', params);

const positions: Position[] = [];
for (let seed = 1; seed <= 6; seed += 1) {
  for (const state of playRandomGame(seed, 84, 7).states) {
    positions.push(toPosition(state));
  }
}

{
  const buffer = newMoveBuffer();
  const records = positions.map((position) => {
    const legal: number[][] = [];
    for (let seat = 0; seat < 4; seat += 1) {
      const count = position.generateMoves(seat, buffer);
      legal.push(Array.from(buffer.subarray(0, count)));
    }
    const perVersion: Record<string, unknown> = {};
    for (const version of ['v4.1-ultra', 'v12']) {
      const p = params[version];
      const context = createEvalContext();
      context.fractionalTies = p.fractionalTerritoryTies;
      refreshContext(context, position, true);
      const evaluations = PHASES.map((phase) => Array.from(evaluate(context, position, p, phase)));
      const phases = [0, 1, 2, 3].map((seat) => detectPhase(position, context, p, seat));
      const seat = position.turn;
      const moves = legal[seat].slice(0, 64);
      const scores = new Float64Array(moves.length);
      new MoveOrderer(p).scoreMoves(
        position, context, seat, Int32Array.from(moves), moves.length, scores, phases[seat],
        { withSplit: true, splitBudget: 24 },
      );
      perVersion[version] = {
        territory: Array.from(context.territory.territory),
        contested: context.territory.contested,
        reachable: Array.from(context.territory.reachableCount),
        regions: context.regions.count,
        articulation: Array.from(context.articulation).reduce((a, b) => a + b, 0),
        leader: context.leader,
        evaluations,
        phases,
        orderingMoves: moves,
        orderingScores: Array.from(scores),
      };
    }
    return {
      position: encodePosition(position),
      hashLo: position.hashLo >>> 0,
      hashHi: position.hashHi >>> 0,
      ply: position.ply,
      legal,
      versions: perVersion,
    };
  });
  write('positions.json', records);
}

/* --- 3. Greedy ranking ---------------------------------------------------------------------- */
{
  const records = [];
  for (let seed = 1; seed <= 3; seed += 1) {
    for (const state of playRandomGame(seed + 40, 84, 11).states) {
      if (state.finished) continue;
      const result = await rankMovesGreedyV12(state, state.currentTurn, params['v4.1-ultra']);
      records.push({
        position: encodePosition(toPosition(state)),
        ranked: result.rankedMoves.map((entry) => ({ move: placementFor(entry.move), value: entry.value })),
      });
    }
  }
  write('greedy.json', records);
}

/* --- 4. Playouts ---------------------------------------------------------------------------- */
{
  const records = [];
  for (const version of ['v4.1-ultra', 'v12']) {
    const p = params[version];
    const playout = new Playout(p);
    const context = createEvalContext();
    context.fractionalTies = p.fractionalTerritoryTies;
    for (let i = 0; i < positions.length; i += 3) {
      const position = positions[i];
      if (position.finished) continue;
      const seed = 1000 + i;
      setSeed(seed);
      const phase = PHASES[i % 3];
      const outcome = playout.run(position, context, phase, createOutcome());
      records.push({
        version,
        index: i,
        seed,
        phase,
        values: Array.from(outcome.values),
        terminal: outcome.terminal,
        nextDraw: random(),
        hashLo: position.hashLo >>> 0,
      });
    }
  }
  write('playouts.json', records);
}

/* --- 5. Searches ---------------------------------------------------------------------------- */
{
  const records = [];
  for (const [version, budget] of [['v4.1-ultra', 160], ['v3.5', 200], ['v12', 200], ['v4.1-ultra-settlefix', 160]] as const) {
    const p = params[version];
    for (let i = 1; i < positions.length; i += 5) {
      const position = positions[i].clone();
      const seat = position.turn;
      if (!position.hasMove(seat)) continue;
      const search = new V12Search(p);
      const seed = 5000 + i;
      setSeed(seed);
      const result = search.run(position, seat, { iterations: budget });
      records.push({
        version,
        index: i,
        seed,
        budget,
        iterations: result.iterations,
        best: result.best,
        ranked: result.ranked.map((entry) => [entry.move, entry.visits, entry.value]),
        nextDraw: random(),
      });
    }
  }
  write('searches.json', records);
}

/* --- 6. Whole seeded games ------------------------------------------------------------------ */
{
  const colors: PlayerColor[] = ['blue', 'green', 'purple', 'yellow'];
  const setups: Array<{ label: string; seats: string[]; policy: PolicyId; seed: number; budget?: number }> = [
    { label: 'greedy-v41', seats: ['v4.1-ultra', 'v4.1-ultra', 'v4.1-ultra', 'v4.1-ultra'], policy: 'greedy', seed: 7001 },
    { label: 'mixed-greedy', seats: ['v4.1-ultra', 'v3.5', 'v3.1', 'v12'], policy: 'greedy', seed: 7002 },
    { label: 'search-mixed', seats: ['v4.1-ultra', 'v3.5', 'v3.1', 'v12'], policy: 'mcts-bench', seed: 7003, budget: GAME_BUDGET },
    { label: 'search-v41', seats: ['v4.1-ultra', 'v4.1-ultra', 'v4.1-ultra', 'v4.1-ultra'], policy: 'mcts-bench', seed: 7004, budget: GAME_BUDGET },
    { label: 'search-settlefix', seats: ['v4.1-ultra-settlefix', 'v4.1-ultra', 'v4.1-ultra-settlefix', 'v4.1-ultra'], policy: 'mcts-bench', seed: 7005, budget: GAME_BUDGET },
  ];
  const records = [];
  for (const setup of setups) {
    resetV12();
    const moves: number[] = [];
    const seatVersions = Object.fromEntries(colors.map((c, i) => [c, setup.seats[i]])) as Record<PlayerColor, never>;
    const seatPolicies = Object.fromEntries(colors.map((c) => [c, setup.policy])) as Record<PlayerColor, PolicyId>;
    const startedAt = Date.now();
    const record = await playSeatedGame({
      hero: setup.policy,
      opponents: setup.policy,
      seatVersions,
      seatPolicies,
      seed: setup.seed,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: { skipWinOddsRefinement: true, lightRollouts: true, iterationBudget: setup.budget },
      onMove: (_state, move) => moves.push(move ? placementFor(move) : -1),
    });
    console.log(`  game ${setup.label}: ${record.plies} plies in ${Date.now() - startedAt} ms`);
    records.push({ ...setup, moves, scores: colors.map((c) => record.scores[c]), plies: record.plies });
  }
  write('games.json', records);
}
