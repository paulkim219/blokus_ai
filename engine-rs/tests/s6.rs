//! S6 gate: move generation with the forbidden window and the reach prefilter lists exactly the
//! legal placements (checked against `is_legal` over every placement) in random games, and
//! `apply_unhashed` + `undo` leaves the position (hash included) as `apply` + `undo` does.

use blokee::placements::placements;
use blokee::position::{MAX_MOVES, Position};
use blokee::rng::Rng;

#[test]
fn generation_matches_brute_force_legality() {
    let t = placements();
    let mut buffer = vec![0i32; MAX_MOVES];
    let mut checked = 0usize;
    for seed in 0..40u32 {
        let mut rng = Rng::new(9000 + seed);
        let mut p = Position::initial(false);
        for _ in 0..90 {
            if p.finished() {
                break;
            }
            let seat = p.turn;
            let n = p.generate_moves(seat, &mut buffer, MAX_MOVES);
            let mut got: Vec<i32> = buffer[..n].to_vec();
            got.sort_unstable();
            let want: Vec<i32> = (0..t.count as i32).filter(|&id| p.hand[seat] & (1 << t.piece_id[id as usize]) != 0 && p.is_legal(seat, id)).collect();
            assert_eq!(got, want, "seed {seed} ply {}", p.ply);
            checked += 1;
            if n == 0 {
                p.mark_out(seat);
                p.advance_turn();
                continue;
            }
            let mv = buffer[rng.next_int(n)];
            let (lo, hi, turn) = (p.hash_lo, p.hash_hi, p.turn);
            let u = p.apply_unhashed(mv);
            p.undo(&u);
            assert_eq!((p.hash_lo, p.hash_hi, p.turn), (lo, hi, turn));
            let u2 = p.apply_unhashed(mv);
            let unhashed_turn = p.turn;
            p.undo(&u2);
            p.apply(mv);
            assert_eq!(p.turn, unhashed_turn, "turn after apply_unhashed");
        }
    }
    assert!(checked > 1000, "{checked}");
}
