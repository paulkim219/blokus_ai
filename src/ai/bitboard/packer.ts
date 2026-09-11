/**
 * Exact endgame packing — Formulation A of §4.3.
 *
 * "Once the agent's remaining reachable area is a set of regions no opponent can enter, the problem
 * becomes a deterministic maximum-weight packing under the corner rule… Search over placements with
 * memoisation on (region bitboard, remaining-piece bitmask), pruning with the bound min(free cells,
 * Σ remaining sizes) plus a hole-feasibility check."
 *
 * Formulation B (the ILP with lazy connectivity cuts) is deliberately not implemented: its stated
 * role is to validate this solver offline and to take the largest regions, and it needs a MIP
 * solver this repo does not ship. `packer.test.ts` covers the same ground the ILP comparison would
 * by checking small regions against exhaustive enumeration.
 *
 * The memo key is the position hash, which is strictly finer than (region, hand) — it also
 * separates states by last piece — so it can cost hits but never soundness. The memoised value is
 * the *additional* score obtainable from a state including the +15/+5 completion bonuses, which is
 * well defined because the ordering that earns the +5 lies entirely in that state's future.
 */

import { CELL_COUNT, WORDS, newMask, testBit, type Mask } from './bitboard';
import { MONOMINO_PIECE_ID, PIECE_SIZES, PLACEMENTS } from './placements';
import { ALL_PLACED_BONUS, MAX_MOVES, MONOMINO_LAST_BONUS, type Position } from './position';
import type { EndgameParams } from './config';
import { SEAT_COUNT } from './seats';
import type { TerritoryMap } from './territory';

export interface PackResult {
  /** The seat's final Blokus score if it plays this line out alone. */
  score: number;
  /** Squares the line places. */
  squares: number;
  /** Best line found, as placement ids in play order. */
  moves: number[];
  /** True when the whole tree was explored — the value is a proven optimum. */
  proven: boolean;
  nodes: number;
}

interface MemoEntry {
  hi: number;
  value: number;
  line: number[];
}

interface SolveContext {
  seat: number;
  params: EndgameParams;
  nodes: number;
  exhausted: boolean;
  /** Keyed by the low half of the Zobrist hash; `hi` disambiguates the rare collision. */
  memo: Map<number, MemoEntry>;
  reach: Mask;
  /** One best-continuation slot per depth, written by the frame that owns it. */
  lines: number[][];
  buffers: Int32Array[];
}

function buffer(context: SolveContext, depth: number): Int32Array {
  while (context.buffers.length <= depth) {
    context.buffers.push(new Int32Array(MAX_MOVES));
  }
  return context.buffers[depth];
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0xff;
}

/**
 * Upper bound on squares this seat can still place: cells inside its reach that are empty and not
 * on its own edge halo. The halo term is the hole-feasibility check — a cell orthogonally adjacent
 * to our own colour can never be covered by us whatever is left in hand.
 */
function coverableCells(position: Position, seat: number, reach: Mask): number {
  const occ = position.occ;
  const edge = position.edgeHalo[seat];
  let count = 0;
  for (let w = 0; w < WORDS; w += 1) {
    count += popcount32(reach[w] & ~occ[w] & ~edge[w]);
  }
  return count;
}

function solve(context: SolveContext, position: Position, depth: number): number {
  context.nodes += 1;
  if (context.nodes > context.params.nodeBudget) {
    context.exhausted = true;
    context.lines[depth] = [];
    return 0;
  }

  const cached = context.memo.get(position.hashLo);
  if (cached && cached.hi === position.hashHi) {
    context.lines[depth] = cached.line;
    return cached.value;
  }

  const seat = context.seat;
  const moves = buffer(context, depth);
  const count = position.generateMoves(seat, moves);
  if (count === 0) {
    context.lines[depth] = [];
    return 0;
  }

  // Largest piece first: branch-and-bound cuts earliest when a strong line is found early.
  const order = Array.from({ length: count }, (_, i) => moves[i]);
  order.sort((a, b) => PLACEMENTS.size[b] - PLACEMENTS.size[a] || a - b);

  const handSquares = position.handSquares[seat];
  const headroom = Math.min(coverableCells(position, seat, context.reach), handSquares);
  const optimistic =
    headroom === handSquares ? headroom + ALL_PLACED_BONUS + MONOMINO_LAST_BONUS : headroom;

  let best = 0;
  let bestLine: number[] = [];

  for (const move of order) {
    if (optimistic <= best) {
      break;
    }
    const size = PIECE_SIZES[PLACEMENTS.pieceId[move]];
    const undo = position.apply(move);
    // `apply` hands the turn on; here the same seat plays every move of the line, so take it back.
    // Without this the next placement would be applied under a different colour, and the memo key
    // would carry a turn that never occurs in this solver.
    position.forceTurn(seat);
    let value: number;
    let continuation: number[];
    if (position.hand[seat] === 0) {
      value =
        size +
        ALL_PLACED_BONUS +
        (PLACEMENTS.pieceId[move] === MONOMINO_PIECE_ID ? MONOMINO_LAST_BONUS : 0);
      continuation = [];
    } else {
      value = size + solve(context, position, depth + 1);
      continuation = context.lines[depth + 1];
    }
    position.undo(undo);

    if (value > best) {
      best = value;
      bestLine = [move, ...continuation];
    }
    if (context.exhausted) {
      break;
    }
  }

  context.lines[depth] = bestLine;
  if (!context.exhausted) {
    context.memo.set(position.hashLo, {
      hi: position.hashHi,
      value: best,
      line: bestLine,
    });
    if (context.memo.size > context.params.memoLimit) {
      context.memo.clear();
    }
  }
  return best;
}

const packCache = new Map<string, PackResult>();

export function clearPackCache(): void {
  packCache.clear();
}

/**
 * Solves the sealed region for `seat`. Returns null when the position does not qualify: the region
 * is too large, or the seat has more legal moves than branch-and-bound can settle.
 *
 * `score` is the seat's final Blokus score, so the search can drop it straight into that seat's
 * component of the value vector.
 */
export function solveSealedRegion(
  position: Position,
  seat: number,
  map: TerritoryMap,
  params: EndgameParams,
  blocked?: Mask,
): PackResult | null {
  if (map.reachableCount[seat] > params.maxRegionCells) {
    return null;
  }

  const cacheKey = `${position.key()}|${seat}|${blocked ? 'p' : 'o'}`;
  const cached = packCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const working = position.clone();
  const reach = newMask();
  reach.set(map.reach[seat]);
  if (blocked) {
    for (let w = 0; w < WORDS; w += 1) {
      working.occ[w] |= blocked[w];
      reach[w] &= ~blocked[w];
    }
  }

  working.forceTurn(seat);
  const probe = new Int32Array(params.maxOwnMoves + 1);
  if (working.generateMoves(seat, probe, params.maxOwnMoves + 1) > params.maxOwnMoves) {
    return null;
  }

  const context: SolveContext = {
    seat,
    params,
    nodes: 0,
    exhausted: false,
    memo: new Map(),
    reach,
    lines: [],
    buffers: [],
  };

  solve(context, working, 0);
  const line = context.lines[0] ?? [];
  const squares = squaresOf(line);
  const remainingAfter = position.handSquares[seat] - squares;
  const last = line[line.length - 1];
  const score =
    remainingAfter === 0
      ? ALL_PLACED_BONUS +
        (last !== undefined && PLACEMENTS.pieceId[last] === MONOMINO_PIECE_ID
          ? MONOMINO_LAST_BONUS
          : 0)
      : -remainingAfter;

  const result: PackResult = {
    score,
    squares,
    moves: line,
    proven: !context.exhausted,
    nodes: context.nodes,
  };
  packCache.set(cacheKey, result);
  if (packCache.size > 8192) {
    packCache.clear();
  }
  return result;
}

function squaresOf(line: number[]): number {
  let total = 0;
  for (const move of line) {
    total += PIECE_SIZES[PLACEMENTS.pieceId[move]];
  }
  return total;
}

export interface PackBracket {
  /** Certified lower bound: every cell an opponent can touch next move is conceded. */
  lower: PackResult | null;
  /** Optimistic bound: every contested cell is kept. */
  upper: PackResult | null;
}

const blockerScratch = newMask();

/**
 * §4.3, near-sealed regions: "solve on the pessimistic assumption that all cells reachable by any
 * opponent within one move are lost, giving a certified lower bound that replaces the playout as
 * the leaf value inside MCTS; the optimistic bound (all contested cells kept) brackets it, and the
 * gap is itself a useful measure of how much is at stake in the region."
 */
export function bracketNearSealed(
  position: Position,
  seat: number,
  map: TerritoryMap,
  params: EndgameParams,
  contestRadius = 1,
): PackBracket {
  blockerScratch.fill(0);
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (!testBit(map.reach[seat], cell)) {
      continue;
    }
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other === seat) {
        continue;
      }
      if (map.distance[other * CELL_COUNT + cell] <= contestRadius) {
        blockerScratch[cell >>> 5] |= 1 << (cell & 31);
        break;
      }
    }
  }

  return {
    lower: solveSealedRegion(position, seat, map, params, blockerScratch),
    upper: solveSealedRegion(position, seat, map, params),
  };
}
