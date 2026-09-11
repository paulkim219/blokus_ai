import type { Cell, PlaceMove } from '../engine/types';
import { PIECES } from '../engine/pieces';

function range(from: number, to: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += 1) {
    values.push(value);
  }
  return values;
}

/** ASCII of relative or absolute cells. `#` occupies a square, `.` is empty. */
export function formatShapeGrid(cells: Cell[]): string {
  const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return range(minY, maxY)
    .map((y) =>
      range(minX, maxX)
        .map((x) => (occupied.has(`${x},${y}`) ? '#' : '.'))
        .join(' '),
    )
    .join('\n');
}

/** Default (unrotated) shapes with piece ids — for the live-eval legend. */
export function formatPieceCatalog(): string {
  return PIECES.map((piece) => `${piece.name} (id ${piece.id})\n${formatShapeGrid(piece.cells)}`).join(
    '\n\n',
  );
}

/**
 * Oriented piece on the board.
 * x = column (0 = left, Blue), y = row (0 = top, Blue). Printed pairs are (x,y), not (row,col).
 */
export function formatMoveDiagram(move: PlaceMove): string {
  const name = PIECES[move.pieceId]?.name ?? `id ${move.pieceId}`;
  const cells = move.absoluteCells;
  const occupied = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const header = `      ${range(minX, maxX)
    .map((x) => String(x).padStart(3, ' '))
    .join('')}`;
  const rows = range(minY, maxY).map((y) => {
    const squares = range(minX, maxX)
      .map((x) => (occupied.has(`${x},${y}`) ? '  #' : '  .'))
      .join('');
    return `${String(y).padStart(4, ' ')}  ${squares}`;
  });

  const squares = cells.map((cell) => `(col ${cell.x}, row ${cell.y})`).join(', ');

  return [
    `${name} (id ${move.pieceId})`,
    `column ${move.anchor.x}, row ${move.anchor.y}  —  printed (x,y)=(${move.anchor.x},${move.anchor.y})`,
    `x = column → (0 = left / Blue). y = row ↓ (0 = top / Blue).`,
    `If you write (row, column), this origin is (${move.anchor.y}, ${move.anchor.x}).`,
    `Cover: ${squares}`,
    'col x →',
    header,
    'row y',
    ...rows,
  ].join('\n');
}
