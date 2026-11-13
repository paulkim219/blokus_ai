//! P6/P7/P8 diagnostics (no strength claims).
//!
//!   p67_probe reuse <moves.jsonl> <config.json> <games> <out.csv>
//!   p67_probe stats <moves.jsonl> <positions> <out.csv> <config.json>...
//!
//! `reuse` (P8): replays `blokee-pentobi --moves-out` games of the lone Blokee seat exactly as the
//! bridge played them — one engine, one RNG stream seeded with the game seed and consumed by the
//! lone seat's searches in game order, the same recent placements — and checks that every searched
//! move reproduces the recorded one. Before each of the seat's decisions it asks the engine how many
//! visits the tree of the seat's previous decision holds at the position now on the board (found by
//! its hash; 0 when that tree has no node there), i.e. what subtree reuse would have carried over.
//! One CSV row per decision: seed, seat, ply, own move index, source, previous search's iterations,
//! the reusable visits, this search's iterations, whether the move reproduced.
//!
//! `stats` (P6/P7): on the lone seat's positions at own moves 3–20 (sampled evenly, as `p4_cost`),
//! each config searches at budget 300 with the same RNG seed; one row per (position, config) with
//! the root's edge count, edges with real visits, edges with AMAF updates, the mean and median AMAF
//! weight of the edges without a real visit, and the reply table's (asked, supplied) counts.
//! Run from the repo root.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats, Source};
use blokee::game::{GameState, recent_placements};
use blokee::position::SEAT_COLORS;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use std::io::Write;
use std::sync::Arc;

fn load(path: &str) -> Engine {
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(p)) => Some(Arc::new(RolloutPolicy::from_file(p).unwrap())),
        _ => None,
    };
    Engine::new(params, table).unwrap()
}

struct Game {
    seed: u32,
    lone: usize,
    moves: Vec<i32>,
}

fn games(path: &str) -> Vec<Game> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            Game {
                seed: v["seed"].as_u64().unwrap() as u32,
                lone: SEAT_COLORS.iter().position(|c| *c == v["seat"].as_str().unwrap()).unwrap(),
                moves: v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect(),
            }
        })
        .collect()
}

fn reuse(argv: &[String]) {
    let (moves_path, config, wanted, out) = (&argv[2], &argv[3], argv[4].parse::<usize>().unwrap(), &argv[5]);
    let mut all = games(moves_path);
    all.sort_by_key(|g| (g.seed, g.lone));
    let step = (all.len() / wanted).max(1);
    let chosen: Vec<&Game> = all.iter().step_by(step).take(wanted).collect();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "seed,seat,ply,own_idx,source,prev_iterations,visits_d1,visits_d2,visits_d3,reusable_visits,iterations,reproduced").unwrap();
    let (mut searched, mut reproduced) = (0, 0);
    for g in &chosen {
        // A fresh engine per game; the bridge reuses one per thread, but every search starts from a
        // cleared tree, so the decisions are the same (checked below).
        let mut engine = load(config);
        let mut rng = Rng::new(g.seed);
        let mut state = GameState::new(false);
        // Visits of the previous own tree at the positions after each later ply (depth 1, 2, 3).
        let mut line: Vec<String> = Vec::new();
        for (ply, &mv) in g.moves.iter().enumerate() {
            let seat = state.turn;
            if seat == g.lone && mv >= 0 {
                let mut position = state.to_position();
                let probe = engine.reuse_probe(&position);
                while line.len() < 3 {
                    line.push(String::new());
                }
                engine.set_recent(&recent_placements(&g.moves[..ply]));
                let mut stats = MoveStats::default();
                let ranked = engine.search(&mut position, seat, 300, &mut rng, &mut stats);
                let own = 21 - state.board.hand[seat].count_ones();
                let source = match stats.source {
                    Source::Search => "search",
                    Source::Heuristic => "heuristic",
                    Source::Packer => "packer",
                    Source::Greedy => "greedy",
                };
                // The bridge samples among the top 3 on plies < 8; after that it plays the top move.
                let same = if stats.source == Source::Search && ply >= 8 { (ranked.first().map(|r| r.mv) == Some(mv)) as i32 } else { -1 };
                if same >= 0 {
                    searched += 1;
                    reproduced += same;
                }
                let (visits, prev) = probe.map_or((String::new(), String::new()), |(v, i)| (format!("{v}"), format!("{i}")));
                writeln!(w, "{},{},{ply},{own},{source},{prev},{},{visits},{},{same}", g.seed, SEAT_COLORS[seat], line[..3].join(","), stats.iterations).unwrap();
                line.clear();
                if mv >= 0 { state.apply(mv) } else { state.pass() }
                if let Some((v, _)) = engine.reuse_probe(&state.to_position()) {
                    line.push(format!("{v}"));
                }
                continue;
            }
            if mv >= 0 { state.apply(mv) } else { state.pass() }
            if !line.is_empty() && line.len() < 3 {
                line.push(engine.reuse_probe(&state.to_position()).map_or(String::new(), |(v, _)| format!("{v}")));
            }
        }
    }
    eprintln!("p67_probe reuse: {} games, {searched} searched moves after ply 8, {reproduced} reproduced the recorded move; wrote {out}", chosen.len());
}

fn stats(argv: &[String]) {
    let (moves_path, wanted, out) = (&argv[2], argv[3].parse::<usize>().unwrap(), &argv[4]);
    let configs: Vec<String> = argv[5..].to_vec();
    let mut engines: Vec<Engine> = configs.iter().map(|c| load(c)).collect();
    let mut jobs: Vec<(u32, Vec<i32>, usize, u32)> = Vec::new();
    for g in games(moves_path) {
        let mut state = GameState::new(false);
        for (ply, &mv) in g.moves.iter().enumerate() {
            let seat = state.turn;
            if seat == g.lone && mv >= 0 {
                let own = 21 - state.board.hand[seat].count_ones();
                if (3..=20).contains(&own) {
                    jobs.push((g.seed, g.moves[..ply].to_vec(), seat, own));
                }
            }
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
    }
    let step = (jobs.len() / wanted).max(1);
    let jobs: Vec<_> = jobs.into_iter().step_by(step).take(wanted).collect();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "pos,seed,own_idx,config,iterations,edges,visited,amaf_edges,unvisited_amaf_mean,unvisited_amaf_median,lgr_asked,lgr_supplied").unwrap();
    for (i, (seed, prefix, seat, own)) in jobs.iter().enumerate() {
        let mut state = GameState::new(false);
        for &mv in prefix {
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
        for (k, engine) in engines.iter_mut().enumerate() {
            let before = engine.reply_stats().unwrap_or((0, 0));
            let mut position = state.to_position();
            let mut rng = Rng::new(*seed ^ (prefix.len() as u32).wrapping_mul(0x9e37_79b9));
            let mut st = MoveStats::default();
            engine.set_recent(&recent_placements(prefix));
            engine.search(&mut position, *seat, 300, &mut rng, &mut st);
            let after = engine.reply_stats().unwrap_or((0, 0));
            let Some(edges) = engine.root_edge_stats() else { continue };
            let visited = edges.iter().filter(|e| e.0 > 0).count();
            let amaf_edges = edges.iter().filter(|e| e.1 > 0.0).count();
            let mut unvisited: Vec<f64> = edges.iter().filter(|e| e.0 == 0).map(|e| e.1).collect();
            unvisited.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let mean = if unvisited.is_empty() { f64::NAN } else { unvisited.iter().sum::<f64>() / unvisited.len() as f64 };
            let median = if unvisited.is_empty() { f64::NAN } else { unvisited[unvisited.len() / 2] };
            writeln!(
                w,
                "{i},{seed},{own},{k},{},{},{visited},{amaf_edges},{mean:.3},{median:.3},{},{}",
                st.iterations,
                edges.len(),
                after.0 - before.0,
                after.1 - before.1
            )
            .unwrap();
        }
    }
    eprintln!("p67_probe stats: {} positions, configs: {}; wrote {out}", jobs.len(), configs.join(" "));
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    match argv.get(1).map(String::as_str) {
        Some("reuse") => reuse(&argv),
        Some("stats") => stats(&argv),
        _ => {
            eprintln!("usage: p67_probe reuse <moves.jsonl> <config> <games> <out.csv> | stats <moves.jsonl> <positions> <out.csv> <config>...");
            std::process::exit(2);
        }
    }
}
