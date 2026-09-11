/**
 * The book's two measurement-critical properties: ranked entries, and path isolation.
 *
 * Neither is about playing strength. Both are about a book being *measurable* — a single-move book
 * collapses the harness's opening sampling, and a globally-shared book lets one config play
 * another's theory.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  bookMeta,
  bookSize,
  clearBooks,
  isBookRegistered,
  lookupBook,
  registerBook,
} from './book';
import type { Position } from './position';

const position = (hi: number, lo: number) => ({ hashHi: hi, hashLo: lo }) as Position;

describe('opening book', () => {
  beforeEach(() => clearBooks());

  it('returns nothing when no book is registered or none is named', () => {
    expect(lookupBook(undefined, position(1, 2))).toEqual([]);
    expect(lookupBook('never/loaded.json', position(1, 2))).toEqual([]);
  });

  it('returns ranked alternatives, not a single move', () => {
    // choosePolicyMove samples from min(openingTopK, rankedMoves.length). One entry would make
    // every seed replay one line and the seed bootstrap would be measuring a single game.
    registerBook('a.json', {
      entries: [
        { hi: 7, lo: 9, moves: [
          { move: 100, value: 1.5, agreement: 3 },
          { move: 200, value: 1.2, agreement: 0 },
          { move: 300, value: 0.9, agreement: 0 },
        ] },
      ],
    });
    const moves = lookupBook('a.json', position(7, 9));
    expect(moves.map((m) => m.move)).toEqual([100, 200, 300]);
  });

  it('matches on both Zobrist halves', () => {
    // The low half is only the bucket key. Matching on it alone would return another position's
    // theory, which is worse than having no book.
    registerBook('a.json', { entries: [{ hi: 7, lo: 9, moves: [{ move: 1, value: 0, agreement: 2 }] }] });
    expect(lookupBook('a.json', position(7, 9))).toHaveLength(1);
    expect(lookupBook('a.json', position(8, 9))).toEqual([]);
  });

  it('keeps books isolated by path', () => {
    registerBook('a.json', { entries: [{ hi: 1, lo: 1, moves: [{ move: 11, value: 0, agreement: 2 }] }] });
    registerBook('b.json', { entries: [{ hi: 1, lo: 1, moves: [{ move: 22, value: 0, agreement: 2 }] }] });
    expect(lookupBook('a.json', position(1, 1))[0].move).toBe(11);
    expect(lookupBook('b.json', position(1, 1))[0].move).toBe(22);
  });

  it('carries the generator provenance so a match can assert seed disjointness', () => {
    registerBook('a.json', { entries: [], generatorSeedBase: 51000000, generatorGames: 120 });
    expect(bookMeta('a.json')).toMatchObject({ generatorSeedBase: 51000000, generatorGames: 120 });
    expect(isBookRegistered('a.json')).toBe(true);
    expect(bookSize('a.json')).toBe(0);
  });
});
