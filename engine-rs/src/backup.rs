//! Value vectors for the max^n backup (`backup.ts`).

use crate::jsmath;
use crate::position::SEAT_COUNT;

#[inline(always)]
pub fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + jsmath::exp(-x))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Aggregation {
    Mean,
    Max,
}

impl Aggregation {
    pub fn parse(value: &str) -> Aggregation {
        if value == "mean" { Aggregation::Mean } else { Aggregation::Max }
    }
}

pub fn margins_from(scores: &[f64; SEAT_COUNT], aggregation: Aggregation) -> [f64; SEAT_COUNT] {
    std::array::from_fn(|seat| {
        let reference = match aggregation {
            Aggregation::Mean => {
                let mut total = 0.0;
                for other in 0..SEAT_COUNT {
                    if other != seat {
                        total += scores[other];
                    }
                }
                total / (SEAT_COUNT as f64 - 1.0)
            }
            Aggregation::Max => {
                let mut reference = f64::NEG_INFINITY;
                for other in 0..SEAT_COUNT {
                    if other != seat && scores[other] > reference {
                        reference = scores[other];
                    }
                }
                reference
            }
        };
        scores[seat] - reference
    })
}

pub fn rank_from(scores: &[f64; SEAT_COUNT]) -> [f64; SEAT_COUNT] {
    std::array::from_fn(|seat| {
        let mut beaten = 0.0;
        for other in 0..SEAT_COUNT {
            if other == seat {
                continue;
            }
            if scores[seat] > scores[other] {
                beaten += 1.0;
            } else if scores[seat] == scores[other] {
                beaten += 0.5;
            }
        }
        beaten / (SEAT_COUNT as f64 - 1.0)
    })
}

pub fn value_vector(scores: &[f64; SEAT_COUNT], scale: f64, rank_blend: f64, aggregation: Aggregation) -> [f64; SEAT_COUNT] {
    let margins = margins_from(scores, aggregation);
    let ranks = rank_from(scores);
    let beta = f64::max(0.0, f64::min(1.0, rank_blend));
    std::array::from_fn(|seat| {
        let margin = sigmoid(margins[seat] / f64::max(1e-6, scale));
        (1.0 - beta) * margin + beta * ranks[seat]
    })
}

pub fn margin_value(scores: &[f64; SEAT_COUNT], scale: f64, aggregation: Aggregation) -> [f64; SEAT_COUNT] {
    let margins = margins_from(scores, aggregation);
    std::array::from_fn(|seat| sigmoid(margins[seat] / f64::max(1e-6, scale)))
}

pub fn objective_blend(base: f64, lead: f64, enabled: bool) -> f64 {
    if !enabled {
        return base;
    }
    if lead >= 0.0 {
        return base * 0.5;
    }
    let deficit = f64::min(1.0, -lead / 20.0);
    base + (1.0 - base) * deficit
}
