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
                out.push(format!("native.candidates.model: {e}"));
            }
        }
        out
    }
}
