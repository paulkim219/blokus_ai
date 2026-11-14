//! S4 gates (speed work with identical output): the fast fitted-prior scorer gives the reference
//! scorer's numbers bit for bit; `sort_by_score` gives the reference order; the rest of the
//! identity checks are whole searches and games against the binary from before the change
//! (`engine-rs/scripts/s4-run.sh identity`).

use blokee::config::BitboardParams;
use blokee::feature_prior::PriorContext;
use blokee::game::{GameState, recent_placements};
use blokee::ordering::{sort_by_score, sort_by_score_reference};
use blokee::position::MAX_MOVES;
use blokee::rng::Rng;

fn model() -> blokee::feature_prior::PriorModel {
    let p: BitboardParams = serde_json::from_str(&std::fs::read_to_string("configs/v5.0-p4i-ultra.json").unwrap()).unwrap();
    p.native.unwrap().candidates.unwrap().model.unwrap()
}

/// Random games, every position along them (all seats, all move counts).
fn games(count: usize, seed: u32) -> Vec<(GameState, Vec<i32>)> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::new();
    let mut buffer = vec![0i32; MAX_MOVES];
    for _ in 0..count {
        let mut state = GameState::new(false);
        let mut moves = Vec::new();
        while !state.finished {
            let seat = state.turn;
            let n = state.board.generate_moves(seat, &mut buffer, MAX_MOVES);
            if n == 0 {
                state.pass();
                moves.push(-1);
                continue;
            }
            out.push((state.clone(), moves.clone()));
            // Prefer big pieces now and then so games look less random.
            let mv = buffer[rng.next_int(n)];
            state.apply(mv);
            moves.push(mv);
        }
    }
    out
}

#[test]
fn fast_prior_scorer_equals_reference_bit_for_bit() {
    let model = model();
    let mut buffer = vec![0i32; MAX_MOVES];
    let mut checked = 0usize;
    for (state, moves) in games(60, 4242) {
        let position = state.to_position();
        let seat = state.turn;
        let n = position.generate_moves(seat, &mut buffer, MAX_MOVES);
        // With and without the recent placements (the local features).
        for recent in [recent_placements(&moves), Vec::new()] {
            let ctx = PriorContext::new(&position, seat, &recent);
            let mut fast = vec![0.0; n];
            let mut reference = vec![0.0; n];
            model.score(&ctx, &buffer[..n], &mut fast);
            model.score_reference(&ctx, &buffer[..n], &mut reference);
            for i in 0..n {
                assert_eq!(fast[i].to_bits(), reference[i].to_bits(), "move {} at ply {}", buffer[i], moves.len());
            }
            checked += n;
        }
    }
    assert!(checked > 100_000, "only {checked} moves checked");
}

#[test]
fn sort_by_score_equals_reference() {
    let mut rng = Rng::new(7);
    for round in 0..2000 {
        let n = 1 + rng.next_int(400);
        let mut moves: Vec<i32> = (0..n as i32).map(|i| i * 7 + (round % 5) as i32).collect();
        // Shuffle, and draw scores with many ties, signed zeros and a wide range.
        for i in (1..n).rev() {
            moves.swap(i, rng.next_int(i + 1));
        }
        let scores: Vec<f64> = (0..n)
            .map(|_| match rng.next_int(6) {
                0 => 0.0,
                1 => -0.0,
                2 => (rng.next_int(5) as f64) - 2.0,
                3 => rng.next_f64() * 1e6 - 5e5,
                _ => rng.next_f64() * 4.0 - 2.0,
            })
            .collect();
        let (mut m1, mut s1) = (moves.clone(), scores.clone());
        let (mut m2, mut s2) = (moves.clone(), scores.clone());
        sort_by_score(&mut m1, &mut s1);
        sort_by_score_reference(&mut m2, &mut s2);
        assert_eq!(m1, m2);
        assert_eq!(s1.iter().map(|s| s.to_bits()).collect::<Vec<_>>(), s2.iter().map(|s| s.to_bits()).collect::<Vec<_>>());
    }
}
