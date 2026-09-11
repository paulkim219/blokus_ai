import { describe, expect, it } from 'vitest';
import { detectOurColor, emptyOpeningCorners, inferCurrentTurn } from './detectOurColor';
import type { DomSeatInfo, SeatInfo, SeatSnapshot } from './detectOurColor';
import type { ExternalBoard } from './types';
import type { PlayerColor } from '../engine/types';

function emptyBoard(): ExternalBoard {
  return Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => null));
}

function boardWithCorners(filled: PlayerColor[]): ExternalBoard {
  const board = emptyBoard();
  const corners: Record<PlayerColor, { x: number; y: number }> = {
    blue: { x: 0, y: 0 },
    yellow: { x: 19, y: 0 },
    purple: { x: 19, y: 19 },
    green: { x: 0, y: 19 },
  };
  for (const color of filled) {
    board[corners[color].y][corners[color].x] = color;
  }
  return board;
}

function cpu(color: PlayerColor, index: number): SeatInfo {
  return { color, index, name: 'CPU', userId: null, isBot: true };
}

function guest(color: PlayerColor, index: number, userId = 'user-1'): SeatInfo {
  return { color, index, name: 'guest2302359', userId, isBot: false };
}

function stub(color: PlayerColor, index: number): SeatInfo {
  return { color, index, name: null, userId: null, isBot: false };
}

function domCpu(color: PlayerColor): DomSeatInfo {
  return { color, name: 'CPU', isBot: true, hasPass: false, isActive: false };
}

function domYou(color: PlayerColor, extras: Partial<DomSeatInfo> = {}): DomSeatInfo {
  return {
    color,
    name: 'guest2302359',
    isBot: false,
    hasPass: true,
    isActive: true,
    ...extras,
  };
}

describe('detectOurColor yellow vs green', () => {
  it('does not treat a green activeStatuses stub as the human when yellow is the guest', () => {
    const snapshot: SeatSnapshot = {
      userId: 'user-1',
      username: 'guest2302359',
      seats: [cpu('blue', 0), stub('green', 1), cpu('purple', 2), guest('yellow', 3)],
      domSeats: [domCpu('blue'), domYou('yellow'), domCpu('purple'), domCpu('green')],
      board: boardWithCorners(['blue', 'green', 'purple']),
    };
    const result = detectOurColor(snapshot);
    expect(result.color).toBe('yellow');
    expect(result.reason).toMatch(/yellow/i);
  });

  it('picks yellow from the Pass button even if Meteor userId landed on green', () => {
    const snapshot: SeatSnapshot = {
      userId: 'user-1',
      seats: [
        cpu('blue', 0),
        { color: 'green', index: 1, name: null, userId: 'user-1', isBot: false },
        cpu('purple', 2),
        { color: 'yellow', index: 3, name: 'guest2302359', userId: null, isBot: false },
      ],
      domSeats: [domCpu('blue'), domYou('yellow'), domCpu('purple'), domCpu('green')],
    };
    expect(detectOurColor(snapshot).color).toBe('yellow');
  });

  it('does not pick the unique !isBot Meteor seat when that seat is a nameless green stub', () => {
    const snapshot: SeatSnapshot = {
      seats: [cpu('blue', 0), stub('green', 1), cpu('purple', 2), cpu('yellow', 3)],
    };
    const result = detectOurColor(snapshot);
    expect(result.color).not.toBe('green');
  });

  it('still detects green when the guest panel is bottom-left', () => {
    const snapshot: SeatSnapshot = {
      userId: 'user-1',
      username: 'guest2302359',
      seats: [cpu('blue', 0), guest('green', 1), cpu('purple', 2), cpu('yellow', 3)],
      domSeats: [domCpu('blue'), domCpu('yellow'), domCpu('purple'), domYou('green')],
      board: boardWithCorners(['blue', 'yellow', 'purple']),
    };
    expect(detectOurColor(snapshot).color).toBe('green');
  });

  it('uses the single empty opening corner as a yellow/green tie-break', () => {
    const board = boardWithCorners(['blue', 'green', 'purple']);
    expect(emptyOpeningCorners(board)).toEqual(['yellow']);
    const snapshot: SeatSnapshot = {
      board,
      seats: [stub('blue', 0), stub('green', 1), stub('purple', 2), stub('yellow', 3)],
    };
    const result = detectOurColor(snapshot);
    expect(result.color).toBe('yellow');
  });

  it('waits when yellow and green look equally likely', () => {
    const result = detectOurColor({
      seats: [stub('green', 1), stub('yellow', 3)],
    });
    expect(result.color).toBeNull();
  });
});

describe('inferCurrentTurn', () => {
  it('does not assume blue after blue has already opened', () => {
    const result = inferCurrentTurn({
      scrapedTurn: 'blue',
      board: boardWithCorners(['blue']),
    });
    expect(result.turn).toBe('green');
    expect(result.reason).toMatch(/green/);
  });

  it('ignores a stale blue scrape once blue, green, and purple have opened', () => {
    const result = inferCurrentTurn({
      scrapedTurn: 'blue',
      board: boardWithCorners(['blue', 'green', 'purple']),
    });
    expect(result.turn).toBe('yellow');
  });

  it('still treats a first-round pass as purple when green never opened', () => {
    const result = inferCurrentTurn({
      scrapedTurn: 'purple',
      board: boardWithCorners(['blue']),
    });
    expect(result.turn).toBe('purple');
  });

  it('trusts Pass on green even if Meteor still says blue', () => {
    const result = inferCurrentTurn({
      scrapedTurn: 'blue',
      passColor: 'green',
      board: emptyBoard(),
    });
    expect(result.turn).toBe('green');
  });

  it('does not default an empty unknown board to blue', () => {
    const result = inferCurrentTurn({ board: emptyBoard() });
    expect(result.turn).toBeNull();
  });

  it('uses a ticking header / scrape turn when cell counts are tied', () => {
    const board = boardWithCorners(['blue', 'yellow', 'purple', 'green']);
    board[0][1] = 'blue';
    board[19][1] = 'yellow';
    board[19][18] = 'purple';
    board[1][19] = 'green';
    const result = inferCurrentTurn({
      board,
      scrapedTurn: 'purple',
    });
    expect(result.turn).toBe('purple');
  });

  it('picks the unique color that is behind on squares after the opening round', () => {
    const board = emptyBoard();
    board[0][0] = 'blue';
    board[0][1] = 'blue';
    board[19][0] = 'yellow';
    board[19][19] = 'purple';
    board[19][18] = 'purple';
    board[0][19] = 'green';
    board[1][19] = 'green';
    const result = inferCurrentTurn({ board });
    expect(result.turn).toBe('yellow');
  });
});
