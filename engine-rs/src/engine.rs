//! Move selection for one seat (`bitboard/index.ts`): opening shortcut, sealed-region packer,
//! MCTS, and the tree-free greedy ranker. Iteration-budgeted only — the clock path is never
//! deterministic and no measurement in this repo uses it.

use crate::config::{BitboardParams, Phase};
use crate::features::{EvalContext, detect_phase, evaluate, refresh_context};
use crate::jsmath;
use crate::ordering::{MoveOrderer, sort_by_score};
use crate::packer::solve_sealed_region;
use crate::placements::*;
use crate::position::{Position, new_move_buffer};
use crate::rng::Rng;
use crate::rollout_policy::RolloutPolicy;
use crate::search::V12Search;
use crate::territory::is_sealed;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct Ranked {
    pub mv: i32,
    pub visits: i32,
    pub value: f64,
}

/// Where a move decision came from — matters to anyone training on the decisions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Source {
    #[default]
    Search,
    /// The opening shortcut: tier-1 ordering, no tree. `visits` are synthetic ranks.
    Heuristic,
    /// The exact packer on a sealed region. `visits` are synthetic ranks.
    Packer,
    Greedy,
}

#[derive(Clone, Debug, Default)]
pub struct MoveStats {
    pub iterations: u32,
    pub searched: bool,
    pub source: Source,
}

/// A configured engine: resolved params plus any artifacts they name, with a reusable search.
pub struct Engine {
    pub params: Arc<BitboardParams>,
    search: V12Search,
    context: EvalContext,
    orderer: MoveOrderer,
}

impl Engine {
    pub fn new(params: BitboardParams, table: Option<Arc<RolloutPolicy>>) -> Result<Engine, String> {
        let problems = params.unsupported();
        if !problems.is_empty() {
            return Err(format!("unsupported by the native engine: {}", problems.join(", ")));
        }
        if params.search.playout_policy == "table" && table.is_none() {
            return Err("playout asked for the table policy but no artifact was loaded".into());
        }
        let params = Arc::new(params);
        let mut search = V12Search::new(Arc::clone(&params), table);
        search.connect_prior()?;
        Ok(Engine {
            search,
            context: EvalContext::new(params.fractional_territory_ties),
            orderer: MoveOrderer::new(),
            params,
        })
    }

    fn own_moves_played(position: &Position, seat: usize) -> i32 {
        PIECE_COUNT as i32 - position.hand[seat].count_ones() as i32
    }

    /// `searchBestMoveV12` with an iteration budget. Returns the ranked root moves, best first.
    pub fn search(&mut self, position: &mut Position, seat: usize, budget: u32, rng: &mut Rng, stats: &mut MoveStats) -> Vec<Ranked> {
        if position.turn != seat {
            position.force_turn(seat);
        }
        let params = Arc::clone(&self.params);
        let s = &params.search;
        refresh_context(&mut self.context, position, false);
        let phase = detect_phase(position, &self.context, &params, seat);
        let own_moves = Self::own_moves_played(position, seat);
        let shape = shape_at(s.iteration_shape.as_deref(), own_moves);
        let scaled = f64::max(1.0, jsmath::round(budget as f64 * s.iteration_scale * shape)) as u32;

        let heuristic_max = s.opening_heuristic_max_own_move.unwrap_or(0.0);
        if heuristic_max > 0.0 && (own_moves as f64) < heuristic_max {
            let selected = self.heuristic_opening_moves(position, seat, phase, 3);
            if !selected.is_empty() {
                stats.source = Source::Heuristic;
                let n = selected.len() as i32;
                return selected
                    .into_iter()
                    .enumerate()
                    .map(|(i, (mv, score))| Ranked { mv, visits: n - i as i32, value: score })
                    .collect();
            }
        }

        if is_sealed(&self.context.territory, seat) {
            if let Some(plan) = solve_sealed_region(position, seat, &self.context.territory, &params.endgame) {
                if !plan.moves.is_empty() {
                    stats.source = Source::Packer;
                    let n = plan.moves.len() as i32;
                    return plan
                        .moves
                        .iter()
                        .enumerate()
                        .map(|(i, &mv)| Ranked {
                            mv,
                            visits: n - i as i32,
                            value: if i == 0 { plan.score as f64 } else { (plan.score - i as i32) as f64 },
                        })
                        .collect();
                }
            }
        }

        let candidates = self.search.prepare(position, seat);
        if candidates == 0 {
            return Vec::new();
        }
        while self.search.advance(position, 64, scaled, rng) {}
        let outcome = self.search.result();
        stats.iterations += outcome.iterations;
        stats.searched = true;
        stats.source = Source::Search;
        let mut ranked = outcome.ranked;

        let offset = s.opening_rank_offset.unwrap_or(0.0) as usize;
        let offset_max = s.opening_rank_offset_max_own_move.unwrap_or(0.0);
        let offset_min = s.opening_rank_offset_min_own_move.unwrap_or(0.0);
        if offset > 0
            && offset_max > 0.0
            && own_moves as f64 >= offset_min
            && (own_moves as f64) < offset_max
            && ranked.len() > offset
        {
            let promoted = ranked.remove(offset);
            ranked.insert(0, promoted);
        }

        let scale = s.sigmoid_scale;
        ranked
            .into_iter()
            .map(|entry| Ranked {
                mv: entry.mv,
                visits: entry.visits,
                value: if entry.visits > 0 { logit(entry.value) * scale } else { -scale },
            })
            .collect()
    }

    /// `heuristicOpeningMoves`: the tier-1 ordering's top moves, no tree.
    fn heuristic_opening_moves(&mut self, position: &Position, seat: usize, phase: Phase, top_k: usize) -> Vec<(i32, f64)> {
        let t = placements();
        let mut buffer = new_move_buffer();
        let legal = position.generate_moves(seat, &mut buffer, usize::MAX);
        if legal == 0 {
            return Vec::new();
        }
        let ordering = self.params.ordering.get(phase);
        let key = |m: i32| t.size[m as usize] as f64 * ordering.piece_size - t.centre_distance[m as usize] as f64 * ordering.centre_pull;
        let mut ids: Vec<i32> = buffer[..legal].to_vec();
        // Stable, like V8's TimSort: ties keep generation order.
        ids.sort_by(|&a, &b| key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal));
        let kept = (f64::max(self.params.search.root_shortlist * 2.0, 96.0) as usize).min(ids.len());
        let mut moves = ids[..kept].to_vec();
        let mut scores = vec![0.0; kept];
        let split_budget = if self.params.search.interior_split_budget > 0.0 { self.params.search.interior_split_budget as i32 } else { 24 };
        let params = Arc::clone(&self.params);
        self.orderer.score_moves(&params, position, &self.context, seat, &moves, &mut scores, phase, true, split_budget);
        sort_by_score(&mut moves, &mut scores);
        (0..top_k.min(kept)).map(|i| (moves[i], scores[i])).collect()
    }

    /// `rankMovesGreedyV12`: every shortlisted move applied and scored with E_i.
    pub fn rank_greedy(&mut self, position: &mut Position, seat: usize, limit: usize) -> Vec<Ranked> {
        if position.turn != seat {
            position.force_turn(seat);
        }
        let t = placements();
        let mut moves = new_move_buffer();
        let count = position.generate_moves(seat, &mut moves, usize::MAX);
        if count == 0 {
            return Vec::new();
        }
        let params = Arc::clone(&self.params);
        refresh_context(&mut self.context, position, false);
        let phase = detect_phase(position, &self.context, &params, seat);
        let ordering = params.ordering.get(phase);
        let mut scores: Vec<f64> = moves[..count]
            .iter()
            .map(|&m| t.size[m as usize] as f64 * ordering.piece_size - t.centre_distance[m as usize] as f64 * ordering.centre_pull)
            .collect();
        sort_by_score(&mut moves[..count], &mut scores);
        let shortlist = count.min(limit);
        let mut scratch = EvalContext::new(params.fractional_territory_ties);
        let before = evaluate(&mut self.context, position, &params, phase)[seat];
        let mut ranked: Vec<Ranked> = (0..shortlist)
            .map(|i| {
                let value = self.orderer.deep_score(&params, position, &mut scratch, seat, moves[i], phase, before);
                Ranked { mv: moves[i], visits: 1, value }
            })
            .collect();
        ranked.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
        ranked
    }
}

fn logit(p: f64) -> f64 {
    let clamped = f64::min(1.0 - 1e-6, f64::max(1e-6, p));
    jsmath::log(clamped / (1.0 - clamped))
}

pub fn shape_at(shape: Option<&[f64]>, own_moves: i32) -> f64 {
    match shape {
        Some(shape) if !shape.is_empty() => {
            let index = (own_moves.max(0) as usize).min(shape.len() - 1);
            let value = shape[index];
            if value.is_finite() && value > 0.0 { value } else { 1.0 }
        }
        _ => 1.0,
    }
}
