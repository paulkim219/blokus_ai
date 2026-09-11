/**
 * Reachable territory and the Voronoi partition of §3.1.
 *
 * "Compute, for each player, a multi-source shortest-path map d_i(c) from that player's open
 * corners over empty cells, where a step is allowed diagonally through empty cells and
 * orthogonally through empty cells that are not edge-adjacent to that player's own colour (a cheap
 * approximation to piece geometry). Then define the Voronoi territory
 *
 *     T_i = { c empty : d_i(c) < d_j(c) for all j ≠ i, with ties awarded by turn order to the
 *             player who moves first }."
 *
 * The tie-break is not decoration. It is where the first-mover advantage of §5 enters the
 * evaluation as a fact about the position rather than as a hand-tuned seat bonus, so it lives here
 * and not in the weight vector.
 */

import {
  BOARD_SIZE,
  CELL_COUNT,
  WORDS,
  newMask,
  popcount,
  setBit,
  testBit,
  toIndices,
  type Mask,
} from './bitboard';
import type { Position } from './position';
import { HOME_CORNER, SEAT_COUNT, pliesUntil } from './seats';

const UNREACHED = 32000;

export interface TerritoryMap {
  /** `seat * CELL_COUNT + cell` → BFS steps, or UNREACHED. */
  distance: Int16Array;
  /** Winning seat per empty cell, or -1 if no one can reach it. */
  owner: Int8Array;
  /**
   * |T_i| — cells credited to this seat. Winner-take-all after the tempo tie-break by default;
   * fractional (1/k among the k tied seats) when `fractionalTies` is set. Float because of the
   * latter.
   */
  territory: Float64Array;
  /** Cells this seat can reach at all. */
  reachableCount: Int32Array;
  /** Cells where two or more seats tied and the tie-break decided. Diagnostic for §7 logging. */
  contested: number;
  /** Reach as a bitboard per seat — what the endgame packer and sealed-region test consume. */
  reach: Mask[];
  /** Open corners per seat, recomputed here so callers share one pass. */
  openCorners: Mask[];
}

export function createTerritoryMap(): TerritoryMap {
  return {
    distance: new Int16Array(SEAT_COUNT * CELL_COUNT),
    owner: new Int8Array(CELL_COUNT),
    territory: new Float64Array(SEAT_COUNT),
    reachableCount: new Int32Array(SEAT_COUNT),
    contested: 0,
    reach: [newMask(), newMask(), newMask(), newMask()],
    openCorners: [newMask(), newMask(), newMask(), newMask()],
  };
}

const queue = new Int32Array(CELL_COUNT);
const sourceScratch = new Int32Array(CELL_COUNT);

/**
 * One seat's distance map. Orthogonal steps may not land on a cell edge-adjacent to the seat's own
 * colour (no piece of theirs could ever cover it); diagonal steps are unrestricted, which is what
 * makes the map a reach estimate rather than a flood fill.
 */
function floodSeat(
  position: Position,
  seat: number,
  sourceCells: Mask,
  distance: Int16Array,
  offset: number,
  reach: Mask,
): number {
  distance.fill(UNREACHED, offset, offset + CELL_COUNT);
  reach.fill(0);

  const sources = toIndices(sourceCells, sourceScratch);
  if (sources === 0) {
    return 0;
  }

  let head = 0;
  let tail = 0;
  for (let i = 0; i < sources; i += 1) {
    const cell = sourceScratch[i];
    distance[offset + cell] = 0;
    setBit(reach, cell);
    queue[tail] = cell;
    tail += 1;
  }

  const occ = position.occ;
  const edge = position.edgeHalo[seat];
  let reached = tail;

  while (head < tail) {
    const cell = queue[head];
    head += 1;
    const next = distance[offset + cell] + 1;
    const x = cell % BOARD_SIZE;
    const y = (cell / BOARD_SIZE) | 0;

    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= BOARD_SIZE) {
        continue;
      }
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const nx = x + dx;
        if (nx < 0 || nx >= BOARD_SIZE) {
          continue;
        }
        const target = ny * BOARD_SIZE + nx;
        if (distance[offset + target] !== UNREACHED) {
          continue;
        }
        if (testBit(occ, target)) {
          continue;
        }
        // Orthogonal steps must stay off our own edge halo; diagonal steps may pass anywhere empty.
        if ((dx === 0 || dy === 0) && testBit(edge, target)) {
          continue;
        }
        distance[offset + target] = next;
        setBit(reach, target);
        queue[tail] = target;
        tail += 1;
        reached += 1;
      }
    }
  }

  return reached;
}

/**
 * @param fractionalTies When set, a cell that several seats reach in the same number of steps is
 * split 1/k between them instead of going whole to whoever moves soonest. Winner-take-all makes
 * |T_i| jump by whole regions between siblings that differ by one placement, and those jumps are
 * noise with respect to the outcome; splitting them is a smoothing of the same statistic. `owner`
 * still records the tempo winner, since the waste term needs a definite owner per cell.
 */
export function computeTerritory(
  position: Position,
  out: TerritoryMap = createTerritoryMap(),
  fractionalTies = false,
): TerritoryMap {
  out.territory.fill(0);
  out.contested = 0;

  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const corners = out.openCorners[seat];
    position.openCornersInto(corners, seat);
    // A seat that has not opened yet has no corners, but it is not out of the game: its first
    // placement must cover its home corner, so that cell is its foothold. Without this the whole
    // board reads as belonging to whoever moved first, and every unplayed seat reads as "sealed"
    // — which is exactly backwards for the four plies §4.1 cares most about.
    if (position.played[seat] === 0) {
      const home = HOME_CORNER[seat];
      if (!testBit(position.occ, home)) {
        setBit(corners, home);
      }
    }
    out.reachableCount[seat] = floodSeat(
      position,
      seat,
      corners,
      out.distance,
      seat * CELL_COUNT,
      out.reach[seat],
    );
  }

  const turn = position.turn;
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (testBit(position.occ, cell)) {
      out.owner[cell] = -1;
      continue;
    }
    let bestSeat = -1;
    let bestDistance = UNREACHED;
    let bestTempo = SEAT_COUNT;
    let tiedCount = 0;
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      const d = out.distance[seat * CELL_COUNT + cell];
      if (d === UNREACHED) {
        continue;
      }
      const tempo = pliesUntil(turn, seat);
      if (d < bestDistance) {
        bestDistance = d;
        bestSeat = seat;
        bestTempo = tempo;
        tiedCount = 1;
      } else if (d === bestDistance) {
        tiedCount += 1;
        // Equal distance goes to whoever moves sooner — the tempo rule of §5.
        if (tempo < bestTempo) {
          bestSeat = seat;
          bestTempo = tempo;
        }
      }
    }
    out.owner[cell] = bestSeat;
    if (bestSeat >= 0) {
      if (fractionalTies && tiedCount > 1) {
        const share = 1 / tiedCount;
        for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
          if (out.distance[seat * CELL_COUNT + cell] === bestDistance) {
            out.territory[seat] += share;
          }
        }
      } else {
        out.territory[bestSeat] += 1;
      }
      if (tiedCount > 1) {
        out.contested += 1;
      }
    }
  }

  return out;
}

/**
 * True when no other seat can reach any cell this seat can reach. The position has then stopped
 * being a game for that seat and becomes the packing problem of §4.3.
 */
export function isSealed(map: TerritoryMap, seat: number): boolean {
  const mine = map.reach[seat];
  for (let other = 0; other < SEAT_COUNT; other += 1) {
    if (other === seat) {
      continue;
    }
    const theirs = map.reach[other];
    for (let w = 0; w < WORDS; w += 1) {
      if ((mine[w] & theirs[w]) !== 0) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Frontier pressure (§3.1): corners of `seat` that an opponent can reach within two steps are
 * discounted, because three opposing plies fall between this move and the next one by `seat`.
 */
export function frontierPressure(map: TerritoryMap, seat: number, radius = 2): number {
  const corners = map.openCorners[seat];
  let pressure = 0;
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (!testBit(corners, cell)) {
      continue;
    }
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other === seat) {
        continue;
      }
      if (map.distance[other * CELL_COUNT + cell] <= radius) {
        pressure += 1;
      }
    }
  }
  return pressure;
}

/** Cells only this seat can reach — the part of the board that is genuinely banked. */
export function exclusiveReach(map: TerritoryMap, seat: number, dst: Mask): number {
  const mine = map.reach[seat];
  for (let w = 0; w < WORDS; w += 1) {
    let word = mine[w];
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other !== seat) {
        word &= ~map.reach[other][w];
      }
    }
    dst[w] = word;
  }
  return popcount(dst);
}

export { UNREACHED };
