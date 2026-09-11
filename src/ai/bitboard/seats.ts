/**
 * Seat indexing for the v12 engine.
 *
 * The rest of the repo keys players by colour and keeps two orders around (`PLAYER_COLORS` for
 * display, `TURN_ORDER` for play). Every asymmetry the report describes in §5 is about *turn
 * order* — tempo tie-breaks, "the next player acts before you can use that corner", blocking the
 * previous player being cheaper — so this engine indexes seats 0–3 by `TURN_ORDER` and converts at
 * the boundary. `next(s)` is then simply `(s + 1) % 4` and the diagonal opponent is `(s + 2) % 4`,
 * which is also true geometrically: seats 0 and 2 are opposite corners, as are 1 and 3.
 */

import { PLAYER_QUARTERS, START_CORNERS, TURN_ORDER } from '../../engine/types';
import type { PlayerColor } from '../../engine/types';
import { BOARD_SIZE, cellIndex, newMask, setBit, type Mask } from './bitboard';

export const SEAT_COUNT = 4;

/** Seat index → colour. Index 0 moves first. */
export const SEAT_COLORS: PlayerColor[] = [...TURN_ORDER];

export const SEAT_OF_COLOR: Record<PlayerColor, number> = Object.fromEntries(
  SEAT_COLORS.map((color, seat) => [color, seat]),
) as Record<PlayerColor, number>;

export const HOME_CORNER: Int32Array = new Int32Array(
  SEAT_COLORS.map((color) => cellIndex(START_CORNERS[color].x, START_CORNERS[color].y)),
);

/** Only used by the `anywhere` opening variant this repo supports alongside classic corner play. */
export const QUARTER_MASKS: Mask[] = SEAT_COLORS.map((color) => {
  const quarter = PLAYER_QUARTERS[color];
  const mask = newMask();
  for (let y = quarter.minY; y <= quarter.maxY; y += 1) {
    for (let x = quarter.minX; x <= quarter.maxX; x += 1) {
      setBit(mask, cellIndex(x, y));
    }
  }
  return mask;
});

export function nextSeat(seat: number): number {
  return (seat + 1) % SEAT_COUNT;
}

export function prevSeat(seat: number): number {
  return (seat + SEAT_COUNT - 1) % SEAT_COUNT;
}

export function diagonalSeat(seat: number): number {
  return (seat + 2) % SEAT_COUNT;
}

export type SeatRelation = 'self' | 'next' | 'prev' | 'diag';

export function seatRelation(from: number, to: number): SeatRelation {
  const delta = (to - from + SEAT_COUNT) % SEAT_COUNT;
  if (delta === 0) {
    return 'self';
  }
  if (delta === 1) {
    return 'next';
  }
  if (delta === 2) {
    return 'diag';
  }
  return 'prev';
}

/**
 * How many opposing plies fall between `from` moving now and `from` moving again, counted up to
 * the moment `to` acts. Used for the tempo tie-break in the territory map (§5): at equal distance
 * the cell goes to whoever gets there first, which is whoever moves sooner in the round.
 */
export function pliesUntil(from: number, to: number): number {
  return (to - from + SEAT_COUNT) % SEAT_COUNT;
}

export const BOARD_CENTRE = (BOARD_SIZE - 1) / 2;
