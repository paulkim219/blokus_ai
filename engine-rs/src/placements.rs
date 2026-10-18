//! The precomputed placement table, built exactly as `placements.ts` builds it.
//!
//! Placement ids are part of the contract with the TS engine (they cross the worker protocol and
//! decide every tie-break that falls back to `a - b`), so the piece list, the orientation order and
//! the piece-major / orientation / row-major anchor numbering are all reproduced verbatim.

use crate::bitboard::*;
use std::sync::OnceLock;

pub const PIECE_COUNT: usize = 21;
pub const ALL_PIECES_MASK: u32 = (1 << PIECE_COUNT) - 1;
pub const MONOMINO_PIECE_ID: usize = 0;

/// `src/engine/pieces.ts` RAW_PIECES, in id order.
pub const RAW_PIECES: [(&str, &[(i32, i32)]); PIECE_COUNT] = [
    ("I1", &[(0, 0)]),
    ("I2", &[(0, 0), (1, 0)]),
    ("I3", &[(0, 0), (1, 0), (2, 0)]),
    ("L3", &[(0, 0), (1, 0), (0, 1)]),
    ("I4", &[(0, 0), (1, 0), (2, 0), (3, 0)]),
    ("O4", &[(0, 0), (1, 0), (0, 1), (1, 1)]),
    ("T4", &[(0, 0), (1, 0), (2, 0), (1, 1)]),
    ("L4", &[(0, 0), (1, 0), (2, 0), (0, 1)]),
    ("Z4", &[(0, 0), (1, 0), (1, 1), (2, 1)]),
    ("I5", &[(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]),
    ("L5", &[(0, 0), (1, 0), (2, 0), (3, 0), (0, 1)]),
    ("Y5", &[(0, 0), (1, 0), (2, 0), (3, 0), (1, 1)]),
    ("N5", &[(0, 0), (1, 0), (2, 0), (2, 1), (3, 1)]),
    ("V5", &[(0, 0), (0, 1), (0, 2), (1, 2), (2, 2)]),
    ("T5", &[(0, 0), (1, 0), (2, 0), (1, 1), (1, 2)]),
    ("Z5", &[(0, 0), (1, 0), (1, 1), (1, 2), (2, 2)]),
    ("U5", &[(0, 0), (2, 0), (0, 1), (1, 1), (2, 1)]),
    ("W5", &[(0, 0), (1, 0), (1, 1), (2, 1), (2, 2)]),
    ("P5", &[(0, 0), (1, 0), (0, 1), (1, 1), (0, 2)]),
    ("F5", &[(0, 0), (1, 0), (1, 1), (2, 1), (1, 2)]),
    ("X5", &[(1, 0), (0, 1), (1, 1), (2, 1), (1, 2)]),
];

pub const PIECE_SIZES: [i32; PIECE_COUNT] = {
    let mut sizes = [0; PIECE_COUNT];
    let mut i = 0;
    while i < PIECE_COUNT {
        sizes[i] = RAW_PIECES[i].1.len() as i32;
        i += 1;
    }
    sizes
};

pub const TOTAL_SQUARES: i32 = 89;

type Shape = Vec<(i32, i32)>;

fn normalize(cells: &[(i32, i32)]) -> Shape {
    let min_x = cells.iter().map(|c| c.0).min().unwrap();
    let min_y = cells.iter().map(|c| c.1).min().unwrap();
    let mut out: Shape = cells.iter().map(|&(x, y)| (x - min_x, y - min_y)).collect();
    out.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    out
}

fn rotate90(cells: &[(i32, i32)]) -> Shape {
    normalize(&cells.iter().map(|&(x, y)| (y, -x)).collect::<Vec<_>>())
}

fn reflect_x(cells: &[(i32, i32)]) -> Shape {
    normalize(&cells.iter().map(|&(x, y)| (-x, y)).collect::<Vec<_>>())
}

/// `generateOrientations` — order matters: it fixes every orientation index.
pub fn orientations(piece: usize) -> Vec<Shape> {
    let mut seen: Vec<Shape> = Vec::new();
    let mut current = normalize(RAW_PIECES[piece].1);
    for _flip in 0..2 {
        for _rot in 0..4 {
            if !seen.contains(&current) {
                seen.push(current.clone());
            }
            current = rotate90(&current);
        }
        current = reflect_x(&current);
    }
    seen
}

pub struct PlacementTable {
    pub count: usize,
    pub cells: Vec<Mask>,
    pub edge_halo: Vec<Mask>,
    pub corner_halo: Vec<Mask>,
    pub mask_lo: Vec<u8>,
    pub mask_hi: Vec<u8>,
    pub cover_piece_start: Vec<i32>,
    pub piece_id: Vec<u8>,
    pub orientation: Vec<u8>,
    pub size: Vec<u8>,
    pub anchor_x: Vec<u8>,
    pub anchor_y: Vec<u8>,
    /// Float32 in TS, so stored as f32 here and widened at every use exactly as JS does.
    pub centre_distance: Vec<f32>,
    pub cell_start: Vec<i32>,
    pub cell_list: Vec<i32>,
    pub cover_start: Vec<i32>,
    pub cover_list: Vec<i32>,
    pub base: Vec<i32>,
    pub span_x: Vec<i32>,
    pub span_y: Vec<i32>,
    /// Static popcounts of the haloes, shared by the rollout policies.
    pub corner_halo_count: Vec<f32>,
    pub edge_halo_count: Vec<f32>,
    /// Parallel to `cover_list`: which [`LocalShape`] that placement has around that cover cell.
    pub cover_shape: Vec<u16>,
    /// Distinct (cells, edge halo) shapes in the 11×11 window centred on the cover cell.
    pub shapes: Vec<LocalShape>,
}

/// Side of the local window around a cover cell. A placement covering cell `c` reaches at most 4
/// squares from `c`, and its edge halo one more, so everything a legality test reads lies within
/// 5 squares: an 11×11 window, which packs into one u128.
pub const WINDOW: usize = 11;
const WINDOW_RADIUS: isize = 5;

/// A placement's cells and *unclipped* edge halo, relative to the cover cell. Unclipped is safe
/// because the board windows it is tested against are zero off the board.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct LocalShape {
    pub cells: u128,
    pub edge: u128,
}

#[inline(always)]
fn window_bit(dx: isize, dy: isize) -> u128 {
    debug_assert!(dx.abs() <= WINDOW_RADIUS && dy.abs() <= WINDOW_RADIUS);
    1u128 << ((dy + WINDOW_RADIUS) as usize * WINDOW + (dx + WINDOW_RADIUS) as usize)
}

/// One 20-bit row per board row, for building local windows.
#[inline(always)]
pub fn board_rows(mask: &Mask) -> [u32; BOARD_SIZE] {
    let mut rows = [0u32; BOARD_SIZE];
    for (y, row) in rows.iter_mut().enumerate() {
        let bit = y * BOARD_SIZE;
        let (word, shift) = (bit >> 5, bit & 31);
        let lo = mask[word] as u64;
        let hi = if word + 1 < WORDS { mask[word + 1] as u64 } else { 0 };
        *row = (((lo | (hi << 32)) >> shift) & 0xfffff) as u32;
    }
    rows
}

/// The 11×11 window of `rows` centred on (cx, cy), zero outside the board.
#[inline(always)]
pub fn local_window(rows: &[u32; BOARD_SIZE], cx: usize, cy: usize) -> u128 {
    let mut window = 0u128;
    let y_start = cy as isize - WINDOW_RADIUS;
    for r in 0..WINDOW {
        let y = y_start + r as isize;
        if !(0..BOARD_SIZE as isize).contains(&y) {
            continue;
        }
        let row = rows[y as usize] as u64;
        // Column cx-5 → bit 0; shifting left first keeps columns left of the board at zero.
        let bits = ((row << WINDOW_RADIUS) >> cx) & ((1 << WINDOW) - 1);
        window |= (bits as u128) << (r * WINDOW);
    }
    window
}

fn build() -> PlacementTable {
    let slots = PIECE_COUNT * 8;
    let mut base = vec![-1i32; slots];
    let mut span_x = vec![0i32; slots];
    let mut span_y = vec![0i32; slots];
    let all_orientations: Vec<Vec<Shape>> = (0..PIECE_COUNT).map(orientations).collect();

    let mut count = 0usize;
    let mut cell_total = 0usize;
    for piece in 0..PIECE_COUNT {
        for (o, shape) in all_orientations[piece].iter().enumerate() {
            let w = shape.iter().map(|c| c.0 + 1).max().unwrap();
            let h = shape.iter().map(|c| c.1 + 1).max().unwrap();
            let sx = BOARD_SIZE as i32 - w + 1;
            let sy = BOARD_SIZE as i32 - h + 1;
            let key = piece * 8 + o;
            base[key] = count as i32;
            span_x[key] = sx;
            span_y[key] = sy;
            count += (sx * sy) as usize;
            cell_total += (sx * sy) as usize * shape.len();
        }
    }

    let mut t = PlacementTable {
        count,
        cells: vec![EMPTY; count],
        edge_halo: vec![EMPTY; count],
        corner_halo: vec![EMPTY; count],
        mask_lo: vec![0; count],
        mask_hi: vec![0; count],
        cover_piece_start: vec![0; CELL_COUNT * (PIECE_COUNT + 1)],
        piece_id: vec![0; count],
        orientation: vec![0; count],
        size: vec![0; count],
        anchor_x: vec![0; count],
        anchor_y: vec![0; count],
        centre_distance: vec![0.0; count],
        cell_start: vec![0; count + 1],
        cell_list: vec![0; cell_total],
        cover_start: vec![0; CELL_COUNT + 1],
        cover_list: vec![0; cell_total],
        base,
        span_x,
        span_y,
        corner_halo_count: vec![0.0; count],
        edge_halo_count: vec![0.0; count],
        cover_shape: Vec::new(),
        shapes: Vec::new(),
    };

    let centre = (BOARD_SIZE as f64 - 1.0) / 2.0;
    let mut cover_counts = vec![0i32; CELL_COUNT];
    let mut scratch = [0i32; CELL_COUNT];
    let mut id = 0usize;
    let mut cursor = 0usize;
    for piece in 0..PIECE_COUNT {
        for (o, shape) in all_orientations[piece].iter().enumerate() {
            let key = piece * 8 + o;
            let (sx, sy) = (t.span_x[key], t.span_y[key]);
            for ay in 0..sy {
                for ax in 0..sx {
                    let mut cells = EMPTY;
                    let mut centre_sum = 0.0f64;
                    for &(cx, cy) in shape {
                        let x = cx + ax;
                        let y = cy + ay;
                        set_bit(&mut cells, cell_index(x as usize, y as usize));
                        centre_sum += (x as f64 - centre).abs() + (y as f64 - centre).abs();
                    }
                    t.cells[id] = cells;
                    let mut edge = dilate_orthogonal(&cells);
                    and_not_into(&mut edge, &cells);
                    t.edge_halo[id] = edge;
                    let mut corner = dilate_diagonal(&cells);
                    and_not_into(&mut corner, &cells);
                    t.corner_halo[id] = corner;

                    let mut lo = WORDS;
                    let mut hi = 0;
                    for w in 0..WORDS {
                        if cells[w] != 0 || edge[w] != 0 {
                            if w < lo {
                                lo = w;
                            }
                            hi = w + 1;
                        }
                    }
                    t.mask_lo[id] = lo as u8;
                    t.mask_hi[id] = hi as u8;
                    t.piece_id[id] = piece as u8;
                    t.orientation[id] = o as u8;
                    t.size[id] = shape.len() as u8;
                    t.anchor_x[id] = ax as u8;
                    t.anchor_y[id] = ay as u8;
                    t.centre_distance[id] = (centre_sum / shape.len() as f64) as f32;
                    t.corner_halo_count[id] = popcount(&corner) as f32;
                    t.edge_halo_count[id] = popcount(&edge) as f32;

                    t.cell_start[id] = cursor as i32;
                    let written = to_indices(&cells, &mut scratch);
                    for i in 0..written {
                        let index = scratch[i];
                        t.cell_list[cursor + i] = index;
                        cover_counts[index as usize] += 1;
                    }
                    cursor += written;
                    id += 1;
                }
            }
        }
    }
    t.cell_start[count] = cursor as i32;

    let mut running = 0;
    for c in 0..CELL_COUNT {
        t.cover_start[c] = running;
        running += cover_counts[c];
    }
    t.cover_start[CELL_COUNT] = running;

    let mut fill: Vec<i32> = t.cover_start[..CELL_COUNT].to_vec();
    for p in 0..count {
        for i in t.cell_start[p]..t.cell_start[p + 1] {
            let index = t.cell_list[i as usize] as usize;
            t.cover_list[fill[index] as usize] = p as i32;
            fill[index] += 1;
        }
    }

    for c in 0..CELL_COUNT {
        let b = c * (PIECE_COUNT + 1);
        let end = t.cover_start[c + 1];
        let mut i = t.cover_start[c];
        for piece in 0..PIECE_COUNT {
            t.cover_piece_start[b + piece] = i;
            while i < end && t.piece_id[t.cover_list[i as usize] as usize] as usize == piece {
                i += 1;
            }
        }
        t.cover_piece_start[b + PIECE_COUNT] = i;
    }

    // Local shapes, deduplicated: a (piece, orientation, square-at-the-cover-cell) triple gives the
    // same window shape everywhere on the board, so a few hundred cover ~115k cover entries.
    let mut index: std::collections::HashMap<LocalShape, u16> = std::collections::HashMap::new();
    t.cover_shape = vec![0; t.cover_list.len()];
    for c in 0..CELL_COUNT {
        let (cx, cy) = ((c % BOARD_SIZE) as isize, (c / BOARD_SIZE) as isize);
        for i in t.cover_start[c] as usize..t.cover_start[c + 1] as usize {
            let p = t.cover_list[i] as usize;
            let mut shape = LocalShape { cells: 0, edge: 0 };
            let start = t.cell_start[p] as usize;
            let end = t.cell_start[p + 1] as usize;
            for &cell in &t.cell_list[start..end] {
                let (x, y) = ((cell as usize % BOARD_SIZE) as isize, (cell as usize / BOARD_SIZE) as isize);
                shape.cells |= window_bit(x - cx, y - cy);
            }
            for &cell in &t.cell_list[start..end] {
                let (x, y) = ((cell as usize % BOARD_SIZE) as isize, (cell as usize / BOARD_SIZE) as isize);
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let bit = window_bit(x + dx - cx, y + dy - cy);
                    if shape.cells & bit == 0 {
                        shape.edge |= bit;
                    }
                }
            }
            let next = index.len() as u16;
            t.cover_shape[i] = *index.entry(shape).or_insert(next);
        }
    }
    let mut shapes = vec![LocalShape { cells: 0, edge: 0 }; index.len()];
    for (shape, id) in index {
        shapes[id as usize] = shape;
    }
    t.shapes = shapes;
    t
}

static TABLE: OnceLock<PlacementTable> = OnceLock::new();

#[inline(always)]
pub fn placements() -> &'static PlacementTable {
    TABLE.get_or_init(build)
}

pub fn placement_id(piece: usize, orientation: usize, anchor_x: i32, anchor_y: i32) -> i32 {
    let t = placements();
    let key = piece * 8 + orientation;
    if key >= t.base.len() || t.base[key] < 0 {
        return -1;
    }
    let (sx, sy) = (t.span_x[key], t.span_y[key]);
    if anchor_x < 0 || anchor_y < 0 || anchor_x >= sx || anchor_y >= sy {
        return -1;
    }
    t.base[key] + anchor_y * sx + anchor_x
}

pub fn remaining_squares(hand: u32) -> i32 {
    let mut total = 0;
    let mut bits = hand;
    while bits != 0 {
        total += PIECE_SIZES[bits.trailing_zeros() as usize];
        bits &= bits - 1;
    }
    total
}

pub fn smallest_remaining(hand: u32) -> i32 {
    let mut best = 0;
    let mut bits = hand;
    while bits != 0 {
        let size = PIECE_SIZES[bits.trailing_zeros() as usize];
        if best == 0 || size < best {
            best = size;
        }
        bits &= bits - 1;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_has_91_orientations_and_expected_size() {
        let total: usize = (0..PIECE_COUNT).map(|p| orientations(p).len()).sum();
        assert_eq!(total, 91);
        assert_eq!(TOTAL_SQUARES, PIECE_SIZES.iter().sum::<i32>());
        assert!(placements().count > 25_000);
    }
}
