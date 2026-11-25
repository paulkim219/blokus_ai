//! Hybrid H2 cost probe: `p4_cost` (same positions, RNG seeds and budget 300) plus the network
//! positions evaluated per searched move (`MoveStats::net_evaluations`: the root call and any interior
//! calls), with one untimed warm-up search per config before the timed ones (the first CUDA call and
//! session warm-up are not charged to a position). Used to choose `interiorVisits` and to calibrate
//! equal wall time (`engine-rs/scripts/h2_calibrate.py`).
//!
//!   cargo run --release --features ort --example h2_cost -- <moves.jsonl> <positions> <threads> <out.csv> <config.json>...
//!
//! Positions are the lone Blokee seat's decisions at own moves 3+ (`P4_COST_MIN_OWN`, default 3) in a `blokee-pentobi --moves-out`
//! file, sampled evenly (every k-th). Each position is searched by every config in turn on the same
//! thread with the same RNG seed and budget 300, so machine load changes hit all configs alike.
//! Run from the repo root.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::game::{GameState, recent_placements};
use blokee::position::SEAT_COLORS;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (moves_path, wanted, threads, out) = (&argv[1], argv[2].parse::<usize>().unwrap(), argv[3].parse::<usize>().unwrap(), &argv[4]);
    let configs: Vec<String> = argv[5..].to_vec();
    let load = |path: &str| {
        let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
            ("table", Some(p)) => Some(Arc::new(RolloutPolicy::from_file(p).unwrap())),
            _ => None,
        };
        (params, table)
    };
    let loaded: Vec<_> = configs.iter().map(|c| load(c)).collect();
    // P4_COST_MIN_OWN (default 3): the smallest own-move index sampled (0 to include the opening).
    let min_own: u32 = std::env::var("P4_COST_MIN_OWN").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    // (seed, moves prefix, seat, own index)
    let mut jobs: Vec<(u64, Vec<i32>, usize, u32)> = Vec::new();
    for l in std::fs::read_to_string(moves_path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
        let v: serde_json::Value = serde_json::from_str(l).unwrap();
        let lone = SEAT_COLORS.iter().position(|c| *c == v["seat"].as_str().unwrap()).unwrap();
        let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
        let mut state = GameState::new(false);
        for (ply, &mv) in moves.iter().enumerate() {
            let seat = state.turn;
            if seat == lone && mv >= 0 {
                let own = 21 - state.board.hand[seat].count_ones();
                if own >= min_own {
                    jobs.push((v["seed"].as_u64().unwrap(), moves[..ply].to_vec(), seat, own));
                }
            }
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
    }
    let step = (jobs.len() / wanted).max(1);
    let jobs: Vec<_> = jobs.into_iter().step_by(step).take(wanted).collect();
    eprintln!("h2_cost: {} positions, {} configs, {threads} threads", jobs.len(), configs.len());
    let next = AtomicUsize::new(0);
    let rows: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut engines: Vec<Engine> = loaded.iter().map(|(p, t)| Engine::new(p.clone(), t.clone()).unwrap()).collect();
                // Untimed warm-up: one search per engine on the first position.
                if let Some((seed, prefix, seat, _)) = jobs.first() {
                    let mut state = GameState::new(false);
                    for &mv in prefix {
                        if mv >= 0 { state.apply(mv) } else { state.pass() }
                    }
                    for engine in engines.iter_mut() {
                        let mut position = state.to_position();
                        let mut rng = Rng::new(*seed as u32);
                        engine.set_recent(&recent_placements(prefix));
                        engine.search(&mut position, *seat, 300, &mut rng, &mut MoveStats::default());
                    }
                }
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= jobs.len() {
                        break;
                    }
                    let (seed, prefix, seat, own) = &jobs[i];
                    let mut state = GameState::new(false);
                    for &mv in prefix {
                        if mv >= 0 { state.apply(mv) } else { state.pass() }
                    }
                    let mut first_move = None;
                    for (k, engine) in engines.iter_mut().enumerate() {
                        let mut position = state.to_position();
                        let mut rng = Rng::new((*seed as u32) ^ (prefix.len() as u32).wrapping_mul(0x9e37_79b9));
                        let mut stats = MoveStats::default();
                        engine.set_recent(&recent_placements(prefix));
                        let started = Instant::now();
                        let ranked = engine.search(&mut position, *seat, 300, &mut rng, &mut stats);
                        let ms = started.elapsed().as_secs_f64() * 1000.0;
                        let best = ranked.first().map_or(-1, |r| r.mv);
                        if k == 0 {
                            first_move = Some(best);
                        }
                        let visited = ranked.iter().filter(|r| r.visits > 0).count();
                        let top = ranked.first().map_or(0, |r| r.visits);
                        let row = format!(
                            "{i},{seed},{},{seat},{own},{k},{:.3},{},{},{visited},{top},{best},{},{}",
                            prefix.len(),
                            ms,
                            stats.iterations,
                            ranked.len(),
                            (Some(best) == first_move) as u8,
                            stats.net_evaluations
                        );
                        rows.lock().unwrap().push((i * 100 + k, row));
                    }
                }
            });
        }
    });
    let mut rows = rows.into_inner().unwrap();
    rows.sort();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "pos,seed,ply,seat,own_idx,config,ms,iterations,candidates,visited,top_visits,best,same_as_first,net_evals").unwrap();
    for (_, r) in rows {
        writeln!(w, "{r}").unwrap();
    }
    eprintln!("h2_cost: wrote {out}; configs: {}", configs.join(" "));
}
