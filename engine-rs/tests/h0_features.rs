//! Hybrid H0: the bitboard network encoder (`Inputs::push_record`) equals the cell-by-cell
//! transcription of `ml/torch/features.py` (`push_record_reference`) on positions from random games.
//! Equality with Python itself is checked by `ml/torch/h0_encoding_parity.py` (gate G2).

use blokee::game::GameState;
use blokee::net_features::Inputs;
use blokee::position::SEAT_COUNT;
use blokee::prior::encode_request;
use blokee::rng::Rng;

#[test]
fn bitboard_encoder_matches_reference() {
    let mut rng = Rng::new(20261119);
    let mut buffer = vec![0i32; 4096];
    let (mut fast, mut slow) = (Inputs::default(), Inputs::default());
    let mut positions = 0;
    for _ in 0..40 {
        let mut game = GameState::new(false);
        while !game.finished {
            let seat = game.turn;
            let n = game.board.generate_moves(seat, &mut buffer, 4096);
            // Encode from every seat's point of view, so all four rotations are exercised.
            let moves: Vec<i32> = buffer[..n].iter().copied().take(64).collect();
            for view in 0..SEAT_COUNT {
                let record = encode_request(&game.board, view, if view == seat { &moves } else { &[] });
                fast.push_record(&record);
                slow.push_record_reference(&record);
                positions += 1;
            }
            if n == 0 {
                game.pass();
            } else {
                game.apply(buffer[rng.next_int(n)]);
            }
        }
    }
    assert!(positions > 10_000, "{positions}");
    assert_eq!(fast.batch, slow.batch);
    assert!(fast.planes == slow.planes, "planes differ");
    assert!(fast.hands == slow.hands);
    assert!(fast.footprint == slow.footprint);
    assert!(fast.pieces == slow.pieces);
    assert!(fast.mask == slow.mask);
    assert!(fast.seat == slow.seat);
}
