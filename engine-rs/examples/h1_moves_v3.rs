//! Hybrid H1: Pentobi decisions in record format v3 (`blokee::record_v3`).
//!
//! Replays the games of `blokee-pentobi --moves-out` files and writes one v3 record per decision
//! made by a seat whose engine is "pentobi": every legal move, visits 1 on the move Pentobi played
//! and 0 elsewhere (a one-hot policy target), priors 0, no root values (NaN), source 4 (teacher
//! move), `teacher` = the Pentobi level given, and the game's final scores. The scores are
//! recomputed by the replay and checked against the line's own. Games are numbered in the order
//! read; duplicate seeds are refused.
//!
//!   cargo run --release --example h1_moves_v3 -- <out-dir> <level> <moves.jsonl>...
//!
//! Writes `<out-dir>/v3-shard-00.bin`, `games.jsonl` (game, seed, plies, finished, scores per seat
//! in turn order, moves) and `meta.json`.

use blokee::game::GameState;
use blokee::placements::PIECE_COUNT;
use blokee::position::{SEAT_COLORS, SEAT_COUNT, new_move_buffer};
use blokee::record_v3::{self, RecordV3};
use serde_json::json;
use std::io::Write;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 4 {
        panic!("usage: h1_moves_v3 <out-dir> <level> <moves.jsonl>...");
    }
    let out = &argv[1];
    let level: u8 = argv[2].parse().unwrap();
    std::fs::create_dir_all(out).unwrap();
    let mut shard = std::io::BufWriter::new(std::fs::File::create(format!("{out}/v3-shard-00.bin")).unwrap());
    let mut games_log = std::io::BufWriter::new(std::fs::File::create(format!("{out}/games.jsonl")).unwrap());
    let mut seen = std::collections::HashSet::new();
    let mut buf = new_move_buffer();
    let (mut game, mut decisions) = (0u32, 0usize);
    for path in &argv[3..] {
        for line in std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}")).lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let order: Vec<&str> = v["seatOrder"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert_eq!(order, SEAT_COLORS.to_vec(), "seat order");
            let seed = v["seed"].as_u64().unwrap() as u32;
            assert!(seen.insert(seed), "{path}: seed {seed} appears twice");
            let engines: [String; SEAT_COUNT] = std::array::from_fn(|s| v["engines"][s].as_str().unwrap().to_string());
            let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
            let mut state = GameState::new(false);
            let mut buffer = Vec::new();
            let mut starts = Vec::new();
            for (ply, &mv) in moves.iter().enumerate() {
                let seat = state.turn;
                if mv < 0 {
                    state.pass();
                    continue;
                }
                if engines[seat] == "pentobi" {
                    let mut p = state.to_position();
                    p.force_turn(seat);
                    let n = p.generate_moves(seat, &mut buf, usize::MAX);
                    assert!(buf[..n].contains(&mv), "{path}: seed {seed} ply {ply}: played move not legal");
                    let board = &state.board;
                    let record = RecordV3 {
                        game,
                        ply: ply as u16,
                        seat: seat as u8,
                        source: record_v3::SOURCE_TEACHER,
                        own: board.own,
                        hand: board.hand,
                        last_piece: board.last_piece.map(|p| p as i8),
                        chosen: mv as u16,
                        iterations: 0,
                        root_visits: 0,
                        root_values: [f32::NAN; SEAT_COUNT],
                        final_scores: [0.0; SEAT_COUNT],
                        teacher: level,
                        own_moves: (PIECE_COUNT as u32 - board.hand[seat].count_ones()) as u8,
                        seed,
                        moves: buf[..n].iter().map(|&m| m as u16).collect(),
                        visits: buf[..n].iter().map(|&m| (m == mv) as u32).collect(),
                        priors: vec![0.0; n],
                    };
                    starts.push(buffer.len());
                    record.encode(&mut buffer);
                    decisions += 1;
                }
                state.apply(mv);
            }
            let scores = state.scores();
            for (s, colour) in SEAT_COLORS.iter().enumerate() {
                let logged = v["scores"][*colour].as_f64().unwrap();
                assert_eq!(logged, scores[s], "{path}: seed {seed}: replayed score of {colour} differs");
            }
            for &at in &starts {
                RecordV3::patch_scores(&mut buffer, at, &scores);
            }
            shard.write_all(&buffer).unwrap();
            writeln!(
                games_log,
                "{}",
                json!({"game": game, "seed": seed, "plies": moves.len(), "finished": true, "scores": scores, "moves": moves,
                       "engines": engines, "teacher": level, "source": path})
            )
            .unwrap();
            game += 1;
        }
    }
    shard.flush().unwrap();
    games_log.flush().unwrap();
    std::fs::write(
        format!("{out}/meta.json"),
        serde_json::to_string_pretty(&json!({
            "source": "blokee-pentobi --moves-out (Pentobi decisions only)", "files": &argv[3..], "teacher": level,
            "games": game, "decisions": decisions, "format": "v3", "shards": "v3-shard-XX.bin", "layout": RecordV3::layout_json(),
        }))
        .unwrap(),
    )
    .unwrap();
    eprintln!("h1_moves_v3: {game} games, {decisions} decisions -> {out}");
}
