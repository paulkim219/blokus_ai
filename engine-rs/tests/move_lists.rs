//! P2 correctness gate: the incremental legal-move lists (`move_lists::MoveLists`) equal a
//! from-scratch generation (`Position::generate_moves`), as sets and without duplicates, for every
//! seat at every ply of many random games — both when every seat's list is kept from the start and
//! when lists are only asked for now and then (built lazily part-way through a game), with and
//! without base lists set at random earlier positions and rollout-style resets, on both opening
//! rules.

use blokee::move_lists::{MoveLists, entry_id};
use blokee::position::{MAX_MOVES, Position, SEAT_COUNT};
use blokee::rng::Rng;

fn scratch_set(position: &Position, seat: usize, buffer: &mut [i32]) -> Vec<i32> {
    let n = position.generate_moves(seat, buffer, MAX_MOVES);
    let mut v = buffer[..n].to_vec();
    v.sort_unstable();
    v
}

/// Plays one random game; returns (plies, list comparisons made).
fn play(seed: u32, opening_anywhere: bool, lazy: bool, bases: bool) -> (usize, usize) {
    let mut rng = Rng::new(seed);
    let mut position = Position::initial(opening_anywhere);
    let mut lists = MoveLists::new();
    let mut buffer = vec![0i32; MAX_MOVES];
    let mut plies = 0;
    let mut checks = 0;
    // Some games start from a position a few random moves in, with the lists built only there.
    let mut warmup = if lazy { rng.next_int(30) } else { 0 };
    while !position.finished() {
        let seat = position.turn;
        if warmup > 0 {
            warmup -= 1;
            let n = position.generate_moves(seat, &mut buffer, MAX_MOVES);
            if n == 0 {
                position.mark_out(seat);
                position.advance_turn();
            } else {
                position.apply(buffer[rng.next_int(n)]);
            }
            continue;
        }
        if bases {
            // A new search root now and then; a new rollout below the current base more often.
            if rng.next_f64() < 0.04 {
                lists.set_base(&position);
            }
            if rng.next_f64() < 0.15 {
                lists.reset();
            }
        }
        for s in 0..SEAT_COUNT {
            // Lazy games look at another seat's list only now and then.
            if s != seat && lazy && rng.next_f64() < 0.7 {
                continue;
            }
            let mut inc: Vec<i32> = lists.moves(&position, s).iter().map(|&e| entry_id(e)).collect();
            inc.sort_unstable();
            let n = inc.len();
            inc.dedup();
            assert_eq!(inc.len(), n, "seed {seed} ply {plies} seat {s}: duplicate in the incremental list");
            let full = scratch_set(&position, s, &mut buffer);
            assert_eq!(inc, full, "seed {seed} ply {plies} seat {s} (anywhere {opening_anywhere}, lazy {lazy})");
            checks += 1;
        }
        let moves = lists.moves(&position, seat);
        if moves.is_empty() {
            position.mark_out(seat);
            position.advance_turn();
            continue;
        }
        let chosen = entry_id(moves[rng.next_int(moves.len())]);
        let corner_before = position.corner_halo[seat];
        let played_before = position.played[seat] == 1;
        position.apply(chosen);
        lists.after_placement(&position, seat, chosen, &corner_before, played_before);
        plies += 1;
    }
    (plies, checks)
}

#[test]
fn incremental_lists_equal_scratch_generation() {
    let (mut games, mut plies, mut checks) = (0, 0, 0);
    for seed in 0..1000u32 {
        for (anywhere, lazy, bases) in [
            (false, false, false),
            (false, true, false),
            (true, false, false),
            (true, true, false),
            (false, false, true),
            (false, true, true),
            (true, true, true),
        ] {
            let (p, c) = play(0x5150_0000 + seed, anywhere, lazy, bases);
            games += 1;
            plies += p;
            checks += c;
        }
    }
    eprintln!("move lists: {games} games, {plies} placements, {checks} list comparisons, all equal");
    assert!(plies > 300_000 && checks > 900_000);
}

/// The rollout itself (`native.rollout` "all"): from random positions, with a base set at a random
/// ancestor, every rollout reaches the end of the game, restores the position exactly, and (in a
/// debug build, where `play_all_moves` asserts each move's legality) plays only legal moves.
#[test]
fn all_moves_rollouts_finish_and_restore() {
    use blokee::config::BitboardParams;
    use blokee::features::EvalContext;
    use blokee::playout::Playout;
    let mut params: BitboardParams =
        serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/configs/v5.0-p4-ultra.json")).unwrap()).unwrap();
    params.native.as_mut().unwrap().rollout = Some(
        serde_json::from_str(r#"{"policy": "all", "sizeWeight": 1.4, "localWeight": 0.7, "localOwnExtra": 0.65}"#).unwrap(),
    );
    let mut playout = Playout::new(None);
    let mut context = EvalContext::new(true);
    let mut buffer = vec![0i32; MAX_MOVES];
    let mut rollouts = 0;
    for seed in 0..60u32 {
        let mut rng = Rng::new(0x7013_0000 + seed);
        let mut position = Position::initial(false);
        let depth = 8 + rng.next_int(50);
        let mut recent = Vec::new();
        for ply in 0..depth {
            if position.finished() {
                break;
            }
            if ply == depth / 2 {
                playout.set_base(&position);
            }
            let seat = position.turn;
            let n = position.generate_moves(seat, &mut buffer, MAX_MOVES);
            if n == 0 {
                position.mark_out(seat);
                position.advance_turn();
            } else {
                let mv = buffer[rng.next_int(n)];
                position.apply(mv);
                recent.push((seat, mv));
            }
        }
        let before = position.clone();
        for _ in 0..20 {
            playout.set_recent(&recent);
            let outcome = playout.run(&params, &mut position, &mut context, blokee::config::Phase::Midgame, None, &mut rng);
            assert!(outcome.terminal);
            assert_eq!(position.occ, before.occ);
            assert_eq!(position.hand, before.hand);
            assert_eq!((position.hash_lo, position.hash_hi, position.turn, position.out), (before.hash_lo, before.hash_hi, before.turn, before.out));
            rollouts += 1;
        }
    }
    eprintln!("all-moves rollouts: {rollouts} finished and restored");
}
