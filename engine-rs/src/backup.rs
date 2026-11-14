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

/// Round 3 D2: as `rank_from`, with the next seat in turn order weighing `next` and the others 1.
pub fn weighted_rank_from(scores: &[f64; SEAT_COUNT], next: f64) -> [f64; SEAT_COUNT] {
    std::array::from_fn(|seat| {
        let (mut beaten, mut total) = (0.0, 0.0);
        for other in 0..SEAT_COUNT {
            if other == seat {
                continue;
            }
            let w = if other == (seat + 1) % SEAT_COUNT { next } else { 1.0 };
            total += w;
            if scores[seat] > scores[other] {
                beaten += w;
            } else if scores[seat] == scores[other] {
                beaten += 0.5 * w;
            }
        }
        beaten / total
    })
}

/// 1/t for each of the t seats sharing the highest score, 0 for the others (sums to 1).
pub fn first_from(scores: &[f64; SEAT_COUNT]) -> [f64; SEAT_COUNT] {
    let top = scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let tied = scores.iter().filter(|&&s| s == top).count() as f64;
    std::array::from_fn(|seat| if scores[seat] == top { 1.0 / tied } else { 0.0 })
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

/// Running mean and (population) variance, Welford's update.
#[derive(Clone, Copy, Debug, Default)]
struct Running {
    n: f64,
    mean: f64,
    m2: f64,
}

impl Running {
    fn add(&mut self, x: f64) {
        self.n += 1.0;
        let delta = x - self.mean;
        self.mean += delta / self.n;
        self.m2 += delta * (x - self.mean);
    }

    /// `x` standardised by the samples so far (`x` included), or None while the spread is zero.
    fn z(&self, x: f64) -> Option<f64> {
        let var = if self.n > 0.0 { self.m2 / self.n } else { 0.0 };
        if var > 0.0 { Some((x - self.mean) / var.sqrt()) } else { None }
    }
}

/// v5.0 port P3 (`native.reward` kind "rank"): the fraction of opponents beaten (ties count half),
/// plus a bounded bonus for a margin that is good *for this search* and a game-length term.
///
/// For seat i with final scores s: `v_i = rank_i + qw · tanh(k · z_i) − lw · (rank_i − ½) · tanh(k · z_len)`,
/// where `z_i` is `s_i − mean(s_j, j ≠ i)` standardised by the running mean and deviation of that
/// quantity over this search's simulations, and `z_len` the game length (placements) standardised
/// the same way. Statistics are cleared at the start of every search; each call adds its sample
/// before standardising. Weights and slope are config values (`RewardOptions`).
///
/// v5.1 R1 (`firstWeight` f > 0): the leading `rank_i` is replaced by `(1 − f)·rank_i + f·first_i`,
/// `first_i` = 1/t when seat i is one of the t seats sharing the highest score, else 0. That part
/// still runs from 0 (last alone) to 1 (first alone), so the bonus and length terms keep their
/// scale; the length term still multiplies `rank_i − ½`. At f = 0 nothing is computed.
#[derive(Clone, Debug)]
pub struct RankReward {
    next_weight: f64,
    first_weight: f64,
    quality_weight: f64,
    slope: f64,
    length_weight: f64,
    margin: [Running; SEAT_COUNT],
    length: Running,
}

impl RankReward {
    pub fn new(quality_weight: f64, slope: f64, length_weight: f64) -> RankReward {
        RankReward { next_weight: 0.0, first_weight: 0.0, quality_weight, slope, length_weight, margin: [Running::default(); SEAT_COUNT], length: Running::default() }
    }

    pub fn with_next_weight(mut self, next_weight: f64) -> RankReward {
        self.next_weight = next_weight;
        self
    }

    pub fn with_first_weight(mut self, first_weight: f64) -> RankReward {
        self.first_weight = first_weight;
        self
    }

    pub fn clear(&mut self) {
        self.margin = [Running::default(); SEAT_COUNT];
        self.length = Running::default();
    }

    /// `length`: the game's length in placements, or None where it is not known (sealed regions
    /// solved by the packer), which leaves the length term out and the length statistics alone.
    pub fn value(&mut self, scores: &[f64; SEAT_COUNT], length: Option<f64>) -> [f64; SEAT_COUNT] {
        let ranks = if self.next_weight > 0.0 { weighted_rank_from(scores, self.next_weight) } else { rank_from(scores) };
        let length_term = match length {
            Some(l) if self.length_weight > 0.0 => {
                self.length.add(l);
                self.length.z(l).map_or(0.0, |z| (self.slope * z).tanh())
            }
            _ => 0.0,
        };
        let total: f64 = scores.iter().sum();
        let first = if self.first_weight > 0.0 { first_from(scores) } else { [0.0; SEAT_COUNT] };
        std::array::from_fn(|seat| {
            let margin = scores[seat] - (total - scores[seat]) / (SEAT_COUNT as f64 - 1.0);
            let mut quality = 0.0;
            if self.quality_weight > 0.0 {
                let stats = &mut self.margin[seat];
                stats.add(margin);
                quality = stats.z(margin).map_or(0.0, |z| (self.slope * z).tanh());
            }
            let place = if self.first_weight > 0.0 {
                (1.0 - self.first_weight) * ranks[seat] + self.first_weight * first[seat]
            } else {
                ranks[seat]
            };
            place + self.quality_weight * quality - self.length_weight * (ranks[seat] - 0.5) * length_term
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_reward_without_bonus_is_rank() {
        let mut r = RankReward::new(0.0, 1.0, 0.0);
        let v = r.value(&[3.0, -2.0, 3.0, -10.0], Some(70.0));
        assert_eq!(v, [5.0 / 6.0, 1.0 / 3.0, 5.0 / 6.0, 0.0]);
    }

    #[test]
    fn weighted_rank() {
        let s = [3.0, -2.0, 3.0, -10.0];
        assert_eq!(weighted_rank_from(&s, 1.0), rank_from(&s));
        // Seat 1 beats only seat 3 (its previous seat), next (seat 2) weighs 3: 1 / (3 + 1 + 1).
        assert!((weighted_rank_from(&s, 3.0)[1] - 0.2).abs() < 1e-12);
    }

    #[test]
    fn rank_reward_first_weight() {
        // Zero first weight: exactly the rank.
        let mut r = RankReward::new(0.0, 1.0, 0.0).with_first_weight(0.0);
        assert_eq!(r.value(&[3.0, -2.0, 3.0, -10.0], None), [5.0 / 6.0, 1.0 / 3.0, 5.0 / 6.0, 0.0]);
        // f = 0.5: the two tied leaders share the first-place unit.
        let mut r = RankReward::new(0.0, 1.0, 0.0).with_first_weight(0.5);
        let v = r.value(&[3.0, -2.0, 3.0, -10.0], None);
        let want = [0.5 * 5.0 / 6.0 + 0.25, 0.5 / 3.0, 0.5 * 5.0 / 6.0 + 0.25, 0.0];
        for s in 0..SEAT_COUNT {
            assert!((v[s] - want[s]).abs() < 1e-12, "{v:?}");
        }
        // A sole winner gets 1, last gets 0, whatever f is.
        let v = r.value(&[9.0, 1.0, 2.0, 0.0], None);
        assert_eq!((v[0], v[3]), (1.0, 0.0));
        assert_eq!(first_from(&[1.0, 1.0, 1.0, 1.0]), [0.25; SEAT_COUNT]);
    }

    #[test]
    fn rank_reward_bonus_is_bounded_and_ordered() {
        let mut r = RankReward::new(0.2, 1.0, 0.1);
        let mut last = [0.0; SEAT_COUNT];
        for i in 0..50 {
            let s = [i as f64 % 7.0, -3.0, 0.5, -(i as f64 % 5.0)];
            last = r.value(&s, Some(60.0 + (i % 9) as f64));
            for seat in 0..SEAT_COUNT {
                assert!(last[seat] > -0.3 && last[seat] < 1.3, "{last:?}");
            }
        }
        // Same rank, better margin than this search's average -> positive bonus.
        assert!(last[0] > rank_from(&[49.0 % 7.0, -3.0, 0.5, -(49.0 % 5.0)])[0] - 0.2);
    }
}
