/**
 * §3.1's chokepoint machinery, checked against brute force.
 *
 * An articulation point is a cell whose removal breaks its region into more pieces. Tarjan finds
 * them in one pass; the reference here removes each empty cell in turn and recounts the components,
 * which is the definition and is far too slow to use in the search.
 */

import { describe, expect, it } from 'vitest';
import { toPosition } from './adapter';
import { CELL_COUNT, cellIndex, newMask, setBit, testBit, type Mask } from './bitboard';
import { articulationPoints, labelRegions, createRegionMap } from './regions';
import { playRandomGame } from './testUtil';

function occupiedExcept(empty: Array<[number, number]>): Mask {
  const mask = newMask();
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    setBit(mask, cell);
  }
  for (const [x, y] of empty) {
    mask[cellIndex(x, y) >>> 5] &= ~(1 << (cellIndex(x, y) & 31));
  }
  return mask;
}

function bruteForceArticulation(occ: Mask): Set<number> {
  const base = labelRegions(occ, createRegionMap()).count;
  const found = new Set<number>();
  const probe = newMask();
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (testBit(occ, cell)) {
      continue;
    }
    probe.set(occ);
    setBit(probe, cell);
    if (labelRegions(probe, createRegionMap()).count > base) {
      found.add(cell);
    }
  }
  return found;
}

describe('v12 empty-space structure', () => {
  it('labels 4-connected empty regions and ignores diagonal-only contact', () => {
    // Two cells touching only at a corner are two regions: a piece cannot cross a diagonal gap.
    const occ = occupiedExcept([
      [3, 3],
      [4, 4],
    ]);
    const regions = labelRegions(occ, createRegionMap());
    expect(regions.count).toBe(2);
    expect(regions.size[0]).toBe(1);
    expect(regions.size[1]).toBe(1);
  });

  it('finds the cell that joins two rooms', () => {
    // Two 2×2 rooms joined by a single cell at (4,1): that cell is the only articulation point.
    const occ = occupiedExcept([
      [2, 0],
      [3, 0],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [5, 0],
      [6, 0],
    ]);
    const points = articulationPoints(occ);
    expect(points[cellIndex(4, 1)]).toBe(1);
    expect(points[cellIndex(2, 0)]).toBe(0);
    expect(points[cellIndex(6, 0)]).toBe(0);
  });

  it('matches brute force on real positions', () => {
    const { states } = playRandomGame(3);
    let checked = 0;
    for (const state of states.slice(-4)) {
      const occ = toPosition(state).occ;
      const expected = bruteForceArticulation(occ);
      const actual = articulationPoints(occ);
      const mismatches: number[] = [];
      for (let cell = 0; cell < CELL_COUNT; cell += 1) {
        if ((actual[cell] === 1) !== expected.has(cell)) {
          mismatches.push(cell);
        }
      }
      expect(mismatches).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
