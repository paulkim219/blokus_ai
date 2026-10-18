//! The v12 position (`position.ts`): occupancy, per-seat colour and haloes, hands, Zobrist hash.
//!
//! Seats are indexed in turn order (blue, green, purple, yellow), as on the TS side.

use crate::bitboard::*;
use crate::placements::*;
use std::cell::{Cell, RefCell};
use std::sync::OnceLock;

pub const SEAT_COUNT: usize = 4;
pub const ALL_PLACED_BONUS: i32 = 15;
pub const MONOMINO_LAST_BONUS: i32 = 5;
pub const MAX_MOVES: usize = 8192;

/// Seat → colour name, in turn order. Index 0 moves first.
pub const SEAT_COLORS: [&str; SEAT_COUNT] = ["blue", "green", "purple", "yellow"];
/// Home corner cell per seat: blue (0,0), green (0,19), purple (19,19), yellow (19,0).
pub const HOME_CORNER: [usize; SEAT_COUNT] = [0, 380, 399, 19];

pub fn seat_of_color(color: &str) -> Option<usize> {
    SEAT_COLORS.iter().position(|&c| c == color)
}

/* --- Zobrist --------------------------------------------------------------------------------- */

pub struct Zobrist {
    pub cell_lo: Vec<u32>,
    pub cell_hi: Vec<u32>,
    pub turn_lo: [u32; SEAT_COUNT],
    pub turn_hi: [u32; SEAT_COUNT],
    pub last_lo: Vec<u32>,
    pub last_hi: Vec<u32>,
}

fn build_zobrist() -> Zobrist {
    let mut state: u32 = 0x5eed_b10c;
    let mut next = || {
        state = state.wrapping_add(0x9e37_79b9);
        let mut z = state;
        z = (z ^ (z >> 16)).wrapping_mul(0x21f0_aaad);
        z = (z ^ (z >> 15)).wrapping_mul(0x735a_2d97);
        z ^ (z >> 15)
    };
    let mut table = |size: usize| {
        let mut lo = vec![0u32; size];
        let mut hi = vec![0u32; size];
        for i in 0..size {
            lo[i] = next();
            hi[i] = next();
        }
        (lo, hi)
    };
    let (cell_lo, cell_hi) = table(CELL_COUNT * SEAT_COUNT);
    let (tlo, thi) = table(SEAT_COUNT);
    let (last_lo, last_hi) = table(SEAT_COUNT * (PIECE_COUNT + 1));
    Zobrist {
        cell_lo,
        cell_hi,
        turn_lo: [tlo[0], tlo[1], tlo[2], tlo[3]],
        turn_hi: [thi[0], thi[1], thi[2], thi[3]],
        last_lo,
        last_hi,
    }
}

static ZOBRIST: OnceLock<Zobrist> = OnceLock::new();

#[inline(always)]
pub fn zobrist() -> &'static Zobrist {
    ZOBRIST.get_or_init(build_zobrist)
}

#[inline(always)]
fn last_key(seat: usize, piece: i32) -> usize {
    seat * (PIECE_COUNT + 1) + (piece + 1) as usize
}

/* --- Opening quarters (the `anywhere` variant) ----------------------------------------------- */

fn quarter_mask(seat: usize) -> Mask {
    // blue TL, green BL, purple BR, yellow TR.
    let (min_x, min_y) = match seat {
        0 => (0, 0),
        1 => (0, 10),
        2 => (10, 10),
        _ => (10, 0),
    };
    let mut mask = EMPTY;
    for y in min_y..min_y + 10 {
        for x in min_x..min_x + 10 {
            set_bit(&mut mask, cell_index(x, y));
        }
    }
    mask
}

struct Quarters {
    complement: [Mask; SEAT_COUNT],
    placements: [Vec<i32>; SEAT_COUNT],
}

static QUARTERS: OnceLock<Quarters> = OnceLock::new();

fn quarters() -> &'static Quarters {
    QUARTERS.get_or_init(|| {
        let t = placements();
        let complement: [Mask; SEAT_COUNT] = std::array::from_fn(|seat| {
            let mut mask = full_board();
            and_not_into(&mut mask, &quarter_mask(seat));
            mask
        });
        let placements = std::array::from_fn(|seat| {
            (0..t.count as i32)
                .filter(|&id| !intersects(&complement[seat], &t.cells[id as usize]))
                .collect()
        });
        Quarters { complement, placements }
    })
}

/* --- Position -------------------------------------------------------------------------------- */

thread_local! {
    static GEN_STAMP: RefCell<Vec<u32>> = RefCell::new(vec![0; placements().count]);
    static GEN_GENERATION: Cell<u32> = const { Cell::new(0) };
}

#[derive(Clone, Copy, Debug)]
pub struct Undo {
    pub mv: i32,
    pub seat: usize,
    prev_turn: usize,
    prev_last_piece: i32,
    prev_played: u8,
    prev_hash_lo: u32,
    prev_hash_hi: u32,
    prev_out: u8,
    edge_snapshot: Mask,
    corner_snapshot: Mask,
}

#[derive(Clone, Debug)]
pub struct Position {
    pub occ: Mask,
    pub own: [Mask; SEAT_COUNT],
    pub edge_halo: [Mask; SEAT_COUNT],
    pub corner_halo: [Mask; SEAT_COUNT],
    pub hand: [u32; SEAT_COUNT],
    pub hand_squares: [i32; SEAT_COUNT],
    pub last_piece: [i32; SEAT_COUNT],
    pub played: [u8; SEAT_COUNT],
    /// Sticky: set once a seat has been shown to have no legal move.
    pub out: [u8; SEAT_COUNT],
    pub turn: usize,
    pub ply: i32,
    pub opening_anywhere: bool,
    pub hash_lo: u32,
    pub hash_hi: u32,
}

impl Position {
    pub fn initial(opening_anywhere: bool) -> Position {
        let z = zobrist();
        let mut p = Position {
            occ: EMPTY,
            own: [EMPTY; SEAT_COUNT],
            edge_halo: [EMPTY; SEAT_COUNT],
            corner_halo: [EMPTY; SEAT_COUNT],
            hand: [ALL_PIECES_MASK; SEAT_COUNT],
            hand_squares: [TOTAL_SQUARES; SEAT_COUNT],
            last_piece: [-1; SEAT_COUNT],
            played: [0; SEAT_COUNT],
            out: [0; SEAT_COUNT],
            turn: 0,
            ply: 0,
            opening_anywhere,
            hash_lo: z.turn_lo[0],
            hash_hi: z.turn_hi[0],
        };
        for seat in 0..SEAT_COUNT {
            p.hash_lo ^= z.last_lo[last_key(seat, -1)];
            p.hash_hi ^= z.last_hi[last_key(seat, -1)];
        }
        p
    }

    /// `Position.fromCells`: the import path from a legacy `GameState`.
    pub fn from_cells(
        cell_owners: &[i8; CELL_COUNT],
        hand: [u32; SEAT_COUNT],
        last_piece: [i32; SEAT_COUNT],
        turn: usize,
        opening_anywhere: bool,
    ) -> Position {
        let z = zobrist();
        let mut p = Position::initial(opening_anywhere);
        p.hash_lo ^= z.turn_lo[0] ^ z.turn_lo[turn];
        p.hash_hi ^= z.turn_hi[0] ^ z.turn_hi[turn];
        p.turn = turn;
        for cell in 0..CELL_COUNT {
            let owner = cell_owners[cell];
            if owner < 0 {
                continue;
            }
            let seat = owner as usize;
            set_bit(&mut p.occ, cell);
            set_bit(&mut p.own[seat], cell);
            p.played[seat] = 1;
            p.hash_lo ^= z.cell_lo[cell * SEAT_COUNT + seat];
            p.hash_hi ^= z.cell_hi[cell * SEAT_COUNT + seat];
        }
        for seat in 0..SEAT_COUNT {
            p.hand[seat] = hand[seat];
            p.hand_squares[seat] = remaining_squares(hand[seat]);
            let previous = p.last_piece[seat];
            p.last_piece[seat] = last_piece[seat];
            p.hash_lo ^= z.last_lo[last_key(seat, previous)] ^ z.last_lo[last_key(seat, last_piece[seat])];
            p.hash_hi ^= z.last_hi[last_key(seat, previous)] ^ z.last_hi[last_key(seat, last_piece[seat])];
            p.rebuild_haloes(seat);
            p.ply += 21 - hand[seat].count_ones() as i32;
        }
        p
    }

    fn rebuild_haloes(&mut self, seat: usize) {
        let mut edge = EMPTY;
        let mut corner = EMPTY;
        let mut cells = [0i32; CELL_COUNT];
        let count = to_indices(&self.own[seat], &mut cells);
        for &cell in &cells[..count] {
            let (x, y) = ((cell % 20) as isize, (cell / 20) as isize);
            for dy in -1..=1isize {
                for dx in -1..=1isize {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let (nx, ny) = (x + dx, y + dy);
                    if !(0..=19).contains(&nx) || !(0..=19).contains(&ny) {
                        continue;
                    }
                    let index = (ny * 20 + nx) as usize;
                    if dx == 0 || dy == 0 {
                        set_bit(&mut edge, index);
                    } else {
                        set_bit(&mut corner, index);
                    }
                }
            }
        }
        and_not_into(&mut edge, &self.own[seat]);
        and_not_into(&mut corner, &self.own[seat]);
        self.edge_halo[seat] = edge;
        self.corner_halo[seat] = corner;
    }

    #[inline(always)]
    pub fn finished(&self) -> bool {
        self.out == [1, 1, 1, 1]
    }

    /// `C_i`: empty cells diagonally adjacent to seat i and never orthogonally adjacent.
    #[inline(always)]
    pub fn open_corners(&self, seat: usize) -> Mask {
        let mut dst = EMPTY;
        let (corner, edge) = (&self.corner_halo[seat], &self.edge_halo[seat]);
        for w in 0..WORDS {
            dst[w] = corner[w] & !self.occ[w] & !edge[w];
        }
        dst
    }

    pub fn open_corner_count(&self, seat: usize) -> u32 {
        popcount(&self.open_corners(seat))
    }

    /// Legal placements for `seat`, written into `out`. Returns the count; stops at `limit`.
    pub fn generate_moves(&self, seat: usize, out: &mut [i32], limit: usize) -> usize {
        if self.hand[seat] == 0 {
            return 0;
        }
        let capped = limit.min(out.len());
        if self.played[seat] == 0 {
            self.generate_opening(seat, out, capped)
        } else {
            self.generate_from_corners(seat, out, capped)
        }
    }

    fn generate_opening(&self, seat: usize, out: &mut [i32], limit: usize) -> usize {
        let t = placements();
        let hand = self.hand[seat];
        let mut count = 0;
        let mut consider = |id: i32, count: &mut usize| -> bool {
            if hand & (1 << t.piece_id[id as usize]) == 0 {
                return false;
            }
            if intersects(&self.occ, &t.cells[id as usize]) {
                return false;
            }
            out[*count] = id;
            *count += 1;
            *count >= limit
        };
        if self.opening_anywhere {
            for &id in &quarters().placements[seat] {
                if consider(id, &mut count) {
                    return count;
                }
            }
            return count;
        }
        let home = HOME_CORNER[seat];
        for i in t.cover_start[home]..t.cover_start[home + 1] {
            if consider(t.cover_list[i as usize], &mut count) {
                return count;
            }
        }
        count
    }

    fn generate_from_corners(&self, seat: usize, out: &mut [i32], limit: usize) -> usize {
        let t = placements();
        let corners_mask = self.open_corners(seat);
        let mut corner_cells = [0i32; CELL_COUNT];
        let corners = to_indices(&corners_mask, &mut corner_cells);
        if corners == 0 {
            return 0;
        }
        let generation = GEN_GENERATION.with(|g| {
            let next = g.get().wrapping_add(1);
            g.set(next);
            next
        });
        let hand = self.hand[seat];
        let occ_rows = board_rows(&self.occ);
        let own_rows = board_rows(&self.own[seat]);
        GEN_STAMP.with(|stamp| {
            let mut stamp = stamp.borrow_mut();
            let mut count = 0;
            for &cell in &corner_cells[..corners] {
                let cell = cell as usize;
                let (cx, cy) = (cell % BOARD_SIZE, cell / BOARD_SIZE);
                let occ_window = local_window(&occ_rows, cx, cy);
                let own_window = local_window(&own_rows, cx, cy);
                // The cover list is piece-major, so walking only the pieces in hand visits the
                // surviving candidates in the original order. Skipped ids would have failed the
                // hand test anyway, so leaving them unstamped cannot change any later decision.
                let base = cell * (PIECE_COUNT + 1);
                for piece in 0..PIECE_COUNT {
                    if hand & (1 << piece) == 0 {
                        continue;
                    }
                    let run = t.cover_piece_start[base + piece] as usize..t.cover_piece_start[base + piece + 1] as usize;
                    for i in run {
                        let id = t.cover_list[i] as usize;
                        if stamp[id] == generation {
                            continue;
                        }
                        stamp[id] = generation;
                        let shape = &t.shapes[t.cover_shape[i] as usize];
                        if (occ_window & shape.cells) | (own_window & shape.edge) != 0 {
                            continue;
                        }
                        out[count] = id as i32;
                        count += 1;
                        if count >= limit {
                            return count;
                        }
                    }
                }
            }
            count
        })
    }

    pub fn has_move(&self, seat: usize) -> bool {
        let mut one = [0i32; 1];
        self.generate_moves(seat, &mut one, 1) > 0
    }

    pub fn is_legal(&self, seat: usize, id: i32) -> bool {
        let t = placements();
        if id < 0 || id as usize >= t.count {
            return false;
        }
        let id = id as usize;
        if self.hand[seat] & (1 << t.piece_id[id]) == 0 || intersects(&self.occ, &t.cells[id]) {
            return false;
        }
        if self.played[seat] == 0 {
            if self.opening_anywhere {
                return !intersects(&quarters().complement[seat], &t.cells[id]);
            }
            return test_bit(&t.cells[id], HOME_CORNER[seat]);
        }
        if intersects(&self.own[seat], &t.edge_halo[id]) {
            return false;
        }
        intersects(&self.open_corners(seat), &t.cells[id])
    }

    /// Applies `id` for the seat to move and advances the turn. Pair with [`Position::undo`].
    #[inline]
    pub fn apply(&mut self, id: i32) -> Undo {
        let t = placements();
        let z = zobrist();
        let seat = self.turn;
        let m = id as usize;
        let record = Undo {
            mv: id,
            seat,
            prev_turn: seat,
            prev_last_piece: self.last_piece[seat],
            prev_played: self.played[seat],
            prev_hash_lo: self.hash_lo,
            prev_hash_hi: self.hash_hi,
            prev_out: self.out_mask(),
            edge_snapshot: self.edge_halo[seat],
            corner_snapshot: self.corner_halo[seat],
        };
        or_into(&mut self.occ, &t.cells[m]);
        or_into(&mut self.own[seat], &t.cells[m]);
        or_into(&mut self.edge_halo[seat], &t.edge_halo[m]);
        or_into(&mut self.corner_halo[seat], &t.corner_halo[m]);
        let own = self.own[seat];
        and_not_into(&mut self.edge_halo[seat], &own);
        and_not_into(&mut self.corner_halo[seat], &own);

        let piece = t.piece_id[m] as usize;
        self.hand[seat] &= !(1 << piece);
        self.hand_squares[seat] -= PIECE_SIZES[piece];
        self.played[seat] = 1;
        for i in t.cell_start[m]..t.cell_start[m + 1] {
            let key = t.cell_list[i as usize] as usize * SEAT_COUNT + seat;
            self.hash_lo ^= z.cell_lo[key];
            self.hash_hi ^= z.cell_hi[key];
        }
        let before = last_key(seat, self.last_piece[seat]);
        let after = last_key(seat, piece as i32);
        self.hash_lo ^= z.last_lo[before] ^ z.last_lo[after];
        self.hash_hi ^= z.last_hi[before] ^ z.last_hi[after];
        self.last_piece[seat] = piece as i32;
        self.ply += 1;
        self.advance_turn();
        record
    }

    #[inline]
    pub fn undo(&mut self, record: &Undo) {
        let t = placements();
        let (seat, m) = (record.seat, record.mv as usize);
        and_not_into(&mut self.occ, &t.cells[m]);
        and_not_into(&mut self.own[seat], &t.cells[m]);
        self.edge_halo[seat] = record.edge_snapshot;
        self.corner_halo[seat] = record.corner_snapshot;
        let piece = t.piece_id[m] as usize;
        self.hand[seat] |= 1 << piece;
        self.hand_squares[seat] += PIECE_SIZES[piece];
        self.played[seat] = record.prev_played;
        self.last_piece[seat] = record.prev_last_piece;
        self.hash_lo = record.prev_hash_lo;
        self.hash_hi = record.prev_hash_hi;
        self.set_out_mask(record.prev_out);
        self.turn = record.prev_turn;
        self.ply -= 1;
    }

    #[inline(always)]
    pub fn mark_out(&mut self, seat: usize) {
        self.out[seat] = 1;
    }

    #[inline]
    pub fn advance_turn(&mut self) {
        let before = self.turn;
        for step in 1..=SEAT_COUNT {
            let seat = (before + step) % SEAT_COUNT;
            if self.out[seat] == 0 {
                self.set_turn(seat);
                return;
            }
        }
        self.set_turn(before);
    }

    #[inline(always)]
    pub fn force_turn(&mut self, seat: usize) {
        self.set_turn(seat);
    }

    #[inline(always)]
    fn set_turn(&mut self, seat: usize) {
        if seat == self.turn {
            return;
        }
        let z = zobrist();
        self.hash_lo ^= z.turn_lo[self.turn] ^ z.turn_lo[seat];
        self.hash_hi ^= z.turn_hi[self.turn] ^ z.turn_hi[seat];
        self.turn = seat;
    }

    #[inline(always)]
    pub fn out_mask(&self) -> u8 {
        self.out[0] | (self.out[1] << 1) | (self.out[2] << 2) | (self.out[3] << 3)
    }

    #[inline(always)]
    pub fn set_out_mask(&mut self, mask: u8) {
        for seat in 0..SEAT_COUNT {
            self.out[seat] = (mask >> seat) & 1;
        }
    }

    /// Final Blokus score for every seat, as if the game ended here.
    pub fn scores(&self) -> [f64; SEAT_COUNT] {
        std::array::from_fn(|seat| {
            let left = self.hand_squares[seat];
            let mut score = -left;
            if left == 0 {
                score += ALL_PLACED_BONUS;
                if self.last_piece[seat] == MONOMINO_PIECE_ID as i32 {
                    score += MONOMINO_LAST_BONUS;
                }
            }
            score as f64
        })
    }

    #[inline(always)]
    pub fn placed_squares(&self, seat: usize) -> i32 {
        TOTAL_SQUARES - self.hand_squares[seat]
    }
}

pub fn new_move_buffer() -> Vec<i32> {
    vec![0; MAX_MOVES]
}
