//! Move ordering, the PUCT prior and progressive history (`ordering.ts`).

use crate::bitboard::*;
use crate::config::{BitboardParams, Phase};
use crate::features::{EvalContext, evaluate, lambda_for, refresh_context};
use crate::jsmath;
use crate::placements::*;
use crate::position::{Position, SEAT_COUNT};
use crate::regions::*;
use std::cmp::Ordering;

/// Progressive history keyed by (placement, seat). The sum is a Float32Array in TS, so each update
/// rounds the f64 sum back to f32 exactly as a typed-array store does.
pub struct HistoryTable {
    sum: Vec<f32>,
    count: Vec<i32>,
}

impl HistoryTable {
    pub fn new() -> Self {
        let n = placements().count * SEAT_COUNT;
        HistoryTable { sum: vec![0.0; n], count: vec![0; n] }
    }

    #[inline(always)]
    pub fn update(&mut self, seat: usize, mv: i32, value: f64) {
        let index = mv as usize * SEAT_COUNT + seat;
        self.sum[index] = (self.sum[index] as f64 + value) as f32;
        self.count[index] += 1;
    }

    #[inline(always)]
    pub fn score(&self, seat: usize, mv: i32) -> f64 {
        let index = mv as usize * SEAT_COUNT + seat;
        let visits = self.count[index];
        if visits == 0 { 0.0 } else { self.sum[index] as f64 / visits as f64 }
    }

    pub fn clear(&mut self) {
        self.sum.fill(0.0);
        self.count.fill(0);
    }
}

impl Default for HistoryTable {
    fn default() -> Self {
        Self::new()
    }
}

pub struct MoveOrderer {
    after_regions: RegionMap,
    after_ownership: RegionOwnership,
}

impl MoveOrderer {
    pub fn new() -> Self {
        MoveOrderer { after_regions: RegionMap::new(), after_ownership: RegionOwnership::new() }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn score_moves(
        &mut self,
        params: &BitboardParams,
        position: &Position,
        context: &EvalContext,
        seat: usize,
        moves: &[i32],
        out: &mut [f64],
        phase: Phase,
        with_split: bool,
        split_budget: i32,
    ) {
        let t = placements();
        let weights = params.ordering.get(phase);
        let lambda_profile = params.lambda.get(phase);
        let occ = &position.occ;
        let own_edge = &position.edge_halo[seat];
        let lambdas: [f64; SEAT_COUNT] = std::array::from_fn(|other| {
            if other == seat { 0.0 } else { lambda_for(params, lambda_profile, seat, other, context.leader) }
        });
        let mut split_budget = if with_split { split_budget } else { 0 };
        let baseline = if split_budget > 0 { region_value(context, seat, &lambdas) } else { 0.0 };

        for (i, &mv) in moves.iter().enumerate() {
            let m = mv as usize;
            let mut score = t.size[m] as f64 * weights.piece_size;
            score -= t.centre_distance[m] as f64 * weights.centre_pull;
            let (cells, edge, corner) = (&t.cells[m], &t.edge_halo[m], &t.corner_halo[m]);
            let mut created = 0;
            for w in 0..WORDS {
                created += (corner[w] & !occ[w] & !cells[w] & !own_edge[w] & !edge[w]).count_ones();
            }
            score += created as f64 * weights.new_corners;
            for other in 0..SEAT_COUNT {
                if lambdas[other] == 0.0 {
                    continue;
                }
                let corners = &context.territory.open_corners[other];
                let mut denied = 0;
                for w in 0..WORDS {
                    denied += (corners[w] & cells[w]).count_ones();
                }
                if denied != 0 {
                    score += denied as f64 * weights.deny_corners * lambdas[other];
                }
            }
            if split_budget > 0 && touches_articulation(context, m) {
                split_budget -= 1;
                score += weights.split * self.split_delta(position, seat, m, &lambdas, baseline);
            }
            out[i] = score;
        }
    }

    fn split_delta(&mut self, position: &Position, seat: usize, m: usize, lambdas: &[f64; SEAT_COUNT], baseline: f64) -> f64 {
        let t = placements();
        let mut after_occ = EMPTY;
        for w in 0..WORDS {
            after_occ[w] = position.occ[w] | t.cells[m][w];
        }
        label_regions(&after_occ, &mut self.after_regions);
        let after_corners: [Mask; SEAT_COUNT] = std::array::from_fn(|other| {
            let (corner, edge) = (&position.corner_halo[other], &position.edge_halo[other]);
            let mut dst = EMPTY;
            for w in 0..WORDS {
                dst[w] = if other == seat {
                    let grown_corner = corner[w] | t.corner_halo[m][w];
                    let grown_edge = edge[w] | t.edge_halo[m][w];
                    grown_corner & !after_occ[w] & !grown_edge
                } else {
                    corner[w] & !after_occ[w] & !edge[w]
                };
            }
            dst
        });
        region_ownership(&self.after_regions, &after_corners, &mut self.after_ownership);
        let (ownership, sizes) = (&self.after_ownership, &self.after_regions.size);
        let mut after = 0.0;
        for region in 0..ownership.count {
            after += own_share(ownership, sizes, region, seat);
            for other in 0..SEAT_COUNT {
                if lambdas[other] != 0.0 {
                    after -= lambdas[other] * own_share(ownership, sizes, region, other);
                }
            }
        }
        after - baseline
    }

    /// Apply the move, re-run the full evaluation and take the change in this seat's component.
    #[allow(clippy::too_many_arguments)]
    pub fn deep_score(
        &self,
        params: &BitboardParams,
        position: &mut Position,
        scratch: &mut EvalContext,
        seat: usize,
        mv: i32,
        phase: Phase,
        before: f64,
    ) -> f64 {
        let undo = position.apply(mv);
        refresh_context(scratch, position, false);
        let after = evaluate(scratch, position, params, phase)[seat];
        position.undo(&undo);
        after - before
    }
}

impl Default for MoveOrderer {
    fn default() -> Self {
        Self::new()
    }
}

fn touches_articulation(context: &EvalContext, m: usize) -> bool {
    if !context.has_articulation {
        return false;
    }
    let t = placements();
    (t.cell_start[m]..t.cell_start[m + 1]).any(|i| context.articulation[t.cell_list[i as usize] as usize] == 1)
}

fn region_value(context: &EvalContext, seat: usize, lambdas: &[f64; SEAT_COUNT]) -> f64 {
    let (ownership, sizes) = (&context.ownership, &context.regions.size);
    let mut total = 0.0;
    for region in 0..ownership.count {
        total += own_share(ownership, sizes, region, seat);
        for other in 0..SEAT_COUNT {
            if lambdas[other] != 0.0 {
                total -= lambdas[other] * own_share(ownership, sizes, region, other);
            }
        }
    }
    total
}

/// Softmax of ordering scores — the heuristic stands in for a policy net.
pub fn softmax_priors(scores: &[f64], temperature: f64, out: &mut [f64]) {
    if scores.is_empty() {
        return;
    }
    let max = scores.iter().copied().fold(f64::NEG_INFINITY, |m, s| if s > m { s } else { m });
    let temp = f64::max(1e-6, temperature);
    let mut total = 0.0;
    for (i, &s) in scores.iter().enumerate() {
        let value = jsmath::exp((s - max) / temp);
        out[i] = value;
        total += value;
    }
    let norm = if total > 0.0 { total } else { 1.0 };
    for value in out[..scores.len()].iter_mut() {
        *value /= norm;
    }
}

/// Descending by score, ascending by placement id on ties — a total order, so any sort agrees.
pub fn sort_by_score(moves: &mut [i32], scores: &mut [f64]) {
    let mut order: Vec<usize> = (0..moves.len()).collect();
    order.sort_by(|&a, &b| match scores[b].partial_cmp(&scores[a]) {
        Some(Ordering::Equal) | None => moves[a].cmp(&moves[b]),
        Some(o) => o,
    });
    let (m, s): (Vec<i32>, Vec<f64>) = order.iter().map(|&i| (moves[i], scores[i])).unzip();
    moves.copy_from_slice(&m);
    scores.copy_from_slice(&s);
}
