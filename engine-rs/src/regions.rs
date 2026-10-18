//! Empty-space regions and articulation points (`regions.ts`).

use crate::bitboard::*;
use crate::position::SEAT_COUNT;

pub const NO_REGION: i16 = -1;

#[derive(Clone)]
pub struct RegionMap {
    pub label: [i16; CELL_COUNT],
    pub size: [i32; CELL_COUNT],
    pub count: usize,
}

impl RegionMap {
    pub fn new() -> Self {
        RegionMap { label: [NO_REGION; CELL_COUNT], size: [0; CELL_COUNT], count: 0 }
    }
}

impl Default for RegionMap {
    fn default() -> Self {
        Self::new()
    }
}

/// 4-connected components of the empty cells, labelled in ascending start-cell order.
pub fn label_regions(occ: &Mask, out: &mut RegionMap) {
    out.label = [NO_REGION; CELL_COUNT];
    let mut queue = [0u16; CELL_COUNT];
    let mut count = 0usize;
    for start in 0..CELL_COUNT {
        if test_bit(occ, start) || out.label[start] != NO_REGION {
            continue;
        }
        let id = count as i16;
        count += 1;
        let (mut head, mut tail) = (0usize, 0usize);
        queue[tail] = start as u16;
        tail += 1;
        out.label[start] = id;
        let mut cells = 0;
        while head < tail {
            let cell = queue[head] as usize;
            head += 1;
            cells += 1;
            let x = cell % BOARD_SIZE;
            let mut visit = |n: usize, tail: &mut usize| {
                if !test_bit(occ, n) && out.label[n] == NO_REGION {
                    out.label[n] = id;
                    queue[*tail] = n as u16;
                    *tail += 1;
                }
            };
            if x > 0 {
                visit(cell - 1, &mut tail);
            }
            if x < BOARD_SIZE - 1 {
                visit(cell + 1, &mut tail);
            }
            if cell >= BOARD_SIZE {
                visit(cell - BOARD_SIZE, &mut tail);
            }
            if cell + BOARD_SIZE < CELL_COUNT {
                visit(cell + BOARD_SIZE, &mut tail);
            }
        }
        out.size[id as usize] = cells;
    }
    out.count = count;
}

#[inline(always)]
fn neighbour(cell: usize, direction: u8) -> i32 {
    let x = cell % BOARD_SIZE;
    match direction {
        0 => if x > 0 { cell as i32 - 1 } else { -1 },
        1 => if x < BOARD_SIZE - 1 { cell as i32 + 1 } else { -1 },
        2 => if cell >= BOARD_SIZE { (cell - BOARD_SIZE) as i32 } else { -1 },
        _ => if cell + BOARD_SIZE < CELL_COUNT { (cell + BOARD_SIZE) as i32 } else { -1 },
    }
}

/// Articulation points of the empty-cell graph, iterative Tarjan.
pub fn articulation_points(occ: &Mask, out: &mut [u8; CELL_COUNT]) {
    *out = [0; CELL_COUNT];
    let mut disc = [0i32; CELL_COUNT];
    let mut low = [0i32; CELL_COUNT];
    let mut parent = [0i32; CELL_COUNT];
    let mut iterator = [0u8; CELL_COUNT];
    let mut stack = [0u16; CELL_COUNT];
    let mut timer = 0;
    for root in 0..CELL_COUNT {
        if test_bit(occ, root) || disc[root] != 0 {
            continue;
        }
        let mut top: isize = 0;
        stack[0] = root as u16;
        parent[root] = -1;
        iterator[root] = 0;
        timer += 1;
        disc[root] = timer;
        low[root] = timer;
        let mut root_children = 0;
        while top >= 0 {
            let cell = stack[top as usize] as usize;
            let direction = iterator[cell];
            if direction < 4 {
                iterator[cell] = direction + 1;
                let next = neighbour(cell, direction);
                if next < 0 || test_bit(occ, next as usize) {
                    continue;
                }
                let next = next as usize;
                if disc[next] == 0 {
                    parent[next] = cell as i32;
                    iterator[next] = 0;
                    timer += 1;
                    disc[next] = timer;
                    low[next] = timer;
                    if cell == root {
                        root_children += 1;
                    }
                    top += 1;
                    stack[top as usize] = next as u16;
                } else if next as i32 != parent[cell] && disc[next] < low[cell] {
                    low[cell] = disc[next];
                }
                continue;
            }
            top -= 1;
            let up = parent[cell];
            if up >= 0 {
                let up = up as usize;
                if low[cell] < low[up] {
                    low[up] = low[cell];
                }
                if up != root && low[cell] >= disc[up] {
                    out[up] = 1;
                }
            }
        }
        if root_children > 1 {
            out[root] = 1;
        }
    }
}

/// Open corners per (region, seat), plus totals per region.
#[derive(Clone)]
pub struct RegionOwnership {
    pub count: usize,
    pub corners: Vec<i32>,
    pub total_corners: Vec<i32>,
}

impl RegionOwnership {
    pub fn new() -> Self {
        RegionOwnership { count: 0, corners: vec![0; CELL_COUNT * SEAT_COUNT], total_corners: vec![0; CELL_COUNT] }
    }
}

impl Default for RegionOwnership {
    fn default() -> Self {
        Self::new()
    }
}

pub fn region_ownership(regions: &RegionMap, open_corners: &[Mask; SEAT_COUNT], out: &mut RegionOwnership) {
    out.corners[..regions.count * SEAT_COUNT].fill(0);
    out.total_corners[..regions.count].fill(0);
    for seat in 0..SEAT_COUNT {
        let mut cells = [0i32; CELL_COUNT];
        let n = to_indices(&open_corners[seat], &mut cells);
        for &cell in &cells[..n] {
            let region = regions.label[cell as usize];
            if region == NO_REGION {
                continue;
            }
            out.corners[region as usize * SEAT_COUNT + seat] += 1;
            out.total_corners[region as usize] += 1;
        }
    }
    out.count = regions.count;
}

/// `own_share_i(r)`: the region's cells split between the seats holding corners in it.
#[inline]
pub fn own_share(ownership: &RegionOwnership, sizes: &[i32; CELL_COUNT], region: usize, seat: usize) -> f64 {
    let total = ownership.total_corners[region];
    if total == 0 {
        return 0.0;
    }
    (sizes[region] as f64 * ownership.corners[region * SEAT_COUNT + seat] as f64) / total as f64
}
