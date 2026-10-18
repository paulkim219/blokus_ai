//! Multi-threaded self-play data generator (experiment E1 of the v6 plan).
//!
//! Plays seeded games with one config in every seat, exactly as the match harness would, and
//! writes one fixed-size binary record per decision plus one JSON line per game. Unlike the v4
//! exporter (top-12 candidates from a 300-iteration teacher on ~400 games), each record keeps
//! *every* root child the search considered with its visit count, and runs are sized for tens of
//! thousands of games.
//!
//!   blokee-selfplay --config configs/v4.1-ultra.json --games 20000 --budget 300 \
//!       --threads 12 --seed-base 61000000 --out ../ml/data/selfplay-v41u
//!
//! Record layout (little-endian, 512 bytes) is written to `<out>/meta.json` alongside the shards.

use blokee::bitboard::WORDS;
use blokee::config::BitboardParams;
use blokee::engine::{Engine, Source};
use blokee::game::{Decision, GameOptions, Policy, play_game_observed};
use blokee::rollout_policy::RolloutPolicy;
use serde_json::json;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const RECORD_BYTES: usize = 512;
const MAX_CANDIDATES: usize = 64;

struct Args {
    config: String,
    games: u32,
    budget: u32,
    threads: usize,
    seed_base: u32,
    out: String,
    opening_random_plies: usize,
    opening_top_k: usize,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().collect();
    let get = |name: &str, fallback: &str| -> String {
        argv.iter().position(|a| a == &format!("--{name}")).and_then(|i| argv.get(i + 1)).cloned().unwrap_or(fallback.to_string())
    };
    let threads = std::thread::available_parallelism().map(|n| n.get().saturating_sub(2).max(1)).unwrap_or(4);
    Args {
        config: get("config", "configs/v4.1-ultra.json"),
        games: get("games", "100").parse().unwrap(),
        budget: get("budget", "300").parse().unwrap(),
        threads: get("threads", &threads.to_string()).parse().unwrap(),
        seed_base: get("seed-base", "61000000").parse().unwrap(),
        out: get("out", "selfplay-out"),
        opening_random_plies: get("opening-random-plies", "8").parse().unwrap(),
        opening_top_k: get("opening-top-k", "3").parse().unwrap(),
    }
}

fn encode(decision: &Decision, game: u32, out: &mut [u8; RECORD_BYTES]) {
    *out = [0; RECORD_BYTES];
    let board = &decision.state.board;
    out[0..4].copy_from_slice(&game.to_le_bytes());
    out[4..6].copy_from_slice(&(decision.ply as u16).to_le_bytes());
    out[6] = decision.seat as u8;
    out[7] = match decision.stats.source {
        Source::Search => 0,
        Source::Heuristic => 1,
        Source::Packer => 2,
        Source::Greedy => 3,
    };
    let mut at = 8;
    for seat in 0..4 {
        for w in 0..WORDS {
            out[at..at + 4].copy_from_slice(&board.own[seat][w].to_le_bytes());
            at += 4;
        }
    }
    for seat in 0..4 {
        out[at..at + 4].copy_from_slice(&board.hand[seat].to_le_bytes());
        at += 4;
    }
    for seat in 0..4 {
        out[at] = board.last_piece[seat] as i8 as u8;
        at += 1;
    }
    debug_assert_eq!(at, 236);
    let n = decision.ranked.len().min(MAX_CANDIDATES);
    out[236] = n as u8;
    out[238..240].copy_from_slice(&(decision.chosen as u16).to_le_bytes());
    for (i, r) in decision.ranked.iter().take(n).enumerate() {
        out[240 + 2 * i..242 + 2 * i].copy_from_slice(&(r.mv as u16).to_le_bytes());
        out[368 + 2 * i..370 + 2 * i].copy_from_slice(&(r.visits.clamp(0, u16::MAX as i32) as u16).to_le_bytes());
    }
    let value = decision.ranked.first().map_or(0.0, |r| r.value) as f32;
    out[496..500].copy_from_slice(&value.to_le_bytes());
    out[500..504].copy_from_slice(&decision.stats.iterations.to_le_bytes());
}

fn main() {
    let args = parse_args();
    let params: BitboardParams =
        serde_json::from_str(&std::fs::read_to_string(&args.config).unwrap_or_else(|e| panic!("{}: {e}", args.config))).unwrap();
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(path)) => {
            // Artifact paths in configs are relative to the repo root.
            let candidates = [path.clone(), format!("../{path}")];
            let found = candidates.iter().find(|p| std::path::Path::new(p).exists()).unwrap_or_else(|| panic!("rollout table {path} not found"));
            Some(Arc::new(RolloutPolicy::from_file(found).unwrap()))
        }
        _ => None,
    };
    // Fail before spawning threads if the config is unsupported.
    Engine::new(params.clone(), table.clone()).unwrap_or_else(|e| panic!("{e}"));
    std::fs::create_dir_all(&args.out).unwrap();
    std::fs::write(
        format!("{}/meta.json", args.out),
        serde_json::to_string_pretty(&json!({
            "config": args.config,
            "budget": args.budget,
            "seedBase": args.seed_base,
            "games": args.games,
            "openingRandomPlies": args.opening_random_plies,
            "openingTopK": args.opening_top_k,
            "recordBytes": RECORD_BYTES,
            "layout": {
                "game": [0, "u32"], "ply": [4, "u16"], "seat": [6, "u8"],
                "source": [7, "u8 (0 search, 1 opening heuristic, 2 packer, 3 greedy)"],
                "own": [8, "4 x 13 u32 bitboards, seats in turn order (blue, green, purple, yellow)"],
                "hand": [216, "4 x u32 piece masks"], "lastPiece": [232, "4 x i8"],
                "candidates": [236, "u8"], "chosen": [238, "u16 placement id"],
                "moves": [240, "64 x u16 placement ids, best first"], "visits": [368, "64 x u16"],
                "rootValue": [496, "f32, squares"], "iterations": [500, "u32"],
            },
        }))
        .unwrap(),
    )
    .unwrap();

    let next = Arc::new(AtomicU32::new(0));
    let games_log = Arc::new(Mutex::new(BufWriter::new(File::create(format!("{}/games.jsonl", args.out)).unwrap())));
    let started = Instant::now();
    let done = Arc::new(AtomicU32::new(0));
    let handles: Vec<_> = (0..args.threads)
        .map(|thread| {
            let (next, games_log, done, params, table) =
                (Arc::clone(&next), Arc::clone(&games_log), Arc::clone(&done), params.clone(), table.clone());
            let (out, games, budget, seed_base) = (args.out.clone(), args.games, args.budget, args.seed_base);
            let (orp, otk) = (args.opening_random_plies, args.opening_top_k);
            std::thread::spawn(move || {
                let mut pool = vec![Engine::new(params, table).unwrap()];
                let mut shard = BufWriter::new(File::create(format!("{out}/shard-{thread:02}.bin")).unwrap());
                let mut record = [0u8; RECORD_BYTES];
                loop {
                    let game = next.fetch_add(1, Ordering::Relaxed);
                    if game >= games {
                        break;
                    }
                    let seed = seed_base + game;
                    let options = GameOptions {
                        seed,
                        opening_anywhere: false,
                        iteration_budget: Some(budget),
                        max_plies: usize::MAX,
                        opening_random_plies: orp,
                        opening_top_k: otk,
                    };
                    let mut buffer: Vec<u8> = Vec::with_capacity(90 * RECORD_BYTES);
                    let result = play_game_observed(&mut pool, [0; 4], [Policy::Search; 4], &options, &mut |d| {
                        encode(&d, game, &mut record);
                        buffer.extend_from_slice(&record);
                    })
                    .unwrap();
                    shard.write_all(&buffer).unwrap();
                    let line = json!({
                        "game": game, "seed": seed, "plies": result.plies, "finished": result.finished,
                        "scores": result.scores, "iterations": result.iterations,
                    });
                    writeln!(games_log.lock().unwrap(), "{line}").unwrap();
                    let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if finished % 50 == 0 || finished == games {
                        let secs = started.elapsed().as_secs_f64();
                        eprintln!("{finished}/{games} games, {:.0} games/hour", finished as f64 / secs * 3600.0);
                    }
                }
                shard.flush().unwrap();
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    games_log.lock().unwrap().flush().unwrap();
    eprintln!("done in {:.1} min", started.elapsed().as_secs_f64() / 60.0);
}
