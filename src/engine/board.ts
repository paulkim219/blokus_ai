import { BOARD_SIZE, PLAYER_QUARTERS } from './types';
import type { BoardQuarter, Cell, PlayerColor } from './types';

export function createEmptyBoard(): (PlayerColor | null)[][] {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null),
  );
}

export function inBounds(cell: Cell): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < BOARD_SIZE && cell.y < BOARD_SIZE;
}

export function getCell(board: (PlayerColor | null)[][], cell: Cell): PlayerColor | null {
  return board[cell.y][cell.x];
}

export function cellsAreEmpty(board: (PlayerColor | null)[][], cells: Cell[]): boolean {
  return cells.every((cell) => inBounds(cell) && board[cell.y][cell.x] === null);
}

const ORTHOGONAL = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const DIAGONAL = [
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

export function hasSameColorEdgeContact(
  board: (PlayerColor | null)[][],
  cells: Cell[],
  color: PlayerColor,
): boolean {
  for (const cell of cells) {
    for (const delta of ORTHOGONAL) {
      const neighbor = { x: cell.x + delta.x, y: cell.y + delta.y };
      if (inBounds(neighbor) && board[neighbor.y][neighbor.x] === color) {
        return true;
      }
    }
  }
  return false;
}

export function touchesSameColorCorner(
  board: (PlayerColor | null)[][],
  cells: Cell[],
  color: PlayerColor,
): boolean {
  for (const cell of cells) {
    for (const delta of DIAGONAL) {
      const neighbor = { x: cell.x + delta.x, y: cell.y + delta.y };
      if (inBounds(neighbor) && board[neighbor.y][neighbor.x] === color) {
        return true;
      }
    }
  }
  return false;
}

export function coversCorner(cells: Cell[], corner: Cell): boolean {
  return cells.some((cell) => cell.x === corner.x && cell.y === corner.y);
}

export function cellsInQuarter(cells: Cell[], quarter: BoardQuarter): boolean {
  return cells.every(
    (cell) =>
      cell.x >= quarter.minX &&
      cell.x <= quarter.maxX &&
      cell.y >= quarter.minY &&
      cell.y <= quarter.maxY,
  );
}

export function cellsInPlayerQuarter(cells: Cell[], color: PlayerColor): boolean {
  return cellsInQuarter(cells, PLAYER_QUARTERS[color]);
}

export function placeCells(
  board: (PlayerColor | null)[][],
  cells: Cell[],
  color: PlayerColor,
): void {
  for (const cell of cells) {
    board[cell.y][cell.x] = color;
  }
}

export function cloneBoard(board: (PlayerColor | null)[][]): (PlayerColor | null)[][] {
  return board.map((row) => [...row]);
}
