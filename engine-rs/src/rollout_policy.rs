//! v4.1's compiled rollout-policy table (`rolloutPolicy.ts`).
//!
//! The TS loader writes features into a Float32Array and stores the compiled scores in
//! Float32Arrays, so every intermediate here is rounded to f32 at the same points.

use crate::config::Phase;
use crate::placements::*;
use crate::position::SEAT_COUNT;
use serde::Deserialize;

pub const FEATURE_COUNT: usize = 52;
const STATIC_COUNT: usize = 46;
const GRID: usize = 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRolloutPolicy {
    pub kind: String,
    pub feature_count: usize,
    pub weights: Vec<Vec<f64>>,
    pub blend: f64,
}

pub struct RolloutPolicy {
    pub static_scores: Vec<f32>,
    pub hand_slopes: Vec<f32>,
    pub piece_slopes: Vec<f32>,
    pub blend: f64,
}

/// Rotates a cell into the frame where `seat`'s home corner is the top-left.
#[inline]
pub fn canonical_cell(cell: usize, seat: usize) -> usize {
    let (x, y) = (cell % 20, cell / 20);
    match seat {
        1 => (19 - y) + 20 * x,
        2 => (19 - x) + 20 * (19 - y),
        3 => y + 20 * (19 - x),
        _ => cell,
    }
}

fn write_features(out: &mut [f32; FEATURE_COUNT], mv: usize, seat: usize) {
    let t = placements();
    *out = [0.0; FEATURE_COUNT];
    let size = t.size[mv] as f64;
    let centre = t.centre_distance[mv] as f64 / 19.0;
    let corner = t.corner_halo_count[mv] as f64 / 20.0;
    let edge = t.edge_halo_count[mv] as f64 / 20.0;
    out[0] = (size / 5.0) as f32;
    out[1] = centre as f32;
    out[2] = corner as f32;
    out[3] = edge as f32;
    out[4 + t.piece_id[mv] as usize] = 1.0;
    let (start, end) = (t.cell_start[mv] as usize, t.cell_start[mv + 1] as usize);
    let cells = usize::max(1, end - start) as f64;
    let (mut x_total, mut y_total) = (0.0f64, 0.0f64);
    for at in start..end {
        let canonical = canonical_cell(t.cell_list[at] as usize, seat);
        let (x, y) = (canonical % 20, canonical / 20);
        x_total += x as f64;
        y_total += y as f64;
        let bucket = x / 5 + GRID * (y / 5);
        out[25 + bucket] = (out[25 + bucket] as f64 + 1.0 / cells) as f32;
    }
    let x = x_total / cells / 19.0;
    let y = y_total / cells / 19.0;
    out[41] = x as f32;
    out[42] = y as f32;
    out[43] = (x * y) as f32;
    out[44] = (x * x) as f32;
    out[45] = (y * y) as f32;
}

impl RolloutPolicy {
    pub fn load(raw: &RawRolloutPolicy) -> Result<RolloutPolicy, String> {
        if raw.kind != "canonical-rollout-policy-v41"
            || raw.feature_count != FEATURE_COUNT
            || raw.weights.len() != 3
            || raw.weights.iter().any(|w| w.len() != FEATURE_COUNT)
            || !(0.0..=1.0).contains(&raw.blend)
        {
            return Err("invalid v4.1 rollout policy contract".into());
        }
        let count = placements().count;
        let total = 3 * SEAT_COUNT * count;
        let mut policy = RolloutPolicy {
            static_scores: vec![0.0; total],
            hand_slopes: vec![0.0; total],
            piece_slopes: vec![0.0; total],
            blend: raw.blend,
        };
        let mut scratch = [0.0f32; FEATURE_COUNT];
        for (phase, weights) in raw.weights.iter().enumerate() {
            for seat in 0..SEAT_COUNT {
                for mv in 0..count {
                    write_features(&mut scratch, mv, seat);
                    let mut score = 0.0f64;
                    for f in 0..STATIC_COUNT {
                        score += scratch[f] as f64 * weights[f];
                    }
                    let s = |i: usize| scratch[i] as f64;
                    let index = (phase * SEAT_COUNT + seat) * count + mv;
                    policy.static_scores[index] = score as f32;
                    policy.hand_slopes[index] = (s(0) * weights[46] + s(1) * weights[47] + s(2) * weights[48]) as f32;
                    policy.piece_slopes[index] = (s(0) * weights[49] + s(2) * weights[50] + s(3) * weights[51]) as f32;
                }
            }
        }
        Ok(policy)
    }

    pub fn from_file(path: &str) -> Result<RolloutPolicy, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
        let raw: RawRolloutPolicy = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
        RolloutPolicy::load(&raw)
    }

    #[inline(always)]
    pub fn score(&self, phase: Phase, seat: usize, mv: i32, hand_squares: i32, hand: u32) -> f64 {
        let index = (phase.index() * SEAT_COUNT + seat) * placements().count + mv as usize;
        self.static_scores[index] as f64
            + self.hand_slopes[index] as f64 * (hand_squares as f64 / TOTAL_SQUARES as f64)
            + self.piece_slopes[index] as f64 * (hand.count_ones() as f64 / 21.0)
    }
}
