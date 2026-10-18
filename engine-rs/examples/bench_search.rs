//! µs per MCTS iteration on fixed positions, for v4.1-ultra-style params.
//!   cargo run --release --example bench_search -- [iterations] [repeats]
use blokee::bitboard::CELL_COUNT;
use blokee::config::BitboardParams;
use blokee::position::Position;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use blokee::search::V12Search;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let iterations: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(4800);
    let repeats: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let dir = env!("CARGO_MANIFEST_DIR");
    let params: HashMap<String, BitboardParams> =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/tests/goldens/params.json")).unwrap()).unwrap();
    let mut p = params["v4.1-ultra"].clone();
    p.time.early_exit = false; // measure the full budget, not the early stop
    let p = Arc::new(p);
    let table = Arc::new(RolloutPolicy::from_file(&format!("{dir}/../ml/v41-rollout-policy.json")).unwrap());
    let positions: Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/tests/goldens/positions.json")).unwrap()).unwrap();
    let decode = |r: &Value| {
        let owners: Vec<i64> = serde_json::from_value(r["owners"].clone()).unwrap();
        let mut cells = [-1i8; CELL_COUNT];
        for (i, &o) in owners.iter().enumerate() { cells[i] = o as i8; }
        let hand: Vec<u32> = serde_json::from_value(r["hand"].clone()).unwrap();
        let last: Vec<i32> = serde_json::from_value(r["lastPiece"].clone()).unwrap();
        Position::from_cells(&cells, [hand[0], hand[1], hand[2], hand[3]], [last[0], last[1], last[2], last[3]], r["turn"].as_u64().unwrap() as usize, false)
    };
    // Plies ~8, ~24, ~40 of the first random game: opening, midgame, late.
    for (label, index) in [("opening", 2usize), ("midgame", 4), ("late", 6)] {
        let base = decode(&positions[index]["position"]);
        let mut best = f64::INFINITY;
        for r in 0..repeats {
            let mut position = base.clone();
            let seat = position.turn;
            let mut search = V12Search::new(Arc::clone(&p), Some(Arc::clone(&table)));
            let mut rng = Rng::new(99 + r as u32);
            let started = Instant::now();
            let result = search.run(&mut position, seat, iterations, &mut rng);
            let us = started.elapsed().as_secs_f64() * 1e6 / result.iterations.max(1) as f64;
            best = best.min(us);
        }
        println!("{label:8} ply {:3}  {best:7.1} µs/iteration", base.ply);
    }
}
