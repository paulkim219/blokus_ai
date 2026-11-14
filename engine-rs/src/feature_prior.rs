//! v5.0 port P4/P5: a move prior over *every* legal move from cheap move features and fitted
//! weights (a multinomial logit, `score = w · f`, prior = softmax over the legal moves).
//!
//! The weights are ours: `ml/p4_fit_prior.py` fits them on recorded Pentobi level-6 decisions
//! (features dumped by `examples/p4_features.rs` through [`PriorContext::features`], so training
//! and play compute the same numbers). Configs carry the model inline under
//! `native.candidates.model` (see `search.rs` and `engine-rs/README.md`), so a pinned binary plus a
//! config file is a complete description of an arm.
//!
//! Everything here is O(1) bitboard work per move after one [`PriorContext`] per position, so the
//! scorer can be run over all legal moves of a root (a few hundred to ~1,500).

use crate::bitboard::*;
use crate::placements::*;
use crate::position::{HOME_CORNER, Position, SEAT_COUNT};
use serde::{Deserialize, Serialize};

/// Feature vector layout. The names are written next to the weights in the model JSON and checked
/// on load, so a model fitted against another layout is refused instead of misread.
pub const FEATURE_NAMES: [&str; FEATURE_COUNT] = [
    "piece0", "piece1", "piece2", "piece3", "piece4", "piece5", "piece6", "piece7", "piece8", "piece9", "piece10",
    "piece11", "piece12", "piece13", "piece14", "piece15", "piece16", "piece17", "piece18", "piece19", "piece20",
    // Mean Manhattan distance of the piece's cells from the board centre (placement table), and its square / 10.
    "centre", "centre_sq",
    // Largest Manhattan distance from the mover's home corner over the piece's cells; how far that is
    // beyond the mover's furthest placed cell (0 if not further).
    "home_far", "advance",
    // Cells covering an open corner of any opponent / of the next seat / of the previous seat.
    "opp_cover", "opp_cover_next", "opp_cover_prev",
    // Cells orthogonally adjacent to an opponent's open corner (and not themselves one).
    "opp_adj",
    // Own open corners occupied or made edge-adjacent by the move.
    "own_lost",
    // New own open corners, split by free orthogonal neighbours (empty and not edge-adjacent to own
    // colour after the move): 0, 1, 2 (two of a new corner's four neighbours touch the piece, so 2 is
    // the most); and new own corners that are also an opponent's open corner.
    "new_f0", "new_f1", "new_f2", "new_contested",
    // Opponent cells orthogonally / diagonally adjacent to the piece.
    "opp_contact", "opp_diag",
    // Piece cells on the board edge.
    "border",
    // Local response: cells on an attach point of one of the last three opponent placements, and on
    // an orthogonal neighbour of one (not usable by that opponent). Zero when no history is given.
    "local_attach", "local_near",
];
pub const FEATURE_COUNT: usize = 39;

/// Own-move bands the model may carry separate weights for (a seat's i-th placement, 0-based).
pub fn band_of(own_moves: u32, bands: &[PriorBand]) -> usize {
    bands.iter().position(|b| own_moves >= b.min_own_move && own_moves < b.max_own_move).unwrap_or(bands.len() - 1)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorBand {
    pub min_own_move: u32,
    pub max_own_move: u32,
    pub weights: Vec<f64>,
}

/// The fitted model as exported by `ml/p4_fit_prior.py` (extra keys such as notes are ignored).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorModel {
    pub features: Vec<String>,
    pub bands: Vec<PriorBand>,
    /// S4: per band, per placement, the score's partial sum over the position-independent features
    /// 0–22 (piece, centre, centre²), built on first use. Not part of the model's JSON.
    #[serde(skip)]
    statics: std::sync::OnceLock<Vec<Vec<f64>>>,
}

/// S4: per placement, the word range `lo..hi` outside which its cells, edge halo and corner halo
/// are all zero, and per (seat, placement) the largest home-corner distance of its cells (`home_far`).
struct ScoreTables {
    lo: Vec<u8>,
    hi: Vec<u8>,
    far: [Vec<u8>; SEAT_COUNT],
}

static SCORE_TABLES: std::sync::OnceLock<ScoreTables> = std::sync::OnceLock::new();

fn score_tables() -> &'static ScoreTables {
    SCORE_TABLES.get_or_init(|| {
        let t = placements();
        let mut lo = vec![0u8; t.count];
        let mut hi = vec![0u8; t.count];
        for m in 0..t.count {
            let (mut l, mut h) = (WORDS, 0);
            for w in 0..WORDS {
                if t.cells[m][w] != 0 || t.edge_halo[m][w] != 0 || t.corner_halo[m][w] != 0 {
                    l = l.min(w);
                    h = w + 1;
                }
            }
            lo[m] = l as u8;
            hi[m] = h as u8;
        }
        let far = std::array::from_fn(|seat| {
            let home_cell = HOME_CORNER[seat];
            let home = ((home_cell % BOARD_SIZE) as i32, (home_cell / BOARD_SIZE) as i32);
            (0..t.count)
                .map(|m| {
                    let mut far = 0;
                    for i in t.cell_start[m]..t.cell_start[m + 1] {
                        far = far.max(home_distance(home, t.cell_list[i as usize] as usize));
                    }
                    far as u8
                })
                .collect()
        });
        ScoreTables { lo, hi, far }
    })
}

impl PriorModel {
    pub fn check(&self) -> Result<(), String> {
        if self.features.len() != FEATURE_COUNT || self.features.iter().zip(FEATURE_NAMES).any(|(a, b)| a != b) {
            return Err(format!("prior model features {:?} do not match this engine's layout", self.features));
        }
        if self.bands.is_empty() {
            return Err("prior model has no bands".into());
        }
        for band in &self.bands {
            if band.weights.len() != FEATURE_COUNT || band.weights.iter().any(|w| !w.is_finite()) {
                return Err(format!("prior model band {}..{} has bad weights", band.min_own_move, band.max_own_move));
            }
        }
        Ok(())
    }

    /// Scores (logits) of `moves` for the seat to move at `ctx`.
    ///
    /// S4: the same numbers as [`PriorModel::score_reference`], bit for bit: the sum runs over the
    /// features in the same order, skipping the zero ones, so the static prefix (features 0–22) is
    /// the same partial sum and every later term is added exactly as before (`tests/s4.rs`).
    pub fn score(&self, ctx: &PriorContext, moves: &[i32], out: &mut [f64]) {
        let band_index = band_of(ctx.own_moves, &self.bands);
        let weights = &self.bands[band_index].weights;
        let statics = &self.statics.get_or_init(|| self.build_statics())[band_index];
        let tables = score_tables();
        for (i, &mv) in moves.iter().enumerate() {
            out[i] = ctx.score_from(mv, statics[mv as usize], weights, tables);
        }
    }

    /// The scorer as it was before S4: the full feature vector, then the dot product.
    pub fn score_reference(&self, ctx: &PriorContext, moves: &[i32], out: &mut [f64]) {
        let band = &self.bands[band_of(ctx.own_moves, &self.bands)];
        let mut f = [0f32; FEATURE_COUNT];
        for (i, &mv) in moves.iter().enumerate() {
            ctx.features(mv, &mut f);
            let mut s = 0.0;
            for k in 0..FEATURE_COUNT {
                if f[k] != 0.0 {
                    s += band.weights[k] * f[k] as f64;
                }
            }
            out[i] = s;
        }
    }

    fn build_statics(&self) -> Vec<Vec<f64>> {
        let t = placements();
        self.bands
            .iter()
            .map(|band| {
                (0..t.count)
                    .map(|m| {
                        let f = static_features(m);
                        let mut s = 0.0;
                        for k in 0..STATIC_COUNT {
                            if f[k] != 0.0 {
                                s += band.weights[k] * f[k] as f64;
                            }
                        }
                        s
                    })
                    .collect()
            })
            .collect()
    }
}

/// Features 0–22 depend only on the placement.
const STATIC_COUNT: usize = 23;

/// Features 0–22 of placement `m`, computed exactly as [`PriorContext::features`] computes them.
fn static_features(m: usize) -> [f32; STATIC_COUNT] {
    let t = placements();
    let mut f = [0f32; STATIC_COUNT];
    f[t.piece_id[m] as usize] = 1.0;
    let centre = t.centre_distance[m];
    f[21] = centre;
    f[22] = centre * centre / 10.0;
    f
}

/// Per-position masks, computed once and shared by every move scored there.
pub struct PriorContext {
    pub seat: usize,
    pub own_moves: u32,
    occ: Mask,
    own_edge: Mask,
    own_corners: Mask,
    opp_corners: Mask,
    next_corners: Mask,
    prev_corners: Mask,
    opp_corner_adj: Mask,
    opp_occ: Mask,
    local_attach: Mask,
    local_near: Mask,
    home: (i32, i32),
    reach: i32,
}

fn border_mask() -> Mask {
    let mut m = EMPTY;
    for i in 0..BOARD_SIZE {
        set_bit(&mut m, cell_index(i, 0));
        set_bit(&mut m, cell_index(i, BOARD_SIZE - 1));
        set_bit(&mut m, cell_index(0, i));
        set_bit(&mut m, cell_index(BOARD_SIZE - 1, i));
    }
    m
}

static BORDER: std::sync::OnceLock<Mask> = std::sync::OnceLock::new();

#[inline(always)]
fn home_distance(home: (i32, i32), cell: usize) -> i32 {
    let (x, y) = ((cell % BOARD_SIZE) as i32, (cell / BOARD_SIZE) as i32);
    (x - home.0).abs() + (y - home.1).abs()
}

impl PriorContext {
    /// `recent`: the game's placements so far as (seat, placement), oldest first (passes left out);
    /// only the last three are read. Empty is allowed and zeroes the local-response features.
    pub fn new(position: &Position, seat: usize, recent: &[(usize, i32)]) -> PriorContext {
        let t = placements();
        let occ = position.occ;
        let own_corners = position.open_corners(seat);
        let mut opp_corners = EMPTY;
        let mut opp_occ = EMPTY;
        for other in 0..SEAT_COUNT {
            if other != seat {
                or_into(&mut opp_corners, &position.open_corners(other));
                or_into(&mut opp_occ, &position.own[other]);
            }
        }
        let next_corners = position.open_corners((seat + 1) % SEAT_COUNT);
        let prev_corners = position.open_corners((seat + SEAT_COUNT - 1) % SEAT_COUNT);
        let mut opp_corner_adj = dilate_orthogonal(&opp_corners);
        and_not_into(&mut opp_corner_adj, &opp_corners);
        and_not_into(&mut opp_corner_adj, &occ);

        let mut local_attach = EMPTY;
        let mut local_near = EMPTY;
        let start = recent.len().saturating_sub(3);
        for &(c, mv) in &recent[start..] {
            if c == seat || mv < 0 {
                continue;
            }
            let m = mv as usize;
            let mut forbidden = occ;
            or_into(&mut forbidden, &position.edge_halo[c]);
            let mut attach = t.corner_halo[m];
            and_not_into(&mut attach, &t.edge_halo[m]);
            and_not_into(&mut attach, &forbidden);
            or_into(&mut local_attach, &attach);
            let mut near = dilate_orthogonal(&attach);
            and_not_into(&mut near, &forbidden);
            or_into(&mut local_near, &near);
        }
        and_not_into(&mut local_near, &local_attach);

        let home_cell = HOME_CORNER[seat];
        let home = ((home_cell % BOARD_SIZE) as i32, (home_cell / BOARD_SIZE) as i32);
        let mut reach = 0;
        for w in 0..WORDS {
            let mut bits = position.own[seat][w];
            while bits != 0 {
                let cell = w * 32 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                reach = reach.max(home_distance(home, cell));
            }
        }
        PriorContext {
            seat,
            own_moves: PIECE_COUNT as u32 - position.hand[seat].count_ones(),
            occ,
            own_edge: position.edge_halo[seat],
            own_corners,
            opp_corners,
            next_corners,
            prev_corners,
            opp_corner_adj,
            opp_occ,
            local_attach,
            local_near,
            home,
            reach,
        }
    }

    /// S4: the score of `mv` given `prefix`, its partial sum over features 0–22: features 23–38
    /// added in order, zero ones skipped, exactly as the reference dot product does. The board
    /// words are visited only where the placement's cells or haloes are (every count is zero
    /// elsewhere); integer counts convert to f64 exactly whether or not they pass through f32.
    #[inline(always)]
    fn score_from(&self, mv: i32, prefix: f64, w: &[f64], tables: &ScoreTables) -> f64 {
        let t = placements();
        let m = mv as usize;
        let (cells, edge, corner) = (&t.cells[m], &t.edge_halo[m], &t.corner_halo[m]);
        let mut s = prefix;
        let far = tables.far[self.seat][m] as i32;
        if far != 0 {
            s += w[23] * far as f64;
        }
        let advance = (far - self.reach).max(0);
        if advance != 0 {
            s += w[24] * advance as f64;
        }
        let border = BORDER.get_or_init(border_mask);
        let (lo, hi) = (tables.lo[m] as usize, tables.hi[m] as usize);
        let mut new_corners = EMPTY;
        let (mut opp_cover, mut next_cover, mut prev_cover, mut opp_adj, mut lost) = (0u32, 0u32, 0u32, 0u32, 0u32);
        let (mut contact, mut diag, mut on_border, mut l_attach, mut l_near, mut contested) = (0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
        for w in lo..hi {
            let occ_after = self.occ[w] | cells[w];
            let edge_after = self.own_edge[w] | edge[w];
            new_corners[w] = corner[w] & !occ_after & !edge_after & !self.own_corners[w];
            opp_cover += (cells[w] & self.opp_corners[w]).count_ones();
            next_cover += (cells[w] & self.next_corners[w]).count_ones();
            prev_cover += (cells[w] & self.prev_corners[w]).count_ones();
            opp_adj += (cells[w] & self.opp_corner_adj[w]).count_ones();
            lost += (self.own_corners[w] & (cells[w] | edge[w])).count_ones();
            contact += (edge[w] & self.opp_occ[w]).count_ones();
            diag += (corner[w] & !edge[w] & self.opp_occ[w]).count_ones();
            on_border += (cells[w] & border[w]).count_ones();
            l_attach += (cells[w] & self.local_attach[w]).count_ones();
            l_near += (cells[w] & self.local_near[w]).count_ones();
            contested += (new_corners[w] & self.opp_corners[w]).count_ones();
        }
        let (mut f0, mut f1, mut f2) = (0u32, 0u32, 0u32);
        let blocked = |c: usize| test_bit(&self.occ, c) || test_bit(cells, c) || test_bit(&self.own_edge, c) || test_bit(edge, c);
        for w in lo..hi {
            let mut bits = new_corners[w];
            while bits != 0 {
                let cell = w * 32 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                let (x, y) = (cell % BOARD_SIZE, cell / BOARD_SIZE);
                let mut n = 0;
                if x > 0 && !blocked(cell - 1) {
                    n += 1;
                }
                if x + 1 < BOARD_SIZE && !blocked(cell + 1) {
                    n += 1;
                }
                if y > 0 && !blocked(cell - BOARD_SIZE) {
                    n += 1;
                }
                if y + 1 < BOARD_SIZE && !blocked(cell + BOARD_SIZE) {
                    n += 1;
                }
                match n {
                    0 => f0 += 1,
                    1 => f1 += 1,
                    _ => f2 += 1,
                }
            }
        }
        for (k, v) in [
            (25, opp_cover),
            (26, next_cover),
            (27, prev_cover),
            (28, opp_adj),
            (29, lost),
            (30, f0),
            (31, f1),
            (32, f2),
            (33, contested),
            (34, contact),
            (35, diag),
            (36, on_border),
            (37, l_attach),
            (38, l_near),
        ] {
            if v != 0 {
                s += w[k] * v as f64;
            }
        }
        s
    }

    /// Writes the feature vector of placing `mv` (legal for `self.seat`) into `f`.
    pub fn features(&self, mv: i32, f: &mut [f32; FEATURE_COUNT]) {
        let t = placements();
        let m = mv as usize;
        let (cells, edge, corner) = (&t.cells[m], &t.edge_halo[m], &t.corner_halo[m]);
        *f = [0.0; FEATURE_COUNT];
        f[t.piece_id[m] as usize] = 1.0;
        let centre = t.centre_distance[m];
        f[21] = centre;
        f[22] = centre * centre / 10.0;
        let mut far = 0;
        for i in t.cell_start[m]..t.cell_start[m + 1] {
            far = far.max(home_distance(self.home, t.cell_list[i as usize] as usize));
        }
        f[23] = far as f32;
        f[24] = (far - self.reach).max(0) as f32;
        let border = BORDER.get_or_init(border_mask);

        let mut occ_after = EMPTY;
        let mut edge_after = EMPTY;
        let mut new_corners = EMPTY;
        let (mut opp_cover, mut next_cover, mut prev_cover, mut opp_adj, mut lost) = (0, 0, 0, 0, 0);
        let (mut contact, mut diag, mut on_border, mut l_attach, mut l_near, mut contested) = (0, 0, 0, 0, 0, 0);
        for w in 0..WORDS {
            occ_after[w] = self.occ[w] | cells[w];
            edge_after[w] = self.own_edge[w] | edge[w];
            new_corners[w] = corner[w] & !occ_after[w] & !edge_after[w] & !self.own_corners[w];
            opp_cover += (cells[w] & self.opp_corners[w]).count_ones();
            next_cover += (cells[w] & self.next_corners[w]).count_ones();
            prev_cover += (cells[w] & self.prev_corners[w]).count_ones();
            opp_adj += (cells[w] & self.opp_corner_adj[w]).count_ones();
            lost += (self.own_corners[w] & (cells[w] | edge[w])).count_ones();
            contact += (edge[w] & self.opp_occ[w]).count_ones();
            diag += (corner[w] & !edge[w] & self.opp_occ[w]).count_ones();
            on_border += (cells[w] & border[w]).count_ones();
            l_attach += (cells[w] & self.local_attach[w]).count_ones();
            l_near += (cells[w] & self.local_near[w]).count_ones();
            contested += (new_corners[w] & self.opp_corners[w]).count_ones();
        }
        let (mut f0, mut f1, mut f2) = (0, 0, 0);
        for w in 0..WORDS {
            let mut bits = new_corners[w];
            while bits != 0 {
                let cell = w * 32 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                let (x, y) = (cell % BOARD_SIZE, cell / BOARD_SIZE);
                let free = |c: usize| !test_bit(&occ_after, c) && !test_bit(&edge_after, c);
                let mut n = 0;
                if x > 0 && free(cell - 1) {
                    n += 1;
                }
                if x + 1 < BOARD_SIZE && free(cell + 1) {
                    n += 1;
                }
                if y > 0 && free(cell - BOARD_SIZE) {
                    n += 1;
                }
                if y + 1 < BOARD_SIZE && free(cell + BOARD_SIZE) {
                    n += 1;
                }
                match n {
                    0 => f0 += 1,
                    1 => f1 += 1,
                    _ => f2 += 1,
                }
            }
        }
        f[25] = opp_cover as f32;
        f[26] = next_cover as f32;
        f[27] = prev_cover as f32;
        f[28] = opp_adj as f32;
        f[29] = lost as f32;
        f[30] = f0 as f32;
        f[31] = f1 as f32;
        f[32] = f2 as f32;
        f[33] = contested as f32;
        f[34] = contact as f32;
        f[35] = diag as f32;
        f[36] = on_border as f32;
        f[37] = l_attach as f32;
        f[38] = l_near as f32;
    }
}
