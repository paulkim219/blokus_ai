import { describe, expect, it } from 'vitest';
import { cellsInPlayerQuarter } from './board';
import { PIECES } from './pieces';
import {
  applyMove,
  createInitialState,
  generateLegalMoves,
  isLegalPlacement,
} from './game';
import { START_CORNERS } from './types';

describe('pieces', () => {
  it('defines 21 blokus pieces', () => {
    expect(PIECES).toHaveLength(21);
  });
});

describe('rules', () => {
  it('requires the first move to cover the start corner', () => {
    const state = createInitialState();
    const corner = START_CORNERS.blue;
    const legalFirst = generateLegalMoves(state, 'blue').find((move) =>
      move.absoluteCells.some((cell) => cell.x === corner.x && cell.y === corner.y),
    );
    expect(legalFirst).toBeDefined();

    const illegal = isLegalPlacement(state, 'blue', legalFirst!.pieceId, legalFirst!.orientationIndex, {
      x: 5,
      y: 5,
    });
    expect(illegal).toBeNull();
  });

  it('anywhere mode allows a first move anywhere in the player quarter', () => {
    const state = createInitialState('anywhere');
    const monomino = PIECES.find((piece) => piece.name === 'I1')!;
    const inside = isLegalPlacement(state, 'blue', monomino.id, 0, { x: 5, y: 5 });
    expect(inside).not.toBeNull();
    expect(cellsInPlayerQuarter(inside!.absoluteCells, 'blue')).toBe(true);

    const outside = isLegalPlacement(state, 'blue', monomino.id, 0, { x: 10, y: 0 });
    expect(outside).toBeNull();
  });

  it('anywhere mode rejects first moves that spill past the quarter', () => {
    const state = createInitialState('anywhere');
    const moves = generateLegalMoves(state, 'blue');
    expect(moves.length).toBeGreaterThan(0);
    expect(
      moves.every((move) => cellsInPlayerQuarter(move.absoluteCells, 'blue')),
    ).toBe(true);

    const cornerOnly = generateLegalMoves(createInitialState('corner'), 'blue');
    expect(moves.length).toBeGreaterThan(cornerOnly.length);
  });

  it('advances turns Blue → Green → Purple → Yellow', () => {
    const state = createInitialState();
    const move = generateLegalMoves(state, 'blue')[0];
    const next = applyMove(state, move);
    expect(next.currentTurn).toBe('green');
    expect(next.hasPlayed.blue).toBe(true);
  });

  it('can enumerate legal moves for a seat that is not currentTurn', () => {
    const state = createInitialState();
    const greenMoves = generateLegalMoves(state, 'green');
    expect(greenMoves.length).toBeGreaterThan(0);
    const applied = applyMove(state, greenMoves[0]);
    expect(applied).toBe(state);
  });

  it('includes distinct F5 and X5 pieces', () => {
    const f5 = PIECES.find((piece) => piece.name === 'F5');
    const x5 = PIECES.find((piece) => piece.name === 'X5');
    expect(f5).toBeDefined();
    expect(x5).toBeDefined();
    const fKey = f5!.cells.map((c) => `${c.x},${c.y}`).join('|');
    const xKey = x5!.cells.map((c) => `${c.x},${c.y}`).join('|');
    expect(fKey).not.toBe(xKey);
  });
});
