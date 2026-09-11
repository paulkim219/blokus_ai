/**
 * Rebuilds the root shortlist exactly as `BitboardSearch.initialise` does.
 *
 * The root decision passes through two hand filters before any learned model is consulted:
 *
 *   tier 0 — an O(1) score per legal move (piece size and centre pull only) cuts hundreds of moves
 *            to `max(rootShortlist * 2, 96)`;
 *   tier 1 — `MoveOrderer.scoreMoves`, including Δsplit for cut moves, sorts those and truncates to
 *            `rootShortlist` (40).
 *
 * A learned prior reranks the survivors of both and cannot recover anything either discarded, so the
 * rank of a strong move in these two orders is a hard ceiling on the whole reranking programme.
 */

import type { GameState, PlayerColor } from '../../src/engine/types.ts';
import { bitboardParamsFor, getAlgo, type AlgoVersionId } from '../../src/ai/algoVersions.ts';
import { seatOf, toPosition } from '../../src/ai/bitboard/index.ts';
import { MoveOrderer, sortByScore } from '../../src/ai/bitboard/ordering.ts';
import { createEvalContext, detectPhase, refreshContext } from '../../src/ai/bitboard/features.ts';
import { PLACEMENTS } from '../../src/ai/bitboard/placements.ts';
import { newMoveBuffer } from '../../src/ai/bitboard/position.ts';

export interface FunnelOrder {
  /** Every legal move, in tier-0 order. */
  tier0: number[];
  /** The tier-0 survivors, in tier-1 order. */
  tier1: number[];
  funnel: number;
  shortlist: number;
  legal: number;
}

export function shortlistOrder(
  state: GameState,
  player: PlayerColor,
  version: AlgoVersionId,
): FunnelOrder {
  const params = bitboardParamsFor(getAlgo(version));
  const position = toPosition(state);
  const seat = seatOf(player);
  if (position.turn !== seat) {
    position.forceTurn(seat);
  }

  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  // `withSplit` is true at the root, and Δsplit needs the articulation map.
  refreshContext(context, position, true);
  const phase = detectPhase(position, context, params, seat);

  const buffer = newMoveBuffer();
  const legal = position.generateMoves(seat, buffer);
  if (legal === 0) {
    return { tier0: [], tier1: [], funnel: 0, shortlist: 0, legal: 0 };
  }

  const ordering = params.ordering[phase];
  const tier0 = Array.from({ length: legal }, (_, i) => buffer[i])
    .map((move) => ({
      move,
      score:
        PLACEMENTS.size[move] * ordering.pieceSize -
        PLACEMENTS.centreDistance[move] * ordering.centrePull,
    }))
    .sort((a, b) => b.score - a.score);

  const funnel = Math.max(params.search.rootShortlist * 2, 96);
  const kept = Math.min(funnel, tier0.length);
  const moves = new Int32Array(kept);
  const scores = new Float64Array(kept);
  for (let i = 0; i < kept; i += 1) {
    moves[i] = tier0[i].move;
  }

  const orderer = new MoveOrderer(params);
  orderer.scoreMoves(position, context, seat, moves, kept, scores, phase, {
    withSplit: true,
    splitBudget: 24,
  });
  sortByScore(moves, scores, kept);

  return {
    tier0: tier0.map((entry) => entry.move),
    tier1: Array.from(moves.subarray(0, kept)),
    funnel,
    shortlist: Math.min(kept, params.search.rootShortlist),
    legal,
  };
}
