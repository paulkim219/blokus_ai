/**
 * v3.5 — committee arbitration at the root.
 *
 * One engine searches, exactly as it does today. Where its top root children are separated by less
 * than a visit-share band, a set of *free* one-ply arbiters re-ranks that contested subset and the
 * combined ranking decides the move.
 *
 *     root children by visits:  A 412 | B 398 | C 151 | ...
 *                               ^^^^^^^^^^^^^ share gap < band -> contested {A, B}
 *     arbiters score {A, B} at one ply, ranks are combined, the winner is played.
 *
 * **Why this is not another reallocation of the same information.** The measured nulls in this repo
 * are all tree-policy changes — selection rule, widening, transpositions, shortlists, exploration
 * constant — which redistribute evidence one evaluation already produced. This adds a *second,
 * independently fitted* evaluation to the decision. `v3`'s `E_i` and `v2`'s fitted evaluation
 * disagree in a structured way: `E_i` is the better global predictor (Spearman 0.494 vs 0.444) while
 * `v2`'s retains +0.065 incremental signal over it, concentrated in the opening and the endgame.
 *
 * **Why the members are free.** The compute ladder is measured: ~700 iterations to ~1380 is worth
 * +3.04. A committee that splits the budget between two full searches is three points down before it
 * starts. One-ply arbiters over at most `maxArbitrated` moves cost well under 1% of a pro-max move,
 * so any gain is a net gain.
 *
 * **`band: 0` is inert.** No contested set is ever formed, no arbiter is ever called, and the
 * primary's move is returned untouched — so a committee config with `band: 0` must play byte-identical
 * games to its primary, which is what `npm run match --challenger v3.5-balanced --champion
 * v3.1-pro-max` checks by printing exactly 0.00.
 */

import type { GameState, PlaceMove, PlayerColor } from '../engine/types';
import { bitboardParamsFor, getAlgo, type AlgoVersionId } from './algoVersions';
import { scoreMovesV12 } from './bitboard';
import { evaluateMovePrior } from './heuristics';
import type { ProgressCallback } from './progress';
import type { RankedMove, SearchResult } from './searchTypes';

export interface CommitteeMember {
  /** Any registered version. Its own `engine` decides how it scores a move at one ply. */
  version: AlgoVersionId;
  /** Relative weight in the rank combination. */
  weight: number;
}

export interface CommitteeParams {
  /** The engine that actually searches. Its budget is untouched. */
  primary: AlgoVersionId;
  /** Free one-ply scorers consulted only on the contested set. */
  arbiters: CommitteeMember[];
  /**
   * Visit-share gap below which a child counts as tied with the leader.
   *
   * `0` disables arbitration entirely and is the default, so the mechanism ships inert and every
   * measurement of it is a single axis.
   */
  band: number;
  /** Hard cap on the contested set, so the arbiters' cost stays bounded and predictable. */
  maxArbitrated: number;
  /** How the members' rankings are pooled. */
  combine: CombineRule;
  /** The primary's own weight in that pool. */
  primaryWeight: number;
  /**
   * Optional inclusive own-move-index ranges where arbitration is active. `null` means every move.
   * This permits evaluator selection by phase without running a second search tree.
   */
  ownMoveRanges: Array<readonly [number, number]> | null;
}

export type CombineRule = 'borda' | 'geomMean';

export const DEFAULT_COMMITTEE: CommitteeParams = {
  primary: 'v3.1-pro-max',
  arbiters: [],
  band: 0,
  maxArbitrated: 4,
  combine: 'borda',
  primaryWeight: 1,
  ownMoveRanges: null,
};

export function committeeActiveAtOwnMove(params: CommitteeParams, ownMove: number): boolean {
  return (
    params.ownMoveRanges === null ||
    params.ownMoveRanges.some(([from, to]) => ownMove >= from && ownMove <= to)
  );
}

/**
 * Which root children are close enough to the leader to be worth arbitrating.
 *
 * Shares are taken over the *whole* root visit total rather than over the top two, so the band means
 * the same thing whatever the branching factor. Returns fewer than two entries when the decision is
 * not contested, which is the caller's signal to leave the primary alone.
 */
export function contestedSet(ranked: readonly RankedMove[], params: CommitteeParams): number[] {
  if (params.band <= 0 || ranked.length < 2) {
    return [];
  }
  let total = 0;
  for (const entry of ranked) {
    total += entry.visits;
  }
  if (total <= 0) {
    return [];
  }
  const leader = ranked[0].visits / total;
  const indices: number[] = [];
  for (let i = 0; i < ranked.length && indices.length < params.maxArbitrated; i += 1) {
    if (leader - ranked[i].visits / total <= params.band) {
      indices.push(i);
    } else {
      // `ranked` is sorted by visits, so the first miss ends the set.
      break;
    }
  }
  return indices.length >= 2 ? indices : [];
}

/**
 * One member's opinion, as a rank vector over the contested set: 0 is that member's favourite.
 *
 * Ranks rather than values, because the members live on incomparable scales — `E_i` units, v2's
 * fitted units, the network's squashed margin — and normalising them against each other would be a
 * calibration claim nothing here supports. Ranking is the only combination that needs no such claim.
 */
function ranksOf(scores: readonly number[]): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  const ranks = new Array<number>(scores.length);
  order.forEach((index, rank) => {
    ranks[index] = rank;
  });
  return ranks;
}

function scoreAtOnePly(
  state: GameState,
  rootPlayer: PlayerColor,
  version: AlgoVersionId,
  moves: readonly PlaceMove[],
): number[] {
  const config = getAlgo(version);
  if (config.engine === 'bitboard') {
    return scoreMovesV12(state, rootPlayer, bitboardParamsFor(config), moves);
  }
  // The legacy line's one-ply score, including its phase piece bonus. `fast` keeps it to the
  // BFS-based features the search itself uses.
  return moves.map((move) => evaluateMovePrior(state, move, true, version));
}

/**
 * Pool the members' rankings and return the index of the winner within the contested set.
 *
 * `borda` sums weighted ranks: a move every member likes wins even if no member ranks it first.
 * `geomMean` sums weighted logs of a rank-derived score, which punishes a single bad opinion much
 * harder — the "they must *all* agree" rule. Both are total orders; ties fall back to the primary's
 * visit order, which is the order `indices` already carries.
 */
export function combineRanks(
  memberRanks: readonly number[][],
  weights: readonly number[],
  rule: CombineRule,
): number {
  const size = memberRanks[0]?.length ?? 0;
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < size; candidate += 1) {
    let score = 0;
    for (let member = 0; member < memberRanks.length; member += 1) {
      const rank = memberRanks[member][candidate];
      score +=
        rule === 'borda'
          ? weights[member] * rank
          : // −log of a strictly positive rank score, so one last-place opinion dominates the sum.
            weights[member] * -Math.log((size - rank) / size);
    }
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * Apply the committee to a primary's finished search result.
 *
 * Only the *order* of `rankedMoves` changes. Values are left exactly as the primary reported them,
 * because `SearchResult.value` is contractually in squares and `quality.ts`'s blunder thresholds are
 * calibrated in that unit — restating them in committee units would silently recalibrate the
 * coaching UI.
 */
export function arbitrate(
  state: GameState,
  rootPlayer: PlayerColor,
  result: SearchResult,
  params: CommitteeParams,
): SearchResult {
  const ownMove = 21 - state.remainingPieces[rootPlayer].length;
  if (!committeeActiveAtOwnMove(params, ownMove)) {
    return result;
  }
  const indices = contestedSet(result.rankedMoves, params);
  if (indices.length < 2) {
    return result;
  }

  const moves = indices.map((i) => result.rankedMoves[i].move);
  const memberRanks: number[][] = [
    // The primary votes with the ordering it already produced: visits, which is the statistic
    // AlphaZero-style work treats as the better target than a ranking of noisy Q estimates.
    ranksOf(indices.map((_, i) => -i)),
  ];
  const weights: number[] = [params.primaryWeight];

  for (const arbiter of params.arbiters) {
    if (arbiter.weight === 0) {
      continue;
    }
    memberRanks.push(ranksOf(scoreAtOnePly(state, rootPlayer, arbiter.version, moves)));
    weights.push(arbiter.weight);
  }
  if (memberRanks.length < 2) {
    return result;
  }

  const winner = combineRanks(memberRanks, weights, params.combine);
  if (winner === 0) {
    return result;
  }

  const chosen = result.rankedMoves[indices[winner]];
  const rest = result.rankedMoves.filter((entry) => entry !== chosen);
  return { ...result, bestMove: chosen.move, rankedMoves: [chosen, ...rest] };
}

/**
 * The committee's `searchBestMove`. Runs the primary at its own full budget, then arbitrates.
 *
 * Imported lazily to keep the module graph acyclic: `mcts.ts` dispatches into here, and the primary
 * search lives in `mcts.ts`.
 */
export async function searchBestMoveCommittee(
  state: GameState,
  rootPlayer: PlayerColor,
  timeLimitMs: number,
  params: CommitteeParams,
  onProgress: ProgressCallback | undefined,
  options: { iterationBudget?: number },
): Promise<SearchResult> {
  const { searchBestMove } = await import('./mcts');
  const result = await searchBestMove(state, rootPlayer, timeLimitMs, onProgress, {
    version: params.primary,
    iterationBudget: options.iterationBudget,
  });
  if (!result.bestMove) {
    return result;
  }
  return arbitrate(state, rootPlayer, result, params);
}

/**
 * The committee at the one-ply policy.
 *
 * Here the primary is itself a one-ply evaluator, so the committee reduces to a weighted rank
 * combination with no tree and no budget question — which makes the core hypothesis testable at 400
 * seeds in minutes, before any search-level run is paid for. Every candidate is contested, since
 * there are no visit counts to separate them.
 */
export async function rankMovesGreedyCommittee(
  state: GameState,
  rootPlayer: PlayerColor,
  params: CommitteeParams,
  candidateMoves?: PlaceMove[],
): Promise<SearchResult> {
  const { rankMovesGreedy } = await import('./mcts');
  const result = await rankMovesGreedy(
    state,
    rootPlayer,
    undefined,
    800,
    candidateMoves,
    undefined,
    params.primary,
  );
  if (!result.bestMove || params.band <= 0) {
    return result;
  }
  // A one-ply primary has no visit counts, so `contestedSet` cannot separate anything: arbitrate the
  // primary's own top `maxArbitrated` instead.
  const flat = result.rankedMoves.slice(0, Math.max(2, params.maxArbitrated));
  const arbitrated = arbitrate(
    state,
    rootPlayer,
    { ...result, rankedMoves: flat.map((entry) => ({ ...entry, visits: 1 })) },
    { ...params, band: 1 },
  );
  if (arbitrated.bestMove === result.bestMove) {
    return result;
  }
  const chosen = result.rankedMoves.find((entry) => entry.move === arbitrated.bestMove)!;
  const rest = result.rankedMoves.filter((entry) => entry !== chosen);
  return { ...result, bestMove: chosen.move, rankedMoves: [chosen, ...rest] };
}
