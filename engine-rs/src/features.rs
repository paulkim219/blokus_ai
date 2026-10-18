//! The composite evaluation E_i (`features.ts`). Expression order is kept term-for-term so the
//! floating-point sums round exactly as they do in JS.

use crate::bitboard::*;
use crate::config::{BitboardParams, LambdaProfile, Phase};
use crate::jsmath;
use crate::placements::*;
use crate::position::{Position, SEAT_COUNT};
use crate::regions::*;
use crate::territory::*;

const BOARD_CENTRE: f64 = 9.5;

#[derive(Clone)]
pub struct EvalContext {
    pub territory: TerritoryMap,
    pub regions: RegionMap,
    pub ownership: RegionOwnership,
    pub articulation: [u8; CELL_COUNT],
    pub has_articulation: bool,
    pub corner_score: [f64; SEAT_COUNT],
    pub centre_score: [f64; SEAT_COUNT],
    pub waste: [f64; SEAT_COUNT],
    pub pressure: [f64; SEAT_COUNT],
    pub values: [f64; SEAT_COUNT],
    pub leader: i32,
    pub fractional_ties: bool,
}

impl EvalContext {
    pub fn new(fractional_ties: bool) -> Self {
        EvalContext {
            territory: TerritoryMap::new(),
            regions: RegionMap::new(),
            ownership: RegionOwnership::new(),
            articulation: [0; CELL_COUNT],
            has_articulation: false,
            corner_score: [0.0; SEAT_COUNT],
            centre_score: [0.0; SEAT_COUNT],
            waste: [0.0; SEAT_COUNT],
            pressure: [0.0; SEAT_COUNT],
            values: [0.0; SEAT_COUNT],
            leader: -1,
            fractional_ties,
        }
    }
}

pub fn refresh_context(context: &mut EvalContext, position: &Position, with_articulation: bool) {
    compute_territory(position, &mut context.territory, context.fractional_ties);
    label_regions(&position.occ, &mut context.regions);
    region_ownership(&context.regions, &context.territory.open_corners, &mut context.ownership);
    context.has_articulation = with_articulation;
    if with_articulation {
        articulation_points(&position.occ, &mut context.articulation);
    }
    let mut leader = -1;
    let mut best = i32::MIN;
    let mut tie = false;
    for seat in 0..SEAT_COUNT {
        let placed = position.placed_squares(seat);
        if placed > best {
            best = placed;
            leader = seat as i32;
            tie = false;
        } else if placed == best {
            tie = true;
        }
    }
    context.leader = if tie { -1 } else { leader };
}

fn corner_score_for(context: &EvalContext, seat: usize, exponent: f64) -> f64 {
    let ownership = &context.ownership;
    let linear = exponent == 1.0;
    let mut total = 0.0;
    for region in 0..ownership.count {
        let corners = ownership.corners[region * SEAT_COUNT + seat];
        if corners > 0 {
            total += if linear { corners as f64 } else { jsmath::pow(corners as f64, exponent) };
        }
    }
    total
}

fn centre_score_for(context: &EvalContext, seat: usize) -> f64 {
    let corners = &context.territory.open_corners[seat];
    let mut total = 0.0;
    for cell in 0..CELL_COUNT {
        if !test_bit(corners, cell) {
            continue;
        }
        let x = (cell % 20) as f64;
        let y = (cell / 20) as f64;
        let distance = (x - BOARD_CENTRE).abs() + (y - BOARD_CENTRE).abs();
        total += f64::max(0.0, 1.0 - distance / 19.0);
    }
    total
}

fn waste_for(context: &EvalContext, position: &Position, seat: usize) -> f64 {
    let smallest = smallest_remaining(position.hand[seat]);
    if smallest == 0 {
        return 0.0;
    }
    let t = placements();
    let owner = &context.territory.owner;
    let own = &position.own[seat];
    let edge = &position.edge_halo[seat];
    let hand = position.hand[seat];
    let mut waste = 0.0;
    for cell in 0..CELL_COUNT {
        if owner[cell] as i32 != seat as i32 {
            continue;
        }
        if smallest == 1 {
            if test_bit(edge, cell) {
                waste += 1.0;
            }
            continue;
        }
        let mut fits = false;
        for i in t.cover_start[cell]..t.cover_start[cell + 1] {
            let id = t.cover_list[i as usize] as usize;
            if t.size[id] as i32 != smallest || hand & (1 << t.piece_id[id]) == 0 {
                continue;
            }
            if intersects(&position.occ, &t.cells[id]) || intersects(own, &t.edge_halo[id]) {
                continue;
            }
            fits = true;
            break;
        }
        if !fits {
            waste += 1.0;
        }
    }
    waste
}

fn unique_corners_for(context: &EvalContext, seat: usize) -> f64 {
    let corners = &context.territory.open_corners;
    let mut count = 0;
    for w in 0..WORDS {
        let mut word = corners[seat][w];
        for other in 0..SEAT_COUNT {
            if other != seat {
                word &= !corners[other][w];
            }
        }
        count += word.count_ones();
    }
    count as f64
}

fn mobility_for(context: &EvalContext, position: &Position, seat: usize) -> f64 {
    let corners = popcount(&context.territory.open_corners[seat]);
    (corners + 2 * position.hand[seat].count_ones()) as f64
}

/// λ_j as seen by `from`: relation, seat aggression, the global dial, and standing.
#[inline]
pub fn lambda_for(params: &BitboardParams, profile: &LambdaProfile, from: usize, to: usize, leader: i32) -> f64 {
    let mut lambda = match (to + SEAT_COUNT - from) % SEAT_COUNT {
        1 => profile.next,
        2 => profile.diag,
        3 => profile.prev,
        _ => return 0.0,
    };
    if to as i32 == leader {
        lambda += profile.leader_boost;
    }
    lambda * params.seats[from].aggression * params.aggression_scale
}

pub fn evaluate(context: &mut EvalContext, position: &Position, params: &BitboardParams, phase: Phase) -> [f64; SEAT_COUNT] {
    let weights = params.phases.get(phase);
    let lambda_profile = params.lambda.get(phase);
    for seat in 0..SEAT_COUNT {
        context.corner_score[seat] = corner_score_for(context, seat, weights.corner_exponent);
        context.centre_score[seat] = if weights.centre != 0.0 { centre_score_for(context, seat) } else { 0.0 };
        context.waste[seat] = if weights.waste != 0.0 { waste_for(context, position, seat) } else { 0.0 };
        context.pressure[seat] =
            if weights.frontier != 0.0 { frontier_pressure(&context.territory, seat, 2) } else { 0.0 };
    }
    for seat in 0..SEAT_COUNT {
        let profile = &params.seats[seat];
        let mut value = weights.squares * position.placed_squares(seat) as f64
            + weights.corners * profile.corners * context.corner_score[seat]
            + weights.territory * profile.territory * context.territory.territory[seat]
            + weights.centre * profile.centre * context.centre_score[seat]
            - weights.waste * profile.waste * context.waste[seat]
            - weights.frontier * context.pressure[seat];
        if weights.mobility != 0.0 {
            value += weights.mobility * mobility_for(context, position, seat);
        }
        if weights.unique_corners != 0.0 {
            value += weights.unique_corners * profile.corners * unique_corners_for(context, seat);
        }
        for other in 0..SEAT_COUNT {
            if other == seat {
                continue;
            }
            let lambda = lambda_for(params, lambda_profile, seat, other, context.leader);
            if lambda == 0.0 {
                continue;
            }
            value -= lambda
                * (weights.opp_territory * context.territory.territory[other]
                    + weights.opp_corners * context.corner_score[other]
                    + weights.opp_squares * position.placed_squares(other) as f64);
        }
        context.values[seat] = value;
    }
    context.values
}

pub fn detect_phase(position: &Position, context: &EvalContext, params: &BitboardParams, seat: usize) -> Phase {
    let played = 21 - position.hand[seat].count_ones() as i32;
    let empty = CELL_COUNT as i32 - popcount(&position.occ) as i32;
    let contested_share = if empty > 0 { context.territory.contested as f64 / empty as f64 } else { 0.0 };
    let d = &params.detection;
    if contested_share < d.contested_floor && played as f64 >= d.opening_moves {
        return Phase::Endgame;
    }
    if (played as f64) < d.opening_moves {
        return Phase::Opening;
    }
    if (played as f64) < d.midgame_moves {
        return Phase::Midgame;
    }
    Phase::Endgame
}
