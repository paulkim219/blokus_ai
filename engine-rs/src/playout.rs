//! ε-greedy terminal/truncated playouts (`playout.ts`). `sample_moves` is the engine's hot loop.

use crate::bitboard::*;
use crate::config::{BitboardParams, Phase, RolloutOptions};
use crate::features::{EvalContext, evaluate, refresh_context};
use crate::jsmath;
use crate::move_lists::{self, MoveLists, entry_count, entry_id, rows_of};
use crate::placements::*;
use crate::position::{Position, SEAT_COUNT, Undo};
use crate::reply_table::ReplyTable;
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
    /// Placements on the board when the rollout stopped (the game's length if `terminal`).
    pub plies: i32,
}

/// Sizes 1–5 × local squares 0–5 × local own-corner squares 0–5.
const WEIGHT_TABLE: usize = 5 * 6 * 6;

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
    /// P1/P2 (`native.rollout.policy` "all"): built on first use, so the default rollout never
    /// allocates them.
    lists: Option<MoveLists>,
    /// The last placements before this rollout, then the rollout's own, as (seat, placement);
    /// oldest first, at most three.
    recent: [(usize, i32); 3],
    recent_len: usize,
    weights: Vec<f64>,
    weight_table: [f64; WEIGHT_TABLE],
    weight_key: [u64; 3],
    /// P7 (`native.lastGoodReply`): None leaves every rollout exactly as before.
    lgr: Option<ReplyTable>,
    /// The placement before the rollout's next move (-1 if none); kept only with `lgr`.
    lgr_prev: i32,
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
            lists: None,
            recent: [(0, -1); 3],
            recent_len: 0,
            weights: Vec::new(),
            weight_table: [0.0; WEIGHT_TABLE],
            weight_key: [u64::MAX; 3],
            lgr: None,
            lgr_prev: -1,
        }
    }

    /// P7: turns the last-good-reply table on (empty) for every later rollout.
    pub fn enable_last_good_reply(&mut self, forget: bool) {
        self.lgr = Some(ReplyTable::new(forget));
    }

    pub fn reply_table(&mut self) -> Option<&mut ReplyTable> {
        self.lgr.as_mut()
    }

    /// P7: the placement made just before the next rollout's first move (-1 if none).
    pub fn set_previous(&mut self, mv: i32) {
        self.lgr_prev = mv;
    }

    /// The placements the last rollout made, in order, as (seat, placement), appended to `out`.
    /// Valid until the next `run`.
    pub fn played(&self, out: &mut Vec<(usize, i32)>) {
        for step in &self.steps {
            if let Step::Move(undo) = step {
                out.push((undo.seat, undo.mv));
            }
        }
    }

    /// P7: the stored reply of `seat` to the previous placement, if it is legal now.
    #[inline]
    fn last_good_reply(&mut self, position: &Position, seat: usize) -> Option<i32> {
        let prev = self.lgr_prev;
        let table = self.lgr.as_mut()?;
        table.asked += 1;
        let reply = table.get(seat, prev);
        if reply >= 0 && position.is_legal(seat, reply) {
            table.supplied += 1;
            Some(reply)
        } else {
            None
        }
    }

    /// The placements made before the next rollout (seat, placement), oldest first; only the last
    /// three are kept. Read only by `native.rollout` with a local weight.
    pub fn set_recent(&mut self, recent: &[(usize, i32)]) {
        let start = recent.len().saturating_sub(3);
        self.recent_len = recent.len() - start;
        for (i, &entry) in recent[start..].iter().enumerate() {
            self.recent[i] = entry;
        }
    }

    /// P2: the position all of this search's rollouts start below (its root). Lists first needed in
    /// a rollout are derived from lists generated here once.
    pub fn set_base(&mut self, position: &Position) {
        self.lists.get_or_insert_with(MoveLists::new).set_base(position);
    }

    fn push_recent(&mut self, seat: usize, mv: i32) {
        if self.recent_len < 3 {
            self.recent[self.recent_len] = (seat, mv);
            self.recent_len += 1;
        } else {
            self.recent[0] = self.recent[1];
            self.recent[1] = self.recent[2];
            self.recent[2] = (seat, mv);
        }
    }

    pub fn set_table(&mut self, table: Option<Arc<RolloutPolicy>>) {
        self.table = table;
    }

    /// Legal placements covering randomly drawn open corners of `seat`, up to `limit`. Returns 0
    /// only when the seat has no legal move anywhere.
    /// `considered` masks the seat's hand (P9 large-piece rule); `u32::MAX` keeps every piece.
    fn sample_moves(&mut self, position: &Position, seat: usize, limit: usize, max_corners: usize, considered: u32, rng: &mut Rng) -> usize {
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
        let hand = position.hand[seat] & considered;
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
        let all_moves = params.native.as_ref().and_then(|n| n.rollout.as_ref()).filter(|r| r.all_moves());
        // P9 large-piece rule (`native.opening`): (pieces of the minimum size or more, piece-count limit).
        let early = params.native.as_ref().and_then(|n| n.opening.as_ref()).filter(|o| o.rollout_on()).map(|o| {
            let mask = (0..PIECE_COUNT).filter(|&p| PIECE_SIZES[p] as f64 >= o.rollout_min_size).fold(0u32, |m, p| m | (1 << p));
            (mask, o.rollout_until_pieces)
        });
        if let Some(options) = all_moves {
            self.play_all_moves(options, position, cutoff, rng);
            steps = cutoff;
        }

        while steps < cutoff && !position.finished() {
            let seat = position.turn;
            if self.lgr.is_some()
                && let Some(reply) = self.last_good_reply(position, seat)
            {
                let undo = position.apply(reply);
                self.steps.push(Step::Move(undo));
                self.lgr_prev = reply;
                steps += 1.0;
                continue;
            }
            let considered = match early {
                Some((mask, until)) => {
                    let on_board: u32 = position.hand.iter().map(|h| PIECE_COUNT as u32 - h.count_ones()).sum();
                    if (on_board as f64) < until { mask } else { u32::MAX }
                }
                None => u32::MAX,
            };
            let mut count = self.sample_moves(position, seat, cap, max_corners, considered, rng);
            if count == 0 && considered != u32::MAX {
                count = self.sample_moves(position, seat, cap, max_corners, u32::MAX, rng);
            }
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
            if self.lgr.is_some() {
                self.lgr_prev = chosen;
            }
            steps += 1.0;
        }

        let terminal = position.finished();
        let plies = position.ply;
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
        PlayoutOutcome { values, terminal, plies }
    }

    fn refresh_weight_table(&mut self, r: &RolloutOptions) {
        let key = [r.size_weight.to_bits(), r.local_weight.to_bits(), r.local_own_extra.to_bits()];
        if key == self.weight_key {
            return;
        }
        for size in 1..=5usize {
            for local in 0..6usize {
                for own in 0..6usize {
                    let x = r.size_weight * size as f64 + r.local_weight * (local as f64 + r.local_own_extra * own as f64);
                    self.weight_table[((size - 1) * 6 + local) * 6 + own] = x.exp();
                }
            }
        }
        self.weight_key = key;
    }

    /// P1/P2: plays to the end of the game (or `cutoff` plies) choosing each move among *all* the
    /// mover's legal placements, kept incrementally, with weight from `options`.
    fn play_all_moves(&mut self, options: &RolloutOptions, position: &mut Position, cutoff: f64, rng: &mut Rng) {
        self.refresh_weight_table(options);
        let mut lists = self.lists.take().unwrap_or_default();
        lists.reset();
        let use_local = options.local_weight != 0.0;
        let mut steps = 0.0f64;
        while steps < cutoff && !position.finished() {
            let seat = position.turn;
            let moves = lists.moves(position, seat);
            let count = moves.len();
            if count == 0 {
                let turn = position.turn;
                position.mark_out(seat);
                position.advance_turn();
                self.steps.push(Step::Pass { seat, turn });
                steps += 1.0;
                continue;
            }
            let reply = if self.lgr.is_some() && count > 1 { self.last_good_reply(position, seat) } else { None };
            let chosen = if let Some(reply) = reply {
                reply
            } else if count == 1 {
                entry_id(moves[0])
            } else {
                let (local, local_own) = if use_local { local_squares(position, seat, &self.recent[..self.recent_len]) } else { (EMPTY, EMPTY) };
                let any_local = use_local && !is_empty(&local);
                let (local, local_own) = (rows_of(&local), rows_of(&local_own));
                self.weights.clear();
                let mut total = 0.0;
                for &e in moves {
                    let size = PIECE_SIZES[move_lists::entry_piece(e)] as usize;
                    let (l, o) = if any_local { (entry_count(e, &local) as usize, entry_count(e, &local_own) as usize) } else { (0, 0) };
                    total += self.weight_table[((size - 1) * 6 + l) * 6 + o];
                    self.weights.push(total);
                }
                let draw = rng.next_f64() * total;
                let index = self.weights.partition_point(|&c| c <= draw).min(count - 1);
                entry_id(moves[index])
            };
            debug_assert!(position.is_legal(seat, chosen), "rollout list gave an illegal move");
            let corner_before = position.corner_halo[seat];
            let played_before = position.played[seat] == 1;
            let undo = position.apply(chosen);
            lists.after_placement(position, seat, chosen, &corner_before, played_before);
            self.push_recent(seat, chosen);
            if self.lgr.is_some() {
                self.lgr_prev = chosen;
            }
            self.steps.push(Step::Move(undo));
            steps += 1.0;
        }
        self.lists = Some(lists);
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

/// P1's local squares for `seat`, given the last placements as (seat, placement), oldest first:
/// the corners opened by opponents' placements made since `seat`'s own last placement (walking
/// back from the newest and stopping at `seat`'s own) that the opponent can still use, plus their
/// empty orthogonal neighbours not forbidden to that opponent. Returns (local, local ∩ `seat`'s
/// open corners).
pub fn local_squares(position: &Position, seat: usize, recent: &[(usize, i32)]) -> (Mask, Mask) {
    let t = placements();
    let mut local = EMPTY;
    for &(owner, mv) in recent.iter().rev() {
        if owner == seat {
            break;
        }
        if mv < 0 {
            continue;
        }
        let m = mv as usize;
        let mut forbidden = position.occ;
        or_into(&mut forbidden, &position.edge_halo[owner]);
        for w in 0..WORDS {
            let mut bits = t.corner_halo[m][w] & !t.edge_halo[m][w] & !forbidden[w];
            while bits != 0 {
                let cell = w * 32 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                set_bit(&mut local, cell);
                let (x, y) = (cell % BOARD_SIZE, cell / BOARD_SIZE);
                let mut near = |n: usize| {
                    if !test_bit(&forbidden, n) {
                        set_bit(&mut local, n);
                    }
                };
                if x > 0 {
                    near(cell - 1);
                }
                if x + 1 < BOARD_SIZE {
                    near(cell + 1);
                }
                if y > 0 {
                    near(cell - BOARD_SIZE);
                }
                if y + 1 < BOARD_SIZE {
                    near(cell + BOARD_SIZE);
                }
            }
        }
    }
    let own = position.open_corners(seat);
    let mut local_own = local;
    and_into(&mut local_own, &own);
    (local, local_own)
}
