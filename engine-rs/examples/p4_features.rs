//! P4/P5 feature extraction: every legal move of every decision made by a Pentobi seat in bridge
//! games, with the move-prior features of `feature_prior.rs` (the same code the search runs), today's
//! ordering score, and the move's rank in today's 40-move root shortlist.
//!
//!   cargo run --release --example p4_features -- <config.json> <threads> <out-prefix> <moves.jsonl>...
//!
//! Run from the repo root (the config's rollout table path is relative). Writes
//!   <out-prefix>.f32       rows of COLS little-endian f32: FEATURE_COUNT features, ordering score
//!                          (`MoveOrderer::score_moves` over all legal moves, no split term), rank in
//!                          the root shortlist `V12Search::prepare` builds for `config` (−1 if not in
//!                          it), label (1 for the move played);
//!   <out-prefix>.csv       one line per decision: file, seed, lone, seat, ply, own_idx, legal, row
//!                          start, phase, shortlist size.
//! The engine of each seat comes from the record's `engines` list; only "pentobi" seats are used.

use blokee::config::BitboardParams;
use blokee::feature_prior::{FEATURE_COUNT, FEATURE_NAMES, PriorContext};
use blokee::features::{EvalContext, detect_phase, refresh_context};
use blokee::game::GameState;
use blokee::ordering::MoveOrderer;
use blokee::position::{SEAT_COLORS, SEAT_COUNT, new_move_buffer};
use blokee::rollout_policy::RolloutPolicy;
use blokee::search::V12Search;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const COLS: usize = FEATURE_COUNT + 3;

struct Game {
    file: usize,
    seed: u64,
    lone: String,
    engines: [String; SEAT_COUNT],
    moves: Vec<i32>,
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 5 {
        panic!("usage: p4_features <config.json> <threads> <out-prefix> <moves.jsonl>...");
    }
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(&argv[1]).unwrap()).unwrap();
    let threads: usize = argv[2].parse().unwrap();
    let prefix = &argv[3];
    let files = &argv[4..];
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(p)) => {
            let found = [p.clone(), format!("../{p}")].into_iter().find(|c| std::path::Path::new(c).exists()).expect("rollout table not found");
            Some(Arc::new(RolloutPolicy::from_file(&found).unwrap()))
        }
        _ => None,
    };
    let mut games = Vec::new();
    for (fi, path) in files.iter().enumerate() {
        for l in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let order: Vec<&str> = v["seatOrder"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert_eq!(order, SEAT_COLORS.to_vec(), "seat order");
            games.push(Game {
                file: fi,
                seed: v["seed"].as_u64().unwrap(),
                lone: v["seat"].as_str().unwrap().to_string(),
                engines: std::array::from_fn(|s| v["engines"][s].as_str().unwrap().to_string()),
                moves: v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect(),
            });
        }
    }
    eprintln!("p4_features: {} games, {} features: {}", games.len(), FEATURE_COUNT, FEATURE_NAMES.join(","));
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(usize, Vec<f32>, Vec<String>)>> = Mutex::new(Vec::new());
    let params = Arc::new(params);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut search = V12Search::new(Arc::clone(&params), table.clone());
                let mut context = EvalContext::new(params.fractional_territory_ties);
                let mut orderer = MoveOrderer::new();
                let mut buf = new_move_buffer();
                loop {
                    let gi = next.fetch_add(1, Ordering::Relaxed);
                    if gi >= games.len() {
                        break;
                    }
                    let g = &games[gi];
                    let mut rows: Vec<f32> = Vec::new();
                    let mut lines: Vec<String> = Vec::new();
                    let mut state = GameState::new(false);
                    let mut history: Vec<(usize, i32)> = Vec::new();
                    for (ply, &mv) in g.moves.iter().enumerate() {
                        let seat = state.turn;
                        if mv < 0 {
                            state.pass();
                            continue;
                        }
                        if g.engines[seat] == "pentobi" {
                            let mut p = state.to_position();
                            p.force_turn(seat);
                            let n = p.generate_moves(seat, &mut buf, usize::MAX);
                            let moves: Vec<i32> = buf[..n].to_vec();
                            assert!(moves.contains(&mv), "played move not legal: seed {} ply {ply}", g.seed);
                            refresh_context(&mut context, &p, false);
                            let phase = detect_phase(&p, &context, &params, seat);
                            let mut ord = vec![0.0; n];
                            orderer.score_moves(&params, &p, &context, seat, &moves, &mut ord, phase, false, 0);
                            let mut q = p.clone();
                            search.prepare(&mut q, seat);
                            let (short, _) = search.root_candidates();
                            let rank: std::collections::HashMap<i32, usize> = short.iter().enumerate().map(|(r, &m)| (m, r)).collect();
                            let ctx = PriorContext::new(&p, seat, &history);
                            let mut f = [0f32; FEATURE_COUNT];
                            lines.push(format!(
                                "{},{},{},{seat},{ply},{},{n},ROW,{:?},{}",
                                g.file,
                                g.seed,
                                g.lone,
                                ctx.own_moves,
                                phase,
                                short.len()
                            ));
                            for (i, &m) in moves.iter().enumerate() {
                                ctx.features(m, &mut f);
                                rows.extend_from_slice(&f);
                                rows.push(ord[i] as f32);
                                rows.push(rank.get(&m).map_or(-1.0, |&r| r as f32));
                                rows.push((m == mv) as u8 as f32);
                            }
                        }
                        state.apply(mv);
                        history.push((seat, mv));
                    }
                    results.lock().unwrap().push((gi, rows, lines));
                    let done = results.lock().unwrap().len();
                    if done % 100 == 0 {
                        eprintln!("p4_features: {done}/{} games", games.len());
                    }
                }
            });
        }
    });
    let mut results = results.into_inner().unwrap();
    results.sort_by_key(|r| r.0);
    let mut fw = std::io::BufWriter::new(std::fs::File::create(format!("{prefix}.f32")).unwrap());
    let mut cw = std::io::BufWriter::new(std::fs::File::create(format!("{prefix}.csv")).unwrap());
    writeln!(cw, "file,seed,lone,seat,ply,own_idx,legal,row,phase,shortlist").unwrap();
    let mut row = 0usize;
    let mut decisions = 0usize;
    for (_, rows, lines) in results {
        let mut at = 0usize;
        for line in lines {
            let n: usize = line.split(',').nth(6).unwrap().parse().unwrap();
            writeln!(cw, "{}", line.replace("ROW", &row.to_string())).unwrap();
            row += n;
            at += n;
            decisions += 1;
        }
        assert_eq!(at * COLS, rows.len());
        for v in rows {
            fw.write_all(&v.to_le_bytes()).unwrap();
        }
    }
    eprintln!("p4_features: wrote {decisions} decisions, {row} candidate rows ({COLS} f32 columns) to {prefix}.f32/.csv");
}
