/**
 * Opening book (§4.1).
 *
 * "A small opening book generated offline by long MCTS runs from the empty board is cheap and
 * effective, since the position space at ply four is small."
 *
 * Two departures from the original sketch, both forced by how the book is measured rather than by
 * how it plays.
 *
 * **Entries carry ranked alternatives, not a single move.** `choosePolicyMove` samples the first
 * `openingRandomPlies` from a search's top `openingTopK`, which is the only reason two seeds play
 * different games at all. A book that returned one move would collapse `pool` to 1, every seed would
 * replay one line, and the seed bootstrap the whole promotion rule rests on would be measuring a
 * single game. Storing the oracle's top-k lets the harness sample exactly as it would from a live
 * search while real play still takes entry 0.
 *
 * **Books are path-keyed**, like `net.ts`. A config names its book in `search.bookPath` and the Node
 * entry points preload it; the engine never touches the filesystem, and a config that asks for a
 * book it did not get plays without one rather than silently falling back to a different book.
 */

import type { Position } from './position';

export interface BookMove {
  move: number;
  /** The generating oracle's root value, in the squashed units the tree backs up. */
  value: number;
  /** How many of the independent generating searches ranked this move first. */
  agreement: number;
}

export interface BookEntry {
  /** Zobrist halves of the position the entry applies to. */
  hi: number;
  lo: number;
  /** Best first. The engine plays `moves[0]`; the harness may sample the top few. */
  moves: BookMove[];
}

export interface BookMeta {
  /** Seeds the book was generated from, so a match can assert it is not playing its training set. */
  generatorSeedBase?: number;
  generatorGames?: number;
  oracle?: string;
  oracleIterations?: number;
  maxPly?: number;
}

export interface BookFile extends BookMeta {
  entries: BookEntry[];
}

interface LoadedBook {
  byLo: Map<number, BookEntry[]>;
  meta: BookMeta;
  size: number;
}

const books = new Map<string, LoadedBook>();

export function registerBook(path: string, file: BookFile): void {
  const byLo = new Map<number, BookEntry[]>();
  for (const entry of file.entries) {
    const bucket = byLo.get(entry.lo);
    if (bucket) bucket.push(entry);
    else byLo.set(entry.lo, [entry]);
  }
  const { entries, ...meta } = file;
  books.set(path, { byLo, meta, size: entries.length });
}

export function isBookRegistered(path: string): boolean {
  return books.has(path);
}

export function clearBooks(): void {
  books.clear();
}

export function bookSize(path: string): number {
  return books.get(path)?.size ?? 0;
}

export function bookMeta(path: string): BookMeta | undefined {
  return books.get(path)?.meta;
}

/** Ranked book moves for this exact position, best first, or an empty array. */
export function lookupBook(path: string | undefined, position: Position): readonly BookMove[] {
  if (!path) return [];
  const book = books.get(path);
  if (!book) return [];
  const bucket = book.byLo.get(position.hashLo);
  if (!bucket) return [];
  for (const entry of bucket) {
    // The low half is the bucket key; the high half is what makes the match exact.
    if (entry.hi === position.hashHi) return entry.moves;
  }
  return [];
}
