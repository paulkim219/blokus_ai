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
//!
//! Hybrid H1: `--format v3` writes record format v3 instead (`blokee::record_v3`): every legal move
//! with its real root visits and prior, the root's mean value for all four seats, and the game's
//! final scores, in `<out>/v3-shard-XX.bin`; `games.jsonl` lines then also carry the game's moves
//! (placement ids per ply, −1 for a pass). Without the flag (`--format v2`, the default) every output
//! is byte-identical to before.

use blokee::bitboard::WORDS;
use blokee::config::BitboardParams;
use blokee::engine::{Engine, Source};
use blokee::game::{Decision, GameOptions, Policy, play_game_observed};
use blokee::placements::PIECE_COUNT;
use blokee::position::new_move_buffer;
use blokee::record_v3::{self, RecordV3};
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
    v3: bool,
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
        v3: match &get("format", "v2")[..] {
            "v2" => false,
            "v3" => true,
            other => panic!("--format must be v2 or v3, not {other}"),
        },
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

/// Record format v3 of one decision (final scores are patched in when the game ends). Every legal
/// move is listed: the root's moves first in tree order with their real visits and priors, then any
/// legal move the root did not hold (none with `native.candidates.rootFull`) with 0 and 0.
fn encode_v3(decision: &Decision, game: u32, seed: u32, buffer: &mut Vec<i32>) -> RecordV3 {
    let board = &decision.state.board;
    let seat = decision.seat;
    let source = match decision.stats.source {
        Source::Search => record_v3::SOURCE_SEARCH,
        Source::Heuristic => record_v3::SOURCE_HEURISTIC,
        Source::Packer => record_v3::SOURCE_PACKER,
        Source::Greedy => record_v3::SOURCE_GREEDY,
    };
    let mut position = decision.state.to_position();
    position.force_turn(seat);
    let legal = position.generate_moves(seat, buffer, usize::MAX);
    let (mut moves, mut visits, mut priors) = (Vec::with_capacity(legal), Vec::with_capacity(legal), Vec::with_capacity(legal));
    let mut root_visits = 0u32;
    let mut root_values = [f32::NAN; 4];
    let snapshot = if source == record_v3::SOURCE_SEARCH { decision.engine.root_snapshot() } else { None };
    if let Some(snap) = &snapshot {
        for i in 0..snap.moves.len() {
            moves.push(snap.moves[i] as u16);
            visits.push(snap.visits[i].max(0) as u32);
            priors.push(snap.priors[i] as f32);
        }
        root_visits = snap.root_visits as u32;
        root_values = snap.root_values.map(|v| v as f32);
    }
    let listed: std::collections::HashSet<u16> = moves.iter().copied().collect();
    for &m in &buffer[..legal] {
        if !listed.contains(&(m as u16)) {
            moves.push(m as u16);
            visits.push(0);
            priors.push(0.0);
        }
    }
    assert_eq!(moves.len(), legal, "record v3: root moves are not a subset of the legal moves (game {game} ply {})", decision.ply);
    assert!(moves.contains(&(decision.chosen as u16)), "record v3: chosen move not legal");
    RecordV3 {
        game,
        ply: decision.ply as u16,
        seat: seat as u8,
        source,
        own: board.own,
        hand: board.hand,
        last_piece: board.last_piece.map(|p| p as i8),
        chosen: decision.chosen as u16,
        iterations: decision.stats.iterations,
        root_visits,
        root_values,
        final_scores: [0.0; 4],
        teacher: 0,
        own_moves: (PIECE_COUNT as u32 - board.hand[seat].count_ones()) as u8,
        seed,
        moves,
        visits,
        priors,
    }
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
    if args.v3 {
        std::fs::write(
            format!("{}/meta.json", args.out),
            serde_json::to_string_pretty(&json!({
                "config": args.config,
                "budget": args.budget,
                "seedBase": args.seed_base,
                "games": args.games,
                "openingRandomPlies": args.opening_random_plies,
                "openingTopK": args.opening_top_k,
                "format": "v3",
                "shards": "v3-shard-XX.bin",
                "layout": RecordV3::layout_json(),
            }))
            .unwrap(),
        )
        .unwrap();
    } else {
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
    }

    let next = Arc::new(AtomicU32::new(0));
    let games_log = Arc::new(Mutex::new(BufWriter::new(File::create(format!("{}/games.jsonl", args.out)).unwrap())));
    let started = Instant::now();
    let done = Arc::new(AtomicU32::new(0));
    let handles: Vec<_> = (0..args.threads)
        .map(|thread| {
            let (next, games_log, done, params, table) =
                (Arc::clone(&next), Arc::clone(&games_log), Arc::clone(&done), params.clone(), table.clone());
            let (out, games, budget, seed_base) = (args.out.clone(), args.games, args.budget, args.seed_base);
            let (orp, otk, v3) = (args.opening_random_plies, args.opening_top_k, args.v3);
            std::thread::spawn(move || {
                let mut pool = vec![Engine::new(params, table).unwrap()];
                let shard_name = if v3 { format!("{out}/v3-shard-{thread:02}.bin") } else { format!("{out}/shard-{thread:02}.bin") };
                let mut shard = BufWriter::new(File::create(shard_name).unwrap());
                let mut record = [0u8; RECORD_BYTES];
                let mut legal_buffer = new_move_buffer();
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
                        opening_fixed_seat: None,
                    };
                    let mut buffer: Vec<u8> = Vec::with_capacity(90 * RECORD_BYTES);
                    let mut starts: Vec<usize> = Vec::new();
                    let result = play_game_observed(&mut pool, [0; 4], [Policy::Search; 4], &options, &mut |d| {
                        if v3 {
                            starts.push(buffer.len());
                            encode_v3(&d, game, seed, &mut legal_buffer).encode(&mut buffer);
                        } else {
                            encode(&d, game, &mut record);
                            buffer.extend_from_slice(&record);
                        }
                    })
                    .unwrap();
                    for &at in &starts {
                        RecordV3::patch_scores(&mut buffer, at, &result.scores);
                    }
                    shard.write_all(&buffer).unwrap();
                    let line = if v3 {
                        json!({
                            "game": game, "seed": seed, "plies": result.plies, "finished": result.finished,
                            "scores": result.scores, "iterations": result.iterations, "moves": result.moves,
                        })
                    } else {
                        json!({
                            "game": game, "seed": seed, "plies": result.plies, "finished": result.finished,
                            "scores": result.scores, "iterations": result.iterations,
                        })
                    };
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
