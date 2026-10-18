//! Multi-player MCTS with max^n vector backup (`bitboard/mcts.ts`, `V12Search`).
//!
//! Nodes live in an arena and are addressed by index; the transposition table maps the low hash
//! half to a bucket of node indices, disambiguated by the high half, exactly as the TS `Map` does.

use crate::backup::*;
use crate::bitboard::*;
use crate::config::{BitboardParams, Phase};
use crate::features::{EvalContext, detect_phase, evaluate, refresh_context};
use crate::ordering::{HistoryTable, MoveOrderer, softmax_priors, sort_by_score};
use crate::packer::solve_sealed_region;
use crate::placements::*;
use crate::playout::Playout;
use crate::position::{MAX_MOVES, Position, SEAT_COUNT, Undo};
use crate::prior::PriorClient;
use crate::rng::Rng;
use crate::rollout_policy::RolloutPolicy;
use crate::territory::is_sealed;
use rustc_hash::FxHashMap;
use std::sync::Arc;

const NONE: u32 = u32::MAX;

struct Node {
    /// Kept for debugging dumps; lookups go through the table, which is keyed by it.
    #[allow(dead_code)]
    hash_lo: u32,
    hash_hi: u32,
    turn: usize,
    visits: f64,
    values: [f64; SEAT_COUNT],
    initialised: bool,
    moves: Vec<i32>,
    priors: Vec<f64>,
    opened: usize,
    children: Vec<u32>,
    child_visits: Vec<i32>,
    settled: bool,
    settled_out_mask: u8,
    settled_turn: usize,
    terminal: bool,
    proven: Option<[f64; SEAT_COUNT]>,
}

impl Node {
    fn new(position: &Position) -> Node {
        Node {
            hash_lo: position.hash_lo,
            hash_hi: position.hash_hi,
            turn: position.turn,
            visits: 0.0,
            values: [0.0; SEAT_COUNT],
            initialised: false,
            moves: Vec::new(),
            priors: Vec::new(),
            opened: 0,
            children: Vec::new(),
            child_visits: Vec::new(),
            settled: false,
            settled_out_mask: 0,
            settled_turn: 0,
            terminal: false,
            proven: None,
        }
    }

    #[inline(always)]
    fn move_count(&self) -> usize {
        self.moves.len()
    }
}

#[derive(Clone, Debug)]
pub struct RankedPlacement {
    pub mv: i32,
    pub visits: i32,
    /// Root seat's mean value in [0, 1].
    pub value: f64,
    pub prior: f64,
}

pub struct SearchResult {
    pub best: i32,
    pub ranked: Vec<RankedPlacement>,
    pub iterations: u32,
    pub proven: bool,
    pub phase: Phase,
}

/// `topK` from mcts.ts: keep the first `k`, then each later score strictly above the running
/// minimum replaces it. The minimum is the *lowest slot* holding the smallest score, so a heap
/// ordered by (score, slot) evicts exactly the slot the linear rescan would, in O(n log k).
fn top_k(moves: &[i32], scores: &[f64], k: usize, out_moves: &mut [i32], out_scores: &mut [f64]) -> usize {
    let count = moves.len();
    let kept = k.min(count);
    out_moves[..kept].copy_from_slice(&moves[..kept]);
    out_scores[..kept].copy_from_slice(&scores[..kept]);
    if kept == count || kept == 0 {
        return kept;
    }
    // Min-heap of slots keyed by (score, slot). Scores are finite, so `<` is a total order here.
    let less = |a: usize, b: usize, s: &[f64]| s[a] < s[b] || (s[a] == s[b] && a < b);
    let mut heap: Vec<usize> = (0..kept).collect();
    let sift_down = |heap: &mut Vec<usize>, mut i: usize, s: &[f64]| loop {
        let (l, r) = (2 * i + 1, 2 * i + 2);
        let mut m = i;
        if l < heap.len() && less(heap[l], heap[m], s) {
            m = l;
        }
        if r < heap.len() && less(heap[r], heap[m], s) {
            m = r;
        }
        if m == i {
            break;
        }
        heap.swap(i, m);
        i = m;
    };
    for i in (0..kept / 2).rev() {
        sift_down(&mut heap, i, out_scores);
    }
    for i in kept..count {
        let slot = heap[0];
        if scores[i] <= out_scores[slot] {
            continue;
        }
        out_moves[slot] = moves[i];
        out_scores[slot] = scores[i];
        sift_down(&mut heap, 0, out_scores);
    }
    kept
}

pub struct V12Search {
    params: Arc<BitboardParams>,
    aggregation: Aggregation,
    nodes: Vec<Node>,
    table: FxHashMap<u32, Vec<u32>>,
    context: EvalContext,
    playout_context: EvalContext,
    orderer: MoveOrderer,
    playout: Playout,
    history: HistoryTable,
    path_nodes: Vec<u32>,
    path_edges: Vec<usize>,
    path_undos: Vec<Undo>,
    generate_buffer: Vec<i32>,
    tier1_scores: Vec<f64>,
    scratch_moves: Vec<i32>,
    scratch_scores: Vec<f64>,
    inclusion_stamp: Vec<u32>,
    inclusion_generation: u32,
    root: u32,
    iterations: u32,
    root_seat: usize,
    phase: Phase,
    paranoid: bool,
    brs: bool,
    rank_blend: f64,
    prior: Option<PriorClient>,
    learned_prior: bool,
    replay_settle: bool,
}

impl V12Search {
    pub fn new(params: Arc<BitboardParams>, table: Option<Arc<RolloutPolicy>>) -> V12Search {
        let fractional = params.fractional_territory_ties;
        V12Search {
            aggregation: Aggregation::parse(&params.search.opponent_aggregation),
            brs: params.search.opponent_policy == "brs",
            replay_settle: params.search.replay_settle.unwrap_or(false),
            params,
            nodes: Vec::new(),
            table: FxHashMap::default(),
            context: EvalContext::new(fractional),
            playout_context: EvalContext::new(fractional),
            orderer: MoveOrderer::new(),
            playout: Playout::new(table),
            history: HistoryTable::new(),
            path_nodes: Vec::new(),
            path_edges: Vec::new(),
            path_undos: Vec::new(),
            generate_buffer: vec![0; MAX_MOVES],
            tier1_scores: vec![0.0; MAX_MOVES],
            scratch_moves: vec![0; MAX_MOVES],
            scratch_scores: vec![0.0; MAX_MOVES],
            inclusion_stamp: vec![0; placements().count],
            inclusion_generation: 0,
            root: NONE,
            iterations: 0,
            root_seat: 0,
            phase: Phase::Midgame,
            paranoid: false,
            rank_blend: 0.0,
            prior: None,
            learned_prior: false,
        }
    }

    /// Attach a learned root prior (`params.native.prior`). Without one the search is the TS one.
    pub fn connect_prior(&mut self) -> Result<(), String> {
        if let Some(options) = self.params.native.as_ref().and_then(|n| n.prior.as_ref()) {
            self.prior = Some(PriorClient::connect(&options.socket)?);
        }
        Ok(())
    }

    pub fn iteration_count(&self) -> u32 {
        self.iterations
    }

    fn node_for(&mut self, position: &Position) -> u32 {
        let index = self.nodes.len() as u32;
        if !self.params.search.transpositions {
            self.nodes.push(Node::new(position));
            return index;
        }
        let bucket = self.table.entry(position.hash_lo).or_default();
        for &id in bucket.iter() {
            if self.nodes[id as usize].hash_hi == position.hash_hi {
                return id;
            }
        }
        bucket.push(index);
        self.nodes.push(Node::new(position));
        index
    }

    /// Sets the tree up for one move; returns the number of root candidates.
    pub fn prepare(&mut self, position: &mut Position, root_seat: usize) -> usize {
        self.root_seat = root_seat;
        refresh_context(&mut self.context, position, true);
        self.phase = detect_phase(position, &self.context, &self.params, root_seat);
        self.table.clear();
        self.nodes.clear();
        self.history.clear();

        let scores = position.scores();
        let mut best_other = f64::NEG_INFINITY;
        for seat in 0..SEAT_COUNT {
            if seat != root_seat && scores[seat] > best_other {
                best_other = scores[seat];
            }
        }
        let lead = scores[root_seat] - best_other;
        let s = &self.params.search;
        self.rank_blend = objective_blend(s.rank_blend, lead, s.objective_shift);
        self.paranoid = s.opponent_policy == "paranoid" || (s.opponent_policy == "auto" && lead >= s.paranoid_lead);

        let root = self.node_for(position);
        self.initialise_node(root, position, true);
        self.root = root;
        self.learned_prior = false;
        self.apply_learned_prior(position, root_seat);
        self.iterations = 0;
        self.nodes[root as usize].move_count()
    }

    /// Runs up to `chunk` iterations; false once the search is finished.
    pub fn advance(&mut self, position: &mut Position, chunk: u32, budget: u32, rng: &mut Rng) -> bool {
        let root = self.root;
        if root == NONE || self.nodes[root as usize].move_count() == 0 {
            return false;
        }
        for _ in 0..chunk {
            if self.iterations >= budget {
                return false;
            }
            self.iterate(position, rng);
            self.iterations += 1;
        }
        let t = &self.params.time;
        if self.params.search.root_policy == "puct"
            && t.early_exit
            && self.iterations as f64 >= t.min_iterations
            && self.decided(budget - self.iterations)
        {
            return false;
        }
        true
    }

    pub fn run(&mut self, position: &mut Position, root_seat: usize, budget: u32, rng: &mut Rng) -> SearchResult {
        if self.prepare(position, root_seat) > 0 {
            while self.advance(position, 64, budget, rng) {}
        }
        self.result()
    }

    pub fn result(&self) -> SearchResult {
        let root = &self.nodes[self.root as usize];
        if root.move_count() == 0 {
            return SearchResult { best: -1, ranked: vec![], iterations: self.iterations, proven: false, phase: self.phase };
        }
        SearchResult {
            best: self.best_move(),
            ranked: self.rank_root(),
            iterations: self.iterations,
            proven: root.proven.is_some(),
            phase: self.phase,
        }
    }

    fn initialise_node(&mut self, id: u32, position: &mut Position, is_root: bool) {
        self.enter_node(id, position);
        let node = &self.nodes[id as usize];
        if node.initialised || node.terminal {
            return;
        }
        let seat = position.turn;
        let mut buffer = std::mem::take(&mut self.generate_buffer);
        let count = position.generate_moves(seat, &mut buffer, usize::MAX);
        if count == 0 {
            self.generate_buffer = buffer;
            let node = &mut self.nodes[id as usize];
            node.terminal = true;
            node.initialised = true;
            return;
        }
        let params = Arc::clone(&self.params);
        let s = &params.search;
        let t = placements();
        let ordering = params.ordering.get(self.phase);
        for i in 0..count {
            let m = buffer[i] as usize;
            self.tier1_scores[i] = t.size[m] as f64 * ordering.piece_size - t.centre_distance[m] as f64 * ordering.centre_pull;
        }
        let funnel = if is_root {
            f64::max(s.root_shortlist * 2.0, 96.0)
        } else {
            f64::max(s.node_shortlist * 2.0, 48.0)
        } as usize;
        let with_split = is_root || s.split_at_interior;
        let reserve = s.funnel_reserve as usize;
        refresh_context(&mut self.context, position, with_split || reserve > 0);

        let kept = if reserve > 0 {
            self.reserved_top_k(&buffer[..count], count, funnel, reserve, seat)
        } else {
            top_k(&buffer[..count], &self.tier1_scores[..count], funnel, &mut self.scratch_moves, &mut self.scratch_scores)
        };
        self.generate_buffer = buffer;

        let split_budget = if is_root { 24 } else { s.interior_split_budget as i32 };
        self.orderer.score_moves(
            &params,
            position,
            &self.context,
            seat,
            &self.scratch_moves[..kept],
            &mut self.scratch_scores[..kept],
            self.phase,
            with_split,
            split_budget,
        );
        sort_by_score(&mut self.scratch_moves[..kept], &mut self.scratch_scores[..kept]);

        let shortlist = kept.min(if is_root { s.root_shortlist } else { s.node_shortlist } as usize);
        if is_root && s.root_piece_diversity && shortlist > 1 {
            interleave_pieces(&mut self.scratch_moves[..shortlist], &mut self.scratch_scores[..shortlist]);
        }
        let mut priors = vec![0.0; shortlist];
        softmax_priors(&self.scratch_scores[..shortlist], s.prior_temp, &mut priors);
        let node = &mut self.nodes[id as usize];
        node.moves = self.scratch_moves[..shortlist].to_vec();
        node.priors = priors;
        node.children = vec![NONE; shortlist];
        node.child_visits = vec![0; shortlist];
        node.opened = 0;
        node.initialised = true;
    }

    /// Blend the network's softmax into the root prior, as TS `netPrior` / `netPriorBlend` do.
    fn apply_learned_prior(&mut self, position: &Position, seat: usize) {
        let Some(options) = self.params.native.as_ref().and_then(|n| n.prior.clone()) else { return };
        let in_phase = match options.phase.as_str() {
            "endgame" => self.phase == Phase::Endgame,
            "openingMidgame" => self.phase != Phase::Endgame,
            _ => true,
        };
        let root = self.root as usize;
        if !in_phase || self.nodes[root].move_count() < 2 {
            return;
        }
        let client = self.prior.as_mut().expect("learned prior configured but not connected");
        let logits = client.logits(position, seat, &self.nodes[root].moves).unwrap_or_else(|e| panic!("{e}"));
        let scores: Vec<f64> = logits.iter().map(|&l| l as f64).collect();
        let mut net = vec![0.0; scores.len()];
        softmax_priors(&scores, options.temperature, &mut net);
        let blend = options.blend.clamp(0.0, 1.0);
        let node = &mut self.nodes[root];
        for (prior, learned) in node.priors.iter_mut().zip(&net) {
            *prior = (1.0 - blend) * *prior + blend * learned;
        }
        self.learned_prior = true;
    }

    /// Root ranking statistic: visits, plus prior pseudo-visits once a learned prior is in.
    fn decision_visits(&self, index: usize) -> f64 {
        let root = &self.nodes[self.root as usize];
        let pseudo = if self.learned_prior {
            self.params.native.as_ref().and_then(|n| n.prior.as_ref()).map_or(0.0, |p| p.pseudo_visits)
        } else {
            0.0
        };
        root.child_visits[index] as f64 + pseudo * root.priors[index]
    }

    fn reserved_top_k(&mut self, moves: &[i32], count: usize, funnel: usize, reserve: usize, seat: usize) -> usize {
        let base = usize::max(1, funnel.saturating_sub(reserve));
        let mut kept = top_k(moves, &self.tier1_scores[..count], base, &mut self.scratch_moves, &mut self.scratch_scores);
        let mut deny = EMPTY;
        for other in 0..SEAT_COUNT {
            if other != seat {
                or_into(&mut deny, &self.context.territory.open_corners[other]);
            }
        }
        self.inclusion_generation = self.inclusion_generation.wrapping_add(1);
        let generation = self.inclusion_generation;
        for i in 0..kept {
            self.inclusion_stamp[self.scratch_moves[i] as usize] = generation;
        }
        let t = placements();
        let mut added = 0;
        let mut i = 0;
        while i < count && added < reserve {
            let mv = moves[i];
            let m = mv as usize;
            i += 1;
            if self.inclusion_stamp[m] == generation {
                continue;
            }
            let mut interesting = false;
            if self.context.has_articulation {
                interesting = (t.cell_start[m]..t.cell_start[m + 1])
                    .any(|c| self.context.articulation[t.cell_list[c as usize] as usize] == 1);
            }
            if !interesting && intersects(&deny, &t.cells[m]) {
                interesting = true;
            }
            if !interesting {
                continue;
            }
            self.inclusion_stamp[m] = generation;
            self.scratch_moves[kept] = mv;
            self.scratch_scores[kept] = self.tier1_scores[i - 1];
            kept += 1;
            added += 1;
        }
        kept
    }

    fn enter_node(&mut self, id: u32, position: &mut Position) {
        let node = &mut self.nodes[id as usize];
        if node.settled {
            position.set_out_mask(node.settled_out_mask);
            position.force_turn(node.settled_turn);
            return;
        }
        let mut guard = 0;
        while !position.finished() && guard < SEAT_COUNT {
            if position.has_move(position.turn) {
                break;
            }
            position.mark_out(position.turn);
            position.advance_turn();
            guard += 1;
        }
        node.settled = true;
        node.settled_out_mask = position.out_mask();
        node.settled_turn = position.turn;
        node.turn = position.turn;
        if position.finished() {
            node.terminal = true;
            node.initialised = true;
            node.moves.clear();
        }
    }

    #[inline]
    fn allowed_children(&self, id: u32) -> usize {
        let s = &self.params.search;
        let node = &self.nodes[id as usize];
        if !s.widening_all_nodes && id != self.root {
            return node.move_count();
        }
        let widened = (s.widening_init + s.widening_growth * node.visits.sqrt()).floor();
        (node.move_count() as f64).min(widened) as usize
    }

    fn iterate(&mut self, position: &mut Position, rng: &mut Rng) {
        self.path_nodes.clear();
        self.path_edges.clear();
        self.path_undos.clear();
        let root = self.root;
        let mut node = root;
        loop {
            {
                let n = &self.nodes[node as usize];
                if n.terminal || n.proven.is_some() {
                    break;
                }
                if !n.initialised {
                    self.initialise_node(node, position, node == root);
                    if self.nodes[node as usize].terminal {
                        break;
                    }
                } else if self.replay_settle {
                    self.enter_node(node, position);
                }
            }
            let Some(index) = self.select(node) else {
                break;
            };
            self.path_nodes.push(node);
            self.path_edges.push(index);
            let mv = self.nodes[node as usize].moves[index];
            let undo = position.apply(mv);
            self.path_undos.push(undo);
            if self.brs && position.turn != self.root_seat && !position.finished() && position.out[self.root_seat] == 0 {
                position.force_turn(self.root_seat);
            }
            let existing = self.nodes[node as usize].children[index];
            if existing == NONE {
                let child = self.node_for(position);
                self.nodes[node as usize].children[index] = child;
                self.enter_node(child, position);
                node = child;
                break;
            }
            node = existing;
        }
        let value = self.leaf_value(node, position, rng);
        self.backup(&value);
        for undo in self.path_undos.iter().rev() {
            position.undo(undo);
        }
    }

    fn select(&mut self, id: u32) -> Option<usize> {
        let allowed = self.allowed_children(id);
        let node = &mut self.nodes[id as usize];
        if node.opened < allowed && node.opened < node.move_count() {
            let index = node.opened;
            node.opened += 1;
            return Some(index);
        }
        if node.opened == 0 {
            return None;
        }
        let node = &self.nodes[id as usize];
        let s = &self.params.search;
        let seat = node.turn;
        let component = if self.paranoid { self.root_seat } else { seat };
        let invert = self.paranoid && seat != self.root_seat;
        let sqrt_visits = f64::max(1.0, node.visits).sqrt();
        let parent_mean = if node.visits > 0.0 { node.values[component] / node.visits } else { 0.5 };
        let mut best_index = None;
        let mut best_score = f64::NEG_INFINITY;
        for index in 0..node.opened {
            let child = node.children[index];
            let edge_visits = node.child_visits[index] as f64;
            let q = if child == NONE || self.nodes[child as usize].visits == 0.0 {
                (if invert { 1.0 - parent_mean } else { parent_mean }) - s.fpu_reduction
            } else {
                let c = &self.nodes[child as usize];
                let mean = c.values[component] / c.visits;
                if invert { 1.0 - mean } else { mean }
            };
            let u = 1.0 * s.c_puct * node.priors[index] * (sqrt_visits / (1.0 + edge_visits));
            let h = if s.history_weight == 0.0 {
                0.0
            } else {
                (s.history_weight * self.history.score(seat, node.moves[index])) / (1.0 + edge_visits)
            };
            let score = q + u + h;
            if score > best_score {
                best_score = score;
                best_index = Some(index);
            }
        }
        best_index
    }

    fn endgame_gate_open(&self, position: &Position) -> bool {
        let e = &self.params.endgame;
        if e.max_region_cells <= 0.0 {
            return false;
        }
        let total: i32 = position.hand_squares.iter().sum();
        total as f64 <= e.gate_remaining_squares
    }

    fn leaf_value(&mut self, id: u32, position: &mut Position, rng: &mut Rng) -> [f64; SEAT_COUNT] {
        if let Some(proven) = self.nodes[id as usize].proven {
            return proven;
        }
        let params = Arc::clone(&self.params);
        let s = &params.search;
        if self.nodes[id as usize].terminal || position.finished() {
            // The TS engine passes no aggregation here, so it is always `max` on this path.
            let value = value_vector(&position.scores(), s.sigmoid_scale, self.rank_blend, Aggregation::Max);
            self.nodes[id as usize].proven = Some(value);
            return value;
        }

        let mut sealed_flags = [0u8; SEAT_COUNT];
        let mut sealed_squares = [0i32; SEAT_COUNT];
        let mut sealed_score = [0f64; SEAT_COUNT];
        let mut sealed_count = 0;
        let active_seats = position.out.iter().filter(|&&o| o == 0).count();
        if self.endgame_gate_open(position) {
            refresh_context(&mut self.context, position, false);
            for seat in 0..SEAT_COUNT {
                if position.out[seat] == 1 || !is_sealed(&self.context.territory, seat) {
                    continue;
                }
                let Some(pack) = solve_sealed_region(position, seat, &self.context.territory, &params.endgame) else {
                    continue;
                };
                sealed_flags[seat] = 1;
                sealed_squares[seat] = pack.squares;
                sealed_score[seat] = pack.score as f64;
                sealed_count += 1;
            }
        }
        if sealed_count == active_seats && active_seats > 0 {
            let mut scores = position.scores();
            for seat in 0..SEAT_COUNT {
                if sealed_flags[seat] == 1 {
                    scores[seat] = sealed_score[seat];
                }
            }
            let value = value_vector(&scores, s.sigmoid_scale, self.rank_blend, self.aggregation);
            self.nodes[id as usize].proven = Some(value);
            return value;
        }

        let skip = if sealed_count > 0 { Some(&sealed_flags) } else { None };
        let mut outcome = self.playout.run(&params, position, &mut self.playout_context, self.phase, skip, rng);
        if outcome.terminal {
            for seat in 0..SEAT_COUNT {
                if sealed_flags[seat] == 1 {
                    outcome.values[seat] = sealed_score[seat];
                }
            }
            return value_vector(&outcome.values, s.sigmoid_scale, self.rank_blend, self.aggregation);
        }
        if sealed_count > 0 {
            let squares_weight = params.phases.get(self.phase).squares;
            for seat in 0..SEAT_COUNT {
                if sealed_flags[seat] != 1 {
                    continue;
                }
                let final_squares = (position.placed_squares(seat) + sealed_squares[seat]) as f64;
                let bonus = if sealed_score[seat] > 0.0 { sealed_score[seat] } else { 0.0 };
                outcome.values[seat] = squares_weight * (final_squares + bonus);
            }
        }
        let mut value = value_vector(&outcome.values, s.eval_scale, self.rank_blend, self.aggregation);
        let material = s.leaf_material_blend;
        if material > 0.0 {
            let mut scores = position.scores();
            for seat in 0..SEAT_COUNT {
                if sealed_flags[seat] == 1 {
                    scores[seat] = sealed_score[seat];
                }
            }
            let material_values = margin_value(&scores, s.sigmoid_scale, self.aggregation);
            for seat in 0..SEAT_COUNT {
                value[seat] = material * material_values[seat] + (1.0 - material) * value[seat];
            }
        }
        value
    }

    fn backup(&mut self, value: &[f64; SEAT_COUNT]) {
        let history = self.params.search.history_weight != 0.0;
        for i in 0..self.path_nodes.len() {
            let node = &mut self.nodes[self.path_nodes[i] as usize];
            let index = self.path_edges[i];
            node.visits += 1.0;
            node.child_visits[index] += 1;
            for seat in 0..SEAT_COUNT {
                node.values[seat] += value[seat];
            }
            if history {
                let (turn, mv) = (node.turn, node.moves[index]);
                self.history.update(turn, mv, value[turn]);
            }
        }
        let leaf = match (self.path_nodes.last(), self.path_edges.last()) {
            (Some(&parent), Some(&index)) => self.nodes[parent as usize].children[index],
            _ => self.root,
        };
        if leaf != NONE {
            let node = &mut self.nodes[leaf as usize];
            node.visits += 1.0;
            for seat in 0..SEAT_COUNT {
                node.values[seat] += value[seat];
            }
        }
    }

    fn best_move(&self) -> i32 {
        let root = &self.nodes[self.root as usize];
        if root.move_count() == 0 {
            return -1;
        }
        let mut best: Option<usize> = None;
        let mut best_visits = -1.0;
        let mut best_value = f64::NEG_INFINITY;
        for index in 0..root.opened {
            let visits = self.decision_visits(index);
            let child = root.children[index];
            let value = if child != NONE && self.nodes[child as usize].visits > 0.0 {
                let c = &self.nodes[child as usize];
                c.values[self.root_seat] / c.visits
            } else {
                -1.0
            };
            if visits > best_visits || (visits == best_visits && value > best_value) {
                best = Some(index);
                best_visits = visits;
                best_value = value;
            }
        }
        root.moves[best.unwrap_or(0)]
    }

    fn rank_root(&self) -> Vec<RankedPlacement> {
        let root = &self.nodes[self.root as usize];
        let ranked: Vec<RankedPlacement> = (0..root.move_count())
            .map(|index| {
                let child = root.children[index];
                let value = if child != NONE && self.nodes[child as usize].visits > 0.0 {
                    let c = &self.nodes[child as usize];
                    c.values[self.root_seat] / c.visits
                } else {
                    0.0
                };
                RankedPlacement { mv: root.moves[index], visits: root.child_visits[index], value, prior: root.priors[index] }
            })
            .collect();
        let decision: Vec<f64> = (0..root.move_count()).map(|i| self.decision_visits(i)).collect();
        let mut order: Vec<usize> = (0..ranked.len()).collect();
        order.sort_by(|&a, &b| {
            decision[b]
                .partial_cmp(&decision[a])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(ranked[b].value.partial_cmp(&ranked[a].value).unwrap_or(std::cmp::Ordering::Equal))
                .then(ranked[a].mv.cmp(&ranked[b].mv))
        });
        order.into_iter().map(|i| ranked[i].clone()).collect()
    }

    fn decided(&self, remaining: u32) -> bool {
        let root = &self.nodes[self.root as usize];
        if root.opened < 2 {
            return false;
        }
        let (mut best, mut second) = (-1i64, -1i64);
        for index in 0..root.opened {
            let visits = root.child_visits[index] as i64;
            if visits > best {
                second = best;
                best = visits;
            } else if visits > second {
                second = visits;
            }
        }
        second + (remaining as i64) < best
    }
}

/// `interleavePieces`: each piece's best placement first, then the duplicates, scores kept.
fn interleave_pieces(moves: &mut [i32], scores: &mut [f64]) {
    let t = placements();
    let mut seen = [false; PIECE_COUNT];
    let mut out_moves = Vec::with_capacity(moves.len());
    let mut out_scores = Vec::with_capacity(moves.len());
    for i in 0..moves.len() {
        let piece = t.piece_id[moves[i] as usize] as usize;
        if !seen[piece] {
            seen[piece] = true;
            out_moves.push(moves[i]);
            out_scores.push(scores[i]);
        }
    }
    for i in 0..moves.len() {
        let piece = t.piece_id[moves[i] as usize];
        if (0..i).any(|before| t.piece_id[moves[before] as usize] == piece) {
            out_moves.push(moves[i]);
            out_scores.push(scores[i]);
        }
    }
    moves.copy_from_slice(&out_moves);
    scores.copy_from_slice(&out_scores);
}

/// Used by the game driver to evaluate positions with the same E_i the search uses.
pub fn evaluate_position(context: &mut EvalContext, position: &Position, params: &BitboardParams, phase: Phase) -> [f64; SEAT_COUNT] {
    refresh_context(context, position, false);
    evaluate(context, position, params, phase)
}
