//! `BitboardParams`, deserialised from the JSON that `scripts/exportResolvedConfigs.ts` writes.
//!
//! The TS version registry stays the single source of truth: a version is resolved there
//! (`bitboardParamsFor`) and shipped here as data, so the two engines can never disagree about
//! what a version id means. Anything this engine does not implement is rejected by
//! [`BitboardParams::unsupported`] rather than silently ignored — a config falling through to a
//! different engine has already cost this project a day of measurements once.

use crate::feature_prior::PriorModel;
use crate::net::NetOptions;
use crate::prior::PriorOptions;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Opening,
    Midgame,
    Endgame,
}

impl Phase {
    #[inline(always)]
    pub fn index(self) -> usize {
        match self {
            Phase::Opening => 0,
            Phase::Midgame => 1,
            Phase::Endgame => 2,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseWeights {
    pub squares: f64,
    pub corners: f64,
    pub territory: f64,
    pub waste: f64,
    pub centre: f64,
    pub frontier: f64,
    pub opp_territory: f64,
    pub opp_corners: f64,
    pub opp_squares: f64,
    pub mobility: f64,
    pub unique_corners: f64,
    pub corner_exponent: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LambdaProfile {
    pub next: f64,
    pub prev: f64,
    pub diag: f64,
    pub leader_boost: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatProfile {
    pub centre: f64,
    pub corners: f64,
    pub territory: f64,
    pub waste: f64,
    pub aggression: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOrderWeights {
    pub piece_size: f64,
    pub split: f64,
    pub new_corners: f64,
    pub deny_corners: f64,
    pub centre_pull: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerPhase<T> {
    pub opening: T,
    pub midgame: T,
    pub endgame: T,
}

impl<T> PerPhase<T> {
    #[inline(always)]
    pub fn get(&self, phase: Phase) -> &T {
        match phase {
            Phase::Opening => &self.opening,
            Phase::Midgame => &self.midgame,
            Phase::Endgame => &self.endgame,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub root_policy: String,
    pub implicit_maxn_weight: f64,
    pub rave_equivalence: f64,
    pub variance_tuned: bool,
    pub variance_tuned_root_only: bool,
    pub root_audit: String,
    pub root_audit_top_k: f64,
    pub root_audit_rollouts: f64,
    pub root_audit_blend: f64,
    pub root_grouping: String,
    #[serde(default)]
    pub net_path: Option<String>,
    #[serde(default)]
    pub pooled_net_path: Option<String>,
    pub net_scale: f64,
    pub net_blend: f64,
    pub net_output_kind: String,
    pub net_value_sampling: String,
    pub net_sample_scale: f64,
    pub net_tail_prefix: f64,
    pub net_tail_max_std: f64,
    pub net_rollout_probability: f64,
    pub net_prior: bool,
    pub net_prior_phase: String,
    pub net_prior_blend: f64,
    pub net_prior_temp: f64,
    pub root_prior_pseudo_visits: f64,
    pub c_puct: f64,
    pub fpu_reduction: f64,
    pub prior_temp: f64,
    pub widening_init: f64,
    pub widening_growth: f64,
    pub widening_all_nodes: bool,
    pub playout_eps: f64,
    #[serde(default)]
    pub playout_eps_by_phase: Option<PerPhase<f64>>,
    pub playout_cutoff: f64,
    pub playout_move_cap: f64,
    pub playout_corners: f64,
    pub playout_policy: String,
    pub playout_corner_weight: f64,
    pub playout_edge_weight: f64,
    pub playout_temp: f64,
    #[serde(default)]
    pub playout_table_path: Option<String>,
    #[serde(default)]
    pub playout_table_blend: Option<f64>,
    pub playout_mast_weight: f64,
    pub playout_mast_granularity: String,
    pub playout_mast_lifetime: String,
    pub sigmoid_scale: f64,
    pub eval_scale: f64,
    pub rank_blend: f64,
    pub opponent_aggregation: String,
    pub leaf_material_blend: f64,
    pub objective_shift: bool,
    pub history_weight: f64,
    pub opponent_policy: String,
    pub paranoid_lead: f64,
    pub transpositions: bool,
    pub tree_reuse: bool,
    pub root_ensemble_trees: f64,
    pub root_piece_feasibility_weight: f64,
    pub root_piece_diversity: bool,
    pub virtual_loss: f64,
    pub iteration_scale: f64,
    #[serde(default)]
    pub iteration_shape: Option<Vec<f64>>,
    #[serde(default)]
    pub book_path: Option<String>,
    #[serde(default)]
    pub opening_select_max_own_move: Option<f64>,
    #[serde(default)]
    pub opening_select_min_own_move: Option<f64>,
    #[serde(default)]
    pub opening_select_gate: Option<serde_json::Value>,
    #[serde(default)]
    pub opening_rank_offset: Option<f64>,
    #[serde(default)]
    pub opening_rank_offset_max_own_move: Option<f64>,
    #[serde(default)]
    pub opening_rank_offset_min_own_move: Option<f64>,
    #[serde(default)]
    pub opening_heuristic_max_own_move: Option<f64>,
    #[serde(default)]
    pub iteration_banking: Option<bool>,
    pub root_shortlist: f64,
    pub node_shortlist: f64,
    pub split_at_interior: bool,
    pub interior_split_budget: f64,
    pub funnel_reserve: f64,
    /// Re-apply a node's cached settle on every descent (`replaySettle` in config.ts).
    #[serde(default)]
    pub replay_settle: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndgameParams {
    pub max_region_cells: f64,
    pub max_own_moves: f64,
    pub node_budget: f64,
    pub memo_limit: f64,
    pub near_sealed: bool,
    pub gate_remaining_squares: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeParams {
    pub probe_fraction: f64,
    pub min_iterations: f64,
    pub spread_factor: f64,
    pub early_exit: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseDetection {
    pub opening_moves: f64,
    pub midgame_moves: f64,
    pub contested_floor: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitboardParams {
    pub fractional_territory_ties: bool,
    pub aggression_scale: f64,
    pub phases: PerPhase<PhaseWeights>,
    pub lambda: PerPhase<LambdaProfile>,
    pub ordering: PerPhase<MoveOrderWeights>,
    pub seats: Vec<SeatProfile>,
    pub search: SearchParams,
    pub endgame: EndgameParams,
    pub time: TimeParams,
    pub detection: PhaseDetection,
    /// Native-only extensions; absent in every config exported from TS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeOptions>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOptions {
    #[serde(default)]
    pub prior: Option<PriorOptions>,
    /// The network inside the search (E6): root prior, depth-1 policy and root-child value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net: Option<NetOptions>,
    /// v5.0 port P4/P5: root candidate generation, value-initialised root children and the fitted
    /// feature prior. Absent (or every switch at its default) leaves the search exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidates: Option<CandidateOptions>,
    /// v5.0 port P1/P2: how a rollout chooses its moves. Absent, or `policy` "sampled", leaves the
    /// rollout exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollout: Option<RolloutOptions>,
    /// v5.0 port P3: what a finished simulation is worth. Absent, or `kind` "blend", leaves the
    /// reward exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reward: Option<RewardOptions>,
    /// v5.0 port P6: all-moves-as-first (RAVE) statistics per tree edge, blended into the edge's
    /// value in selection. Absent, or `weight` 0, leaves the search exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rave: Option<RaveOptions>,
    /// v5.0 port P7: last-good-reply table tried first in rollouts. Absent, or `enabled` false,
    /// leaves the rollout exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_good_reply: Option<LastGoodReplyOptions>,
    /// v5.0 port P10: the tree's child-selection rule. Absent, or `rule` "puct", leaves selection
    /// exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionOptions>,
    /// v5.0 port P9: opening rules (centre restriction of early candidates, large pieces only early
    /// in rollouts). Absent, or every switch at 0, leaves the search exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opening: Option<OpeningOptions>,
}

/// `native.selection` (see `engine-rs/README.md`, "Selection rule, interior expansion and opening
/// rules (P9/P10)").
///
/// `rule` "puct" is today's `Q + cPuct·p·sqrt(max(1, N))/(1 + n) + history`. `rule` "priorLog" is
/// `Q + exploration·p·sqrt(N)·ln(N + 1)/(n + k) + history`, with N the node's real visits, n the
/// edge's visits and k the value-initialisation count at a value-initialised node (`initVisits` at
/// the root, `interiorInitVisits` inside) or `countOffset` elsewhere. `cutoff` > 0 skips a child whose
/// Q cannot reach the best score so far even with the largest exploration and history terms the node
/// can give (scaled by `cutoff`; 1 is exact and changes no choice).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionOptions {
    #[serde(default = "puct")]
    pub rule: String,
    /// The exploration constant of "priorLog".
    #[serde(default = "one")]
    pub exploration: f64,
    /// "all": root and interior nodes; "root" or "interior": only there (the rest keeps PUCT).
    #[serde(default = "all_scope")]
    pub scope: String,
    /// Count added to an edge's visits in the "priorLog" denominator at nodes that are not
    /// value-initialised.
    #[serde(default = "one")]
    pub count_offset: f64,
    /// 0: off. In (0, 1]: skip children whose Q is at most best − cutoff·(largest possible bonus).
    #[serde(default)]
    pub cutoff: f64,
}

fn puct() -> String {
    "puct".into()
}

impl SelectionOptions {
    pub fn prior_log(&self) -> bool {
        self.rule == "priorLog"
    }

    /// Whether "priorLog" applies at the root (`root` true) or at an interior node.
    pub fn applies(&self, root: bool) -> bool {
        self.prior_log() && (self.scope == "all" || (root && self.scope == "root") || (!root && self.scope == "interior"))
    }
}

/// `native.opening` (P9; see `engine-rs/README.md`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpeningOptions {
    /// Centre rule: at any searched node (root or interior) whose mover has played fewer than this
    /// many pieces, only the legal moves whose centre distance (`placements().centre_distance`, the
    /// mean over the piece's squares) is at most the smallest one plus `centreSlack` are candidates.
    /// 0 is off. The opening shortcut (`openingHeuristicMaxOwnMove`) decides before the search, so
    /// with it on the rule never acts at own moves below the shortcut's limit.
    #[serde(default)]
    pub centre_max_own_move: f64,
    #[serde(default)]
    pub centre_slack: f64,
    /// Large-piece rule: in a rollout (policy "sampled"), while fewer than `rolloutUntilPieces`
    /// pieces are on the board (all seats), the mover's candidates are drawn from its pieces of at
    /// least `rolloutMinSize` squares; if that finds no move, from all its pieces. 0 is off.
    #[serde(default)]
    pub rollout_min_size: f64,
    #[serde(default)]
    pub rollout_until_pieces: f64,
}

impl OpeningOptions {
    pub fn centre_on(&self) -> bool {
        self.centre_max_own_move > 0.0
    }

    pub fn rollout_on(&self) -> bool {
        self.rollout_min_size > 0.0 && self.rollout_until_pieces > 0.0
    }
}

/// `native.rave` (see `engine-rs/README.md`, "RAVE and last-good-reply (P6/P7)").
///
/// Each tree edge (node, child placement) keeps a second value estimate: the weighted mean of the
/// simulation's value for the node's mover over every simulation that passed through the node and in
/// which the mover played that placement at or after the node (in the tree or the rollout). In
/// selection the edge's value becomes `(1 − β)·Q + β·Q_amaf` with
/// `β = ñ / (ñ + n + n·ñ / equivalence)`, `ñ = weight · (AMAF weight sum)` and `n` the real count
/// behind Q (child visits, plus `initVisits` at a value-initialised root).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RaveOptions {
    /// Scale on the AMAF sample count before it is weighed against real visits. 0 is off.
    #[serde(default)]
    pub weight: f64,
    /// Real visits at which, with many AMAF samples, the AMAF estimate and the real one weigh equally.
    #[serde(default = "rave_equivalence")]
    pub equivalence: f64,
    /// Distance weighting: an update for a placement played `k` moves after the node, in a
    /// simulation with `L` moves left from the node, counts `1 − distanceDecay · k / L`. 0 is off.
    #[serde(default)]
    pub distance_decay: f64,
    /// "all": every tree node keeps and uses the statistics; "root": the root only.
    #[serde(default = "all_scope")]
    pub scope: String,
}

fn rave_equivalence() -> f64 {
    100.0
}

fn all_scope() -> String {
    "all".into()
}

impl RaveOptions {
    pub fn on(&self) -> bool {
        self.weight > 0.0
    }

    pub fn root_only(&self) -> bool {
        self.scope == "root"
    }
}

/// `native.lastGoodReply` (see `engine-rs/README.md`, "RAVE and last-good-reply (P6/P7)").
///
/// Per seat, a table from the placement just before that seat's move (by any seat; passes are
/// skipped) to the seat's reply. After each simulation that ends in a known final score, every
/// reply in it (tree part and rollout) by a seat whose score is the highest (ties included) is
/// stored; with `forget`, a reply by any other seat is deleted if it is the one stored. In a
/// rollout the stored reply to the previous placement is played first whenever it is legal. The
/// table is cleared at the start of each search.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastGoodReplyOptions {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub forget: bool,
}

fn yes() -> bool {
    true
}

/// `native.rollout` (see `engine-rs/README.md`, "Rollout policy and reward (P1–P3)").
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RolloutOptions {
    /// "sampled" (today: one random own corner, at most `playoutMoveCap` placements, ε-greedy) or
    /// "all": the mover's full legal-move list, kept incrementally (P2), sampled with weight
    /// `exp(sizeWeight · size + localWeight · (local + localOwnExtra · localOwn))`.
    #[serde(default = "sampled")]
    pub policy: String,
    /// Log-weight per square of the piece.
    #[serde(default)]
    pub size_weight: f64,
    /// Log-weight per "local" square covered: a corner opened by an opponent's placement made since
    /// the mover's own last one (still usable by that opponent), or an empty orthogonal neighbour of
    /// one (not forbidden to that opponent).
    #[serde(default)]
    pub local_weight: f64,
    /// Extra count for a local square that is also one of the mover's own open corners.
    #[serde(default)]
    pub local_own_extra: f64,
}

fn sampled() -> String {
    "sampled".into()
}

impl RolloutOptions {
    pub fn all_moves(&self) -> bool {
        self.policy == "all"
    }
}

/// `native.reward` (see `engine-rs/README.md`, "Rollout policy and reward (P1–P3)").
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RewardOptions {
    /// "blend" (today: `sigmoidScale` margin over the best opponent blended with rank by
    /// `rankBlend`) or "rank": fraction of opponents beaten (ties count half), plus
    /// `qualityWeight · tanh(qualitySlope · z)` with z the seat's margin over the mean opponent
    /// standardised by this search's running mean and deviation, minus
    /// `lengthWeight · (rank − ½) · tanh(qualitySlope · z_len)` with z_len the standardised game
    /// length (placements).
    #[serde(default = "blend")]
    pub kind: String,
    #[serde(default)]
    pub quality_weight: f64,
    #[serde(default = "one")]
    pub quality_slope: f64,
    #[serde(default)]
    pub length_weight: f64,
}

fn blend() -> String {
    "blend".into()
}

impl RewardOptions {
    pub fn rank(&self) -> bool {
        self.kind == "rank"
    }
}

/// `native.candidates` (see `engine-rs/README.md`, "Candidate generation (P4/P5)").
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateOptions {
    /// Scorer that orders and gives priors to the root's moves: "ordering" (today's hand ordering)
    /// or "fitted" (`model`). "fitted" without `rootFull` takes the `rootShortlist` best moves by the
    /// fitted score over *all* legal moves (no size/centre funnel).
    #[serde(default = "ordering")]
    pub root_scorer: String,
    /// Every legal root move becomes a child, ordered by the root scorer.
    #[serde(default)]
    pub root_full: bool,
    /// No progressive widening at the root: every root child is selectable from the first iteration
    /// (unvisited children score with their initial value instead of being opened one per iteration).
    #[serde(default)]
    pub root_no_widening: bool,
    /// Value-initialised root children: `n0` virtual visits at `m · sqrt(p_i / p_max)` for the root
    /// seat, `m` the root's current rollout mean, `p` the root prior. 0 is off.
    #[serde(default)]
    pub init_visits: f64,
    /// Scorer that chooses and orders the `nodeShortlist` at interior nodes from today's
    /// size/centre funnel: "ordering" (today) or "fitted".
    #[serde(default = "ordering")]
    pub interior_scorer: String,
    /// P4 at interior nodes: every legal move of an interior node becomes a child, scored by the
    /// fitted interior scorer over all of them (no size/centre funnel, no `nodeShortlist` cap).
    #[serde(default)]
    pub interior_full: bool,
    /// No progressive widening at interior nodes: every child is selectable from the node's first
    /// selection (as `rootNoWidening` at the root).
    #[serde(default)]
    pub interior_no_widening: bool,
    /// Value-initialised interior children: `n0` virtual visits at `m · sqrt(p_i / p_max)` for the
    /// node's mover, `m` the node's current mean for the mover, `p` the node's prior. 0 is off.
    #[serde(default)]
    pub interior_init_visits: f64,
    /// Softmax temperature over fitted scores (the fit is at temperature 1).
    #[serde(default = "one")]
    pub temperature: f64,
    /// The fitted model (`ml/v5-prior-weights.json`), inline so a config is self-contained.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<PriorModel>,
}

fn ordering() -> String {
    "ordering".into()
}

fn one() -> f64 {
    1.0
}

impl CandidateOptions {
    pub fn root_fitted(&self) -> bool {
        self.root_scorer == "fitted"
    }

    pub fn interior_fitted(&self) -> bool {
        self.interior_scorer == "fitted"
    }

    /// Whether the root is built by the P4/P5 path rather than today's `shortlist`.
    pub fn custom_root(&self) -> bool {
        self.root_full || self.root_fitted()
    }
}

impl BitboardParams {
    /// Every reason this engine would play the config differently from the TS engine, if any.
    pub fn unsupported(&self) -> Vec<String> {
        let s = &self.search;
        let mut out = Vec::new();
        let mut reject = |cond: bool, what: &str| {
            if cond {
                out.push(what.to_string());
            }
        };
        reject(s.net_path.is_some() && (s.net_blend > 0.0 || s.net_prior || s.net_tail_prefix > 0.0), "learned leaf/prior network (netPath)");
        reject(s.pooled_net_path.is_some() && s.net_prior, "pooled policy network (pooledNetPath)");
        reject(s.opening_select_max_own_move.unwrap_or(0.0) > 0.0, "openingSelectMaxOwnMove (pooled-net selection)");
        reject(s.book_path.is_some(), "opening book (bookPath)");
        reject(s.tree_reuse, "treeReuse");
        reject(s.root_ensemble_trees.floor() > 1.0, "rootEnsembleTrees > 1");
        reject(s.root_audit != "none" && s.root_audit_rollouts >= 2.0, "rootAudit");
        reject(s.root_piece_feasibility_weight != 0.0, "rootPieceFeasibilityWeight");
        reject(s.iteration_banking.unwrap_or(false), "iterationBanking");
        reject(s.root_grouping != "none", "rootGrouping");
        reject(s.root_policy != "puct", "rootPolicy other than puct");
        reject(s.rave_equivalence > 0.0, "RAVE");
        reject(s.variance_tuned, "varianceTuned");
        reject(s.playout_mast_weight != 0.0, "MAST");
        reject(s.implicit_maxn_weight > 0.0, "implicitMaxnWeight");
        reject(s.playout_policy == "linear" && s.playout_temp > 0.0, "linear rollout policy with temperature");
        reject(self.endgame.max_region_cells > 0.0 && self.endgame.max_own_moves < 0.0, "negative maxOwnMoves");
        let native = self.native.as_ref();
        reject(native.is_some_and(|n| n.prior.is_some() && n.net.is_some()), "native.prior and native.net together (use one)");
        reject(native.and_then(|n| n.net.as_ref()).is_some_and(|n| n.value_visits < 0.0), "negative native.net.valueVisits");
        if let Some(r) = native.and_then(|n| n.rollout.as_ref()) {
            reject(!matches!(r.policy.as_str(), "sampled" | "all"), "native.rollout.policy must be sampled or all");
            reject(!(r.size_weight.is_finite() && r.local_weight.is_finite()), "native.rollout weights must be finite");
            reject(!(r.local_own_extra >= 0.0 && r.local_own_extra.is_finite()), "native.rollout.localOwnExtra must be >= 0");
            // The weight table is indexed by integer counts and exponentiated once per search; keep
            // every weight inside a range where exp() cannot overflow (5 squares × 2 counts).
            reject(r.size_weight.abs() > 20.0 || r.local_weight.abs() > 20.0 || r.local_own_extra > 20.0, "native.rollout weights out of range (|w| <= 20)");
        }
        if let Some(r) = native.and_then(|n| n.reward.as_ref()) {
            reject(!matches!(r.kind.as_str(), "blend" | "rank"), "native.reward.kind must be blend or rank");
            reject(!(r.quality_weight >= 0.0 && r.quality_weight.is_finite()), "native.reward.qualityWeight must be >= 0");
            reject(!(r.quality_slope > 0.0 && r.quality_slope.is_finite()), "native.reward.qualitySlope must be > 0");
            reject(!(r.length_weight >= 0.0 && r.length_weight.is_finite()), "native.reward.lengthWeight must be >= 0");
            // The E6 value channel and the leaf-material blend mix the old reward's scale into Q.
            reject(r.rank() && native.is_some_and(|n| n.net.is_some()), "native.reward rank with native.net");
            reject(r.rank() && s.leaf_material_blend > 0.0, "native.reward rank with leafMaterialBlend");
        }
        if let Some(r) = native.and_then(|n| n.rave.as_ref()) {
            reject(!(r.weight >= 0.0 && r.weight.is_finite()), "native.rave.weight must be >= 0");
            reject(!(r.equivalence > 0.0 && r.equivalence.is_finite()), "native.rave.equivalence must be > 0");
            reject(!(0.0..=1.0).contains(&r.distance_decay), "native.rave.distanceDecay must be in [0, 1]");
            reject(!matches!(r.scope.as_str(), "all" | "root"), "native.rave.scope must be all or root");
            // The E6 network value channel and the learned prior's pseudo-visits mix extra counts into
            // the root's Q and decision; the blend is not defined against them.
            reject(r.on() && native.is_some_and(|n| n.net.is_some() || n.prior.is_some()), "native.rave with native.net or native.prior");
            // Virtual loss and the ensemble are refused anyway; BRS moves the turn in the tree, so a
            // node's mover is not the seat whose later placements the statistics would credit.
            reject(r.on() && s.opponent_policy == "brs", "native.rave with opponentPolicy brs");
        }
        if let Some(l) = native.and_then(|n| n.last_good_reply.as_ref()) {
            // Replies are learned from final scores; under BRS the tree's move order is not the game's.
            reject(l.enabled && s.opponent_policy == "brs", "native.lastGoodReply with opponentPolicy brs");
        }
        if let Some(c) = native.and_then(|n| n.candidates.as_ref()) {
            // Protocol-1/2 records carry at most 64 candidates and E6 recomputes root-child shortlists
            // outside the tree; neither is defined for these roots, so the combination is refused.
            reject(native.is_some_and(|n| n.prior.is_some() || n.net.is_some()), "native.candidates with native.prior or native.net");
            reject(!matches!(c.root_scorer.as_str(), "ordering" | "fitted"), "native.candidates.rootScorer must be ordering or fitted");
            reject(!matches!(c.interior_scorer.as_str(), "ordering" | "fitted"), "native.candidates.interiorScorer must be ordering or fitted");
            reject(!(c.init_visits >= 0.0 && c.init_visits.is_finite()), "native.candidates.initVisits must be >= 0");
            reject(!(c.temperature > 0.0 && c.temperature.is_finite()), "native.candidates.temperature must be > 0");
            let needs_model = c.root_fitted() || c.interior_fitted();
            reject(needs_model && c.model.is_none(), "native.candidates: a fitted scorer needs a model");
            if let Some(Err(e)) = c.model.as_ref().map(|m| m.check()) {
                reject(true, &format!("native.candidates.model: {e}"));
            }
            reject(c.interior_full && !c.interior_fitted(), "native.candidates.interiorFull needs interiorScorer fitted");
            reject(!(c.interior_init_visits >= 0.0 && c.interior_init_visits.is_finite()), "native.candidates.interiorInitVisits must be >= 0");
            // With RAVE, β counts a value-initialised child's virtual visits as observations behind Q,
            // at the root (`initVisits`) and at interior nodes (`interiorInitVisits`) alike (package, 2026-11-14).
        }
        if let Some(sel) = native.and_then(|n| n.selection.as_ref()) {
            reject(!matches!(sel.rule.as_str(), "puct" | "priorLog"), "native.selection.rule must be puct or priorLog");
            reject(!matches!(sel.scope.as_str(), "all" | "root" | "interior"), "native.selection.scope must be all, root or interior");
            reject(!(sel.exploration > 0.0 && sel.exploration.is_finite()), "native.selection.exploration must be > 0");
            reject(!(sel.count_offset > 0.0 && sel.count_offset.is_finite()), "native.selection.countOffset must be > 0");
            reject(!(0.0..=1.0).contains(&sel.cutoff), "native.selection.cutoff must be in [0, 1]");
            // With RAVE the rule reads the RAVE-blended Q, and its denominator stays the count behind the
            // edge's own estimate (real visits + k): AMAF samples move Q, not exploration (package,
            // 2026-11-14). The cut-off stays exact (it compares the blended Q with the same bound). The
            // E6 value channel / learned prior add counts to the root; the rule is not defined there.
            let changes = sel.prior_log() || sel.cutoff > 0.0;
            reject(changes && native.is_some_and(|n| n.net.is_some() || n.prior.is_some()), "native.selection with native.net or native.prior");
        }
        if let Some(o) = native.and_then(|n| n.opening.as_ref()) {
            reject(!(o.centre_max_own_move >= 0.0 && o.centre_max_own_move.is_finite()), "native.opening.centreMaxOwnMove must be >= 0");
            reject(!(o.centre_slack >= 0.0 && o.centre_slack.is_finite()), "native.opening.centreSlack must be >= 0");
            reject(!(0.0..=5.0).contains(&o.rollout_min_size), "native.opening.rolloutMinSize must be in [0, 5]");
            reject(!(o.rollout_until_pieces >= 0.0 && o.rollout_until_pieces.is_finite()), "native.opening.rolloutUntilPieces must be >= 0");
            // The rule lives in the "sampled" rollout; the "all" rollout and a stored last-good reply
            // would bypass it.
            let rollout_rule = o.rollout_on();
            reject(rollout_rule && native.and_then(|n| n.rollout.as_ref()).is_some_and(|r| r.all_moves()), "native.opening rollout rule with native.rollout all");
            reject(rollout_rule && native.and_then(|n| n.last_good_reply.as_ref()).is_some_and(|l| l.enabled), "native.opening rollout rule with native.lastGoodReply");
        }
        out
    }
}
