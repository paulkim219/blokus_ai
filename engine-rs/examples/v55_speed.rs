//! Round 8 speed probe: single-threaded search speed, tree size and an exact digest of the search
//! result for one config on recorded positions.
//!
//!   v55_speed <moves.jsonl> <positions> <every> <out.csv> <config.json>
//!
//! Positions are chosen exactly as `p4_cost` chooses them (the lone Blokee seat's decisions at own
//! moves 3+, `positions` of them sampled evenly), then every `every`-th of those is searched (1 = all).
//! One thread, one engine, budget 300 scaled by the config, RNG seeded as `p4_cost` seeds it. Per
//! position the row holds ms, iterations, nodes, initialised nodes, edges, the tree's heap bytes, the
//! best move and an FNV-1a digest of every ranked root move (move, visits, value bits), so two
//! binaries can be compared position by position. Run from the repo root.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::game::{GameState, recent_placements};
use blokee::position::SEAT_COLORS;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (moves_path, wanted, every, out, config) =
        (&argv[1], argv[2].parse::<usize>().unwrap(), argv[3].parse::<usize>().unwrap(), &argv[4], &argv[5]);
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(p)) => Some(Arc::new(RolloutPolicy::from_file(p).unwrap())),
        _ => None,
    };
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
    let jobs: Vec<_> = jobs.into_iter().step_by(step).take(wanted).enumerate().filter(|(i, _)| i % every == 0).collect();
    eprintln!("v55_speed: {} positions, config {config}", jobs.len());
    let mut engine = Engine::new(params, table).unwrap();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "pos,seed,ply,own_idx,ms,iterations,nodes,initialised,edges,tree_bytes,best,digest,depth_mean,depth_max").unwrap();
    for (i, (seed, prefix, seat, own)) in jobs {
        let mut state = GameState::new(false);
        for &mv in &prefix {
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
        let mut position = state.to_position();
        let mut rng = Rng::new((seed as u32) ^ (prefix.len() as u32).wrapping_mul(0x9e37_79b9));
        let mut stats = MoveStats::default();
        engine.set_recent(&recent_placements(&prefix));
        let started = Instant::now();
        let ranked = engine.search(&mut position, seat, 300, &mut rng, &mut stats);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let (nodes, init, edges, bytes) = engine.tree_memory().unwrap_or((0, 0, 0, 0));
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for r in &ranked {
            for x in [r.mv as u64, r.visits as u64, r.value.to_bits()] {
                for b in x.to_le_bytes() {
                    h ^= b as u64;
                    h = h.wrapping_mul(0x100_0000_01b3);
                }
            }
        }
        let best = ranked.first().map_or(-1, |r| r.mv);
        let (dm, dx) = engine.depth_stats().unwrap_or((0.0, 0));
        writeln!(w, "{i},{seed},{},{own},{ms:.3},{},{nodes},{init},{edges},{bytes},{best},{h:016x},{dm:.3},{dx}", prefix.len(), stats.iterations).unwrap();
        w.flush().unwrap();
    }
}
