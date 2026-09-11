/**
 * Topological event serialisation for §7's Tier 2 and its note on LLM judges.
 *
 * "Current language models are weak at reasoning directly over a 20×20 spatial state, so the judge
 * should never see raw board strings. Serialise each game as a chronological sequence of
 * engine-computed topological events, for example: 'Turn 14: Blue plays W-pentomino on an
 * articulation point of the central region, splitting it into regions of 22 and 14 cells; Blue
 * holds 3 corners in the 22-cell region, Red 1, no one in the 14-cell region; oracle loss for this
 * move 0.4 squares; best alternative was a non-splitting extension.'"
 *
 * Everything in a `MoveEvent` is computed by the Voronoi BFS, Tarjan, and the oracle — the judge is
 * confined to classifying events it did not have to perceive.
 */

import type { GameState, PlaceMove } from '../../engine/types';
import { PIECES } from '../../engine/pieces';
import { placementFor, seatOf, toPosition } from './adapter';
import { WORDS, popcountAndAt } from './bitboard';
import { PLACEMENTS } from './placements';
import { articulationPoints, labelRegions, createRegionMap, regionOwnership } from './regions';
import { SEAT_COLORS, SEAT_COUNT } from './seats';
import { computeTerritory, isSealed } from './territory';
import { createEvalContext, detectPhase, refreshContext } from './features';
import { DEFAULT_BITBOARD_PARAMS, type PhaseId, type BitboardParams } from './config';

export interface RegionSummary {
  cells: number;
  /** Open corners per seat inside the region, indexed by seat (turn order). */
  corners: number[];
}

export interface MoveEvent {
  ply: number;
  seat: number;
  color: string;
  piece: string;
  phase: PhaseId;
  /** True when the placement covers an articulation point of the empty-cell graph. */
  cutsArticulation: boolean;
  /** True when at least one such move existed, whether or not it was played. */
  cutAvailable: boolean;
  /** Opponent open corners the placement covers. */
  deniedCorners: number;
  /** Regions before and after the move, largest first. */
  regionsBefore: RegionSummary[];
  regionsAfter: RegionSummary[];
  territoryBefore: number[];
  territoryAfter: number[];
  sealedSeats: number[];
  /** Filled in by the oracle pass; in squares. */
  oracleLoss?: number;
  bestAlternative?: string;
}

const context = createEvalContext();
const regionScratch = createRegionMap();
const articulationScratch = new Uint8Array(400);

function summariseRegions(state: GameState): RegionSummary[] {
  const position = toPosition(state);
  const regions = labelRegions(position.occ, regionScratch);
  const territory = computeTerritory(position);
  const ownership = regionOwnership(regions, territory.openCorners);
  const summaries: RegionSummary[] = [];
  for (let region = 0; region < regions.count; region += 1) {
    const corners: number[] = [];
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      corners.push(ownership.corners[region * SEAT_COUNT + seat]);
    }
    summaries.push({ cells: regions.size[region], corners });
  }
  summaries.sort((a, b) => b.cells - a.cells);
  return summaries;
}

/**
 * Describes one played move in terms of what it did to the structure of the empty space.
 * `after` is the state the move produced; passing it in avoids re-applying the move here.
 */
export function describeMove(
  before: GameState,
  after: GameState,
  move: PlaceMove,
  ply: number,
  params: BitboardParams = DEFAULT_BITBOARD_PARAMS,
): MoveEvent {
  const position = toPosition(before);
  const seat = seatOf(move.color);
  refreshContext(context, position, false);
  const phase = detectPhase(position, context, params, seat);

  articulationPoints(position.occ, articulationScratch);
  const id = placementFor(move);
  let cuts = false;
  if (id >= 0) {
    for (let i = PLACEMENTS.cellStart[id]; i < PLACEMENTS.cellStart[id + 1]; i += 1) {
      if (articulationScratch[PLACEMENTS.cellList[i]] === 1) {
        cuts = true;
        break;
      }
    }
  }

  let denied = 0;
  if (id >= 0) {
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other !== seat) {
        denied += popcountAndAt(
          context.territory.openCorners[other],
          PLACEMENTS.cells,
          id * WORDS,
        );
      }
    }
  }

  const buffer = new Int32Array(8192);
  const count = position.generateMoves(seat, buffer);
  let cutAvailable = false;
  for (let i = 0; i < count && !cutAvailable; i += 1) {
    const candidate = buffer[i];
    for (let j = PLACEMENTS.cellStart[candidate]; j < PLACEMENTS.cellStart[candidate + 1]; j += 1) {
      if (articulationScratch[PLACEMENTS.cellList[j]] === 1) {
        cutAvailable = true;
        break;
      }
    }
  }

  const afterPosition = toPosition(after);
  const afterTerritory = computeTerritory(afterPosition);
  const sealed: number[] = [];
  for (let s = 0; s < SEAT_COUNT; s += 1) {
    if (afterPosition.hand[s] !== 0 && isSealed(afterTerritory, s)) {
      sealed.push(s);
    }
  }

  return {
    ply,
    seat,
    color: move.color,
    piece: PIECES[move.pieceId].name,
    phase,
    cutsArticulation: cuts,
    cutAvailable,
    deniedCorners: denied,
    regionsBefore: summariseRegions(before),
    regionsAfter: summariseRegions(after),
    territoryBefore: [...context.territory.territory],
    territoryAfter: [...afterTerritory.territory],
    sealedSeats: sealed,
  };
}

function describeRegions(regions: RegionSummary[], limit = 3): string {
  return regions
    .slice(0, limit)
    .map((region) => {
      const holders = region.corners
        .map((count, seat) => (count > 0 ? `${SEAT_COLORS[seat]} ${count}` : null))
        .filter((entry): entry is string => entry !== null);
      return `${region.cells} cells (${holders.length > 0 ? holders.join(', ') : 'no corners'})`;
    })
    .join('; ');
}

/** One line per move, in the shape §7 asks the judge to read. */
export function formatEvent(event: MoveEvent): string {
  const parts = [
    `Ply ${event.ply}: ${event.color} plays ${event.piece} (${event.phase})`,
  ];
  if (event.cutsArticulation) {
    parts.push(
      `on an articulation point, leaving regions ${describeRegions(event.regionsAfter)}`,
    );
  } else if (event.cutAvailable) {
    parts.push('extending, though a region-splitting move was available');
  } else {
    parts.push('extending');
  }
  if (event.deniedCorners > 0) {
    parts.push(`covering ${event.deniedCorners} opponent corner(s)`);
  }
  parts.push(
    `territory ${event.territoryBefore.join('/')} → ${event.territoryAfter.join('/')} (${SEAT_COLORS.join('/')})`,
  );
  if (event.sealedSeats.length > 0) {
    parts.push(`sealed: ${event.sealedSeats.map((seat) => SEAT_COLORS[seat]).join(', ')}`);
  }
  if (event.oracleLoss !== undefined) {
    parts.push(`oracle loss ${event.oracleLoss.toFixed(2)} squares`);
  }
  if (event.bestAlternative) {
    parts.push(`best alternative ${event.bestAlternative}`);
  }
  return `${parts.join('; ')}.`;
}
