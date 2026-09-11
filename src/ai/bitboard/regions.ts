/**
 * Empty-space structure: connected regions and articulation points (§3.1).
 *
 * "Build the empty-cell graph G_E with 4-connectivity (a piece's cells are orthogonally connected,
 * so a diagonal-only gap is impassable for a piece…). Run Tarjan's linear-time algorithm to find
 * articulation points and biconnected components. Occupying an articulation point splits a region,
 * which is the single most consequential spatial event in the game."
 *
 * Everything here is O(cells) and allocation-free after the first call: the search runs it once per
 * evaluated position, not once per candidate move.
 */

import { BOARD_SIZE, CELL_COUNT, testBit, type Mask } from './bitboard';
import { SEAT_COUNT } from './seats';

export const NO_REGION = -1;

export interface RegionMap {
  /** Region id per cell, or NO_REGION where the cell is occupied. */
  label: Int16Array;
  /** Cell count per region id. */
  size: Int32Array;
  count: number;
}

export function createRegionMap(): RegionMap {
  return {
    label: new Int16Array(CELL_COUNT),
    size: new Int32Array(CELL_COUNT),
    count: 0,
  };
}

const bfsQueue = new Int32Array(CELL_COUNT);

/** 4-connected components of the empty cells. `occ` is the occupied mask. */
export function labelRegions(occ: Mask, out: RegionMap = createRegionMap()): RegionMap {
  const { label, size } = out;
  label.fill(NO_REGION);
  let count = 0;

  for (let start = 0; start < CELL_COUNT; start += 1) {
    if (testBit(occ, start) || label[start] !== NO_REGION) {
      continue;
    }
    const id = count;
    count += 1;
    let head = 0;
    let tail = 0;
    bfsQueue[tail] = start;
    tail += 1;
    label[start] = id;
    let cells = 0;

    while (head < tail) {
      const cell = bfsQueue[head];
      head += 1;
      cells += 1;
      const x = cell % BOARD_SIZE;

      if (x > 0) {
        const west = cell - 1;
        if (!testBit(occ, west) && label[west] === NO_REGION) {
          label[west] = id;
          bfsQueue[tail] = west;
          tail += 1;
        }
      }
      if (x < BOARD_SIZE - 1) {
        const east = cell + 1;
        if (!testBit(occ, east) && label[east] === NO_REGION) {
          label[east] = id;
          bfsQueue[tail] = east;
          tail += 1;
        }
      }
      const north = cell - BOARD_SIZE;
      if (north >= 0 && !testBit(occ, north) && label[north] === NO_REGION) {
        label[north] = id;
        bfsQueue[tail] = north;
        tail += 1;
      }
      const south = cell + BOARD_SIZE;
      if (south < CELL_COUNT && !testBit(occ, south) && label[south] === NO_REGION) {
        label[south] = id;
        bfsQueue[tail] = south;
        tail += 1;
      }
    }

    size[id] = cells;
  }

  out.count = count;
  return out;
}

const disc = new Int32Array(CELL_COUNT);
const low = new Int32Array(CELL_COUNT);
const parent = new Int32Array(CELL_COUNT);
const iterator = new Int32Array(CELL_COUNT);
const dfsStack = new Int32Array(CELL_COUNT);

function neighbour(cell: number, direction: number): number {
  const x = cell % BOARD_SIZE;
  switch (direction) {
    case 0:
      return x > 0 ? cell - 1 : -1;
    case 1:
      return x < BOARD_SIZE - 1 ? cell + 1 : -1;
    case 2:
      return cell - BOARD_SIZE >= 0 ? cell - BOARD_SIZE : -1;
    default:
      return cell + BOARD_SIZE < CELL_COUNT ? cell + BOARD_SIZE : -1;
  }
}

/**
 * Articulation points of the empty-cell graph, as a per-cell 0/1 mask. Iterative Tarjan: a 400-cell
 * grid is shallow enough for recursion in practice, but the search calls this from inside a worker
 * with an unknown stack budget and a blown stack would be a silent loss, not a slow move.
 */
export function articulationPoints(
  occ: Mask,
  out: Uint8Array = new Uint8Array(CELL_COUNT),
): Uint8Array {
  out.fill(0);
  disc.fill(0);
  let timer = 0;

  for (let root = 0; root < CELL_COUNT; root += 1) {
    if (testBit(occ, root) || disc[root] !== 0) {
      continue;
    }

    let top = 0;
    dfsStack[top] = root;
    parent[root] = -1;
    iterator[root] = 0;
    timer += 1;
    disc[root] = timer;
    low[root] = timer;
    let rootChildren = 0;

    while (top >= 0) {
      const cell = dfsStack[top];
      const direction = iterator[cell];
      if (direction < 4) {
        iterator[cell] = direction + 1;
        const next = neighbour(cell, direction);
        if (next < 0 || testBit(occ, next)) {
          continue;
        }
        if (disc[next] === 0) {
          parent[next] = cell;
          iterator[next] = 0;
          timer += 1;
          disc[next] = timer;
          low[next] = timer;
          if (cell === root) {
            rootChildren += 1;
          }
          top += 1;
          dfsStack[top] = next;
        } else if (next !== parent[cell]) {
          if (disc[next] < low[cell]) {
            low[cell] = disc[next];
          }
        }
        continue;
      }

      top -= 1;
      const up = parent[cell];
      if (up >= 0) {
        if (low[cell] < low[up]) {
          low[up] = low[cell];
        }
        if (up !== root && low[cell] >= disc[up]) {
          out[up] = 1;
        }
      }
    }

    if (rootChildren > 1) {
      out[root] = 1;
    }
  }

  return out;
}

export interface RegionOwnership {
  count: number;
  /** `region * SEAT_COUNT + seat` → open corners that seat holds inside the region. */
  corners: Int32Array;
  /** Open corners across all seats, per region. */
  totalCorners: Int32Array;
  size: Int32Array;
}

const ownershipCorners = new Int32Array(CELL_COUNT * SEAT_COUNT);
const ownershipTotals = new Int32Array(CELL_COUNT);

/**
 * Who still has a foothold in each region. The report's `own_share` weights a region's cell count
 * by which players hold corners inside it: a region only one player can enter is worth its full
 * packable size to that player, a region they have no corner in is worth nothing to them.
 */
export function regionOwnership(
  regions: RegionMap,
  openCorners: Mask[],
  out?: RegionOwnership,
): RegionOwnership {
  const corners = out?.corners ?? ownershipCorners;
  const totals = out?.totalCorners ?? ownershipTotals;
  corners.fill(0, 0, regions.count * SEAT_COUNT);
  totals.fill(0, 0, regions.count);

  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const mask = openCorners[seat];
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      if (!testBit(mask, cell)) {
        continue;
      }
      const region = regions.label[cell];
      if (region === NO_REGION) {
        continue;
      }
      corners[region * SEAT_COUNT + seat] += 1;
      totals[region] += 1;
    }
  }

  return {
    count: regions.count,
    corners,
    totalCorners: totals,
    size: regions.size,
  };
}

/** `own_share_i(r)`: the region's cells, split between the seats that still hold corners in it. */
export function ownShare(ownership: RegionOwnership, region: number, seat: number): number {
  const total = ownership.totalCorners[region];
  if (total === 0) {
    return 0;
  }
  return (
    (ownership.size[region] * ownership.corners[region * SEAT_COUNT + seat]) / total
  );
}
