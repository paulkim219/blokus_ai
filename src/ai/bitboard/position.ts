/**
 * The v12 position: four bitboards plus the derived masks the report calls for in §6, Layer 0.
 *
 * Per seat we carry the colour's own squares and its two haloes — the cells orthogonally adjacent
 * to it (illegal to touch) and the cells diagonally adjacent to it (the only places it may grow).
 * Both haloes are monotone unions, so applying a move is an OR and never a rescan.
 *
 * Open corners, the C_i of §3.1, fall straight out:
 *
 *     C_i = cornerHalo[i] & ~occupied & ~edgeHalo[i]
 *
 * and a placement is legal for i exactly when it covers a cell of C_i, overlaps nothing, and its
 * edge halo misses i's own squares. That is the "two ANDs per (orientation, anchor)" of the report.
 *
 * A seat that has no legal move can never gain one again — cells only fill — so `out` is sticky and
 * the turn loop simply skips it, which also implements the report's "drop a sealed-off player from
 * playouts altogether".
 */

import {
  FULL_BOARD,
  WORDS,
  andNotInto,
  andNotIntoAt,
  copyInto,
  intersects,
  intersectsAt,
  newMask,
  orIntoAt,
  popcount,
  toIndices,
  type Mask,
} from './bitboard';
import {
  ALL_PIECES_MASK,
  MONOMINO_PIECE_ID,
  PIECE_SIZES,
  PLACEMENTS,
  TOTAL_SQUARES,
  remainingSquares,
} from './placements';
import { CELL_KEYS, LAST_PIECE_KEYS, TURN_KEYS, cellKeyIndex, lastPieceKeyIndex } from './zobrist';
import { HOME_CORNER, QUARTER_MASKS, SEAT_COUNT } from './seats';

export const ALL_PLACED_BONUS = 15;
export const MONOMINO_LAST_BONUS = 5;
export const PASS_MOVE = -1;

/** Slot layout inside the single backing buffer, so `clone()` is one typed-array copy. */
const SLOT_OCC = 0;
const SLOT_OWN = 1;
const SLOT_EDGE = 5;
const SLOT_CORNER = 9;
const SLOT_COUNT = 13;

export interface Undo {
  move: number;
  seat: number;
  prevTurn: number;
  prevLastPiece: number;
  prevPlayed: number;
  prevHashLo: number;
  prevHashHi: number;
  prevOut: number;
  edgeSnapshot: Uint32Array;
  cornerSnapshot: Uint32Array;
}

/** Deduplication stamps for move generation: one placement can cover several open corners. */
const stamp = new Int32Array(PLACEMENTS.count);

function newUndoRecord(): Undo {
  return {
    move: 0,
    seat: 0,
    prevTurn: 0,
    prevLastPiece: 0,
    prevPlayed: 0,
    prevHashLo: 0,
    prevHashHi: 0,
    prevOut: 0,
    edgeSnapshot: new Uint32Array(WORDS),
    cornerSnapshot: new Uint32Array(WORDS),
  };
}
let stampGeneration = 0;

const cornerScratch = newMask();
const cornerIndices = new Int32Array(400);

const quarterComplement: Mask[] = QUARTER_MASKS.map((quarter) => {
  const mask = newMask();
  copyInto(mask, FULL_BOARD);
  andNotInto(mask, quarter);
  return mask;
});

const quarterPlacementCache: Array<Int32Array | null> = [null, null, null, null];

function quarterPlacements(seat: number): Int32Array {
  const cached = quarterPlacementCache[seat];
  if (cached) {
    return cached;
  }
  const outside = quarterComplement[seat];
  const ids: number[] = [];
  for (let id = 0; id < PLACEMENTS.count; id += 1) {
    if (!intersectsAt(outside, PLACEMENTS.cells, id * WORDS)) {
      ids.push(id);
    }
  }
  const list = new Int32Array(ids);
  quarterPlacementCache[seat] = list;
  return list;
}

export class Position {
  /** 13 mask slots × WORDS words. Views below alias into this buffer. */
  private bits: Uint32Array;

  occ!: Mask;
  own!: Mask[];
  edgeHalo!: Mask[];
  cornerHalo!: Mask[];

  /** Piece bitmask still in hand, per seat. */
  hand = new Int32Array(SEAT_COUNT);
  handSquares = new Int32Array(SEAT_COUNT);
  lastPiece = new Int32Array(SEAT_COUNT);
  played = new Uint8Array(SEAT_COUNT);
  /** Sticky: set once a seat has been shown to have no legal move. */
  out = new Uint8Array(SEAT_COUNT);

  turn = 0;
  ply = 0;

  /**
   * Depth-indexed pool of `Undo` records.
   *
   * `apply` previously allocated one object plus two `Uint32Array` halo snapshots on every call, and
   * it is called once per tree edge *and once per playout ply*. At the promoted full-length rollout
   * that is on the order of 90 objects and 180 typed arrays per MCTS iteration, which made it the
   * dominant source of GC pressure in the engine.
   *
   * Every call site is strictly LIFO — apply then undo, or push onto an array and unwind in reverse
   * (`mcts.ts` descent, `playout.ts` rollout, the `packer.ts` DFS, and the immediate apply/evaluate/
   * undo in `ordering.ts` and `pieceFeasibility.ts`) — so a stack indexed by depth is sufficient and
   * hands back the identical bytes the allocating version did.
   */
  private undoPool: Undo[] = [];

  private undoDepth = 0;
  openingAnywhere = false;
  hashLo = 0;
  hashHi = 0;

  private constructor(bits?: Uint32Array) {
    this.bits = bits ?? new Uint32Array(SLOT_COUNT * WORDS);
    this.bindViews();
  }

  private bindViews(): void {
    const slot = (index: number): Mask =>
      this.bits.subarray(index * WORDS, index * WORDS + WORDS);
    this.occ = slot(SLOT_OCC);
    this.own = [0, 1, 2, 3].map((seat) => slot(SLOT_OWN + seat));
    this.edgeHalo = [0, 1, 2, 3].map((seat) => slot(SLOT_EDGE + seat));
    this.cornerHalo = [0, 1, 2, 3].map((seat) => slot(SLOT_CORNER + seat));
  }

  static initial(openingAnywhere = false): Position {
    const position = new Position();
    position.hand.fill(ALL_PIECES_MASK);
    position.handSquares.fill(TOTAL_SQUARES);
    position.lastPiece.fill(-1);
    position.openingAnywhere = openingAnywhere;
    position.hashLo = TURN_KEYS.lo[0];
    position.hashHi = TURN_KEYS.hi[0];
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      position.hashLo ^= LAST_PIECE_KEYS.lo[lastPieceKeyIndex(seat, -1)];
      position.hashHi ^= LAST_PIECE_KEYS.hi[lastPieceKeyIndex(seat, -1)];
    }
    return position;
  }

  /** Rebuilds a position from raw occupancy — the import path from the legacy `GameState`. */
  static fromCells(
    cellOwners: Int8Array,
    hand: Int32Array,
    lastPiece: Int32Array,
    turn: number,
    openingAnywhere: boolean,
  ): Position {
    const position = Position.initial(openingAnywhere);
    position.hashLo ^= TURN_KEYS.lo[0] ^ TURN_KEYS.lo[turn];
    position.hashHi ^= TURN_KEYS.hi[0] ^ TURN_KEYS.hi[turn];
    position.turn = turn;

    for (let cell = 0; cell < cellOwners.length; cell += 1) {
      const seat = cellOwners[cell];
      if (seat < 0) {
        continue;
      }
      position.occ[cell >>> 5] |= 1 << (cell & 31);
      position.own[seat][cell >>> 5] |= 1 << (cell & 31);
      position.played[seat] = 1;
      position.hashLo ^= CELL_KEYS.lo[cellKeyIndex(cell, seat)];
      position.hashHi ^= CELL_KEYS.hi[cellKeyIndex(cell, seat)];
    }

    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      position.hand[seat] = hand[seat];
      position.handSquares[seat] = remainingSquares(hand[seat]);
      const previous = position.lastPiece[seat];
      position.lastPiece[seat] = lastPiece[seat];
      position.hashLo ^=
        LAST_PIECE_KEYS.lo[lastPieceKeyIndex(seat, previous)] ^
        LAST_PIECE_KEYS.lo[lastPieceKeyIndex(seat, lastPiece[seat])];
      position.hashHi ^=
        LAST_PIECE_KEYS.hi[lastPieceKeyIndex(seat, previous)] ^
        LAST_PIECE_KEYS.hi[lastPieceKeyIndex(seat, lastPiece[seat])];
      position.rebuildHaloes(seat);
      position.ply += 21 - popcountBits(hand[seat]);
    }
    return position;
  }

  /** Haloes are normally maintained incrementally; import has to derive them once. */
  private rebuildHaloes(seat: number): void {
    const own = this.own[seat];
    const edge = this.edgeHalo[seat];
    const corner = this.cornerHalo[seat];
    edge.fill(0);
    corner.fill(0);
    const cells = new Int32Array(400);
    const count = toIndices(own, cells);
    for (let i = 0; i < count; i += 1) {
      const cell = cells[i];
      const x = cell % 20;
      const y = (cell / 20) | 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx > 19 || ny > 19) {
            continue;
          }
          const index = ny * 20 + nx;
          const target = dx === 0 || dy === 0 ? edge : corner;
          target[index >>> 5] |= 1 << (index & 31);
        }
      }
    }
    andNotInto(edge, own);
    andNotInto(corner, own);
  }

  clone(): Position {
    const copy = new Position(this.bits.slice());
    copy.hand.set(this.hand);
    copy.handSquares.set(this.handSquares);
    copy.lastPiece.set(this.lastPiece);
    copy.played.set(this.played);
    copy.out.set(this.out);
    copy.turn = this.turn;
    copy.ply = this.ply;
    copy.openingAnywhere = this.openingAnywhere;
    copy.hashLo = this.hashLo;
    copy.hashHi = this.hashHi;
    return copy;
  }

  get finished(): boolean {
    return this.out[0] === 1 && this.out[1] === 1 && this.out[2] === 1 && this.out[3] === 1;
  }

  /** `dst = C_i`: empty cells diagonally adjacent to seat i and never orthogonally adjacent. */
  openCornersInto(dst: Mask, seat: number): void {
    const corner = this.cornerHalo[seat];
    const edge = this.edgeHalo[seat];
    const occ = this.occ;
    for (let w = 0; w < WORDS; w += 1) {
      dst[w] = corner[w] & ~occ[w] & ~edge[w];
    }
  }

  openCornerCount(seat: number): number {
    this.openCornersInto(cornerScratch, seat);
    return popcount(cornerScratch);
  }

  emptyInto(dst: Mask): void {
    for (let w = 0; w < WORDS; w += 1) {
      dst[w] = FULL_BOARD[w] & ~this.occ[w];
    }
  }

  /**
   * Legal placements for `seat`, written into `out` as placement ids. Returns the count.
   * `limit` stops early — `hasMove` passes 1.
   */
  generateMoves(seat: number, out: Int32Array, limit = Number.POSITIVE_INFINITY): number {
    if (this.hand[seat] === 0) {
      return 0;
    }
    // Never write past the caller's buffer: a silent overflow here would corrupt whatever typed
    // array happens to sit next to it, and the peak branching factor is a runtime fact, not a
    // constant we get to assume.
    const capped = Math.min(limit, out.length);
    return this.played[seat] === 0
      ? this.generateOpening(seat, out, capped)
      : this.generateFromCorners(seat, out, capped);
  }

  private generateOpening(seat: number, out: Int32Array, limit: number): number {
    const hand = this.hand[seat];
    const occ = this.occ;
    let count = 0;

    if (this.openingAnywhere) {
      const ids = quarterPlacements(seat);
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if ((hand & (1 << PLACEMENTS.pieceId[id])) === 0) {
          continue;
        }
        if (intersectsAt(occ, PLACEMENTS.cells, id * WORDS)) {
          continue;
        }
        out[count] = id;
        count += 1;
        if (count >= limit) {
          return count;
        }
      }
      return count;
    }

    const home = HOME_CORNER[seat];
    const start = PLACEMENTS.coverStart[home];
    const end = PLACEMENTS.coverStart[home + 1];
    for (let i = start; i < end; i += 1) {
      const id = PLACEMENTS.coverList[i];
      if ((hand & (1 << PLACEMENTS.pieceId[id])) === 0) {
        continue;
      }
      if (intersectsAt(occ, PLACEMENTS.cells, id * WORDS)) {
        continue;
      }
      out[count] = id;
      count += 1;
      if (count >= limit) {
        return count;
      }
    }
    return count;
  }

  private generateFromCorners(seat: number, out: Int32Array, limit: number): number {
    this.openCornersInto(cornerScratch, seat);
    const corners = toIndices(cornerScratch, cornerIndices);
    if (corners === 0) {
      return 0;
    }

    stampGeneration += 1;
    const generation = stampGeneration;
    const hand = this.hand[seat];
    const occ = this.occ;
    const own = this.own[seat];
    let count = 0;

    for (let c = 0; c < corners; c += 1) {
      const cell = cornerIndices[c];
      const start = PLACEMENTS.coverStart[cell];
      const end = PLACEMENTS.coverStart[cell + 1];
      for (let i = start; i < end; i += 1) {
        const id = PLACEMENTS.coverList[i];
        if (stamp[id] === generation) {
          continue;
        }
        stamp[id] = generation;
        if ((hand & (1 << PLACEMENTS.pieceId[id])) === 0) {
          continue;
        }
        const offset = id * WORDS;
        if (intersectsAt(occ, PLACEMENTS.cells, offset)) {
          continue;
        }
        if (intersectsAt(own, PLACEMENTS.edgeHalo, offset)) {
          continue;
        }
        out[count] = id;
        count += 1;
        if (count >= limit) {
          return count;
        }
      }
    }
    return count;
  }

  hasMove(seat: number): boolean {
    return this.generateMoves(seat, scratchOne, 1) > 0;
  }

  isLegal(seat: number, id: number): boolean {
    if (id < 0 || id >= PLACEMENTS.count) {
      return false;
    }
    if ((this.hand[seat] & (1 << PLACEMENTS.pieceId[id])) === 0) {
      return false;
    }
    const offset = id * WORDS;
    if (intersectsAt(this.occ, PLACEMENTS.cells, offset)) {
      return false;
    }
    if (this.played[seat] === 0) {
      if (this.openingAnywhere) {
        return !intersectsAt(quarterComplement[seat], PLACEMENTS.cells, offset);
      }
      const home = HOME_CORNER[seat];
      return (PLACEMENTS.cells[offset + (home >>> 5)] & (1 << (home & 31))) !== 0;
    }
    if (intersectsAt(this.own[seat], PLACEMENTS.edgeHalo, offset)) {
      return false;
    }
    this.openCornersInto(cornerScratch, seat);
    return intersectsAt(cornerScratch, PLACEMENTS.cells, offset);
  }

  /** Applies `id` for the seat to move and advances the turn. Mutates; pair with {@link undo}. */
  apply(id: number): Undo {
    const seat = this.turn;
    const offset = id * WORDS;
    let record = this.undoPool[this.undoDepth];
    if (record === undefined) {
      record = newUndoRecord();
      this.undoPool[this.undoDepth] = record;
    }
    this.undoDepth += 1;
    record.move = id;
    record.seat = seat;
    record.prevTurn = seat;
    record.prevLastPiece = this.lastPiece[seat];
    record.prevPlayed = this.played[seat];
    record.prevHashLo = this.hashLo;
    record.prevHashHi = this.hashHi;
    record.prevOut = this.outMask();
    record.edgeSnapshot.set(this.edgeHalo[seat]);
    record.cornerSnapshot.set(this.cornerHalo[seat]);

    orIntoAt(this.occ, PLACEMENTS.cells, offset);
    orIntoAt(this.own[seat], PLACEMENTS.cells, offset);
    orIntoAt(this.edgeHalo[seat], PLACEMENTS.edgeHalo, offset);
    orIntoAt(this.cornerHalo[seat], PLACEMENTS.cornerHalo, offset);
    // Subtract the whole colour, not just the new cells: a placement's halo can reach back over
    // squares an *earlier* piece of the same colour already occupies, and leaving those in would
    // make the incremental halo disagree with a from-scratch rebuild.
    andNotInto(this.edgeHalo[seat], this.own[seat]);
    andNotInto(this.cornerHalo[seat], this.own[seat]);

    const piece = PLACEMENTS.pieceId[id];
    this.hand[seat] &= ~(1 << piece);
    this.handSquares[seat] -= PIECE_SIZES[piece];
    this.played[seat] = 1;

    for (let i = PLACEMENTS.cellStart[id]; i < PLACEMENTS.cellStart[id + 1]; i += 1) {
      const key = cellKeyIndex(PLACEMENTS.cellList[i], seat);
      this.hashLo ^= CELL_KEYS.lo[key];
      this.hashHi ^= CELL_KEYS.hi[key];
    }
    const beforeKey = lastPieceKeyIndex(seat, this.lastPiece[seat]);
    const afterKey = lastPieceKeyIndex(seat, piece);
    this.hashLo ^= LAST_PIECE_KEYS.lo[beforeKey] ^ LAST_PIECE_KEYS.lo[afterKey];
    this.hashHi ^= LAST_PIECE_KEYS.hi[beforeKey] ^ LAST_PIECE_KEYS.hi[afterKey];
    this.lastPiece[seat] = piece;

    this.ply += 1;
    this.advanceTurn();
    return record;
  }

  undo(record: Undo): void {
    // Exact under the LIFO discipline every call site follows. Clamping rather than asserting means
    // an out-of-order undo still restores the board correctly from the record it was handed; it only
    // declines to reclaim the pool slot.
    if (this.undoDepth > 0) {
      this.undoDepth -= 1;
    }
    const { seat, move } = record;
    const offset = move * WORDS;
    andNotIntoAt(this.occ, PLACEMENTS.cells, offset);
    andNotIntoAt(this.own[seat], PLACEMENTS.cells, offset);
    this.edgeHalo[seat].set(record.edgeSnapshot);
    this.cornerHalo[seat].set(record.cornerSnapshot);

    const piece = PLACEMENTS.pieceId[move];
    this.hand[seat] |= 1 << piece;
    this.handSquares[seat] += PIECE_SIZES[piece];
    this.played[seat] = record.prevPlayed;
    this.lastPiece[seat] = record.prevLastPiece;
    this.hashLo = record.prevHashLo;
    this.hashHi = record.prevHashHi;
    this.setOutMask(record.prevOut);
    this.turn = record.prevTurn;
    this.ply -= 1;
  }

  markOut(seat: number): void {
    this.out[seat] = 1;
  }

  /** Moves to the next seat that is still in the game. */
  advanceTurn(): void {
    const before = this.turn;
    for (let step = 1; step <= SEAT_COUNT; step += 1) {
      const seat = (before + step) % SEAT_COUNT;
      if (this.out[seat] === 0) {
        this.setTurn(seat);
        return;
      }
    }
    this.setTurn(before);
  }

  /** Restores an arbitrary seat to move — used when unwinding a simulated pass. */
  forceTurn(seat: number): void {
    this.setTurn(seat);
  }

  private setTurn(seat: number): void {
    if (seat === this.turn) {
      return;
    }
    this.hashLo ^= TURN_KEYS.lo[this.turn] ^ TURN_KEYS.lo[seat];
    this.hashHi ^= TURN_KEYS.hi[this.turn] ^ TURN_KEYS.hi[seat];
    this.turn = seat;
  }

  getOutMask(): number {
    return this.outMask();
  }

  private outMask(): number {
    return this.out[0] | (this.out[1] << 1) | (this.out[2] << 2) | (this.out[3] << 3);
  }

  setOutMask(mask: number): void {
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      this.out[seat] = (mask >> seat) & 1;
    }
  }

  /** Final Blokus score for every seat, as if the game ended here. */
  scores(out: Float64Array): void {
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      const left = this.handSquares[seat];
      let score = -left;
      if (left === 0) {
        score += ALL_PLACED_BONUS;
        if (this.lastPiece[seat] === MONOMINO_PIECE_ID) {
          score += MONOMINO_LAST_BONUS;
        }
      }
      out[seat] = score;
    }
  }

  placedSquares(seat: number): number {
    return TOTAL_SQUARES - this.handSquares[seat];
  }

  /** Cheap identity for caches that key on "the same board with the same hands". */
  key(): string {
    return `${this.hashHi.toString(36)}:${this.hashLo.toString(36)}`;
  }
}

const scratchOne = new Int32Array(1);

function popcountBits(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0xff;
}

/**
 * Buffer size for a full legal-move list. The report puts the peak per-turn count "in the low
 * hundreds to well over a thousand"; 8192 leaves headroom without mattering for memory, and
 * `generateMoves` clamps to the buffer anyway.
 */
export const MAX_MOVES = 8192;

export function newMoveBuffer(): Int32Array {
  return new Int32Array(MAX_MOVES);
}

export { intersects };
