//! High-budget §2 probe: at every Pentobi decision in recorded games, the fitted interior prior a
//! Blokee tree would give that position (exactly as `shortlist` builds it for an interior node with
//! `interiorFull`: every legal move, the interior model's logits, sorted, softmax at `temperature`),
//! its effective number of moves 1/Σp², and the rank of the move Pentobi actually played.
//!
//!   hb_prior_probe <config.json> <out.csv> <moves.jsonl>...
//!
//! One row per Pentobi decision (passes skipped): file index, seed, lone seat, seat, ply, the mover's
//! own-move index, legal moves, n_eff, prior and rank (1 = top) of the actual move, the top prior,
//! whether the actual move touches an opponent piece along an edge or at a corner (contact), whether
//! any opponent piece is within the mover's corner/edge halo before the move (board contact), the
//! mover's open corners, and the next own-move score context (none). Run from the repo root.

use blokee::bitboard::*;
use blokee::config::BitboardParams;
use blokee::feature_prior::PriorContext;
use blokee::game::{GameState, recent_placements};
use blokee::ordering::{softmax_priors, sort_by_score};
use blokee::placements::placements;
use blokee::position::{MAX_MOVES, SEAT_COUNT, seat_of_color};
use std::io::Write;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (config, out) = (&argv[1], &argv[2]);
    let files = &argv[3..];
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
    let c = params.native.as_ref().and_then(|n| n.candidates.as_ref()).expect("native.candidates");
    assert!(c.interior_full && c.interior_fitted(), "probe expects interiorFull with the fitted scorer");
    assert!(c.next_pressure == 0.0, "nextPressure not supported by the probe");
    let model = c.interior_prior().expect("model");
    assert!(!model.has_extras(), "mobility extras not supported by the probe");
    let t = placements();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "file,seed,lone,seat,ply,own,legal,n_eff,p_actual,rank,p_top,move_contact,board_contact,open_corners").unwrap();
    let mut buffer = vec![0i32; MAX_MOVES];
    for (fi, file) in files.iter().enumerate() {
        for l in std::fs::read_to_string(file).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let lone = seat_of_color(v["seat"].as_str().unwrap()).unwrap();
            let order: Vec<usize> = v["seatOrder"].as_array().unwrap().iter().map(|s| seat_of_color(s.as_str().unwrap()).unwrap()).collect();
            let engines: Vec<&str> = v["engines"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            let mut pentobi = [false; SEAT_COUNT];
            for (k, &s) in order.iter().enumerate() {
                pentobi[s] = engines[k] == "pentobi";
            }
            assert!(!pentobi[lone]);
            let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
            let seed = v["seed"].as_u64().unwrap();
            let mut state = GameState::new(false);
            for (ply, &mv) in moves.iter().enumerate() {
                let seat = state.turn;
                if mv >= 0 && pentobi[seat] {
                    let position = state.to_position();
                    let n = position.generate_moves(seat, &mut buffer, usize::MAX);
                    let mut ms = buffer[..n].to_vec();
                    let recent = recent_placements(&moves[..ply]);
                    let ctx = PriorContext::new(&position, seat, &recent);
                    let mut scores = vec![0.0; n];
                    model.score(&ctx, &ms, &mut scores);
                    sort_by_score(&mut ms, &mut scores);
                    let mut priors = vec![0.0; n];
                    softmax_priors(&scores, c.temperature, &mut priors);
                    let n_eff = 1.0 / priors.iter().map(|p| p * p).sum::<f64>();
                    let k = ms.iter().position(|&m| m == mv).expect("actual move not legal in the replayed position");
                    let own = 21 - position.hand[seat].count_ones();
                    let mut opp = EMPTY;
                    for o in 0..SEAT_COUNT {
                        if o != seat {
                            or_into(&mut opp, &position.own[o]);
                        }
                    }
                    let m = mv as usize;
                    let mut halo = t.edge_halo[m];
                    or_into(&mut halo, &t.corner_halo[m]);
                    let move_contact = intersects(&halo, &opp);
                    let mut seat_halo = position.edge_halo[seat];
                    or_into(&mut seat_halo, &position.corner_halo[seat]);
                    let board_contact = intersects(&seat_halo, &opp);
                    let corners = popcount(&position.open_corners(seat));
                    writeln!(
                        w,
                        "{fi},{seed},{lone},{seat},{ply},{own},{n},{n_eff:.4},{:.6e},{},{:.6e},{},{},{corners}",
                        priors[k],
                        k + 1,
                        priors[0],
                        move_contact as u8,
                        board_contact as u8
                    )
                    .unwrap();
                }
                if mv >= 0 { state.apply(mv) } else { state.pass() }
            }
        }
    }
    eprintln!("hb_prior_probe: wrote {out}");
}
