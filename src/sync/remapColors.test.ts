import { describe, expect, it } from 'vitest';
import { emptyExternalBoard } from './types';
import { remapBoardColorsByCorners } from './remapColors';

describe('remapBoardColorsByCorners', () => {
  it('swaps green/yellow when start corners are labeled backwards', () => {
    const board = emptyExternalBoard();
    // Intentionally swapped scraped labels at the start corners.
    board[0][0] = 'blue';
    board[0][19] = 'green'; // should be yellow seat
    board[19][19] = 'purple';
    board[19][0] = 'yellow'; // should be green seat
    // Extra cells of those scraped colors
    board[1][1] = 'blue';
    board[1][18] = 'green';
    board[18][18] = 'purple';
    board[18][1] = 'yellow';

    const remapped = remapBoardColorsByCorners(board);
    expect(remapped[0][19]).toBe('yellow');
    expect(remapped[19][0]).toBe('green');
    expect(remapped[1][18]).toBe('yellow');
    expect(remapped[18][1]).toBe('green');
    expect(remapped[0][0]).toBe('blue');
    expect(remapped[19][19]).toBe('purple');
  });

  it('swaps green/yellow for anywhere openings away from corners', () => {
    const board = emptyExternalBoard();
    // Blue covers its corner (correct). Green/yellow first pieces are mid-board but swapped.
    board[0][0] = 'blue';
    board[1][0] = 'blue';
    // Scraped "green" cluster sits in the yellow (TR) quarter
    board[4][14] = 'green';
    board[4][15] = 'green';
    board[5][15] = 'green';
    // Scraped "yellow" cluster sits in the green (BL) quarter
    board[14][4] = 'yellow';
    board[15][4] = 'yellow';
    board[15][5] = 'yellow';

    const remapped = remapBoardColorsByCorners(board);
    expect(remapped[0][0]).toBe('blue');
    expect(remapped[4][14]).toBe('yellow');
    expect(remapped[5][15]).toBe('yellow');
    expect(remapped[14][4]).toBe('green');
    expect(remapped[15][5]).toBe('green');
  });
});
