import { describe, expect, it } from 'vitest';
import { computeTerritory, regionIsSealed } from './territory';
import { BOARD_SIZE } from '../engine/types';
import type { PlayerColor } from '../engine/types';

const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

function index(x: number, y: number): number {
  return y * BOARD_SIZE + x;
}

function openBoard(): Uint8Array {
  return new Uint8Array(CELL_COUNT).fill(1);
}

function liberties(entries: Partial<Record<PlayerColor, number[]>>): Record<PlayerColor, number[]> {
  return {
    blue: entries.blue ?? [],
    yellow: entries.yellow ?? [],
    purple: entries.purple ?? [],
    green: entries.green ?? [],
  };
}

describe('territory BFS', () => {
  it('splits an empty board along the diagonal between two opposite corners', () => {
    const stats = computeTerritory(
      openBoard(),
      liberties({ blue: [index(0, 0)], purple: [index(19, 19)] }),
    );

    // On an empty board BFS distance is Manhattan distance, so blue owns x + y < 19 (190 cells),
    // purple owns the mirror image, and the 20 cells on x + y === 19 are tied.
    expect(stats.voronoi.blue).toBe(190);
    expect(stats.voronoi.purple).toBe(190);
    expect(stats.contested).toBe(20);
    expect(stats.voronoi.yellow).toBe(0);
    expect(stats.reachable.blue).toBe(CELL_COUNT);
  });

  it('treats occupied cells as walls', () => {
    const board = openBoard();
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      board[index(10, y)] = 0;
    }

    const stats = computeTerritory(
      board,
      liberties({ blue: [index(0, 0)], purple: [index(19, 19)] }),
    );

    expect(stats.reachable.blue).toBe(10 * BOARD_SIZE); // columns 0..9
    expect(stats.reachable.purple).toBe(9 * BOARD_SIZE); // columns 11..19
    expect(stats.voronoi.blue).toBe(10 * BOARD_SIZE);
    expect(stats.voronoi.purple).toBe(9 * BOARD_SIZE);
    expect(stats.contested).toBe(0);
  });

  it('reports a colour with no liberties as controlling nothing', () => {
    const stats = computeTerritory(openBoard(), liberties({ blue: [index(0, 0)] }));
    expect(stats.reachable.green).toBe(0);
    expect(stats.voronoi.blue).toBe(CELL_COUNT);
  });

  it('calls a region sealed only when no opponent can reach it', () => {
    const walled = openBoard();
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      walled[index(10, y)] = 0;
    }
    const split = computeTerritory(
      walled,
      liberties({ blue: [index(0, 0)], purple: [index(19, 19)] }),
    );
    expect(regionIsSealed(split, 'blue')).toBe(true);

    const shared = computeTerritory(
      openBoard(),
      liberties({ blue: [index(0, 0)], purple: [index(19, 19)] }),
    );
    expect(regionIsSealed(shared, 'blue')).toBe(false);
  });
});
