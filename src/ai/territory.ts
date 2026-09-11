import { BOARD_SIZE, PLAYER_COLORS } from '../engine/types';
import type { PlayerColor } from '../engine/types';

/**
 * Space control measured by breadth-first distance from each colour's frontier.
 *
 * The repo already had a `territory` feature, but it compared every empty cell against every
 * occupied cell (O(cells²)) and was therefore disabled in fast mode — which is every search path.
 * This version walks the empty space from the cells a colour may legally occupy next (its corner
 * liberties) and costs one pass per colour, so it can run inside the search.
 */
export interface TerritoryStats {
  /** Empty cells strictly closer to this colour's frontier than to any other colour's. */
  voronoi: Record<PlayerColor, number>;
  /** Empty cells this colour's frontier can reach at all, at any distance. */
  reachable: Record<PlayerColor, number>;
  /** Cells where two or more colours tie for closest — the contested middle. */
  contested: number;
  /** BFS distance per colour, `-1` where unreachable. Indexed `y * BOARD_SIZE + x`. */
  distance: Record<PlayerColor, Int16Array>;
}

const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
const UNREACHED = -1;

function emptyCounts(): Record<PlayerColor, number> {
  return { blue: 0, yellow: 0, purple: 0, green: 0 };
}

/**
 * Distances from `sources` through empty cells only, moving orthogonally.
 * Occupied cells are walls: a piece already on the board blocks expansion behind it.
 */
function floodFrom(sources: number[], isEmpty: Uint8Array): Int16Array {
  const distance = new Int16Array(CELL_COUNT).fill(UNREACHED);
  if (sources.length === 0) {
    return distance;
  }

  const queue = new Int16Array(CELL_COUNT);
  let head = 0;
  let tail = 0;
  for (const index of sources) {
    if (distance[index] === UNREACHED && isEmpty[index]) {
      distance[index] = 0;
      queue[tail] = index;
      tail += 1;
    }
  }

  while (head < tail) {
    const index = queue[head];
    head += 1;
    const next = distance[index] + 1;
    const x = index % BOARD_SIZE;

    if (x > 0) {
      const west = index - 1;
      if (isEmpty[west] && distance[west] === UNREACHED) {
        distance[west] = next;
        queue[tail] = west;
        tail += 1;
      }
    }
    if (x < BOARD_SIZE - 1) {
      const east = index + 1;
      if (isEmpty[east] && distance[east] === UNREACHED) {
        distance[east] = next;
        queue[tail] = east;
        tail += 1;
      }
    }
    const north = index - BOARD_SIZE;
    if (north >= 0 && isEmpty[north] && distance[north] === UNREACHED) {
      distance[north] = next;
      queue[tail] = north;
      tail += 1;
    }
    const south = index + BOARD_SIZE;
    if (south < CELL_COUNT && isEmpty[south] && distance[south] === UNREACHED) {
      distance[south] = next;
      queue[tail] = south;
      tail += 1;
    }
  }

  return distance;
}

/**
 * @param isEmpty  Flat occupancy mask, 1 where the cell is empty.
 * @param liberties Flat indices of each colour's corner liberties — its legal next footholds.
 */
export function computeTerritory(
  isEmpty: Uint8Array,
  liberties: Record<PlayerColor, number[]>,
): TerritoryStats {
  const distance = {} as Record<PlayerColor, Int16Array>;
  for (const color of PLAYER_COLORS) {
    distance[color] = floodFrom(liberties[color], isEmpty);
  }

  const voronoi = emptyCounts();
  const reachable = emptyCounts();
  let contested = 0;

  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (!isEmpty[index]) {
      continue;
    }
    let best = Number.POSITIVE_INFINITY;
    let bestColor: PlayerColor | null = null;
    let ties = 0;
    for (const color of PLAYER_COLORS) {
      const d = distance[color][index];
      if (d === UNREACHED) {
        continue;
      }
      reachable[color] += 1;
      if (d < best) {
        best = d;
        bestColor = color;
        ties = 1;
      } else if (d === best) {
        ties += 1;
      }
    }
    if (ties === 1 && bestColor) {
      voronoi[bestColor] += 1;
    } else if (ties > 1) {
      contested += 1;
    }
  }

  return { voronoi, reachable, contested, distance };
}

/**
 * True when no opponent can reach any cell `color` can reach — the region is sealed, so an exact
 * packing of what is left is safe from interference.
 */
export function regionIsSealed(stats: TerritoryStats, color: PlayerColor): boolean {
  const mine = stats.distance[color];
  for (const other of PLAYER_COLORS) {
    if (other === color) {
      continue;
    }
    const theirs = stats.distance[other];
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (mine[index] !== UNREACHED && theirs[index] !== UNREACHED) {
        return false;
      }
    }
  }
  return true;
}
