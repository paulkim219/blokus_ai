//! S4 identity dump: the complete search result of several configs on many recorded positions,
//! written so that two binaries can be compared byte for byte (`cmp`).
//!
//!   s4_identity <out.txt> <positions per file> <threads> <moves.jsonl,...> <config.json>...
//!
//! Positions are every seat's decisions (own moves 0+, Pentobi and Blokee seats alike) in
//! `blokee-pentobi --moves-out` files, sampled evenly per file. Each position is searched by every
//! config at budget 300 with an RNG seeded from the game seed and ply, and the line written holds
//! the iteration count and every ranked root move with its visits and the exact bits of its value.
//! Thread k handles positions k, k + T, ... in order with one engine per config that it reuses, so
//! the output (and any state an engine carries between searches) is deterministic for a given T.
//! Run from the repo root.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::game::{GameState, recent_placements};
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use std::io::Write;
use std::sync::Arc;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (out, wanted, threads) = (&argv[1], argv[2].parse::<usize>().unwrap(), argv[3].parse::<usize>().unwrap());
    let files: Vec<&str> = argv[4].split(',').collect();
    let configs: Vec<String> = argv[5..].to_vec();
    let loaded: Vec<(BitboardParams, Option<Arc<RolloutPolicy>>)> = configs
        .iter()
        .map(|path| {
            let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
                ("table", Some(p)) => Some(Arc::new(RolloutPolicy::from_file(p).unwrap())),
                _ => None,
            };
            (params, table)
        })
        .collect();
    // (seed, moves prefix, seat)
    let mut jobs: Vec<(u64, Vec<i32>, usize)> = Vec::new();
    for file in &files {
        let mut here = Vec::new();
        for l in std::fs::read_to_string(file).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
            let mut state = GameState::new(false);
            for (ply, &mv) in moves.iter().enumerate() {
                if mv >= 0 {
                    here.push((v["seed"].as_u64().unwrap(), moves[..ply].to_vec(), state.turn));
                    state.apply(mv);
                } else {
                    state.pass();
                }
            }
        }
        let step = (here.len() / wanted).max(1);
        jobs.extend(here.into_iter().step_by(step).take(wanted));
    }
    eprintln!("s4_identity: {} positions, {} configs, {threads} threads", jobs.len(), configs.len());
    let mut lines: Vec<Vec<String>> = vec![Vec::new(); threads];
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|k| {
                let jobs = &jobs;
                let loaded = &loaded;
                scope.spawn(move || {
                    let mut engines: Vec<Engine> = loaded.iter().map(|(p, t)| Engine::new(p.clone(), t.clone()).unwrap()).collect();
                    let mut mine = Vec::new();
                    for i in (k..jobs.len()).step_by(threads) {
                        let (seed, prefix, seat) = &jobs[i];
                        let mut state = GameState::new(false);
                        for &mv in prefix {
                            if mv >= 0 { state.apply(mv) } else { state.pass() }
                        }
                        for (c, engine) in engines.iter_mut().enumerate() {
                            let mut position = state.to_position();
                            let mut rng = Rng::new((*seed as u32) ^ (prefix.len() as u32).wrapping_mul(0x9e37_79b9));
                            let mut stats = MoveStats::default();
                            engine.set_recent(&recent_placements(prefix));
                            let ranked = engine.search(&mut position, *seat, 300, &mut rng, &mut stats);
                            let mut line = format!("{i} {c} {seed} {} {seat} {:?} {} |", prefix.len(), stats.source, stats.iterations);
                            for r in &ranked {
                                line.push_str(&format!(" {}:{}:{:016x}", r.mv, r.visits, r.value.to_bits()));
                            }
                            line.push_str(&format!(" | rng {:016x}", rng.next_f64().to_bits()));
                            mine.push((i, c, line));
                        }
                    }
                    mine
                })
            })
            .collect();
        for (k, h) in handles.into_iter().enumerate() {
            lines[k] = h.join().unwrap().into_iter().map(|(_, _, l)| l).collect();
        }
    });
    let mut all: Vec<String> = lines.into_iter().flatten().collect();
    all.sort_by_key(|l| {
        let mut it = l.split(' ');
        (it.next().unwrap().parse::<usize>().unwrap(), it.next().unwrap().parse::<usize>().unwrap())
    });
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    for l in &all {
        writeln!(w, "{l}").unwrap();
    }
    eprintln!("s4_identity: wrote {} lines to {out}; configs: {}", all.len(), configs.join(" "));
}
