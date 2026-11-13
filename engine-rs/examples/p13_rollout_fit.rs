//! P1 rollout-policy data: for every decision of a Pentobi seat in bridge games, the legal moves
//! counted by the rollout policy's three inputs — piece size (1–5), local squares covered (0–5) and
//! local squares that are also own open corners (0–5), exactly as `native.rollout` "all" computes
//! them (`playout::local_squares`, placements since the mover's own last one) — and the cell of the
//! move played. `ml/p13_fit_rollout.py` fits the policy's weights to these by maximum likelihood.
//!
//!   cargo run --release --example p13_rollout_fit -- <out.jsonl> <moves.jsonl>...
//!
//! One output line per decision: {"file", "seed", "seat", "own", "legal", "chosen", "counts"}, where
//! `counts` has 180 entries indexed ((size − 1) · 6 + local) · 6 + localOwn.

use blokee::game::GameState;
use blokee::move_lists::{entry, entry_count, rows_of};
use blokee::placements::PIECE_SIZES;
use blokee::playout::local_squares;
use blokee::position::{SEAT_COLORS, SEAT_COUNT, new_move_buffer};
use std::io::Write;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    assert!(argv.len() >= 3, "usage: p13_rollout_fit <out.jsonl> <moves.jsonl>...");
    let mut out = std::io::BufWriter::new(std::fs::File::create(&argv[1]).unwrap());
    let mut buf = new_move_buffer();
    let (mut games, mut decisions) = (0, 0);
    for (fi, path) in argv[2..].iter().enumerate() {
        for l in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let order: Vec<&str> = v["seatOrder"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert_eq!(order, SEAT_COLORS.to_vec(), "seat order");
            let engines: [String; SEAT_COUNT] = std::array::from_fn(|s| v["engines"][s].as_str().unwrap().to_string());
            let seed = v["seed"].as_u64().unwrap();
            let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
            let mut state = GameState::new(false);
            let mut history: Vec<(usize, i32)> = Vec::new();
            for &mv in &moves {
                let seat = state.turn;
                if mv < 0 {
                    state.pass();
                    continue;
                }
                let own = 21 - state.board.hand[seat].count_ones();
                if engines[seat] == "pentobi" && own >= 3 {
                    let mut p = state.to_position();
                    p.force_turn(seat);
                    let n = p.generate_moves(seat, &mut buf, usize::MAX);
                    assert!(buf[..n].contains(&mv), "played move not legal: seed {seed}");
                    let (local, local_own) = local_squares(&p, seat, &history);
                    let (local, local_own) = (rows_of(&local), rows_of(&local_own));
                    let cell = |m: i32| {
                        let e = entry(m);
                        let size = PIECE_SIZES[blokee::move_lists::entry_piece(e)] as usize;
                        ((size - 1) * 6 + entry_count(e, &local) as usize) * 6 + entry_count(e, &local_own) as usize
                    };
                    let mut counts = vec![0u32; 180];
                    for &m in &buf[..n] {
                        counts[cell(m)] += 1;
                    }
                    writeln!(
                        out,
                        "{{\"file\":{fi},\"seed\":{seed},\"seat\":{seat},\"own\":{own},\"legal\":{n},\"chosen\":{},\"counts\":{:?}}}",
                        cell(mv),
                        counts
                    )
                    .unwrap();
                    decisions += 1;
                }
                state.apply(mv);
                history.push((seat, mv));
            }
            games += 1;
        }
    }
    eprintln!("p13_rollout_fit: {games} games, {decisions} decisions -> {}", argv[1]);
}
