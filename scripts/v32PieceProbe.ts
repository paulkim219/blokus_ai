import { writeFileSync } from 'node:fs';
import { createInitialState, applyMove, passTurn } from '../src/engine/game.ts';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { resetV12, placementFor, toPosition } from '../src/ai/bitboard/index.ts';
import { newMoveBuffer } from '../src/ai/bitboard/position.ts';
import { PIECE_SIZES, PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { setSeed } from '../src/ai/rng.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function feasibility(position: ReturnType<typeof toPosition>, seat: number, move: number): number {
  const undo = position.apply(move);
  position.forceTurn(seat);
  const moves = newMoveBuffer();
  const count = position.generateMoves(seat, moves);
  const placements = new Int32Array(PIECE_SIZES.length);
  for (let index = 0; index < count; index += 1) placements[PLACEMENTS.pieceId[moves[index]]] += 1;
  let score = 0;
  for (let piece = 0; piece < placements.length; piece += 1) {
    if ((position.hand[seat] & (1 << piece)) === 0) continue;
    const legal = placements[piece];
    score += PIECE_SIZES[piece] * Math.log1p(legal);
    score -= 2 * PIECE_SIZES[piece] / (1 + legal);
  }
  position.undo(undo);
  return score;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = x[index] - mx;
    const dy = y[index] - my;
    xy += dx * dy;
    xx += dx * dx;
    yy += dy * dy;
  }
  return xy / Math.max(1e-12, Math.sqrt(xx * yy));
}

const games = Math.max(1, Number(arg('games', '3')));
const maxPlies = Math.max(1, Number(arg('plies', '32')));
const iterations = Math.max(1, Number(arg('iterations', '100')));
const seedBase = Number(arg('seed-base', '985000'));
const rows: Array<{ game: number; ply: number; candidates: number; correlation: number; topRank: number }> = [];

for (let game = 0; game < games; game += 1) {
  resetV12();
  setSeed(seedBase + game);
  let state = createInitialState('corner');
  for (let ply = 0; ply < maxPlies && !state.finished; ply += 1) {
    const seat = PLAYER_COLORS.indexOf(state.currentTurn);
    const result = await searchBestMove(state, state.currentTurn, 60_000, undefined, {
      version: 'v3.1-pro',
      iterationBudget: iterations,
      skipWinOddsRefinement: true,
      lightRollouts: true,
    });
    if (!result.bestMove) {
      state = passTurn(state);
      continue;
    }
    const position = toPosition(state);
    const ranked = result.rankedMoves.filter((entry) => entry.move !== null);
    const scores: number[] = [];
    const visits: number[] = [];
    for (const entry of ranked) {
      const move = placementFor(entry.move!);
      scores.push(feasibility(position, seat, move));
      visits.push(Math.log1p(entry.visits));
    }
    const bestScore = scores[0];
    const topRank = 1 + scores.filter((score) => score > bestScore).length;
    rows.push({ game, ply, candidates: scores.length, correlation: pearson(scores, visits), topRank });
    state = applyMove(state, result.bestMove);
  }
  console.log(`game ${game + 1}/${games} complete`);
}

const usable = rows.filter((row) => Number.isFinite(row.correlation));
const meanCorrelation = usable.reduce((sum, row) => sum + row.correlation, 0) / usable.length;
const meanTopRank = usable.reduce((sum, row) => sum + row.topRank, 0) / usable.length;
const topFive = usable.filter((row) => row.topRank <= 5).length / usable.length;
const summary = { games, maxPlies, iterations, roots: usable.length, meanCorrelation, meanTopRank, topFive, rows };
writeFileSync('selfplay-results/v32-piece-probe.json', `${JSON.stringify(summary, null, 2)}\n`);
console.log(`roots: ${usable.length}`);
console.log(`mean within-root correlation with log visits: ${meanCorrelation.toFixed(4)}`);
console.log(`teacher move mean feasibility rank: ${meanTopRank.toFixed(2)}`);
console.log(`teacher move in feasibility top five: ${(100 * topFive).toFixed(1)}%`);
