/**
 * Move ordering and the PUCT prior (§3.2, §6).
 *
 * Two tiers, because the report asks for two different things in two different places:
 *
 *   `scoreMoves`  — bitboard-only. Piece size, corners created, opponent corners denied, pull
 *                   toward the centre, and (for cut moves only) Δsplit. A few word-loops per move,
 *                   so it can run at every node and inside the ε-greedy playout policy.
 *   `deepScore`   — applies the move and runs the full E_i evaluation. Only the root shortlist can
 *                   afford it; that is where "Δ own(m) + λ Δ harm(m)" is computed literally.
 *
 * Δsplit is the term that earns its keep. A cut move often places a small piece and would never
 * survive the shortlist on size alone, so without an explicit split score the search never looks at
 * the single most consequential spatial event in the game.
 */

import {
  WORDS,
  intersectsAt,
  newMask,
  popcountAndAt,
  type Mask,
} from './bitboard';
import { PLACEMENTS } from './placements';
import type { Position } from './position';
import {
  createRegionMap,
  labelRegions,
  ownShare,
  regionOwnership,
  type RegionMap,
  type RegionOwnership,
} from './regions';
import { SEAT_COUNT } from './seats';
import { evaluate, lambdaFor, refreshContext, type EvalContext } from './features';
import type { PhaseId, BitboardParams } from './config';
import { CELL_COUNT } from './bitboard';

export interface OrderingOptions {
  /** Compute Δsplit for moves that cover an articulation point. Costs one relabelling each. */
  withSplit: boolean;
  /** Cap on how many Δsplit relabellings one call may run, so a wide node cannot stall. */
  splitBudget: number;
}

export const DEFAULT_ORDERING_OPTIONS: OrderingOptions = { withSplit: false, splitBudget: 0 };

/**
 * Progressive history (Nijssen & Winands): a move that has been good elsewhere in the tree is
 * tried sooner here. Keyed by (seat, placement) because the same placement means very different
 * things to different colours.
 */
export class HistoryTable {
  private sum: Float32Array;
  private count: Int32Array;

  constructor() {
    this.sum = new Float32Array(PLACEMENTS.count * SEAT_COUNT);
    this.count = new Int32Array(PLACEMENTS.count * SEAT_COUNT);
  }

  update(seat: number, move: number, value: number): void {
    const index = move * SEAT_COUNT + seat;
    this.sum[index] += value;
    this.count[index] += 1;
  }

  score(seat: number, move: number): number {
    const index = move * SEAT_COUNT + seat;
    const visits = this.count[index];
    return visits === 0 ? 0 : this.sum[index] / visits;
  }

  clear(): void {
    this.sum.fill(0);
    this.count.fill(0);
  }
}

export class MoveOrderer {
  private afterOcc: Mask = newMask();
  private afterCorners: Mask[] = [newMask(), newMask(), newMask(), newMask()];
  private afterRegions: RegionMap = createRegionMap();
  private afterOwnership: RegionOwnership = {
    count: 0,
    corners: new Int32Array(CELL_COUNT * SEAT_COUNT),
    totalCorners: new Int32Array(CELL_COUNT),
    size: new Int32Array(CELL_COUNT),
  };
  private params: BitboardParams;

  constructor(params: BitboardParams) {
    this.params = params;
  }

  setParams(params: BitboardParams): void {
    this.params = params;
  }

  /**
   * Heuristic score per move, written into `out`. Higher is better; the caller turns these into a
   * softmax prior.
   */
  scoreMoves(
    position: Position,
    context: EvalContext,
    seat: number,
    moves: Int32Array,
    count: number,
    out: Float64Array,
    phase: PhaseId,
    options: OrderingOptions = DEFAULT_ORDERING_OPTIONS,
  ): void {
    const weights = this.params.ordering[phase];
    const lambdaProfile = this.params.lambda[phase];
    const occ = position.occ;
    const ownEdge = position.edgeHalo[seat];

    const lambdas = new Float64Array(SEAT_COUNT);
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      lambdas[other] =
        other === seat
          ? 0
          : lambdaFor(this.params, lambdaProfile, seat, other, context.leader);
    }

    let splitBudget = options.withSplit ? options.splitBudget : 0;
    const baseline = splitBudget > 0 ? this.regionValue(context, seat, lambdas) : 0;

    for (let i = 0; i < count; i += 1) {
      const move = moves[i];
      const offset = move * WORDS;
      let score = PLACEMENTS.size[move] * weights.pieceSize;
      score -= PLACEMENTS.centreDistance[move] * weights.centrePull;

      // Corners this placement opens: diagonal neighbours that stay empty and are not knocked out
      // by the placement's own edge halo.
      let created = 0;
      for (let w = 0; w < WORDS; w += 1) {
        const word =
          PLACEMENTS.cornerHalo[offset + w] &
          ~occ[w] &
          ~PLACEMENTS.cells[offset + w] &
          ~ownEdge[w] &
          ~PLACEMENTS.edgeHalo[offset + w];
        created += popcount32(word);
      }
      score += created * weights.newCorners;

      // Corners it takes away, weighted by how much this seat cares about that opponent.
      for (let other = 0; other < SEAT_COUNT; other += 1) {
        if (lambdas[other] === 0) {
          continue;
        }
        const denied = popcountAndAt(context.territory.openCorners[other], PLACEMENTS.cells, offset);
        if (denied !== 0) {
          score += denied * weights.denyCorners * lambdas[other];
        }
      }

      if (splitBudget > 0 && this.touchesArticulation(context, move)) {
        splitBudget -= 1;
        score += weights.split * this.splitDelta(position, seat, move, lambdas, baseline);
      }

      out[i] = score;
    }
  }

  private touchesArticulation(context: EvalContext, move: number): boolean {
    if (!context.hasArticulation) {
      return false;
    }
    for (let i = PLACEMENTS.cellStart[move]; i < PLACEMENTS.cellStart[move + 1]; i += 1) {
      if (context.articulation[PLACEMENTS.cellList[i]] === 1) {
        return true;
      }
    }
    return false;
  }

  /** Σ_regions [ own_share_i(r) − Σ_{j≠i} λ_j · own_share_j(r) ] over a labelled empty space. */
  private regionValue(context: EvalContext, seat: number, lambdas: Float64Array): number {
    const ownership = context.ownership;
    let total = 0;
    for (let region = 0; region < ownership.count; region += 1) {
      total += ownShare(ownership, region, seat);
      for (let other = 0; other < SEAT_COUNT; other += 1) {
        if (lambdas[other] !== 0) {
          total -= lambdas[other] * ownShare(ownership, region, other);
        }
      }
    }
    return total;
  }

  /**
   * Δsplit_i(m) from §3.1: the value of the regions the move produces, minus the value of the
   * region structure it replaced. Positive when the cut seals space only this seat can use,
   * sharply negative when it seals this seat out.
   */
  private splitDelta(
    position: Position,
    seat: number,
    move: number,
    lambdas: Float64Array,
    baseline: number,
  ): number {
    const offset = move * WORDS;
    for (let w = 0; w < WORDS; w += 1) {
      this.afterOcc[w] = position.occ[w] | PLACEMENTS.cells[offset + w];
    }
    labelRegions(this.afterOcc, this.afterRegions);

    for (let other = 0; other < SEAT_COUNT; other += 1) {
      const corner = position.cornerHalo[other];
      const edge = position.edgeHalo[other];
      const dst = this.afterCorners[other];
      if (other === seat) {
        for (let w = 0; w < WORDS; w += 1) {
          const grownCorner = corner[w] | PLACEMENTS.cornerHalo[offset + w];
          const grownEdge = edge[w] | PLACEMENTS.edgeHalo[offset + w];
          dst[w] = grownCorner & ~this.afterOcc[w] & ~grownEdge;
        }
      } else {
        for (let w = 0; w < WORDS; w += 1) {
          dst[w] = corner[w] & ~this.afterOcc[w] & ~edge[w];
        }
      }
    }

    this.afterOwnership.size = this.afterRegions.size;
    const ownership = regionOwnership(
      this.afterRegions,
      this.afterCorners,
      this.afterOwnership,
    );

    let after = 0;
    for (let region = 0; region < ownership.count; region += 1) {
      after += ownShare(ownership, region, seat);
      for (let other = 0; other < SEAT_COUNT; other += 1) {
        if (lambdas[other] !== 0) {
          after -= lambdas[other] * ownShare(ownership, region, other);
        }
      }
    }
    return after - baseline;
  }

  /**
   * "V_i(m) = Δ own(m) + Σ_{j≠i} λ_j · Δ harm_j(m)" evaluated literally: apply the move, re-run the
   * full evaluation, and take the change in this seat's component. λ is already inside E_i, so the
   * difference of the composite is exactly the report's V_i.
   */
  deepScore(
    position: Position,
    scratchContext: EvalContext,
    seat: number,
    move: number,
    phase: PhaseId,
    before: number,
  ): number {
    const undo = position.apply(move);
    refreshContext(scratchContext, position, false);
    const after = evaluate(scratchContext, position, this.params, phase)[seat];
    position.undo(undo);
    return after - before;
  }
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0xff;
}

/** Softmax of ordering scores — AlphaZero's P(a) with the heuristic standing in for a policy net. */
export function softmaxPriors(
  scores: Float64Array,
  count: number,
  temperature: number,
  out: Float64Array,
): void {
  if (count === 0) {
    return;
  }
  let max = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (scores[i] > max) {
      max = scores[i];
    }
  }
  const temp = Math.max(1e-6, temperature);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const value = Math.exp((scores[i] - max) / temp);
    out[i] = value;
    total += value;
  }
  const norm = total > 0 ? total : 1;
  for (let i = 0; i < count; i += 1) {
    out[i] /= norm;
  }
}

/** Descending sort of `moves[0…count)` by `scores`, keeping the two arrays in step. */
export function sortByScore(moves: Int32Array, scores: Float64Array, count: number): void {
  const order = Array.from({ length: count }, (_, i) => i);
  order.sort((a, b) => scores[b] - scores[a] || moves[a] - moves[b]);
  const movesCopy = moves.slice(0, count);
  const scoresCopy = scores.slice(0, count);
  for (let i = 0; i < count; i += 1) {
    moves[i] = movesCopy[order[i]];
    scores[i] = scoresCopy[order[i]];
  }
}

export { intersectsAt };
