/**
 * The composite evaluation E_i of §3.2, used to truncate playouts and to rank root moves.
 *
 *     E_i = a·S_i + b·f(C_i) + c·|T_i| − d·waste_i − Σ_{j≠i} λ_j (e·|T_j| + g·f(C_j))
 *
 * with three additions the report specifies elsewhere: the centre-reachability term of §4.1, the
 * frontier-pressure discount of §3.1, and λ_j as a function of seat relation and standing rather
 * than a constant (§3.2, "λ_j should be a function of j's current standing, not a constant").
 *
 * `f` is the diminishing-returns transform: "Distinct corners in *distinct regions* are more
 * valuable than clustered corners, so use a diminishing-returns transform such as Σ over regions of
 * sqrt(corners in region)."
 */

import { CELL_COUNT, WORDS, intersectsAt, testBit, type Mask } from './bitboard';
import { PLACEMENTS, PIECE_SIZES, smallestRemaining } from './placements';
import type { Position } from './position';
import {
  articulationPoints,
  createRegionMap,
  labelRegions,
  regionOwnership,
  type RegionMap,
  type RegionOwnership,
} from './regions';
import { SEAT_COUNT, seatRelation, BOARD_CENTRE } from './seats';
import {
  computeTerritory,
  createTerritoryMap,
  frontierPressure,
  type TerritoryMap,
} from './territory';
import type { LambdaProfile, PhaseId, BitboardParams } from './config';

export interface EvalContext {
  territory: TerritoryMap;
  regions: RegionMap;
  ownership: RegionOwnership;
  articulation: Uint8Array;
  hasArticulation: boolean;
  /** Per-seat intermediates, kept so the §7 event log can report what the evaluation saw. */
  cornerScore: Float64Array;
  centreScore: Float64Array;
  waste: Float64Array;
  pressure: Float64Array;
  values: Float64Array;
  leader: number;
  /** Mirrors `BitboardParams.fractionalTerritoryTies`; set by whoever owns the params. */
  fractionalTies: boolean;
}

export function createEvalContext(): EvalContext {
  const regions = createRegionMap();
  return {
    territory: createTerritoryMap(),
    regions,
    ownership: {
      count: 0,
      corners: new Int32Array(CELL_COUNT * SEAT_COUNT),
      totalCorners: new Int32Array(CELL_COUNT),
      size: regions.size,
    },
    articulation: new Uint8Array(CELL_COUNT),
    hasArticulation: false,
    cornerScore: new Float64Array(SEAT_COUNT),
    centreScore: new Float64Array(SEAT_COUNT),
    waste: new Float64Array(SEAT_COUNT),
    pressure: new Float64Array(SEAT_COUNT),
    values: new Float64Array(SEAT_COUNT),
    leader: -1,
    fractionalTies: false,
  };
}

/**
 * One board pass shared by every consumer: territory BFS, empty-region labelling, corner ownership
 * per region, and optionally Tarjan. Move ordering asks for articulation points; playout truncation
 * does not, and it is the hot path.
 */
export function refreshContext(
  context: EvalContext,
  position: Position,
  withArticulation = false,
): EvalContext {
  computeTerritory(position, context.territory, context.fractionalTies);
  labelRegions(position.occ, context.regions);
  context.ownership = regionOwnership(
    context.regions,
    context.territory.openCorners,
    context.ownership,
  );
  context.hasArticulation = withArticulation;
  if (withArticulation) {
    articulationPoints(position.occ, context.articulation);
  }

  let leader = -1;
  let best = -Infinity;
  let tie = false;
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const placed = position.placedSquares(seat);
    if (placed > best) {
      best = placed;
      leader = seat;
      tie = false;
    } else if (placed === best) {
      tie = true;
    }
  }
  context.leader = tie ? -1 : leader;
  return context;
}

/**
 * f(C_i): Σ over empty regions of (open corners this seat holds there)^p.
 *
 * The report fixes p = 0.5 so that corners in distinct regions beat clustered ones. The catch is
 * that the board is one region for most of the game, and there f collapses to |C|^p — a concave
 * squash on the feature §3.1 itself calls the most predictive one. p = 1 recovers the plain count
 * and keeps the region-splitting bonus at exactly zero, which is the honest null for the claim.
 */
function cornerScoreFor(context: EvalContext, seat: number, exponent: number): number {
  const { ownership } = context;
  const linear = exponent === 1;
  let total = 0;
  for (let region = 0; region < ownership.count; region += 1) {
    const corners = ownership.corners[region * SEAT_COUNT + seat];
    if (corners > 0) {
      total += linear ? corners : Math.pow(corners, exponent);
    }
  }
  return total;
}

/** §4.1: Σ over open corners of a decreasing function of Manhattan distance to the centre. */
function centreScoreFor(context: EvalContext, seat: number): number {
  const corners = context.territory.openCorners[seat];
  let total = 0;
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (!testBit(corners, cell)) {
      continue;
    }
    const x = cell % 20;
    const y = (cell / 20) | 0;
    const distance = Math.abs(x - BOARD_CENTRE) + Math.abs(y - BOARD_CENTRE);
    total += Math.max(0, 1 - distance / 19);
  }
  return total;
}

/**
 * §3.2: "Penalise the number of empty cells that are unreachable by any piece in R_i (compute by
 * testing whether any orientation of the smallest remaining pieces fits at each cell in own
 * territory)." Corner contact is deliberately not part of the test — reachability is already what
 * T_i measures, and this term is about shape, not access.
 *
 * The monomino case collapses to a single mask test, which is why the fast path exists: while the
 * smallest piece in hand is a pentomino the game is nowhere near the packing phase and the waste
 * weight is ~0 anyway.
 */
function wasteFor(context: EvalContext, position: Position, seat: number): number {
  const smallest = smallestRemaining(position.hand[seat]);
  if (smallest === 0) {
    return 0;
  }
  const owner = context.territory.owner;
  const own = position.own[seat];
  const edge = position.edgeHalo[seat];
  const occ = position.occ;
  let waste = 0;

  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (owner[cell] !== seat) {
      continue;
    }
    if (smallest === 1) {
      if (testBit(edge, cell)) {
        waste += 1;
      }
      continue;
    }
    let fits = false;
    const start = PLACEMENTS.coverStart[cell];
    const end = PLACEMENTS.coverStart[cell + 1];
    for (let i = start; i < end; i += 1) {
      const id = PLACEMENTS.coverList[i];
      if (PLACEMENTS.size[id] !== smallest) {
        continue;
      }
      if ((position.hand[seat] & (1 << PLACEMENTS.pieceId[id])) === 0) {
        continue;
      }
      const offset = id * WORDS;
      if (intersectsAt(occ, PLACEMENTS.cells, offset)) {
        continue;
      }
      if (intersectsAt(own, PLACEMENTS.edgeHalo, offset)) {
        continue;
      }
      fits = true;
      break;
    }
    if (!fits) {
      waste += 1;
    }
  }
  return waste;
}

/**
 * Open corners this seat holds that no opponent also holds. §3.1's frontier pressure at radius
 * zero, and the direct analogue of v11's `uniqueLiberties`.
 */
function uniqueCornersFor(context: EvalContext, seat: number): number {
  const mine = context.territory.openCorners[seat];
  let count = 0;
  for (let w = 0; w < WORDS; w += 1) {
    let word = mine[w];
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other !== seat) {
        word &= ~context.territory.openCorners[other][w];
      }
    }
    count += popcount32(word);
  }
  return count;
}

/**
 * v11's fast-mode stand-in for the legal move count |A_i|: open corners plus twice the pieces still
 * in hand. Cheap, and it is the form that actually earned v11's fitted weight — the exact |A_i|
 * would cost a full move generation per seat per leaf.
 */
function mobilityFor(context: EvalContext, position: Position, seat: number): number {
  let corners = 0;
  const mine = context.territory.openCorners[seat];
  for (let w = 0; w < WORDS; w += 1) {
    corners += popcount32(mine[w]);
  }
  let pieces = 0;
  let bits = position.hand[seat];
  while (bits !== 0) {
    bits &= bits - 1;
    pieces += 1;
  }
  return corners + 2 * pieces;
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0xff;
}

/**
 * λ_j as seen by seat `from`: relation to the mover, scaled by seat aggression, the global
 * `aggressionScale` dial, and standing.
 */
export function lambdaFor(
  params: BitboardParams,
  profile: LambdaProfile,
  from: number,
  to: number,
  leader: number,
): number {
  const relation = seatRelation(from, to);
  let lambda: number;
  switch (relation) {
    case 'next':
      lambda = profile.next;
      break;
    case 'prev':
      lambda = profile.prev;
      break;
    case 'diag':
      lambda = profile.diag;
      break;
    default:
      return 0;
  }
  if (to === leader) {
    lambda += profile.leaderBoost;
  }
  return lambda * params.seats[from].aggression * params.aggressionScale;
}

/**
 * E_i for every seat, in one vector.
 *
 * The phase is a property of the position rather than of the seat: every component has to live on
 * one scale for the margin backup in `backup.ts` to mean anything, and a per-seat phase would put
 * two seats' evaluations in different units. Seat identity still enters through `params.seats`.
 */
export function evaluate(
  context: EvalContext,
  position: Position,
  params: BitboardParams,
  phase: PhaseId,
): Float64Array {
  const weights = params.phases[phase];
  const lambdaProfile = params.lambda[phase];

  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    context.cornerScore[seat] = cornerScoreFor(context, seat, weights.cornerExponent);
    context.centreScore[seat] = weights.centre !== 0 ? centreScoreFor(context, seat) : 0;
    context.waste[seat] = weights.waste !== 0 ? wasteFor(context, position, seat) : 0;
    context.pressure[seat] =
      weights.frontier !== 0 ? frontierPressure(context.territory, seat) : 0;
  }

  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const profile = params.seats[seat];
    let value =
      weights.squares * position.placedSquares(seat) +
      weights.corners * profile.corners * context.cornerScore[seat] +
      weights.territory * profile.territory * context.territory.territory[seat] +
      weights.centre * profile.centre * context.centreScore[seat] -
      weights.waste * profile.waste * context.waste[seat] -
      weights.frontier * context.pressure[seat];

    // The two features §3.1 names and §3.2's formula drops. Both default to weight 0, so a config
    // that leaves them there evaluates exactly as the report specifies.
    if (weights.mobility !== 0) {
      value += weights.mobility * mobilityFor(context, position, seat);
    }
    if (weights.uniqueCorners !== 0) {
      value += weights.uniqueCorners * profile.corners * uniqueCornersFor(context, seat);
    }

    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other === seat) {
        continue;
      }
      const lambda = lambdaFor(params, lambdaProfile, seat, other, context.leader);
      if (lambda === 0) {
        continue;
      }
      value -=
        lambda *
        (weights.oppTerritory * context.territory.territory[other] +
          weights.oppCorners * context.cornerScore[other] +
          // Not in the report's E_i, which weighs opponents by space alone. Blokus is scored in
          // squares, so without this term the agent cannot see a rival out-placing it.
          weights.oppSquares * position.placedSquares(other));
    }
    context.values[seat] = value;
  }

  return context.values;
}

/**
 * §4: "Phase can be detected from the ply number, the fraction of the board that is still
 * contestable and the number of disconnected empty regions." Own move count is the primary signal
 * because the report defines the phases by it; a board that has already decomposed jumps straight
 * to the endgame weights regardless of how many pieces are left.
 */
export function detectPhase(
  position: Position,
  context: EvalContext,
  params: BitboardParams,
  seat: number,
): PhaseId {
  const played = 21 - handSize(position.hand[seat]);
  const empty = CELL_COUNT - popcountMask(position.occ);
  const contestedShare = empty > 0 ? context.territory.contested / empty : 0;

  if (contestedShare < params.detection.contestedFloor && played >= params.detection.openingMoves) {
    return 'endgame';
  }
  if (played < params.detection.openingMoves) {
    return 'opening';
  }
  if (played < params.detection.midgameMoves) {
    return 'midgame';
  }
  return 'endgame';
}

function handSize(mask: number): number {
  let count = 0;
  let bits = mask;
  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
}

function popcountMask(mask: Mask): number {
  let total = 0;
  for (let w = 0; w < WORDS; w += 1) {
    let v = mask[w];
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    v = (v + (v >>> 4)) & 0x0f0f0f0f;
    total += (Math.imul(v, 0x01010101) >>> 24) & 0xff;
  }
  return total;
}

export { PIECE_SIZES };
