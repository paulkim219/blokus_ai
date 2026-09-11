import { describe, expect, it } from 'vitest';
import { formatMoveDiagram, formatPieceCatalog, formatShapeGrid } from './moveDiagram';
import type { PlaceMove } from '../engine/types';

describe('move diagram', () => {
  it('labels columns as x and rows as y', () => {
    const move: PlaceMove = {
      type: 'place',
      color: 'blue',
      pieceId: 12,
      anchor: { x: 7, y: 4 },
      orientationIndex: 0,
      absoluteCells: [
        { x: 7, y: 4 },
        { x: 8, y: 4 },
        { x: 8, y: 5 },
        { x: 9, y: 5 },
        { x: 10, y: 5 },
      ],
    };
    const diagram = formatMoveDiagram(move);
    expect(diagram).toContain('N5');
    expect(diagram).toContain('column 7, row 4');
    expect(diagram).toContain('(row, column), this origin is (4, 7)');
    const lines = diagram.split('\n');
    const grid = lines.filter((line) => /^\s*\d/.test(line) && line.includes('#'));
    expect(grid.length).toBe(2);
  });

  it('draws default piece shapes with ids', () => {
    const catalog = formatPieceCatalog();
    expect(catalog).toContain('N5 (id 12)');
    expect(catalog).toContain('W5 (id 17)');
    expect(formatShapeGrid([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe('# #');
  });
});
