import { BOARD_SIZE, PLAYER_COLORS, START_CORNERS, type PlayerColor } from '../engine/types';
import type { ExternalBoard } from './types';

const SEAT_COLORS: Array<{ seat: PlayerColor; corner: { x: number; y: number } }> = [
  { seat: 'blue', corner: START_CORNERS.blue },
  { seat: 'yellow', corner: START_CORNERS.yellow },
  { seat: 'purple', corner: START_CORNERS.purple },
  { seat: 'green', corner: START_CORNERS.green },
];

function cellsForColor(board: ExternalBoard, color: PlayerColor): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] === color) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

function centroid(cells: Array<{ x: number; y: number }>): { x: number; y: number } {
  const sum = cells.reduce(
    (acc, cell) => ({ x: acc.x + cell.x, y: acc.y + cell.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / cells.length, y: sum.y / cells.length };
}

function dist2(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Remap scraped colors onto Blokee seats.
 * 1) Prefer start-corner ownership when a corner cell is filled.
 * 2) Otherwise assign remaining colors by nearest start-corner to each color's centroid
 *    (needed for Anywhere opening, where first pieces often miss the corner).
 */
export function remapBoardColorsByCorners(board: ExternalBoard): ExternalBoard {
  const mapping = new Map<PlayerColor, PlayerColor>();
  const usedSeats = new Set<PlayerColor>();

  for (const { seat, corner } of SEAT_COLORS) {
    const scraped = board[corner.y]?.[corner.x];
    if (!scraped || mapping.has(scraped) || usedSeats.has(seat)) {
      continue;
    }
    mapping.set(scraped, seat);
    usedSeats.add(seat);
  }

  const present = PLAYER_COLORS.filter((color) => cellsForColor(board, color).length > 0);
  const unmappedColors = present.filter((color) => !mapping.has(color));
  const unusedSeats = PLAYER_COLORS.filter((seat) => !usedSeats.has(seat));

  if (unmappedColors.length > 0 && unusedSeats.length > 0) {
    const candidates: Array<{ scraped: PlayerColor; seat: PlayerColor; score: number }> = [];
    for (const scraped of unmappedColors) {
      const center = centroid(cellsForColor(board, scraped));
      for (const seat of unusedSeats) {
        candidates.push({
          scraped,
          seat,
          score: dist2(center, START_CORNERS[seat]),
        });
      }
    }
    candidates.sort((a, b) => a.score - b.score);

    const claimedColors = new Set<PlayerColor>();
    const claimedSeats = new Set<PlayerColor>();
    for (const candidate of candidates) {
      if (claimedColors.has(candidate.scraped) || claimedSeats.has(candidate.seat)) {
        continue;
      }
      mapping.set(candidate.scraped, candidate.seat);
      claimedColors.add(candidate.scraped);
      claimedSeats.add(candidate.seat);
    }
  }

  if (mapping.size === 0) {
    return board;
  }

  // If two scraped colors map to the same seat, abort (ambiguous).
  const seats = [...mapping.values()];
  if (new Set(seats).size !== seats.length) {
    return board;
  }

  const remapped: ExternalBoard = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null),
  );

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const scraped = board[y][x];
      if (!scraped) {
        continue;
      }
      remapped[y][x] = mapping.get(scraped) ?? scraped;
    }
  }

  return remapped;
}
