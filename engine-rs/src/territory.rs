//! Reachable territory and the Voronoi partition with the tempo tie-break (`territory.ts`).

use crate::bitboard::*;
use crate::position::{HOME_CORNER, Position, SEAT_COUNT};

pub const UNREACHED: i16 = 32000;

#[derive(Clone)]
pub struct TerritoryMap {
    /// `seat * CELL_COUNT + cell` → BFS steps, or UNREACHED.
    pub distance: Vec<i16>,
    pub owner: [i8; CELL_COUNT],
    pub territory: [f64; SEAT_COUNT],
    pub reachable_count: [i32; SEAT_COUNT],
    pub contested: i32,
    pub reach: [Mask; SEAT_COUNT],
    pub open_corners: [Mask; SEAT_COUNT],
}

impl TerritoryMap {
    pub fn new() -> Self {
        TerritoryMap {
            distance: vec![0; SEAT_COUNT * CELL_COUNT],
            owner: [0; CELL_COUNT],
            territory: [0.0; SEAT_COUNT],
            reachable_count: [0; SEAT_COUNT],
            contested: 0,
            reach: [EMPTY; SEAT_COUNT],
            open_corners: [EMPTY; SEAT_COUNT],
        }
    }
}

impl Default for TerritoryMap {
    fn default() -> Self {
        Self::new()
    }
}

/// The board as seven u64 words, for the bit-parallel flood. Bits 400..447 stay zero.
type Wide = [u64; 7];

#[inline(always)]
fn widen(mask: &Mask) -> Wide {
    let mut out = [0u64; 7];
    for (i, word) in out.iter_mut().enumerate() {
        let lo = mask[2 * i] as u64;
        let hi = if 2 * i + 1 < WORDS { mask[2 * i + 1] as u64 } else { 0 };
        *word = lo | (hi << 32);
    }
    out
}

#[inline(always)]
fn narrow(wide: &Wide) -> Mask {
    let mut out = EMPTY;
    for w in 0..WORDS {
        out[w] = (wide[w / 2] >> (32 * (w % 2))) as u32;
    }
    out
}

#[inline(always)]
fn shl(a: &Wide, k: u32) -> Wide {
    let mut out = [0u64; 7];
    out[0] = a[0] << k;
    for i in 1..7 {
        out[i] = (a[i] << k) | (a[i - 1] >> (64 - k));
    }
    out
}

#[inline(always)]
fn shr(a: &Wide, k: u32) -> Wide {
    let mut out = [0u64; 7];
    for i in 0..6 {
        out[i] = (a[i] >> k) | (a[i + 1] << (64 - k));
    }
    out[6] = a[6] >> k;
    out
}

struct Columns {
    not_first: Wide,
    not_last: Wide,
    board: Wide,
}

fn columns() -> &'static Columns {
    static C: std::sync::OnceLock<Columns> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        let (mut not_first, mut not_last, mut board) = (EMPTY, EMPTY, EMPTY);
        for cell in 0..CELL_COUNT {
            set_bit(&mut board, cell);
            if cell % BOARD_SIZE != 0 {
                set_bit(&mut not_first, cell);
            }
            if cell % BOARD_SIZE != BOARD_SIZE - 1 {
                set_bit(&mut not_last, cell);
            }
        }
        Columns { not_first: widen(&not_first), not_last: widen(&not_last), board: widen(&board) }
    })
}

/// One seat's distance map: diagonal steps through any empty cell, orthogonal steps only onto
/// empty cells off the seat's own edge halo.
///
/// Expanded one BFS layer at a time over whole bitboards. BFS distances are unique, so the layer
/// in which a cell first appears is exactly the distance the TS queue BFS assigns it.
fn flood_seat(position: &Position, seat: usize, sources: &Mask, distance: &mut [i16], reach: &mut Mask) -> i32 {
    distance.fill(UNREACHED);
    let c = columns();
    let occ = widen(&position.occ);
    let edge = widen(&position.edge_halo[seat]);
    let mut diag_ok = [0u64; 7];
    let mut orth_ok = [0u64; 7];
    for i in 0..7 {
        diag_ok[i] = c.board[i] & !occ[i];
        orth_ok[i] = diag_ok[i] & !edge[i];
    }
    let mut frontier = widen(sources);
    let mut visited = frontier;
    let mut d: i16 = 0;
    loop {
        // Record this layer.
        for (i, &word) in frontier.iter().enumerate() {
            let mut bits = word;
            while bits != 0 {
                distance[i * 64 + bits.trailing_zeros() as usize] = d;
                bits &= bits - 1;
            }
        }
        // x+1 needs the source off the last column, x-1 off the first; rows shift by 20.
        let east_src: Wide = std::array::from_fn(|i| frontier[i] & c.not_last[i]);
        let west_src: Wide = std::array::from_fn(|i| frontier[i] & c.not_first[i]);
        let (e, w, n, s) = (shl(&east_src, 1), shr(&west_src, 1), shr(&frontier, 20), shl(&frontier, 20));
        let (se, sw) = (shl(&east_src, 21), shl(&west_src, 19));
        let (ne, nw) = (shr(&east_src, 19), shr(&west_src, 21));
        let mut any = 0u64;
        let mut next = [0u64; 7];
        for i in 0..7 {
            let orth = e[i] | w[i] | n[i] | s[i];
            let diag = se[i] | sw[i] | ne[i] | nw[i];
            next[i] = ((orth & orth_ok[i]) | (diag & diag_ok[i])) & !visited[i];
            visited[i] |= next[i];
            any |= next[i];
        }
        if any == 0 {
            break;
        }
        frontier = next;
        d += 1;
    }
    *reach = narrow(&visited);
    visited.iter().map(|w| w.count_ones() as i32).sum()
}

pub fn compute_territory(position: &Position, out: &mut TerritoryMap, fractional_ties: bool) {
    out.territory = [0.0; SEAT_COUNT];
    out.contested = 0;
    for seat in 0..SEAT_COUNT {
        let mut corners = position.open_corners(seat);
        if position.played[seat] == 0 {
            let home = HOME_CORNER[seat];
            if !test_bit(&position.occ, home) {
                set_bit(&mut corners, home);
            }
        }
        out.open_corners[seat] = corners;
        let (distance, reach) = (
            &mut out.distance[seat * CELL_COUNT..(seat + 1) * CELL_COUNT],
            &mut out.reach[seat],
        );
        out.reachable_count[seat] = flood_seat(position, seat, &corners, distance, reach);
    }

    let turn = position.turn;
    for cell in 0..CELL_COUNT {
        if test_bit(&position.occ, cell) {
            out.owner[cell] = -1;
            continue;
        }
        let mut best_seat: i32 = -1;
        let mut best_distance = UNREACHED;
        let mut best_tempo = SEAT_COUNT;
        let mut tied = 0;
        for seat in 0..SEAT_COUNT {
            let d = out.distance[seat * CELL_COUNT + cell];
            if d == UNREACHED {
                continue;
            }
            let tempo = (seat + SEAT_COUNT - turn) % SEAT_COUNT;
            if d < best_distance {
                best_distance = d;
                best_seat = seat as i32;
                best_tempo = tempo;
                tied = 1;
            } else if d == best_distance {
                tied += 1;
                if tempo < best_tempo {
                    best_seat = seat as i32;
                    best_tempo = tempo;
                }
            }
        }
        out.owner[cell] = best_seat as i8;
        if best_seat >= 0 {
            if fractional_ties && tied > 1 {
                let share = 1.0 / tied as f64;
                for seat in 0..SEAT_COUNT {
                    if out.distance[seat * CELL_COUNT + cell] == best_distance {
                        out.territory[seat] += share;
                    }
                }
            } else {
                out.territory[best_seat as usize] += 1.0;
            }
            if tied > 1 {
                out.contested += 1;
            }
        }
    }
}

/// True when no other seat can reach any cell this seat can reach.
pub fn is_sealed(map: &TerritoryMap, seat: usize) -> bool {
    let mine = &map.reach[seat];
    (0..SEAT_COUNT).filter(|&o| o != seat).all(|other| !intersects(mine, &map.reach[other]))
}

/// Corners of `seat` an opponent can reach within `radius` steps (counted once per opponent).
pub fn frontier_pressure(map: &TerritoryMap, seat: usize, radius: i16) -> f64 {
    let corners = &map.open_corners[seat];
    let mut pressure = 0.0;
    for cell in 0..CELL_COUNT {
        if !test_bit(corners, cell) {
            continue;
        }
        for other in 0..SEAT_COUNT {
            if other != seat && map.distance[other * CELL_COUNT + cell] <= radius {
                pressure += 1.0;
            }
        }
    }
    pressure
}
