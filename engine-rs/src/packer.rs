//! Exact endgame packing of a sealed region (`packer.ts`, Formulation A).

use crate::bitboard::*;
use crate::config::EndgameParams;
use crate::placements::*;
use crate::position::{ALL_PLACED_BONUS, MAX_MOVES, MONOMINO_LAST_BONUS, Position};
use crate::territory::TerritoryMap;
use rustc_hash::FxHashMap;
use std::cell::RefCell;

#[derive(Clone, Debug)]
pub struct PackResult {
    pub score: i32,
    pub squares: i32,
    pub moves: Vec<i32>,
    pub proven: bool,
    pub nodes: u32,
}

struct Solver {
    seat: usize,
    node_budget: u32,
    memo_limit: usize,
    nodes: u32,
    exhausted: bool,
    memo: FxHashMap<u32, (u32, i32, Vec<i32>)>,
    reach: Mask,
    lines: Vec<Vec<i32>>,
    buffers: Vec<Vec<i32>>,
}

impl Solver {
    fn set_line(&mut self, depth: usize, line: Vec<i32>) {
        while self.lines.len() <= depth {
            self.lines.push(Vec::new());
        }
        self.lines[depth] = line;
    }

    fn solve(&mut self, position: &mut Position, depth: usize) -> i32 {
        self.nodes += 1;
        if self.nodes > self.node_budget {
            self.exhausted = true;
            self.set_line(depth, Vec::new());
            return 0;
        }
        if let Some((hi, value, line)) = self.memo.get(&position.hash_lo) {
            if *hi == position.hash_hi {
                let (value, line) = (*value, line.clone());
                self.set_line(depth, line);
                return value;
            }
        }
        let seat = self.seat;
        while self.buffers.len() <= depth {
            self.buffers.push(vec![0; MAX_MOVES]);
        }
        let mut moves = std::mem::take(&mut self.buffers[depth]);
        let count = position.generate_moves(seat, &mut moves, usize::MAX);
        if count == 0 {
            self.buffers[depth] = moves;
            self.set_line(depth, Vec::new());
            return 0;
        }
        let t = placements();
        let mut order: Vec<i32> = moves[..count].to_vec();
        self.buffers[depth] = moves;
        order.sort_by(|&a, &b| t.size[b as usize].cmp(&t.size[a as usize]).then(a.cmp(&b)));

        let hand_squares = position.hand_squares[seat];
        let headroom = coverable_cells(position, seat, &self.reach).min(hand_squares);
        let optimistic =
            if headroom == hand_squares { headroom + ALL_PLACED_BONUS + MONOMINO_LAST_BONUS } else { headroom };

        let mut best = 0;
        let mut best_line: Vec<i32> = Vec::new();
        for &mv in &order {
            if optimistic <= best {
                break;
            }
            let piece = t.piece_id[mv as usize] as usize;
            let size = PIECE_SIZES[piece];
            let undo = position.apply(mv);
            position.force_turn(seat);
            let (value, continuation) = if position.hand[seat] == 0 {
                let bonus = if piece == MONOMINO_PIECE_ID { MONOMINO_LAST_BONUS } else { 0 };
                (size + ALL_PLACED_BONUS + bonus, Vec::new())
            } else {
                let v = size + self.solve(position, depth + 1);
                (v, self.lines[depth + 1].clone())
            };
            position.undo(&undo);
            if value > best {
                best = value;
                let mut line = Vec::with_capacity(continuation.len() + 1);
                line.push(mv);
                line.extend_from_slice(&continuation);
                best_line = line;
            }
            if self.exhausted {
                break;
            }
        }
        self.set_line(depth, best_line.clone());
        if !self.exhausted {
            self.memo.insert(position.hash_lo, (position.hash_hi, best, best_line));
            if self.memo.len() > self.memo_limit {
                self.memo.clear();
            }
        }
        best
    }
}

fn coverable_cells(position: &Position, seat: usize, reach: &Mask) -> i32 {
    let edge = &position.edge_halo[seat];
    (0..WORDS).map(|w| (reach[w] & !position.occ[w] & !edge[w]).count_ones() as i32).sum()
}

thread_local! {
    /// Keyed by the position hash and seat. The result is a pure function of the position, so the
    /// cache changes speed, never play.
    static PACK_CACHE: RefCell<FxHashMap<(u32, u32, usize), PackResult>> = RefCell::new(FxHashMap::default());
}

pub fn clear_pack_cache() {
    PACK_CACHE.with(|c| c.borrow_mut().clear());
}

/// Solves the sealed region for `seat`; `None` when it is too large or too branchy.
pub fn solve_sealed_region(position: &Position, seat: usize, map: &TerritoryMap, params: &EndgameParams) -> Option<PackResult> {
    if map.reachable_count[seat] as f64 > params.max_region_cells {
        return None;
    }
    let key = (position.hash_hi, position.hash_lo, seat);
    if let Some(hit) = PACK_CACHE.with(|c| c.borrow().get(&key).cloned()) {
        return Some(hit);
    }
    let mut working = position.clone();
    working.force_turn(seat);
    let max_own = params.max_own_moves as usize;
    let mut probe = vec![0i32; max_own + 1];
    if working.generate_moves(seat, &mut probe, max_own + 1) > max_own {
        return None;
    }
    let mut solver = Solver {
        seat,
        node_budget: params.node_budget as u32,
        memo_limit: params.memo_limit as usize,
        nodes: 0,
        exhausted: false,
        memo: FxHashMap::default(),
        reach: map.reach[seat],
        lines: Vec::new(),
        buffers: Vec::new(),
    };
    solver.solve(&mut working, 0);
    let t = placements();
    let line = solver.lines.first().cloned().unwrap_or_default();
    let squares: i32 = line.iter().map(|&m| PIECE_SIZES[t.piece_id[m as usize] as usize]).sum();
    let remaining_after = position.hand_squares[seat] - squares;
    let score = if remaining_after == 0 {
        let monomino_last = line.last().is_some_and(|&m| t.piece_id[m as usize] as usize == MONOMINO_PIECE_ID);
        ALL_PLACED_BONUS + if monomino_last { MONOMINO_LAST_BONUS } else { 0 }
    } else {
        -remaining_after
    };
    let result = PackResult { score, squares, moves: line, proven: !solver.exhausted, nodes: solver.nodes };
    PACK_CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        cache.insert(key, result.clone());
        if cache.len() > 8192 {
            cache.clear();
        }
    });
    Some(result)
}
