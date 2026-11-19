//! The network's input encoding in Rust (hybrid H0): a port of `ml/torch/features.py`
//! (`Encoder.board`, `Encoder.candidates`, `Encoder.seat`), so the engine can run the network
//! in-process instead of sending records to `ml/torch/serve.py`.
//!
//! It reads the same 512-byte request record the socket clients send (`prior::encode_request`), so
//! the in-process and socket paths see one definition of a position. Every output is a 0/1 float or
//! an integer, and `examples/h0_encode.rs` + `ml/torch/h0_encoding_parity.py` check that it equals
//! the Python encoder element for element.
//!
//! Everything is in the *mover's frame*: the board is rotated so the mover's home corner is cell 0
//! (`canonical_cell`), and seats are relative to the mover (0 mover, 1 next, 2 diagonal, 3 previous).
//!
//! | tensor | shape | dtype | contents |
//! |---|---|---|---|
//! | planes | (B, 13, 20, 20) | f32 | own ×4, edge halo ×4, open corners ×4, empty |
//! | hands | (B, 4, 21) | f32 | bit k of each relative seat's piece mask |
//! | footprint | (B, 64, 5) | i64 | canonical cells of each candidate, 400 pads |
//! | pieces | (B, 64) | i64 | piece id of each candidate, 0 on padding |
//! | mask | (B, 64) | bool | slot < candidate count |
//! | seat | (B,) | i64 | the mover's absolute seat |

use crate::bitboard::CELL_COUNT;
use crate::placements::placements;
use crate::position::{HOME_CORNER, SEAT_COUNT};
use crate::prior::{MAX_CANDIDATES, REQUEST_BYTES};

pub const PLANES: usize = 13;
pub const HAND_BITS: usize = 21;
pub const FOOTPRINT: usize = 5;
pub const PAD_CELL: i64 = CELL_COUNT as i64;
pub const PLANE_FLOATS: usize = PLANES * CELL_COUNT;

/// `features.canonical_cell`: board cell → cell in the frame where `seat`'s home corner is cell 0.
pub const fn canonical_cell(cell: usize, seat: usize) -> usize {
    let (x, y) = (cell % 20, cell / 20);
    match seat {
        1 => (19 - y) + 20 * x,
        2 => (19 - x) + 20 * (19 - y),
        3 => y + 20 * (19 - x),
        _ => cell,
    }
}

const fn canon_table() -> [[u16; CELL_COUNT]; SEAT_COUNT] {
    let mut t = [[0u16; CELL_COUNT]; SEAT_COUNT];
    let mut s = 0;
    while s < SEAT_COUNT {
        let mut c = 0;
        while c < CELL_COUNT {
            t[s][c] = canonical_cell(c, s) as u16;
            c += 1;
        }
        s += 1;
    }
    t
}

/// CANON[s][c]: canonical index of board cell c for mover seat s.
pub static CANON: [[u16; CELL_COUNT]; SEAT_COUNT] = canon_table();

/// A batch of encoded positions, laid out as the ONNX model's inputs. Reused across calls.
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub batch: usize,
    pub planes: Vec<f32>,
    pub hands: Vec<f32>,
    pub footprint: Vec<i64>,
    pub pieces: Vec<i64>,
    pub mask: Vec<bool>,
    pub seat: Vec<i64>,
}

impl Inputs {
    pub fn with_capacity(batch: usize) -> Inputs {
        Inputs {
            batch: 0,
            planes: Vec::with_capacity(batch * PLANE_FLOATS),
            hands: Vec::with_capacity(batch * SEAT_COUNT * HAND_BITS),
            footprint: Vec::with_capacity(batch * MAX_CANDIDATES * FOOTPRINT),
            pieces: Vec::with_capacity(batch * MAX_CANDIDATES),
            mask: Vec::with_capacity(batch * MAX_CANDIDATES),
            seat: Vec::with_capacity(batch),
        }
    }

    pub fn clear(&mut self) {
        self.batch = 0;
        self.planes.clear();
        self.hands.clear();
        self.footprint.clear();
        self.pieces.clear();
        self.mask.clear();
        self.seat.clear();
    }

    /// Append one request record (`prior::encode_request` layout; a self-play record works too).
    ///
    /// The haloes are computed on 448-bit boards in the board frame and then rotated, which gives
    /// the same planes as computing them in the canonical frame (a rotation maps neighbours to
    /// neighbours); `push_record_reference` is the cell-by-cell version, and the two are tested equal.
    pub fn push_record(&mut self, record: &[u8; REQUEST_BYTES]) {
        let mover = record[6] as usize % SEAT_COUNT;
        self.push_planes(record, mover);
        self.push_rest(record, mover);
    }

    /// Network v3 (hybrid H1): planes, hands and seat only; the candidate tensors stay empty (the v3
    /// network has no candidate inputs). The record's candidate fields are ignored.
    pub fn push_board(&mut self, record: &[u8; REQUEST_BYTES]) {
        let mover = record[6] as usize % SEAT_COUNT;
        self.push_planes(record, mover);
        self.push_hands(record, mover);
        self.seat.push(mover as i64);
        self.batch += 1;
    }

    /// The 13 planes of `push_record`.
    fn push_planes(&mut self, record: &[u8; REQUEST_BYTES], mover: usize) {
        let canon = &CANON[mover];
        let word = |at: usize| u32::from_le_bytes(record[at..at + 4].try_into().unwrap());
        let own: [Board; SEAT_COUNT] = std::array::from_fn(|r| {
            let seat = (mover + r) % SEAT_COUNT;
            let mut b = [0u64; BOARD_WORDS];
            for w in 0..13 {
                b[w / 2] |= (word(8 + 52 * seat + 4 * w) as u64) << (32 * (w % 2));
            }
            and(&b, &ON_BOARD)
        });
        let occ = or(&or(&own[0], &own[1]), &or(&own[2], &own[3]));

        let base = self.planes.len();
        self.planes.resize(base + PLANE_FLOATS, 0.0);
        let planes = &mut self.planes[base..];
        for r in 0..SEAT_COUNT {
            let o = &own[r];
            let orth = or(
                &or(&and(&shl(o, 1), &NOT_COL0), &and(&shr(o, 1), &NOT_COL19)),
                &or(&and(&shl(o, 20), &ON_BOARD), &shr(o, 20)),
            );
            let diag = or(
                &or(&and(&shl(o, 21), &NOT_COL0), &and(&shl(o, 19), &NOT_COL19)),
                &or(&and(&shr(o, 19), &NOT_COL0), &and(&shr(o, 21), &NOT_COL19)),
            );
            let edge = andnot(&orth, o);
            let mut open = andnot(&andnot(&andnot(&diag, o), &occ), &edge);
            // A seat that has not opened yet has its home corner as its only foothold.
            if o.iter().all(|&w| w == 0) {
                let home = HOME_CORNER[(mover + r) % SEAT_COUNT];
                if occ[home / 64] >> (home % 64) & 1 == 0 {
                    open[home / 64] |= 1 << (home % 64);
                }
            }
            scatter(o, canon, &mut planes[r * CELL_COUNT..(r + 1) * CELL_COUNT], 1.0);
            scatter(&edge, canon, &mut planes[(SEAT_COUNT + r) * CELL_COUNT..(SEAT_COUNT + r + 1) * CELL_COUNT], 1.0);
            scatter(&open, canon, &mut planes[(2 * SEAT_COUNT + r) * CELL_COUNT..(2 * SEAT_COUNT + r + 1) * CELL_COUNT], 1.0);
        }
        let empty = &mut planes[3 * SEAT_COUNT * CELL_COUNT..];
        empty.fill(1.0);
        scatter(&occ, canon, empty, 0.0);
    }

    /// The cell-by-cell encoder, a direct transcription of `features.py`; kept as the reference the
    /// bitboard version is tested against.
    pub fn push_record_reference(&mut self, record: &[u8; REQUEST_BYTES]) {
        let mover = record[6] as usize % SEAT_COUNT;
        let canon = &CANON[mover];
        let word = |at: usize| u32::from_le_bytes(record[at..at + 4].try_into().unwrap());

        // own[r]: relative seat r's stones in the canonical frame, as 0/1 bytes.
        let mut own = [[0u8; CELL_COUNT]; SEAT_COUNT];
        let mut stones = [0usize; SEAT_COUNT];
        for (r, plane) in own.iter_mut().enumerate() {
            let seat = (mover + r) % SEAT_COUNT;
            for w in 0..13 {
                let mut bits = word(8 + 52 * seat + 4 * w);
                while bits != 0 {
                    let cell = 32 * w + bits.trailing_zeros() as usize;
                    bits &= bits - 1;
                    if cell < CELL_COUNT {
                        plane[canon[cell] as usize] = 1;
                        stones[r] += 1;
                    }
                }
            }
        }
        let mut occ = [0u8; CELL_COUNT];
        for plane in &own {
            for (o, &v) in occ.iter_mut().zip(plane) {
                *o |= v;
            }
        }

        let base = self.planes.len();
        self.planes.resize(base + PLANE_FLOATS, 0.0);
        let planes = &mut self.planes[base..];
        for r in 0..SEAT_COUNT {
            let plane = &own[r];
            let (own_out, rest) = planes[r * CELL_COUNT..].split_at_mut(CELL_COUNT);
            let edge_out = &mut rest[(SEAT_COUNT - 1) * CELL_COUNT..SEAT_COUNT * CELL_COUNT];
            let mut edge = [0u8; CELL_COUNT];
            for c in 0..CELL_COUNT {
                if plane[c] == 1 {
                    own_out[c] = 1.0;
                    continue;
                }
                let (x, y) = (c % 20, c / 20);
                let orth = (x > 0 && plane[c - 1] == 1)
                    || (x < 19 && plane[c + 1] == 1)
                    || (y > 0 && plane[c - 20] == 1)
                    || (y < 19 && plane[c + 20] == 1);
                if orth {
                    edge[c] = 1;
                    edge_out[c] = 1.0;
                }
            }
            let corner_out = &mut planes[(2 * SEAT_COUNT + r) * CELL_COUNT..(2 * SEAT_COUNT + r + 1) * CELL_COUNT];
            for c in 0..CELL_COUNT {
                if plane[c] == 1 || occ[c] == 1 || edge[c] == 1 {
                    continue;
                }
                let (x, y) = (c % 20, c / 20);
                let diag = (x > 0 && y > 0 && plane[c - 21] == 1)
                    || (x < 19 && y > 0 && plane[c - 19] == 1)
                    || (x > 0 && y < 19 && plane[c + 19] == 1)
                    || (x < 19 && y < 19 && plane[c + 21] == 1);
                if diag {
                    corner_out[c] = 1.0;
                }
            }
            // A seat that has not opened yet has its home corner as its only foothold.
            if stones[r] == 0 {
                let home = canon[HOME_CORNER[(mover + r) % SEAT_COUNT]] as usize;
                if occ[home] == 0 {
                    corner_out[home] = 1.0;
                }
            }
        }
        let empty_out = &mut planes[3 * SEAT_COUNT * CELL_COUNT..];
        for (e, &o) in empty_out.iter_mut().zip(&occ) {
            *e = 1.0 - o as f32;
        }
        self.push_rest(record, mover);
    }

    /// The four relative hands.
    fn push_hands(&mut self, record: &[u8; REQUEST_BYTES], mover: usize) {
        let word = |at: usize| u32::from_le_bytes(record[at..at + 4].try_into().unwrap());
        for r in 0..SEAT_COUNT {
            let hand = word(216 + 4 * ((mover + r) % SEAT_COUNT));
            self.hands.extend((0..HAND_BITS).map(|k| ((hand >> k) & 1) as f32));
        }
    }

    /// Hands, candidates and seat (shared by both board encoders).
    fn push_rest(&mut self, record: &[u8; REQUEST_BYTES], mover: usize) {
        let canon = &CANON[mover];
        self.push_hands(record, mover);

        let t = placements();
        let count = record[236] as usize;
        for slot in 0..MAX_CANDIDATES {
            let valid = slot < count;
            let mv = u16::from_le_bytes([record[240 + 2 * slot], record[241 + 2 * slot]]) as usize;
            self.mask.push(valid);
            if valid {
                let cells = &t.cell_list[t.cell_start[mv] as usize..t.cell_start[mv + 1] as usize];
                for k in 0..FOOTPRINT {
                    self.footprint.push(cells.get(k).map_or(PAD_CELL, |&c| canon[c as usize] as i64));
                }
                self.pieces.push(t.piece_id[mv] as i64);
            } else {
                self.footprint.extend([PAD_CELL; FOOTPRINT]);
                self.pieces.push(0);
            }
        }
        self.seat.push(mover as i64);
        self.batch += 1;
    }
}

/// A board as 448 bits (cells 0..399 used), so shifts by a row (20) or a diagonal (19, 21) are plain
/// multi-word shifts.
type Board = [u64; BOARD_WORDS];
const BOARD_WORDS: usize = 7;

const fn board_where(keep: [bool; 2]) -> Board {
    // keep[0]: drop column 0; keep[1]: drop column 19 (both: only on-board cells are set).
    let mut b = [0u64; BOARD_WORDS];
    let mut c = 0;
    while c < CELL_COUNT {
        let x = c % 20;
        if !(keep[0] && x == 0) && !(keep[1] && x == 19) {
            b[c / 64] |= 1 << (c % 64);
        }
        c += 1;
    }
    b
}

const ON_BOARD: Board = board_where([false, false]);
const NOT_COL0: Board = board_where([true, false]);
const NOT_COL19: Board = board_where([false, true]);

#[inline(always)]
fn shl(b: &Board, n: u32) -> Board {
    std::array::from_fn(|i| (b[i] << n) | if i > 0 { b[i - 1] >> (64 - n) } else { 0 })
}

#[inline(always)]
fn shr(b: &Board, n: u32) -> Board {
    std::array::from_fn(|i| (b[i] >> n) | if i + 1 < BOARD_WORDS { b[i + 1] << (64 - n) } else { 0 })
}

#[inline(always)]
fn or(a: &Board, b: &Board) -> Board {
    std::array::from_fn(|i| a[i] | b[i])
}

#[inline(always)]
fn and(a: &Board, b: &Board) -> Board {
    std::array::from_fn(|i| a[i] & b[i])
}

#[inline(always)]
fn andnot(a: &Board, b: &Board) -> Board {
    std::array::from_fn(|i| a[i] & !b[i])
}

/// Writes `value` at the canonical cell of every set bit of `b`.
#[inline(always)]
fn scatter(b: &Board, canon: &[u16; CELL_COUNT], plane: &mut [f32], value: f32) {
    for (i, &w) in b.iter().enumerate() {
        let mut bits = w;
        while bits != 0 {
            let cell = 64 * i + bits.trailing_zeros() as usize;
            bits &= bits - 1;
            plane[canon[cell] as usize] = value;
        }
    }
}
