import type { Cell, PieceDefinition, PieceOrientation } from './types';

const RAW_PIECES: Array<{ name: string; cells: Cell[] }> = [
  { name: 'I1', cells: [{ x: 0, y: 0 }] },
  { name: 'I2', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
  { name: 'I3', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
  { name: 'L3', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] },
  { name: 'I4', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] },
  { name: 'O4', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] },
  { name: 'T4', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }] },
  { name: 'L4', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }] },
  { name: 'Z4', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }] },
  { name: 'I5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }] },
  { name: 'L5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 1 }] },
  { name: 'Y5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 1, y: 1 }] },
  { name: 'N5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }] },
  { name: 'V5', cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }] },
  { name: 'T5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }] },
  { name: 'Z5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }] },
  { name: 'U5', cells: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }] },
  { name: 'W5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }] },
  { name: 'P5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }] },
  // F-pentomino (not a cross): left on top, stem down, right on middle
  { name: 'F5', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }] },
  { name: 'X5', cells: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }] },
];

export const PIECES: PieceDefinition[] = RAW_PIECES.map((piece, id) => ({
  id,
  name: piece.name,
  cells: piece.cells,
  size: piece.cells.length,
}));

function normalize(cells: Cell[]): Cell[] {
  const minX = Math.min(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  const normalized = cells
    .map((c) => ({ x: c.x - minX, y: c.y - minY }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return normalized;
}

function rotate90(cells: Cell[]): Cell[] {
  return normalize(cells.map((c) => ({ x: c.y, y: -c.x })));
}

function reflectX(cells: Cell[]): Cell[] {
  return normalize(cells.map((c) => ({ x: -c.x, y: c.y })));
}

function key(cells: Cell[]): string {
  return cells.map((c) => `${c.x},${c.y}`).join('|');
}

function generateOrientations(cells: Cell[]): Cell[][] {
  const seen = new Set<string>();
  const orientations: Cell[][] = [];
  let current = normalize(cells);

  for (let flip = 0; flip < 2; flip += 1) {
    for (let rot = 0; rot < 4; rot += 1) {
      const k = key(current);
      if (!seen.has(k)) {
        seen.add(k);
        orientations.push(current.map((c) => ({ ...c })));
      }
      current = rotate90(current);
    }
    current = reflectX(current);
  }

  return orientations;
}

export const ORIENTATIONS: PieceOrientation[][] = PIECES.map((piece) =>
  generateOrientations(piece.cells).map((cells, orientationIndex) => ({
    id: orientationIndex,
    cells,
  })),
);

export function getAbsoluteCells(
  pieceId: number,
  orientationIndex: number,
  anchor: Cell,
): Cell[] {
  const orientation = ORIENTATIONS[pieceId][orientationIndex];
  return orientation.cells.map((c) => ({ x: c.x + anchor.x, y: c.y + anchor.y }));
}

/** Place so that `piecePin` (in orientation coords) lands on `boardPin`. */
export function getAbsoluteCellsWithPin(
  pieceId: number,
  orientationIndex: number,
  boardPin: Cell,
  piecePin: Cell,
): Cell[] {
  const orientation = ORIENTATIONS[pieceId][orientationIndex];
  return orientation.cells.map((c) => ({
    x: boardPin.x + (c.x - piecePin.x),
    y: boardPin.y + (c.y - piecePin.y),
  }));
}

export function transformShape(
  cells: Cell[],
  rotations: number,
  flipped: boolean,
): Cell[] {
  let current = normalize(cells);
  if (flipped) {
    current = reflectX(current);
  }
  for (let i = 0; i < ((rotations % 4) + 4) % 4; i += 1) {
    current = rotate90(current);
  }
  return current;
}

export function transformPin(
  pin: Cell,
  cells: Cell[],
  rotations: number,
  flipped: boolean,
): Cell {
  let working = cells.map((c) => ({ ...c }));
  let p = { ...pin };
  if (flipped) {
    working = working.map((c) => ({ x: -c.x, y: c.y }));
    p = { x: -p.x, y: p.y };
  }
  for (let i = 0; i < ((rotations % 4) + 4) % 4; i += 1) {
    working = working.map((c) => ({ x: c.y, y: -c.x }));
    p = { x: p.y, y: -p.x };
  }
  const minX = Math.min(...working.map((c) => c.x));
  const minY = Math.min(...working.map((c) => c.y));
  return { x: p.x - minX, y: p.y - minY };
}

export function findOrientationIndex(pieceId: number, cells: Cell[]): number {
  const k = key(normalize(cells));
  const index = ORIENTATIONS[pieceId].findIndex((orientation) => key(orientation.cells) === k);
  return index >= 0 ? index : 0;
}

export function getShapeFromTransform(
  pieceId: number,
  rotations: number,
  flipped: boolean,
): { cells: Cell[]; orientationIndex: number; pinFor: (pin: Cell) => Cell } {
  const base = PIECES[pieceId].cells;
  const cells = transformShape(base, rotations, flipped);
  return {
    cells,
    orientationIndex: findOrientationIndex(pieceId, cells),
    pinFor: (pin) => transformPin(pin, base, rotations, flipped),
  };
}

export function getRemainingSquareCount(remainingPieceIds: number[]): number {
  return remainingPieceIds.reduce((sum, id) => sum + PIECES[id].size, 0);
}
