//! Network v3's policy indexing in the engine (hybrid H1): placement id → index into the network's
//! 91 × 400 policy map, in the mover's frame. The same definition as `ml/torch/policy_index.py`, built
//! from the engine's own placement table and tested against the Python table element for element
//! (`examples/h1_policy_index.rs` + `ml/torch/h1_parity.py`).
//!
//! In the mover's frame (`net_features::canonical_cell`), a placement p of seat s is the placement p'
//! with the rotated cells; its index is `400 · (first_orientation[piece] + orientation) + 20 · min y +
//! min x` over p''s cells (the top-left corner of its bounding box).

use crate::bitboard::CELL_COUNT;
use crate::net_features::CANON;
use crate::placements::{PIECE_COUNT, placements};
use crate::position::SEAT_COUNT;
use rustc_hash::FxHashMap;
use std::sync::OnceLock;

pub const ORIENTATIONS: usize = 91;
pub const POLICY_SIZE: usize = ORIENTATIONS * CELL_COUNT;

pub struct PolicyTable {
    /// Board-frame placement id → policy index (for mover seat 0, whose frame is the board's).
    pub index: Vec<u16>,
    /// `policy[s][p]`: policy index of board placement p when seat s moves.
    pub policy: [Vec<u16>; SEAT_COUNT],
}

fn build() -> PolicyTable {
    let t = placements();
    let cells_of = |p: usize| &t.cell_list[t.cell_start[p] as usize..t.cell_start[p + 1] as usize];
    let mut per_piece = [0usize; PIECE_COUNT];
    for p in 0..t.count {
        let k = t.piece_id[p] as usize;
        per_piece[k] = per_piece[k].max(t.orientation[p] as usize + 1);
    }
    assert_eq!(per_piece.iter().sum::<usize>(), ORIENTATIONS, "orientation count");
    let mut first = [0usize; PIECE_COUNT];
    for k in 1..PIECE_COUNT {
        first[k] = first[k - 1] + per_piece[k - 1];
    }
    let key = |cells: &mut Vec<u16>| -> [u16; 5] {
        cells.sort_unstable();
        std::array::from_fn(|i| cells.get(i).copied().unwrap_or(CELL_COUNT as u16))
    };
    let mut by_cells: FxHashMap<[u16; 5], u32> = FxHashMap::default();
    let mut index = vec![0u16; t.count];
    for p in 0..t.count {
        let cells = cells_of(p);
        let x = cells.iter().map(|&c| c as usize % 20).min().unwrap();
        let y = cells.iter().map(|&c| c as usize / 20).min().unwrap();
        index[p] = (CELL_COUNT * (first[t.piece_id[p] as usize] + t.orientation[p] as usize) + 20 * y + x) as u16;
        let mut v: Vec<u16> = cells.iter().map(|&c| c as u16).collect();
        by_cells.insert(key(&mut v), p as u32);
    }
    let policy = std::array::from_fn(|s| {
        (0..t.count)
            .map(|p| {
                let mut v: Vec<u16> = cells_of(p).iter().map(|&c| CANON[s][c as usize]).collect();
                let q = by_cells[&key(&mut v)] as usize;
                index[q]
            })
            .collect()
    });
    PolicyTable { index, policy }
}

pub fn policy_table() -> &'static PolicyTable {
    static TABLE: OnceLock<PolicyTable> = OnceLock::new();
    TABLE.get_or_init(build)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_to_one_and_rotation_consistent() {
        let t = policy_table();
        let n = placements().count;
        let mut seen = vec![false; POLICY_SIZE];
        for p in 0..n {
            assert!(!seen[t.index[p] as usize]);
            seen[t.index[p] as usize] = true;
        }
        assert_eq!(t.policy[0], t.index, "seat 0's frame is the board's");
        for s in 0..SEAT_COUNT {
            let mut hit = vec![false; POLICY_SIZE];
            for p in 0..n {
                assert!(!hit[t.policy[s][p] as usize], "seat {s}: two placements share an index");
                hit[t.policy[s][p] as usize] = true;
            }
        }
    }
}
