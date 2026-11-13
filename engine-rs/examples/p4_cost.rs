//! P4/P5 cost: ms per searched move and iterations per second of several configs on the same
//! positions, plus the root candidate count and how often each config picks the first config's move.
//!
//!   cargo run --release --example p4_cost -- <moves.jsonl> <positions> <threads> <out.csv> <config.json>...
//!
//! Positions are the lone Blokee seat's decisions at own moves 3–20 in a `blokee-pentobi --moves-out`
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
                if own >= 3 {
                    jobs.push((v["seed"].as_u64().unwrap(), moves[..ply].to_vec(), seat, own));
                }
            }
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
    }
    let step = (jobs.len() / wanted).max(1);
    let jobs: Vec<_> = jobs.into_iter().step_by(step).take(wanted).collect();
    eprintln!("p4_cost: {} positions, {} configs, {threads} threads", jobs.len(), configs.len());
    let next = AtomicUsize::new(0);
    let rows: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut engines: Vec<Engine> = loaded.iter().map(|(p, t)| Engine::new(p.clone(), t.clone()).unwrap()).collect();
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
                            "{i},{seed},{},{seat},{own},{k},{:.3},{},{},{visited},{top},{best},{}",
                            prefix.len(),
                            ms,
                            stats.iterations,
                            ranked.len(),
                            (Some(best) == first_move) as u8
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
    writeln!(w, "pos,seed,ply,seat,own_idx,config,ms,iterations,candidates,visited,top_visits,best,same_as_first").unwrap();
    for (_, r) in rows {
        writeln!(w, "{r}").unwrap();
    }
    eprintln!("p4_cost: wrote {out}; configs: {}", configs.join(" "));
}
