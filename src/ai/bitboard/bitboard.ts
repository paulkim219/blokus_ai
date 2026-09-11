/**
 * Layer 0 of the research report: the 20×20 board as a fixed 400-bit mask.
 *
 * Every spatial question the engine asks — overlap, own-edge contact, corner contact, territory,
 * region membership — is a bitwise operation over 13 words instead of a scan over 400 cells. The
 * legacy `(PlayerColor | null)[][]` representation in `src/engine` is kept as the slow reference
 * implementation the move-generator equivalence test checks against; nothing here imports it.
 */

export const BOARD_SIZE = 20;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
/** ceil(400 / 32). Word 12 holds bits 384–399, so its top 16 bits are always zero. */
export const WORDS = 13;

const TAIL_WORD = WORDS - 1;
const TAIL_MASK = 0x0000ffff;

export type Mask = Uint32Array;

export function newMask(): Mask {
  return new Uint32Array(WORDS);
}

export function cloneMask(mask: Mask): Mask {
  return mask.slice();
}

export function cellIndex(x: number, y: number): number {
  return y * BOARD_SIZE + x;
}

export function cellX(index: number): number {
  return index % BOARD_SIZE;
}

export function cellY(index: number): number {
  return (index / BOARD_SIZE) | 0;
}

export function setBit(mask: Mask, index: number): void {
  mask[index >>> 5] |= 1 << (index & 31);
}

export function clearBit(mask: Mask, index: number): void {
  mask[index >>> 5] &= ~(1 << (index & 31));
}

export function testBit(mask: Mask, index: number): boolean {
  return (mask[index >>> 5] & (1 << (index & 31))) !== 0;
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0xff;
}

export function popcount(mask: Mask): number {
  let total = 0;
  for (let w = 0; w < WORDS; w += 1) {
    total += popcount32(mask[w]);
  }
  return total;
}

export function clear(mask: Mask): void {
  mask.fill(0);
}

export function copyInto(dst: Mask, src: Mask): void {
  dst.set(src);
}

export function orInto(dst: Mask, src: Mask): void {
  for (let w = 0; w < WORDS; w += 1) {
    dst[w] |= src[w];
  }
}

export function andInto(dst: Mask, src: Mask): void {
  for (let w = 0; w < WORDS; w += 1) {
    dst[w] &= src[w];
  }
}

export function andNotInto(dst: Mask, src: Mask): void {
  for (let w = 0; w < WORDS; w += 1) {
    dst[w] &= ~src[w];
  }
}

export function intersects(a: Mask, b: Mask): boolean {
  for (let w = 0; w < WORDS; w += 1) {
    if ((a[w] & b[w]) !== 0) {
      return true;
    }
  }
  return false;
}

export function isEmpty(mask: Mask): boolean {
  for (let w = 0; w < WORDS; w += 1) {
    if (mask[w] !== 0) {
      return false;
    }
  }
  return true;
}

export function equals(a: Mask, b: Mask): boolean {
  for (let w = 0; w < WORDS; w += 1) {
    if (a[w] !== b[w]) {
      return false;
    }
  }
  return true;
}

/* --- Flat-array variants -------------------------------------------------------------------
 * The placement table stores ~27,000 masks back to back in one `Uint32Array`, so the hot search
 * paths need operations that take (array, offset) instead of a per-placement view object. */

export function intersectsAt(mask: Mask, flat: Uint32Array, offset: number): boolean {
  for (let w = 0; w < WORDS; w += 1) {
    if ((mask[w] & flat[offset + w]) !== 0) {
      return true;
    }
  }
  return false;
}

export function orIntoAt(dst: Mask, flat: Uint32Array, offset: number): void {
  for (let w = 0; w < WORDS; w += 1) {
    dst[w] |= flat[offset + w];
  }
}

export function andNotIntoAt(dst: Mask, flat: Uint32Array, offset: number): void {
  for (let w = 0; w < WORDS; w += 1) {
    dst[w] &= ~flat[offset + w];
  }
}

export function copyFromAt(dst: Mask, flat: Uint32Array, offset: number): void {
  for (let w = 0; w < WORDS; w += 1) {
    dst[w] = flat[offset + w];
  }
}

/** Population count of `mask ∩ flat[offset…]` — "how many of these cells are already spoken for". */
export function popcountAndAt(mask: Mask, flat: Uint32Array, offset: number): number {
  let total = 0;
  for (let w = 0; w < WORDS; w += 1) {
    total += popcount32(mask[w] & flat[offset + w]);
  }
  return total;
}

/* --- Iteration ----------------------------------------------------------------------------- */

function ctz32(value: number): number {
  return 31 - Math.clz32(value & -value);
}

/** Writes the set cell indices into `out` (must hold CELL_COUNT) and returns how many. */
export function toIndices(mask: Mask, out: Int32Array): number {
  let count = 0;
  for (let w = 0; w < WORDS; w += 1) {
    let word = mask[w];
    const base = w << 5;
    while (word !== 0) {
      const bit = ctz32(word);
      out[count] = base + bit;
      count += 1;
      word &= word - 1;
    }
  }
  return count;
}

export function forEachBit(mask: Mask, visit: (index: number) => void): void {
  for (let w = 0; w < WORDS; w += 1) {
    let word = mask[w];
    const base = w << 5;
    while (word !== 0) {
      const bit = ctz32(word);
      visit(base + bit);
      word &= word - 1;
    }
  }
}

/** Lowest set cell index, or -1. */
export function firstBit(mask: Mask): number {
  for (let w = 0; w < WORDS; w += 1) {
    if (mask[w] !== 0) {
      return (w << 5) + ctz32(mask[w]);
    }
  }
  return -1;
}

/* --- Shifts and dilations -------------------------------------------------------------------
 * Used to derive the edge/corner haloes of a whole colour when a position is imported from the
 * legacy representation, and to build the placement table. */

export const FULL_BOARD: Mask = (() => {
  const mask = newMask();
  for (let i = 0; i < CELL_COUNT; i += 1) {
    setBit(mask, i);
  }
  return mask;
})();

function columnMask(predicate: (x: number) => boolean): Mask {
  const mask = newMask();
  for (let i = 0; i < CELL_COUNT; i += 1) {
    if (predicate(cellX(i))) {
      setBit(mask, i);
    }
  }
  return mask;
}

/** Cells that survive a one-step shift without wrapping to the far side of the board. */
const NOT_LEFT_EDGE = columnMask((x) => x > 0);
const NOT_RIGHT_EDGE = columnMask((x) => x < BOARD_SIZE - 1);

function shlInto(dst: Mask, src: Mask, bits: number): void {
  const wordShift = bits >>> 5;
  const bitShift = bits & 31;
  for (let w = WORDS - 1; w >= 0; w -= 1) {
    const lo = w - wordShift;
    let value = lo >= 0 ? src[lo] << bitShift : 0;
    if (bitShift !== 0 && lo - 1 >= 0) {
      value |= src[lo - 1] >>> (32 - bitShift);
    }
    dst[w] = value;
  }
  dst[TAIL_WORD] &= TAIL_MASK;
}

function shrInto(dst: Mask, src: Mask, bits: number): void {
  const wordShift = bits >>> 5;
  const bitShift = bits & 31;
  for (let w = 0; w < WORDS; w += 1) {
    const hi = w + wordShift;
    let value = hi < WORDS ? src[hi] >>> bitShift : 0;
    if (bitShift !== 0 && hi + 1 < WORDS) {
      value |= src[hi + 1] << (32 - bitShift);
    }
    dst[w] = value;
  }
  dst[TAIL_WORD] &= TAIL_MASK;
}

const shiftScratch = newMask();

/** `dst = src translated by (dx, dy)`, dropping anything that would leave the board. */
export function shiftInto(dst: Mask, src: Mask, dx: number, dy: number): void {
  shiftScratch.set(src);
  if (dx > 0) {
    andInto(shiftScratch, NOT_RIGHT_EDGE);
  } else if (dx < 0) {
    andInto(shiftScratch, NOT_LEFT_EDGE);
  }
  const delta = dy * BOARD_SIZE + dx;
  if (delta >= 0) {
    shlInto(dst, shiftScratch, delta);
  } else {
    shrInto(dst, shiftScratch, -delta);
  }
}

const ORTHOGONAL_DELTAS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIAGONAL_DELTAS: Array<[number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const dilateScratch = newMask();

/** All cells orthogonally adjacent to `src` (the "you may not touch this edge-on" halo). */
export function dilateOrthogonal(dst: Mask, src: Mask): void {
  clear(dst);
  for (const [dx, dy] of ORTHOGONAL_DELTAS) {
    shiftInto(dilateScratch, src, dx, dy);
    orInto(dst, dilateScratch);
  }
}

/** All cells diagonally adjacent to `src` (candidate corner contacts). */
export function dilateDiagonal(dst: Mask, src: Mask): void {
  clear(dst);
  for (const [dx, dy] of DIAGONAL_DELTAS) {
    shiftInto(dilateScratch, src, dx, dy);
    orInto(dst, dilateScratch);
  }
}

export function maskFromIndices(indices: Iterable<number>): Mask {
  const mask = newMask();
  for (const index of indices) {
    setBit(mask, index);
  }
  return mask;
}

/** Debug helper: one line per row, `.` empty and `#` set. Used by tests, not by the search. */
export function formatMask(mask: Mask): string {
  const rows: string[] = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    let row = '';
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      row += testBit(mask, cellIndex(x, y)) ? '#' : '.';
    }
    rows.push(row);
  }
  return rows.join('\n');
}
