//! ε-greedy terminal/truncated playouts (`playout.ts`). `sample_moves` is the engine's hot loop.

use crate::bitboard::*;
use crate::config::{BitboardParams, Phase};
use crate::features::{EvalContext, evaluate, refresh_context};
use crate::jsmath;
use crate::placements::*;
use crate::position::{Position, SEAT_COUNT, Undo};
use crate::rng::Rng;
use crate::rollout_policy::RolloutPolicy;
use std::sync::Arc;

pub const CANDIDATE_BUFFER: usize = 512;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Policy {
    Legacy,
    Linear,
    Table,
}

pub struct PlayoutOutcome {
    pub values: [f64; SEAT_COUNT],
    pub terminal: bool,
}

enum Step {
    Move(Undo),
    Pass { seat: usize, turn: usize },
}

pub struct Playout {
    stamp: Vec<u32>,
    generation: u32,
    candidates: [i32; CANDIDATE_BUFFER],
    policy_scores: [f64; CANDIDATE_BUFFER],
    corner_cells: [i32; CELL_COUNT],
    steps: Vec<Step>,
    table: Option<Arc<RolloutPolicy>>,
}

impl Playout {
    pub fn new(table: Option<Arc<RolloutPolicy>>) -> Self {
        Playout {
            stamp: vec![0; placements().count],
            generation: 0,
            candidates: [0; CANDIDATE_BUFFER],
            policy_scores: [0.0; CANDIDATE_BUFFER],
            corner_cells: [0; CELL_COUNT],
            steps: Vec::with_capacity(128),
            table,
        }
    }

    pub fn set_table(&mut self, table: Option<Arc<RolloutPolicy>>) {
        self.table = table;
    }

    /// Legal placements covering randomly drawn open corners of `seat`, up to `limit`. Returns 0
    /// only when the seat has no legal move anywhere.
    fn sample_moves(&mut self, position: &Position, seat: usize, limit: usize, max_corners: usize, rng: &mut Rng) -> usize {
        if position.hand[seat] == 0 {
            return 0;
        }
        if position.played[seat] == 0 {
            return position.generate_moves(seat, &mut self.candidates, limit);
        }
        let corners_mask = position.open_corners(seat);
        let corners = to_indices(&corners_mask, &mut self.corner_cells);
        if corners == 0 {
            return 0;
        }
        let t = placements();
        let hand = position.hand[seat];
        let occ_rows = board_rows(&position.occ);
        let own_rows = board_rows(&position.own[seat]);
        let mut count = 0usize;
        let mut corners_used = 0usize;
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;

        let mut remaining = corners;
        while remaining > 0 && count < limit {
            let pick = rng.next_int(remaining);
            let cell = self.corner_cells[pick];
            self.corner_cells[pick] = self.corner_cells[remaining - 1];
            self.corner_cells[remaining - 1] = cell;

            // The rejection test `(occ & cells) | (own & edgeHalo) != 0`, evaluated on the 11×11
            // window around this corner instead of on 13-word board masks. Every placement in this
            // cell's cover list lies inside the window, so the test decides exactly the same
            // candidates in exactly the same order.
            let (cx, cy) = (cell as usize % BOARD_SIZE, cell as usize / BOARD_SIZE);
            let occ_window = local_window(&occ_rows, cx, cy);
            let own_window = local_window(&own_rows, cx, cy);
            let mut found = false;
            let piece_base = cell as usize * (PIECE_COUNT + 1);
            let mut piece = 0;
            while piece < PIECE_COUNT && count < limit {
                if hand & (1 << piece) != 0 {
                    let run_start = t.cover_piece_start[piece_base + piece] as usize;
                    let run_end = t.cover_piece_start[piece_base + piece + 1] as usize;
                    let mut i = run_start;
                    while i < run_end && count < limit {
                        let shape = &t.shapes[t.cover_shape[i] as usize];
                        let rejected = (occ_window & shape.cells) | (own_window & shape.edge) != 0;
                        let id = t.cover_list[i] as usize;
                        i += 1;
                        if rejected || self.stamp[id] == generation {
                            continue;
                        }
                        self.stamp[id] = generation;
                        self.candidates[count] = id as i32;
                        count += 1;
                        found = true;
                    }
                }
                piece += 1;
            }
            if found {
                corners_used += 1;
                if corners_used >= max_corners {
                    return count;
                }
            }
            remaining -= 1;
        }
        count
    }

    /// Plays from `position` for at most `cutoff` plies; the position is restored before return.
    /// `skip` marks seats to leave out of the simulation (sealed regions solved exactly).
    pub fn run(
        &mut self,
        params: &BitboardParams,
        position: &mut Position,
        context: &mut EvalContext,
        phase: Phase,
        skip: Option<&[u8; SEAT_COUNT]>,
        rng: &mut Rng,
    ) -> PlayoutOutcome {
        let s = &params.search;
        self.steps.clear();
        let mut skipped = [false; SEAT_COUNT];
        if let Some(skip) = skip {
            for seat in 0..SEAT_COUNT {
                if skip[seat] == 1 && position.out[seat] == 0 {
                    position.mark_out(seat);
                    skipped[seat] = true;
                }
            }
            if position.out[position.turn] == 1 {
                position.advance_turn();
            }
        }
        let epsilon = s.playout_eps_by_phase.as_ref().map_or(s.playout_eps, |by| *by.get(phase));
        let ordering = params.ordering.get(phase);
        let policy = match s.playout_policy.as_str() {
            "linear" => Policy::Linear,
            "table" => Policy::Table,
            _ => Policy::Legacy,
        };
        let cutoff = s.playout_cutoff;
        let cap = (s.playout_move_cap as usize).min(CANDIDATE_BUFFER);
        let max_corners = s.playout_corners as usize;
        let mut steps = 0.0f64;
        let t = placements();

        while steps < cutoff && !position.finished() {
            let seat = position.turn;
            let count = self.sample_moves(position, seat, cap, max_corners, rng);
            if count == 0 {
                let turn = position.turn;
                position.mark_out(seat);
                position.advance_turn();
                self.steps.push(Step::Pass { seat, turn });
                steps += 1.0;
                continue;
            }
            let chosen = if count == 1 || rng.next_f64() < epsilon {
                self.candidates[rng.next_int(count)]
            } else {
                match policy {
                    Policy::Table => self.sample_table(params, count, position, seat, phase, rng),
                    Policy::Linear => self.sample_linear(params, count, phase, rng),
                    Policy::Legacy => {
                        let mut best = f64::NEG_INFINITY;
                        let mut chosen = self.candidates[0];
                        for &mv in &self.candidates[..count] {
                            let m = mv as usize;
                            let score = t.size[m] as f64 * ordering.piece_size
                                - t.centre_distance[m] as f64 * ordering.centre_pull;
                            if score > best {
                                best = score;
                                chosen = mv;
                            }
                        }
                        chosen
                    }
                }
            };
            let undo = position.apply(chosen);
            self.steps.push(Step::Move(undo));
            steps += 1.0;
        }

        let terminal = position.finished();
        let values = if terminal {
            position.scores()
        } else {
            refresh_context(context, position, false);
            evaluate(context, position, params, phase)
        };

        for step in self.steps.iter().rev() {
            match step {
                Step::Move(undo) => position.undo(undo),
                Step::Pass { seat, turn } => {
                    position.out[*seat] = 0;
                    position.force_turn(*turn);
                }
            }
        }
        for seat in 0..SEAT_COUNT {
            if skipped[seat] {
                position.out[seat] = 0;
            }
        }
        PlayoutOutcome { values, terminal }
    }

    fn sample_linear(&mut self, params: &BitboardParams, count: usize, phase: Phase, rng: &mut Rng) -> i32 {
        let t = placements();
        let s = &params.search;
        let ordering = params.ordering.get(phase);
        let mut best = f64::NEG_INFINITY;
        let mut best_move = self.candidates[0];
        for i in 0..count {
            let m = self.candidates[i] as usize;
            let score = t.size[m] as f64 * ordering.piece_size - t.centre_distance[m] as f64 * ordering.centre_pull
                + t.corner_halo_count[m] as f64 * s.playout_corner_weight
                - t.edge_halo_count[m] as f64 * s.playout_edge_weight;
            self.policy_scores[i] = score;
            if score > best {
                best = score;
                best_move = self.candidates[i];
            }
        }
        if s.playout_temp <= 0.0 {
            return best_move;
        }
        self.draw_softmax(count, best, s.playout_temp, best_move, rng)
    }

    fn sample_table(&mut self, params: &BitboardParams, count: usize, position: &Position, seat: usize, phase: Phase, rng: &mut Rng) -> i32 {
        let t = placements();
        let policy = self.table.as_ref().expect("table rollout policy not loaded");
        let blend = params.search.playout_table_blend.unwrap_or(policy.blend);
        let temperature = params.search.playout_temp;
        let ordering = params.ordering.get(phase);
        let mut best = f64::NEG_INFINITY;
        let mut best_move = self.candidates[0];
        for i in 0..count {
            let mv = self.candidates[i];
            let m = mv as usize;
            let incumbent = t.size[m] as f64 * ordering.piece_size - t.centre_distance[m] as f64 * ordering.centre_pull;
            let learned = policy.score(phase, seat, mv, position.hand_squares[seat], position.hand[seat]);
            // `+ mastScore` is `+ 0` with MAST off; adding 0.0 keeps -0.0 semantics identical too.
            let score = incumbent * (1.0 - blend) + learned * blend + 0.0;
            self.policy_scores[i] = score;
            if score > best {
                best = score;
                best_move = mv;
            }
        }
        if temperature <= 0.0 {
            return best_move;
        }
        self.draw_softmax(count, best, temperature, best_move, rng)
    }

    fn draw_softmax(&mut self, count: usize, best: f64, temperature: f64, fallback: i32, rng: &mut Rng) -> i32 {
        let mut total = 0.0;
        for i in 0..count {
            let weight = jsmath::exp((self.policy_scores[i] - best) / temperature);
            self.policy_scores[i] = weight;
            total += weight;
        }
        let mut draw = rng.next_f64() * total;
        for i in 0..count {
            draw -= self.policy_scores[i];
            if draw <= 0.0 {
                return self.candidates[i];
            }
        }
        fallback
    }
}
