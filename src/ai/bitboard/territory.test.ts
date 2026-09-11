/**
 * §3.1's Voronoi map and §5's tempo tie-break.
 *
 * The regression these tests exist for: a seat that has not opened yet has no corner liberties, so
 * seeding the flood from liberties alone gave it zero reach — which made every unplayed seat read
 * as "sealed" and handed the whole board to whoever moved first.
 */

import { describe, expect, it } from 'vitest';
import { CELL_COUNT, cellIndex } from './bitboard';
import { ALL_PIECES_MASK } from './placements';
import { Position } from './position';
import { computeTerritory, frontierPressure, isSealed } from './territory';
import { SEAT_COUNT } from './seats';

describe('v12 territory', () => {
  it('gives every seat a foothold before anyone has played', () => {
    const position = Position.initial(false);
    const map = computeTerritory(position);
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      expect(map.reachableCount[seat]).toBeGreaterThan(300);
      expect(map.territory[seat]).toBeGreaterThan(0);
      expect(isSealed(map, seat)).toBe(false);
    }
    const total = [...map.territory].reduce((sum, value) => sum + value, 0);
    expect(total).toBeLessThanOrEqual(400);
  });

  it('awards tied cells to the seat that moves sooner', () => {
    // Blue on (0,0) and purple on (3,0): their frontiers are (1,1) and (2,1), so (1,2) is one step
    // from both. Which of them owns it is decided by nothing but turn order.
    const owners = new Int8Array(CELL_COUNT).fill(-1);
    owners[cellIndex(0, 0)] = 0;
    owners[cellIndex(3, 0)] = 2;
    const hands = new Int32Array(4).fill(ALL_PIECES_MASK);
    const last = new Int32Array(4).fill(-1);

    const blueToMove = Position.fromCells(owners, hands, last, 0, false);
    const tied = cellIndex(1, 2);
    const blueMap = computeTerritory(blueToMove);
    expect(blueMap.distance[tied]).toBe(blueMap.distance[2 * CELL_COUNT + tied]);
    expect(blueMap.owner[tied]).toBe(0);

    const purpleToMove = Position.fromCells(owners, hands, last, 2, false);
    expect(computeTerritory(purpleToMove).owner[tied]).toBe(2);
  });

  it('reports frontier pressure only where opponents are close', () => {
    const position = Position.initial(false);
    const map = computeTerritory(position);
    // At the opening each seat's single foothold is its own corner, ten steps from anyone else.
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      expect(frontierPressure(map, seat)).toBe(0);
    }
  });
});
