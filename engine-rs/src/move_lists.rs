//! v5.0 port P2: every seat's legal placements kept up to date through a rollout.
//!
//! A list is built the first time a seat's moves are asked for in a rollout and then updated after
//! every placement instead of being generated again:
//!
//! - placements by other seats are collected in a pending mask and removed from the list in one
//!   pass when the seat's moves are next asked for (a placement stays legal unless it overlaps a
//!   newly occupied cell);
//! - the mover's own placement removes the placements of that piece and those that would now touch
//!   its colour edge-on, and adds the placements that cover one of its *new* open corners.
//!
//! Nothing else can change legality: occupancy, own edge contact and the hand only ever tighten,
//! and a placement is legal only through an open corner, so a placement that was illegal before a
//! move and is legal after it must cover one of the mover's new corners. A placement that also
//! covers a corner that was already open was already listed, so it is skipped; one that covers two
//! new corners is added at the first.
//!
//! **Base lists.** Rollouts in one search all start below the same root. `set_base` generates the
//! four lists there once; a list first asked for in a rollout is then derived from the base list
//! (filter by what has been placed since, add placements at corners that are new since) instead of
//! being generated from scratch. Without a base, or for a seat that had not placed a piece at the
//! base, the list is generated from scratch.
//!
//! **Entries.** A list holds packed entries (`Entry`), not bare placement ids: the id, the piece and
//! the piece's cells as up to five 5-bit rows at its bounding box. Every per-move test in a rollout
//! (overlap with newly occupied cells, squares on the local-response set) is then a few shifts on
//! the entry and a 24-row copy of the mask, streaming through the list without touching the
//! placement table.
//!
//! `tests/move_lists.rs` checks every list against `Position::generate_moves` at every ply of many
//! random games. Order inside a list is an implementation detail. Only the rollout policy
//! `native.rollout.policy = "all"` uses this module.

use crate::bitboard::*;
use crate::placements::*;
use crate::position::{MAX_MOVES, Position, SEAT_COUNT};
use std::sync::OnceLock;

/// A placement packed for list work: bits 0–15 id, 16–20 piece, 21–25 x0, 26–30 y0, 32–56 five
/// 5-bit rows of cells starting at row y0, bit 0 of a row = column x0.
pub type Entry = u64;

/// Board rows of a mask, padded to 24 so a 5-row read from any y0 ≤ 19 stays in bounds.
pub type Rows = [u32; 24];

fn entries() -> &'static Vec<Entry> {
    static ENTRIES: OnceLock<Vec<Entry>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        let t = placements();
        assert!(t.count <= 1 << 16, "placement ids no longer fit the packed entry");
        (0..t.count)
            .map(|m| {
                let cells: Vec<usize> = (t.cell_start[m]..t.cell_start[m + 1]).map(|i| t.cell_list[i as usize] as usize).collect();
                let x0 = cells.iter().map(|c| c % BOARD_SIZE).min().unwrap();
                let y0 = cells.iter().map(|c| c / BOARD_SIZE).min().unwrap();
                let mut rows = 0u64;
                for c in cells {
                    let (dx, dy) = (c % BOARD_SIZE - x0, c / BOARD_SIZE - y0);
                    rows |= 1 << (dy * 5 + dx);
                }
                m as u64 | (t.piece_id[m] as u64) << 16 | (x0 as u64) << 21 | (y0 as u64) << 26 | rows << 32
            })
            .collect()
    })
}

/// The packed entry of placement `id`.
#[inline(always)]
pub fn entry(id: i32) -> Entry {
    entries()[id as usize]
}

#[inline(always)]
pub fn entry_id(e: Entry) -> i32 {
    (e & 0xffff) as i32
}

#[inline(always)]
pub fn entry_piece(e: Entry) -> usize {
    ((e >> 16) & 31) as usize
}

pub fn rows_of(mask: &Mask) -> Rows {
    let mut rows = [0u32; 24];
    rows[..BOARD_SIZE].copy_from_slice(&board_rows(mask));
    rows
}

/// Squares of the entry's piece on the mask whose rows are `rows`.
#[inline(always)]
pub fn entry_count(e: Entry, rows: &Rows) -> u32 {
    let x0 = (e >> 21) & 31;
    let y0 = ((e >> 26) & 31) as usize;
    let shape = e >> 32;
    let mut n = 0;
    for r in 0..5 {
        n += ((rows[y0 + r] as u64 >> x0) & (shape >> (5 * r)) & 31).count_ones();
    }
    n
}

/// Whether the entry's piece covers any square of the mask whose rows are `rows`.
#[inline(always)]
pub fn entry_hits(e: Entry, rows: &Rows) -> bool {
    let x0 = (e >> 21) & 31;
    let y0 = ((e >> 26) & 31) as usize;
    let shape = e >> 32;
    let mut hit = 0u64;
    for r in 0..5 {
        hit |= (rows[y0 + r] as u64 >> x0) & (shape >> (5 * r));
    }
    hit & 31 != 0
}

struct Base {
    occ: Mask,
    own: [Mask; SEAT_COUNT],
    corner: [Mask; SEAT_COUNT],
    hand: [u32; SEAT_COUNT],
    played: [u8; SEAT_COUNT],
    moves: [Vec<Entry>; SEAT_COUNT],
}

/// The incremental legal-move lists of all four seats.
pub struct MoveLists {
    moves: [Vec<Entry>; SEAT_COUNT],
    ready: [bool; SEAT_COUNT],
    /// Cells occupied by other seats since the list was last filtered.
    pending: [Mask; SEAT_COUNT],
    pending_any: [bool; SEAT_COUNT],
    base: Option<Base>,
    scratch: Vec<i32>,
}

impl Default for MoveLists {
    fn default() -> Self {
        Self::new()
    }
}


impl MoveLists {
    pub fn new() -> MoveLists {
        entries();
        MoveLists {
            moves: std::array::from_fn(|_| Vec::with_capacity(1024)),
            ready: [false; SEAT_COUNT],
            pending: [EMPTY; SEAT_COUNT],
            pending_any: [false; SEAT_COUNT],
            base: None,
            scratch: vec![0; MAX_MOVES],
        }
    }

    /// Generates the base lists at `position` (normally a search root).
    pub fn set_base(&mut self, position: &Position) {
        let mut moves: [Vec<Entry>; SEAT_COUNT] = match self.base.take() {
            Some(b) => b.moves,
            None => std::array::from_fn(|_| Vec::with_capacity(1024)),
        };
        for (seat, list) in moves.iter_mut().enumerate() {
            let n = position.generate_moves(seat, &mut self.scratch, MAX_MOVES);
            list.clear();
            list.extend(self.scratch[..n].iter().map(|&id| entry(id)));
        }
        self.base = Some(Base { occ: position.occ, own: position.own, corner: position.corner_halo, hand: position.hand, played: position.played, moves });
    }

    pub fn clear_base(&mut self) {
        self.base = None;
    }

    /// Forgets every list (start of a rollout); they are rebuilt on first use.
    pub fn reset(&mut self) {
        self.ready = [false; SEAT_COUNT];
        self.pending_any = [false; SEAT_COUNT];
    }

    /// Whether `seat`'s list is currently maintained (for tests).
    pub fn is_ready(&self, seat: usize) -> bool {
        self.ready[seat]
    }

    /// `seat`'s legal placements in `position`, as packed entries (`entry_id` gives the id).
    pub fn moves(&mut self, position: &Position, seat: usize) -> &[Entry] {
        if !self.ready[seat] {
            self.build(position, seat);
        } else if self.pending_any[seat] {
            self.flush(seat);
        }
        &self.moves[seat]
    }

    fn flush(&mut self, seat: usize) {
        let pending = rows_of(&self.pending[seat]);
        self.moves[seat].retain(|&e| !entry_hits(e, &pending));
        self.pending[seat] = EMPTY;
        self.pending_any[seat] = false;
    }

    fn build(&mut self, position: &Position, seat: usize) {
        self.ready[seat] = true;
        self.pending[seat] = EMPTY;
        self.pending_any[seat] = false;
        let list = &mut self.moves[seat];
        list.clear();
        let derivable = self.base.as_ref().is_some_and(|b| b.played[seat] == 1 && position.played[seat] == 1 && descends(b, position));
        if !derivable {
            let n = position.generate_moves(seat, &mut self.scratch, MAX_MOVES);
            list.extend(self.scratch[..n].iter().map(|&id| entry(id)));
            return;
        }
        let base = self.base.as_ref().unwrap();
        let mut placed = position.occ;
        and_not_into(&mut placed, &base.occ);
        let hand = position.hand[seat];
        if hand == base.hand[seat] {
            // The seat has not moved since the base: its legal placements are the base ones that do
            // not overlap anything placed since.
            let placed = rows_of(&placed);
            list.extend(base.moves[seat].iter().copied().filter(|&e| !entry_hits(e, &placed)));
            return;
        }
        let mut kill = placed;
        or_into(&mut kill, &position.edge_halo[seat]);
        let kill = rows_of(&kill);
        list.extend(base.moves[seat].iter().copied().filter(|&e| hand & (1 << entry_piece(e)) != 0 && !entry_hits(e, &kill)));
        let open = position.open_corners(seat);
        let mut new_corners = open;
        and_not_into(&mut new_corners, &base.corner[seat]);
        let mut old_open = open;
        and_into(&mut old_open, &base.corner[seat]);
        add_at_new_corners(list, position, seat, &new_corners, &old_open);
    }

    /// Updates the lists after `seat` placed `mv`. `position` is the position *after* the placement;
    /// `corner_before` is `seat`'s corner halo and `played_before` its `played` flag from *before* it.
    pub fn after_placement(&mut self, position: &Position, seat: usize, mv: i32, corner_before: &Mask, played_before: bool) {
        let t = placements();
        let m = mv as usize;
        for other in 0..SEAT_COUNT {
            if other != seat && self.ready[other] {
                or_into(&mut self.pending[other], &t.cells[m]);
                self.pending_any[other] = true;
            }
        }
        if !self.ready[seat] {
            return;
        }
        if !played_before {
            // A first placement replaces the start-corner rule by the corner rule: start over.
            self.ready[seat] = false;
            return;
        }
        let mut kill = t.cells[m];
        or_into(&mut kill, &t.edge_halo[m]);
        if self.pending_any[seat] {
            or_into(&mut kill, &self.pending[seat]);
            self.pending[seat] = EMPTY;
            self.pending_any[seat] = false;
        }
        let piece = t.piece_id[m] as usize;
        let kill = rows_of(&kill);
        self.moves[seat].retain(|&e| entry_piece(e) != piece && !entry_hits(e, &kill));
        let open = position.open_corners(seat);
        let mut new_corners = EMPTY;
        let mut old_open = open;
        for w in 0..WORDS {
            new_corners[w] = t.corner_halo[m][w] & open[w] & !corner_before[w];
            old_open[w] &= corner_before[w];
        }
        add_at_new_corners(&mut self.moves[seat], position, seat, &new_corners, &old_open);
    }
}

/// Whether `position` holds every piece of the base, by colour, and no piece the base had in hand
/// is back in hand: then the base lists can be carried forward to it.
fn descends(base: &Base, position: &Position) -> bool {
    (0..SEAT_COUNT).all(|seat| {
        position.hand[seat] & !base.hand[seat] == 0 && (0..WORDS).all(|w| base.own[seat][w] & !position.own[seat][w] == 0)
    })
}

/// Appends `seat`'s legal placements in `position` that cover a cell of `new_corners` and no cell of
/// `old_open` (those were listed already), each once.
fn add_at_new_corners(list: &mut Vec<Entry>, position: &Position, seat: usize, new_corners: &Mask, old_open: &Mask) {
    let hand = position.hand[seat];
    if hand == 0 || is_empty(new_corners) {
        return;
    }
    let t = placements();
    let occ_rows = board_rows(&position.occ);
    let own_rows = board_rows(&position.own[seat]);
    // Old open corners plus the new corners already done: a placement covering any of them is
    // already in the list.
    let mut seen = *old_open;
    for w in 0..WORDS {
        let mut bits = new_corners[w];
        while bits != 0 {
            let cell = w * 32 + bits.trailing_zeros() as usize;
            bits &= bits - 1;
            let (cx, cy) = (cell % BOARD_SIZE, cell / BOARD_SIZE);
            let occ_window = local_window(&occ_rows, cx, cy);
            let own_window = local_window(&own_rows, cx, cy);
            let seen_window = local_window(&board_rows(&seen), cx, cy);
            let base = cell * (PIECE_COUNT + 1);
            for p in 0..PIECE_COUNT {
                if hand & (1 << p) == 0 {
                    continue;
                }
                let run = t.cover_piece_start[base + p] as usize..t.cover_piece_start[base + p + 1] as usize;
                for k in run {
                    let shape = &t.shapes[t.cover_shape[k] as usize];
                    if (occ_window & shape.cells) | (own_window & shape.edge) | (seen_window & shape.cells) != 0 {
                        continue;
                    }
                    list.push(entry(t.cover_list[k]));
                }
            }
            set_bit(&mut seen, cell);
        }
    }
}
