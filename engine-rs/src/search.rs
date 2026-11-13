//! Multi-player MCTS with max^n vector backup (`bitboard/mcts.ts`, `V12Search`).
//!
//! Nodes live in an arena and are addressed by index; the transposition table maps the low hash
//! half to a bucket of node indices, disambiguated by the high half, exactly as the TS `Map` does.

use crate::backup::*;
use crate::bitboard::*;
use crate::config::{BitboardParams, CandidateOptions, OpeningOptions, Phase, RaveOptions, SelectionOptions};
use crate::feature_prior::PriorContext;
use crate::features::{EvalContext, detect_phase, evaluate, refresh_context};
use crate::ordering::{HistoryTable, MoveOrderer, softmax_priors, sort_by_score};
use crate::packer::solve_sealed_region;
use crate::placements::*;
use crate::playout::Playout;
use crate::position::{MAX_MOVES, Position, SEAT_COUNT, Undo};
use crate::net::{NetClient, NetOptions, NetOutput};
use crate::prior::{PriorClient, encode_request};
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
    /// P6 (`native.rave`): per child edge, (weighted value sum, weight sum) of the AMAF updates.
    /// Empty unless RAVE is on for this node.
    amaf: Vec<[f64; 2]>,
    /// The largest prior among the node's moves (0 before initialisation).
    prior_max: f64,
    /// P4 at interior nodes (`interiorInitVisits`): children carry a prior-derived initial value.
    value_init: bool,
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
            amaf: Vec::new(),
            prior_max: 0.0,
            value_init: false,
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

/// What this move's batched network call said about one root child (E6 side table).
struct EdgeNet {
    /// The child's mover after settling, i.e. the network record's seat.
    mover: usize,
    /// The child's shortlist as `initialise_node` will build it, in the order sent.
    moves: Vec<i32>,
    output: NetOutput,
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
    /// `native.net` (E6). None leaves every path below exactly as it was.
    net_options: Option<NetOptions>,
    net: Option<NetClient>,
    depth1_blend: f64,
    value_visits: f64,
    /// Per root edge, from this move's call; empty unless a child channel is on.
    net_edges: Vec<Option<EdgeNet>>,
    /// Per root edge, `u_i − ū` for the value channel; None for a child without a network value.
    net_value_delta: Vec<Option<f64>>,
    /// Positions sent to the network for the current move.
    net_positions: u32,
    /// `native.candidates` (P4/P5). None leaves every path below exactly as it was.
    candidates: Option<CandidateOptions>,
    /// The game's last placements before this root, (seat, placement), for the local features.
    root_recent: Vec<(usize, i32)>,
    /// Per root edge, `sqrt(p_i / p_max)` for value-initialised children; empty when off.
    init_ratio: Vec<f64>,
    /// `native.reward` kind "rank" (P3). None leaves every value exactly as it was.
    reward: Option<RankReward>,
    /// `native.rollout` "all" with a local weight (P1): the rollout needs the recent placements.
    rollout_local: bool,
    /// `native.rollout` "all" (P1/P2): the rollouts' move lists are derived from the root's.
    rollout_all: bool,
    /// `native.rave` with a positive weight (P6). None leaves selection and backup exactly as before.
    rave: Option<RaveOptions>,
    /// `native.lastGoodReply` enabled (P7); the table itself lives in the playout.
    last_good_reply: bool,
    /// This simulation's placements in order, (seat, placement): tree path, then rollout (P6/P7).
    sim_moves: Vec<(usize, i32)>,
    /// This simulation's final scores, when it ended in a known final score (P7).
    sim_scores: Option<[f64; SEAT_COUNT]>,
    /// Whether this simulation ran a rollout (its moves are then in the playout).
    rollout_ran: bool,
    /// Per placement: the generation it was last played in and its index in `sim_moves` (P6).
    amaf_stamp: Vec<u32>,
    amaf_index: Vec<u32>,
    amaf_generation: u32,
    /// Per placement: its edge index at the root, or NONE (P6; the root can have hundreds of edges).
    root_edge: Vec<u32>,
    /// `native.selection` when it changes anything (P10). None leaves selection exactly as before.
    selection: Option<SelectionOptions>,
    /// Upper bound on |history term| (for the selection cut-off).
    history_bound: f64,
    /// `native.opening` with the centre rule on (P9). None leaves candidate generation as before.
    opening: Option<OpeningOptions>,
    /// P4 at interior nodes (`native.candidates`): all legal moves, no widening, `n0` there.
    interior_full: bool,
    interior_no_widening: bool,
    interior_init_visits: f64,
    /// Diagnostics: the tree part of each simulation (edges descended), summed and maximum.
    depth_sum: u64,
    depth_max: u32,
}

impl V12Search {
    pub fn new(params: Arc<BitboardParams>, table: Option<Arc<RolloutPolicy>>) -> V12Search {
        let fractional = params.fractional_territory_ties;
        let net_options = params.native.as_ref().and_then(|n| n.net.clone());
        let candidates = params.native.as_ref().and_then(|n| n.candidates.clone());
        let reward = params.native.as_ref().and_then(|n| n.reward.as_ref()).filter(|r| r.rank())
            .map(|r| RankReward::new(r.quality_weight, r.quality_slope, r.length_weight));
        let rollout_local = params.native.as_ref().and_then(|n| n.rollout.as_ref())
            .is_some_and(|r| r.all_moves() && r.local_weight != 0.0);
        let rollout_all = params.native.as_ref().and_then(|n| n.rollout.as_ref()).is_some_and(|r| r.all_moves());
        let rave = params.native.as_ref().and_then(|n| n.rave.clone()).filter(|r| r.on());
        let lgr = params.native.as_ref().and_then(|n| n.last_good_reply.clone()).filter(|l| l.enabled);
        let mut playout = Playout::new(table);
        if let Some(l) = &lgr {
            playout.enable_last_good_reply(l.forget);
        }
        let per_placement = if rave.is_some() { placements().count } else { 0 };
        let selection = params.native.as_ref().and_then(|n| n.selection.clone()).filter(|s| s.prior_log() || s.cutoff > 0.0);
        let history_bound = {
            // History scores are means of backed-up values: in [0, 1] for the blend reward, within
            // [-(q + l), 1 + q + l] for the rank reward.
            let spread = params.native.as_ref().and_then(|n| n.reward.as_ref()).filter(|r| r.rank())
                .map_or(1.0, |r| 1.0 + r.quality_weight + r.length_weight);
            params.search.history_weight.abs() * spread
        };
        let opening = params.native.as_ref().and_then(|n| n.opening.clone()).filter(|o| o.centre_on());
        let (interior_full, interior_no_widening, interior_init_visits) = candidates
            .as_ref()
            .map_or((false, false, 0.0), |c| (c.interior_full, c.interior_no_widening, c.interior_init_visits));
        V12Search {
            selection,
            history_bound,
            opening,
            interior_full,
            interior_no_widening,
            interior_init_visits,
            depth_sum: 0,
            depth_max: 0,
            last_good_reply: lgr.is_some(),
            sim_moves: Vec::new(),
            sim_scores: None,
            rollout_ran: false,
            amaf_stamp: vec![0; per_placement],
            amaf_index: vec![0; per_placement],
            amaf_generation: 0,
            root_edge: vec![NONE; per_placement],
            rave,
            candidates,
            reward,
            rollout_local,
            rollout_all,
            root_recent: Vec::new(),
            init_ratio: Vec::new(),
            depth1_blend: net_options.as_ref().map_or(0.0, |n| n.depth1_blend.clamp(0.0, 1.0)),
            value_visits: net_options.as_ref().map_or(0.0, |n| n.value_visits.max(0.0)),
            net_options,
            net: None,
            net_edges: Vec::new(),
            net_value_delta: Vec::new(),
            net_positions: 0,
            aggregation: Aggregation::parse(&params.search.opponent_aggregation),
            brs: params.search.opponent_policy == "brs",
            replay_settle: params.search.replay_settle.unwrap_or(false),
            params,
            nodes: Vec::new(),
            table: FxHashMap::default(),
            context: EvalContext::new(fractional),
            playout_context: EvalContext::new(fractional),
            orderer: MoveOrderer::new(),
            playout,
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
        if let Some(options) = &self.net_options {
            self.net = Some(NetClient::connect(&options.socket)?);
        }
        Ok(())
    }

    pub fn iteration_count(&self) -> u32 {
        self.iterations
    }

    /// The game's placements before the next root, oldest first (only the last three are kept).
    /// Read by the fitted prior's local-response features; without it they are zero.
    pub fn set_recent(&mut self, recent: &[(usize, i32)]) {
        self.root_recent.clear();
        self.root_recent.extend_from_slice(&recent[recent.len().saturating_sub(3)..]);
    }

    /// The root's candidate moves and priors, in tree order, for the move last prepared.
    pub fn root_candidates(&self) -> (&[i32], &[f64]) {
        let root = &self.nodes[self.root as usize];
        (&root.moves, &root.priors)
    }

    /// Positions the network evaluated for the move last prepared (0 without `native.net`).
    pub fn net_evaluations(&self) -> u32 {
        self.net_positions
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
        if let Some(reward) = &mut self.reward {
            reward.clear();
        }
        if let Some(table) = self.playout.reply_table() {
            table.clear();
        }

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
        if self.rave.is_some() {
            self.root_edge.fill(NONE);
            for (edge, &mv) in self.nodes[root as usize].moves.iter().enumerate() {
                self.root_edge[mv as usize] = edge as u32;
            }
        }
        if self.rollout_all {
            self.playout.set_base(position);
        }
        self.init_ratio.clear();
        if let Some(c) = &self.candidates {
            let node = &mut self.nodes[root as usize];
            if c.root_no_widening {
                node.opened = node.moves.len();
            }
            if c.init_visits > 0.0 && !node.priors.is_empty() {
                let max = node.priors.iter().copied().fold(0.0, f64::max);
                self.init_ratio = node.priors.iter().map(|&p| if max > 0.0 { (p / max).sqrt() } else { 1.0 }).collect();
            }
        }
        self.learned_prior = false;
        self.apply_learned_prior(position, root_seat);
        self.net_edges.clear();
        self.net_value_delta.clear();
        self.net_positions = 0;
        if self.net_options.is_some() {
            self.apply_net(position, root_seat);
        }
        self.iterations = 0;
        self.depth_sum = 0;
        self.depth_max = 0;
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
        let Some((moves, priors)) = self.shortlist(position, is_root) else {
            let node = &mut self.nodes[id as usize];
            node.terminal = true;
            node.initialised = true;
            return;
        };
        let shortlist = moves.len();
        let node = &mut self.nodes[id as usize];
        node.moves = moves;
        node.priors = priors;
        node.children = vec![NONE; shortlist];
        node.child_visits = vec![0; shortlist];
        node.opened = 0;
        node.initialised = true;
        node.prior_max = node.priors.iter().copied().fold(0.0, f64::max);
        if !is_root {
            if self.interior_no_widening {
                node.opened = shortlist;
            }
            node.value_init = self.interior_init_visits > 0.0 && node.prior_max > 0.0;
        }
        if let Some(r) = &self.rave
            && (is_root || !r.root_only())
        {
            node.amaf = vec![[0.0; 2]; shortlist];
        }
    }

    /// The move shortlist and hand prior a node at `position` (settled, `position.turn` to move)
    /// gets; None when the mover has no move. Uses only the search's phase and scratch state — no
    /// RNG and no history — so `prepare` can compute a root child's list before the tree reaches it.
    fn shortlist(&mut self, position: &Position, is_root: bool) -> Option<(Vec<i32>, Vec<f64>)> {
        let seat = position.turn;
        let mut buffer = std::mem::take(&mut self.generate_buffer);
        let count = position.generate_moves(seat, &mut buffer, usize::MAX);
        if count == 0 {
            self.generate_buffer = buffer;
            return None;
        }
        let count = match &self.opening {
            Some(o) => centre_rule(o, position, &mut buffer[..count]),
            None => count,
        };
        let params = Arc::clone(&self.params);
        if !is_root && self.interior_full {
            let c = params.native.as_ref().and_then(|n| n.candidates.as_ref()).unwrap();
            let mut moves = buffer[..count].to_vec();
            self.generate_buffer = buffer;
            let recent = self.path_recent();
            let ctx = PriorContext::new(position, seat, &recent);
            let mut scores = vec![0.0; moves.len()];
            c.model.as_ref().expect("interiorFull without a model").score(&ctx, &moves, &mut scores);
            sort_by_score(&mut moves, &mut scores);
            let mut priors = vec![0.0; moves.len()];
            softmax_priors(&scores, c.temperature, &mut priors);
            return Some((moves, priors));
        }
        if is_root && let Some(c) = params.native.as_ref().and_then(|n| n.candidates.as_ref()).filter(|c| c.custom_root()) {
            let moves = buffer[..count].to_vec();
            self.generate_buffer = buffer;
            return Some(self.root_candidates_v5(position, c, moves));
        }
        let fitted_interior = !is_root && params.native.as_ref().and_then(|n| n.candidates.as_ref()).is_some_and(|c| c.interior_fitted());
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
        if !fitted_interior || reserve > 0 {
            refresh_context(&mut self.context, position, with_split || reserve > 0);
        }

        let kept = if reserve > 0 {
            self.reserved_top_k(&buffer[..count], count, funnel, reserve, seat)
        } else {
            top_k(&buffer[..count], &self.tier1_scores[..count], funnel, &mut self.scratch_moves, &mut self.scratch_scores)
        };
        self.generate_buffer = buffer;

        if fitted_interior {
            let c = params.native.as_ref().and_then(|n| n.candidates.as_ref()).unwrap();
            let recent = self.path_recent();
            let ctx = PriorContext::new(position, seat, &recent);
            c.model.as_ref().unwrap().score(&ctx, &self.scratch_moves[..kept], &mut self.scratch_scores[..kept]);
            sort_by_score(&mut self.scratch_moves[..kept], &mut self.scratch_scores[..kept]);
            let shortlist = kept.min(s.node_shortlist as usize);
            let mut priors = vec![0.0; shortlist];
            softmax_priors(&self.scratch_scores[..shortlist], c.temperature, &mut priors);
            return Some((self.scratch_moves[..shortlist].to_vec(), priors));
        }
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
        Some((self.scratch_moves[..shortlist].to_vec(), priors))
    }

    /// P4/P5 root: every legal move scored by the chosen scorer, sorted best first, and either all
    /// kept (`rootFull`) or the `rootShortlist` best. Priors are the scorer's softmax over the kept
    /// moves (fitted: at `temperature`; ordering: at `priorTemp`, as today).
    fn root_candidates_v5(&mut self, position: &Position, c: &CandidateOptions, mut moves: Vec<i32>) -> (Vec<i32>, Vec<f64>) {
        let params = Arc::clone(&self.params);
        let s = &params.search;
        let seat = position.turn;
        let count = moves.len();
        let mut scores = vec![0.0; count];
        let temperature;
        if c.root_fitted() {
            let ctx = PriorContext::new(position, seat, &self.root_recent);
            c.model.as_ref().expect("fitted root scorer without a model").score(&ctx, &moves, &mut scores);
            temperature = c.temperature;
        } else {
            // Today's ordering over every legal move: tier-1 order first so the split term's budget
            // (24, as at today's root) goes to the moves today's funnel would rank highest.
            let t = placements();
            let ordering = params.ordering.get(self.phase);
            let mut tier1: Vec<f64> = moves.iter().map(|&m| t.size[m as usize] as f64 * ordering.piece_size - t.centre_distance[m as usize] as f64 * ordering.centre_pull).collect();
            sort_by_score(&mut moves, &mut tier1);
            refresh_context(&mut self.context, position, true);
            self.orderer.score_moves(&params, position, &self.context, seat, &moves, &mut scores, self.phase, true, 24);
            temperature = s.prior_temp;
        }
        sort_by_score(&mut moves, &mut scores);
        let kept = if c.root_full { count } else { count.min(s.root_shortlist as usize) };
        moves.truncate(kept);
        let mut priors = vec![0.0; kept];
        softmax_priors(&scores[..kept], temperature, &mut priors);
        (moves, priors)
    }

    /// `root_recent` followed by the moves on the current tree path (for interior nodes).
    fn path_recent(&self) -> Vec<(usize, i32)> {
        let mut recent = self.root_recent.clone();
        for (&node, &edge) in self.path_nodes.iter().zip(&self.path_edges) {
            let n = &self.nodes[node as usize];
            recent.push((n.turn, n.moves[edge]));
        }
        let start = recent.len().saturating_sub(3);
        recent.drain(..start);
        recent
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

    /// E6: this move's one batched network call (see `net.rs`). Record 0 is the root, exactly the
    /// record `apply_learned_prior` sends, and its logits blend into the root prior with the same
    /// arithmetic (no re-sort). With a child channel on, each non-terminal root child follows: the
    /// root move applied and settled as `iterate` + `enter_node` would, its shortlist computed as
    /// `initialise_node` will compute it, then undone. No tree node is created here, so lazy node
    /// creation and every child's first visit stay exactly as without the network.
    fn apply_net(&mut self, position: &mut Position, root_seat: usize) {
        let Some(options) = self.net_options.clone() else { return };
        let root = self.root as usize;
        let count = self.nodes[root].move_count();
        // As `apply_learned_prior`: a forced (or empty) root is not sent; nothing could change the move.
        if count < 2 {
            return;
        }
        let root_moves = self.nodes[root].moves.clone();
        let mut records = vec![encode_request(position, root_seat, &root_moves)];
        let mut sizes = vec![root_moves.len()];
        let mut children: Vec<(usize, usize, Vec<i32>)> = Vec::new();
        if options.wants_children() {
            for (edge, &mv) in root_moves.iter().enumerate() {
                let undo = position.apply(mv);
                if self.brs && position.turn != self.root_seat && !position.finished() && position.out[self.root_seat] == 0 {
                    position.force_turn(self.root_seat);
                }
                settle(position);
                if !position.finished()
                    && let Some((moves, _)) = self.shortlist(position, false)
                {
                    records.push(encode_request(position, position.turn, &moves));
                    sizes.push(moves.len());
                    children.push((edge, position.turn, moves));
                }
                position.undo(&undo);
            }
        }
        let client = self.net.as_mut().expect("native.net configured but not connected");
        let outputs = client.evaluate(&records, &sizes).unwrap_or_else(|e| panic!("{e}"));
        self.net_positions = records.len() as u32;

        let scores: Vec<f64> = outputs[0].logits.iter().map(|&l| l as f64).collect();
        let mut net = vec![0.0; scores.len()];
        softmax_priors(&scores, options.temperature, &mut net);
        let blend = options.root_blend.clamp(0.0, 1.0);
        for (prior, learned) in self.nodes[root].priors.iter_mut().zip(&net) {
            *prior = (1.0 - blend) * *prior + blend * learned;
        }

        if children.is_empty() {
            return;
        }
        self.net_edges = (0..count).map(|_| None).collect();
        for ((edge, mover, moves), output) in children.into_iter().zip(outputs.into_iter().skip(1)) {
            self.net_edges[edge] = Some(EdgeNet { mover, moves, output });
        }
        if self.value_visits > 0.0 {
            let beta = self.rank_blend.clamp(0.0, 1.0);
            let utility: Vec<Option<f64>> = self
                .net_edges
                .iter()
                .map(|e| {
                    e.as_ref().map(|e| {
                        let (margin, rank) = e.output.margin_rank(e.mover, root_seat);
                        (1.0 - beta) * margin + beta * rank
                    })
                })
                .collect();
            let evaluated: Vec<f64> = utility.iter().flatten().copied().collect();
            let mean = evaluated.iter().sum::<f64>() / evaluated.len() as f64;
            self.net_value_delta = utility.into_iter().map(|u| u.map(|u| u - mean)).collect();
        }
    }

    /// E6 depth-1 policy: blend the network's policy into a just-initialised root child's prior
    /// (matched by move id) and stably re-sort its moves by the blended prior, best first, so
    /// progressive widening opens them in that order.
    fn apply_depth1_policy(&mut self, id: u32, edge: usize) {
        let Some(Some(edge_net)) = self.net_edges.get(edge) else { return };
        let temperature = self.net_options.as_ref().map_or(1.0, |n| n.depth1_temperature);
        let blend = self.depth1_blend;
        let scores: Vec<f64> = edge_net.output.logits.iter().map(|&l| l as f64).collect();
        let mut net = vec![0.0; scores.len()];
        softmax_priors(&scores, temperature, &mut net);
        let node = &mut self.nodes[id as usize];
        if node.moves != edge_net.moves {
            eprintln!("E6: root edge {edge}: depth-1 shortlist differs from the one prepare sent");
        }
        let blended: Vec<f64> = node
            .moves
            .iter()
            .zip(&node.priors)
            .map(|(mv, &hand)| {
                let learned = edge_net.moves.iter().position(|m| m == mv).and_then(|k| net.get(k)).copied().unwrap_or(0.0);
                (1.0 - blend) * hand + blend * learned
            })
            .collect();
        let mut order: Vec<usize> = (0..blended.len()).collect();
        order.sort_by(|&a, &b| blended[b].partial_cmp(&blended[a]).unwrap_or(std::cmp::Ordering::Equal));
        node.moves = order.iter().map(|&i| node.moves[i]).collect();
        node.priors = order.iter().map(|&i| blended[i]).collect();
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
        settle(position);
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
        if id == self.root && self.candidates.as_ref().is_some_and(|c| c.root_no_widening) {
            return node.move_count();
        }
        let widened = (s.widening_init + s.widening_growth * node.visits.sqrt()).floor();
        (node.move_count() as f64).min(widened) as usize
    }

    fn iterate(&mut self, position: &mut Position, rng: &mut Rng) {
        self.path_nodes.clear();
        self.path_edges.clear();
        self.path_undos.clear();
        self.rollout_ran = false;
        self.sim_scores = None;
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
                    // A root child, initialised on its second visit: E6 depth-1 policy.
                    if self.depth1_blend > 0.0 && self.path_nodes.len() == 1 {
                        self.apply_depth1_policy(node, self.path_edges[0]);
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
        let depth = self.path_nodes.len() as u32;
        self.depth_sum += depth as u64;
        self.depth_max = self.depth_max.max(depth);
        let value = self.leaf_value(node, position, rng);
        self.backup(&value);
        if self.rave.is_some() || self.last_good_reply {
            self.sim_moves.clear();
            for undo in &self.path_undos {
                self.sim_moves.push((undo.seat, undo.mv));
            }
            if self.rollout_ran {
                self.playout.played(&mut self.sim_moves);
            }
            if self.rave.is_some() {
                self.update_amaf(&value);
            }
            if self.last_good_reply
                && let Some(scores) = self.sim_scores
            {
                let best = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let won: [bool; SEAT_COUNT] = std::array::from_fn(|seat| scores[seat] == best);
                let prev = self.root_previous();
                let moves = std::mem::take(&mut self.sim_moves);
                self.playout.reply_table().expect("last-good-reply table").learn(prev, &moves, &won);
                self.sim_moves = moves;
            }
        }
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
        // E6 root-child value: n_v virtual visits of the network utility, re-centred on the root's
        // current rollout mean for the root seat. Off (empty table) without `native.net`.
        let net_value = id == self.root && !self.net_value_delta.is_empty();
        // P4/P5 value-initialised root children: n0 virtual visits at m · sqrt(p_i / p_max), mixed
        // into Q exactly as the E6 value term is. Off (empty table) without `initVisits`.
        let init_value = id == self.root && !self.init_ratio.is_empty();
        let n0 = self.candidates.as_ref().map_or(0.0, |c| c.init_visits);
        let n_v = self.value_visits;
        let root_mean = if node.visits > 0.0 { node.values[self.root_seat] / node.visits } else { 0.5 };
        // P4 at interior nodes: children start at m · sqrt(p_i / p_max) with `interiorInitVisits`
        // virtual visits, m the node's current mean for its mover (component, inverted if paranoid).
        let interior_init = id != self.root && node.value_init;
        let n0_interior = self.interior_init_visits;
        let mover_mean = if invert { 1.0 - parent_mean } else { parent_mean };
        // P10: the "priorLog" rule here, its count offset k and exploration factor; the cut-off bound.
        let sel = self.selection.as_ref();
        let prior_log = sel.is_some_and(|x| x.applies(id == self.root));
        let k = if init_value {
            n0
        } else if interior_init {
            n0_interior
        } else {
            sel.map_or(1.0, |x| x.count_offset)
        };
        let log_factor = if prior_log {
            let n = node.visits;
            sel.unwrap().exploration * n.sqrt() * (n + 1.0).ln()
        } else {
            0.0
        };
        let cutoff = match sel {
            Some(x) if x.cutoff > 0.0 => {
                let explore = if prior_log { log_factor * node.prior_max / k } else { s.c_puct * node.prior_max * sqrt_visits };
                x.cutoff * (explore + self.history_bound)
            }
            _ => f64::INFINITY,
        };
        let mut best_index = None;
        let mut best_score = f64::NEG_INFINITY;
        for index in 0..node.opened {
            let child = node.children[index];
            let edge_visits = node.child_visits[index] as f64;
            let q = if init_value {
                let v = root_mean * self.init_ratio[index];
                if child == NONE || self.nodes[child as usize].visits == 0.0 {
                    v
                } else {
                    let c = &self.nodes[child as usize];
                    (c.values[self.root_seat] + n0 * v) / (c.visits + n0)
                }
            } else if net_value && let Some(delta) = self.net_value_delta[index] {
                let u = (root_mean + delta).clamp(0.0, 1.0);
                if child == NONE || self.nodes[child as usize].visits == 0.0 {
                    u
                } else {
                    let c = &self.nodes[child as usize];
                    (c.values[self.root_seat] + n_v * u) / (c.visits + n_v)
                }
            } else if interior_init {
                let v = mover_mean * (node.priors[index] / node.prior_max).sqrt();
                if child == NONE || self.nodes[child as usize].visits == 0.0 {
                    v
                } else {
                    let c = &self.nodes[child as usize];
                    let w = if invert { c.visits - c.values[component] } else { c.values[component] };
                    (w + n0_interior * v) / (c.visits + n0_interior)
                }
            } else if child == NONE || self.nodes[child as usize].visits == 0.0 {
                (if invert { 1.0 - parent_mean } else { parent_mean }) - s.fpu_reduction
            } else {
                let c = &self.nodes[child as usize];
                let mean = c.values[component] / c.visits;
                if invert { 1.0 - mean } else { mean }
            };
            let q = if node.amaf.is_empty() || node.amaf[index][1] <= 0.0 {
                q
            } else {
                // P6: blend in the edge's AMAF mean. `n` is the count behind Q: the child's visits,
                // plus the virtual visits of a value-initialised root child.
                let r = self.rave.as_ref().unwrap();
                let child_n = if child == NONE { 0.0 } else { self.nodes[child as usize].visits };
                let n = if init_value { child_n + n0 } else { child_n };
                let [sum, weight] = node.amaf[index];
                let amaf_mean = sum / weight;
                let amaf_q = if invert { 1.0 - amaf_mean } else { amaf_mean };
                let tilde = r.weight * weight;
                let beta = tilde / (tilde + n + n * tilde / r.equivalence);
                (1.0 - beta) * q + beta * amaf_q
            };
            if q + cutoff <= best_score {
                // P10 cut-off: even the largest exploration and history terms cannot lift it above.
                continue;
            }
            let u = if prior_log {
                log_factor * node.priors[index] / (edge_visits + k)
            } else {
                1.0 * s.c_puct * node.priors[index] * (sqrt_visits / (1.0 + edge_visits))
            };
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
            if self.last_good_reply {
                self.sim_scores = Some(position.scores());
            }
            let value = match &mut self.reward {
                Some(reward) => reward.value(&position.scores(), Some(position.ply as f64)),
                None => value_vector(&position.scores(), s.sigmoid_scale, self.rank_blend, Aggregation::Max),
            };
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
            if self.last_good_reply {
                self.sim_scores = Some(scores);
            }
            let value = match &mut self.reward {
                // The packer gives scores, not the number of pieces it places: no length term.
                Some(reward) => reward.value(&scores, None),
                None => value_vector(&scores, s.sigmoid_scale, self.rank_blend, self.aggregation),
            };
            self.nodes[id as usize].proven = Some(value);
            return value;
        }

        let skip = if sealed_count > 0 { Some(&sealed_flags) } else { None };
        if self.rollout_local {
            let recent = self.path_recent();
            self.playout.set_recent(&recent);
        }
        if self.last_good_reply {
            let prev = match (self.path_nodes.last(), self.path_edges.last()) {
                (Some(&node), Some(&edge)) => self.nodes[node as usize].moves[edge],
                _ => self.root_previous(),
            };
            self.playout.set_previous(prev);
        }
        let mut outcome = self.playout.run(&params, position, &mut self.playout_context, self.phase, skip, rng);
        self.rollout_ran = true;
        if outcome.terminal {
            for seat in 0..SEAT_COUNT {
                if sealed_flags[seat] == 1 {
                    outcome.values[seat] = sealed_score[seat];
                }
            }
            if self.last_good_reply {
                self.sim_scores = Some(outcome.values);
            }
            if let Some(reward) = &mut self.reward {
                // With sealed seats left out of the rollout, their pieces are not in the length.
                let length = if sealed_count > 0 { None } else { Some(outcome.plies as f64) };
                return reward.value(&outcome.values, length);
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

    /// The game's last placement before this search's root, or -1 (P7).
    fn root_previous(&self) -> i32 {
        self.root_recent.last().map_or(-1, |&(_, mv)| mv)
    }

    /// P6: credits every path node's edges whose placement the node's mover played at or after that
    /// node in this simulation (tree or rollout), with the simulation's value for the node's Q
    /// component, weighted by distance when `distanceDecay` > 0. A placement occupies its cells, so it
    /// appears at most once in a simulation.
    fn update_amaf(&mut self, value: &[f64; SEAT_COUNT]) {
        let (decay, root_only) = {
            let r = self.rave.as_ref().unwrap();
            (r.distance_decay, r.root_only())
        };
        let total = self.sim_moves.len();
        self.amaf_generation = self.amaf_generation.wrapping_add(1);
        if self.amaf_generation == 0 {
            self.amaf_stamp.fill(0);
            self.amaf_generation = 1;
        }
        let generation = self.amaf_generation;
        for (j, &(_, mv)) in self.sim_moves.iter().enumerate() {
            self.amaf_stamp[mv as usize] = generation;
            self.amaf_index[mv as usize] = j as u32;
        }
        let depth = if root_only { self.path_nodes.len().min(1) } else { self.path_nodes.len() };
        for i in 0..depth {
            let id = self.path_nodes[i];
            let node = &mut self.nodes[id as usize];
            if node.amaf.is_empty() {
                continue;
            }
            let seat = node.turn;
            debug_assert_eq!(self.sim_moves[i].0, seat, "path move by another seat than the node's mover");
            let v = value[if self.paranoid { self.root_seat } else { seat }];
            let span = (total - i) as f64;
            let weight_at = |j: usize| if decay > 0.0 { 1.0 - decay * (j - i) as f64 / span } else { 1.0 };
            if id == self.root {
                for j in i..total {
                    let (s, mv) = self.sim_moves[j];
                    let edge = self.root_edge[mv as usize];
                    if s != seat || edge == NONE {
                        continue;
                    }
                    let w = weight_at(j);
                    let slot = &mut node.amaf[edge as usize];
                    slot[0] += w * v;
                    slot[1] += w;
                }
            } else {
                for edge in 0..node.moves.len() {
                    let mv = node.moves[edge] as usize;
                    if self.amaf_stamp[mv] != generation {
                        continue;
                    }
                    let j = self.amaf_index[mv] as usize;
                    if j < i || self.sim_moves[j].0 != seat {
                        continue;
                    }
                    let w = weight_at(j);
                    let slot = &mut node.amaf[edge];
                    slot[0] += w * v;
                    slot[1] += w;
                }
            }
        }
    }

    /// P8 diagnostic (read only): the visits of the node for `position` in the tree as the last
    /// search left it, if there is one. Needs transpositions (the node is found by its hash).
    pub fn node_visits(&self, position: &Position) -> Option<f64> {
        if !self.params.search.transpositions || self.nodes.is_empty() {
            return None;
        }
        let bucket = self.table.get(&position.hash_lo)?;
        bucket.iter().map(|&id| &self.nodes[id as usize]).find(|n| n.hash_hi == position.hash_hi).map(|n| n.visits)
    }

    /// Diagnostics (read only): per root edge, (real visits, AMAF weight sum); the AMAF part is 0
    /// without RAVE.
    pub fn root_edge_stats(&self) -> Vec<(i32, f64)> {
        let root = &self.nodes[self.root as usize];
        (0..root.move_count()).map(|i| (root.child_visits[i], root.amaf.get(i).map_or(0.0, |a| a[1]))).collect()
    }

    /// Diagnostics (read only): the shape of the tree the last search left.
    pub fn tree_shape(&self) -> TreeShape {
        let mut shape = TreeShape { iterations: self.iterations, depth_max: self.depth_max, nodes_total: self.nodes.len(), ..Default::default() };
        if self.root == NONE || self.nodes.is_empty() {
            return shape;
        }
        shape.depth_mean = if self.iterations > 0 { self.depth_sum as f64 / self.iterations as f64 } else { 0.0 };
        let mut depth = vec![u32::MAX; self.nodes.len()];
        let mut frontier = vec![self.root];
        depth[self.root as usize] = 0;
        let mut d = 0usize;
        while !frontier.is_empty() {
            shape.nodes_by_depth.push(0);
            shape.visits_by_depth.push(0.0);
            let mut next = Vec::new();
            for &id in &frontier {
                let n = &self.nodes[id as usize];
                shape.nodes_by_depth[d] += 1;
                shape.visits_by_depth[d] += n.visits;
                for &c in &n.children {
                    if c != NONE && depth[c as usize] == u32::MAX {
                        depth[c as usize] = d as u32 + 1;
                        next.push(c);
                    }
                }
            }
            frontier = next;
            d += 1;
        }
        let root = &self.nodes[self.root as usize];
        shape.root_edges = root.move_count();
        let mut v: Vec<i32> = root.child_visits.clone();
        v.sort_unstable_by(|a, b| b.cmp(a));
        let total: i64 = v.iter().map(|&x| x as i64).sum();
        shape.root_visited = v.iter().filter(|&&x| x > 0).count();
        if total > 0 {
            shape.root_top_share = v[0] as f64 / total as f64;
            let (mut acc, mut k50, mut k90) = (0i64, 0usize, 0usize);
            for (i, &x) in v.iter().enumerate() {
                acc += x as i64;
                if k50 == 0 && acc * 2 >= total {
                    k50 = i + 1;
                }
                if k90 == 0 && acc * 10 >= total * 9 {
                    k90 = i + 1;
                    break;
                }
            }
            shape.root_50 = k50;
            shape.root_90 = k90;
        }
        let mut id = self.root;
        for _ in 0..16 {
            let n = &self.nodes[id as usize];
            let Some((best, _)) = n.child_visits.iter().enumerate().filter(|(_, v)| **v > 0).max_by_key(|(i, v)| (**v, std::cmp::Reverse(*i))) else { break };
            let c = n.children[best];
            if c == NONE {
                break;
            }
            shape.pv_visits.push(self.nodes[c as usize].visits);
            id = c;
        }
        for (i, n) in self.nodes.iter().enumerate() {
            if i as u32 == self.root || !n.initialised || n.terminal || n.moves.is_empty() {
                continue;
            }
            let visited = n.child_visits.iter().filter(|&&x| x > 0).count();
            shape.interior_nodes += 1;
            shape.interior_edges += n.moves.len();
            shape.interior_visited += visited;
            if n.visits >= 100.0 {
                let edge_total: i64 = n.child_visits.iter().map(|&x| x as i64).sum();
                let top = n.child_visits.iter().copied().max().unwrap_or(0);
                shape.busy_nodes += 1;
                shape.busy_edges += n.moves.len();
                shape.busy_visited += visited;
                shape.busy_top_share_sum += if edge_total > 0 { top as f64 / edge_total as f64 } else { 0.0 };
            }
        }
        shape
    }

    /// Diagnostics: (rollout moves asked of the reply table, moves it supplied) since the table was
    /// built; None without `native.lastGoodReply`.
    pub fn reply_stats(&mut self) -> Option<(u64, u64)> {
        self.playout.reply_table().map(|t| (t.asked, t.supplied))
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

/// P9 centre rule: if the mover has played fewer than `centreMaxOwnMove` pieces, keep (in order)
/// only the moves whose centre distance is at most the smallest plus `centreSlack`; returns the count.
fn centre_rule(o: &OpeningOptions, position: &Position, moves: &mut [i32]) -> usize {
    let seat = position.turn;
    let own = (PIECE_COUNT as u32 - position.hand[seat].count_ones()) as f64;
    if own >= o.centre_max_own_move || moves.is_empty() {
        return moves.len();
    }
    let t = placements();
    let min = moves.iter().map(|&m| t.centre_distance[m as usize] as f64).fold(f64::INFINITY, f64::min);
    let limit = min + o.centre_slack;
    let mut kept = 0;
    for i in 0..moves.len() {
        let m = moves[i];
        if t.centre_distance[m as usize] as f64 <= limit {
            moves[kept] = m;
            kept += 1;
        }
    }
    kept
}

/// Tree-shape diagnostics of the last search (read only; P9/P10 probe).
#[derive(Clone, Debug, Default)]
pub struct TreeShape {
    pub iterations: u32,
    /// Edges descended in the tree part of a simulation: mean and maximum over the search.
    pub depth_mean: f64,
    pub depth_max: u32,
    /// Per depth (0 = root; a node counted once, at its smallest depth): nodes and their visits.
    pub nodes_by_depth: Vec<usize>,
    pub visits_by_depth: Vec<f64>,
    /// Visits of the nodes along the most-visited line (index 0 = after the root move).
    pub pv_visits: Vec<f64>,
    pub root_edges: usize,
    pub root_visited: usize,
    /// Fewest root children holding 50% / 90% of the root's edge visits, and the top child's share.
    pub root_50: usize,
    pub root_90: usize,
    pub root_top_share: f64,
    /// Initialised non-terminal non-root nodes: count, candidate edges, edges with a visit.
    pub interior_nodes: usize,
    pub interior_edges: usize,
    pub interior_visited: usize,
    /// The same for interior nodes with at least 100 visits, plus the sum of their top-edge shares.
    pub busy_nodes: usize,
    pub busy_edges: usize,
    pub busy_visited: usize,
    pub busy_top_share_sum: f64,
    pub nodes_total: usize,
}

/// `enter_node`'s settle: seats with no move are marked out until someone can move or all are out.
fn settle(position: &mut Position) {
    let mut guard = 0;
    while !position.finished() && guard < SEAT_COUNT {
        if position.has_move(position.turn) {
            break;
        }
        position.mark_out(position.turn);
        position.advance_turn();
        guard += 1;
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
