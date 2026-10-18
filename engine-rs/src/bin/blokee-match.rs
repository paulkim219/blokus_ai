//! Native seat-rotated match runner for configs only the native engine can play (learned priors).
//!
//! Plays the same assignments as `scripts/tournament.ts` — each seed four times, the challenger
//! once in every seat against three champion seats, opening sampling from the top `k` for the
//! first plies — and writes the same JSONL. Score it with the TS statistic, never a re-derivation:
//!
//!   blokee-match --challenger a.json --champion configs/v4.1-ultra.json --seeds 100 \
//!       --seed-base 71234567 --budget 300 --label prior-b05 --out ../selfplay-results/m.jsonl
//!   npm run aggregate -- selfplay-results/m.jsonl
//!
//! The printed mean is only a progress indicator.

use blokee::config::BitboardParams;
use blokee::engine::Engine;
use blokee::game::{GameOptions, Policy, play_game};
use blokee::position::SEAT_COLORS;
use blokee::rollout_policy::RolloutPolicy;
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// `PLAYER_COLORS` — the display order the TS harness rotates the challenger through.
const DISPLAY: [&str; 4] = ["blue", "yellow", "purple", "green"];

fn arg(argv: &[String], name: &str, fallback: &str) -> String {
    argv.iter().position(|a| a == &format!("--{name}")).and_then(|i| argv.get(i + 1)).cloned().unwrap_or(fallback.to_string())
}

fn load(path: &str) -> (BitboardParams, Option<Arc<RolloutPolicy>>) {
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap();
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(p)) => {
            let found = [p.clone(), format!("../{p}")].into_iter().find(|c| std::path::Path::new(c).exists()).expect("rollout table not found");
            Some(Arc::new(RolloutPolicy::from_file(&found).unwrap()))
        }
        _ => None,
    };
    (params, table)
}

fn stem(path: &str) -> String {
    std::path::Path::new(path).file_stem().unwrap().to_string_lossy().to_string()
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let challenger_path = arg(&argv, "challenger", "");
    let champion_path = arg(&argv, "champion", "configs/v4.1-ultra.json");
    let seeds: u32 = arg(&argv, "seeds", "20").parse().unwrap();
    let seed_base: u32 = arg(&argv, "seed-base", "71234567").parse().unwrap();
    let budget: u32 = arg(&argv, "budget", "300").parse().unwrap();
    let default_threads = std::thread::available_parallelism().map(|n| n.get().saturating_sub(2).max(1)).unwrap_or(4);
    let threads: usize = arg(&argv, "threads", &default_threads.to_string()).parse().unwrap();
    let challenger_name = arg(&argv, "challenger-name", &stem(&challenger_path));
    let champion_name = arg(&argv, "champion-name", &stem(&champion_path));
    let label = arg(&argv, "label", &format!("{challenger_name}-vs-{champion_name}"));
    let out = arg(&argv, "out", &format!("../selfplay-results/match-native-{label}.jsonl"));
    let opening_random_plies: usize = arg(&argv, "opening-random-plies", "8").parse().unwrap();
    let opening_top_k: usize = arg(&argv, "opening-top-k", "3").parse().unwrap();
    let policy = Policy::parse(&arg(&argv, "policy", "mcts-bench")).unwrap();

    let challenger = load(&challenger_path);
    let champion = load(&champion_path);
    let assignments: Vec<(u32, usize)> = (0..seeds).flat_map(|i| (0..4).map(move |seat| (seed_base + i, seat))).collect();
    eprintln!("{label}: {} games ({seeds} seeds x 4 seats), {threads} threads, {budget} base iterations", assignments.len());

    let next = Arc::new(AtomicUsize::new(0));
    let log = Arc::new(Mutex::new(OpenOptions::new().create(true).append(true).open(&out).unwrap()));
    let advantages = Arc::new(Mutex::new(Vec::<f64>::new()));
    let started = Instant::now();
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let (next, log, advantages, assignments) = (Arc::clone(&next), Arc::clone(&log), Arc::clone(&advantages), assignments.clone());
            let (challenger, champion) = (challenger.clone(), champion.clone());
            let (label, challenger_name, champion_name) = (label.clone(), challenger_name.clone(), champion_name.clone());
            std::thread::spawn(move || {
                let mut pool = vec![
                    Engine::new(challenger.0, challenger.1).unwrap_or_else(|e| panic!("challenger: {e}")),
                    Engine::new(champion.0, champion.1).unwrap_or_else(|e| panic!("champion: {e}")),
                ];
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= assignments.len() {
                        break;
                    }
                    let (seed, display_seat) = assignments[i];
                    let color = DISPLAY[display_seat];
                    let challenger_seat = SEAT_COLORS.iter().position(|c| *c == color).unwrap();
                    let mut seat_engine = [1usize; 4];
                    seat_engine[challenger_seat] = 0;
                    let options = GameOptions {
                        seed,
                        opening_anywhere: false,
                        iteration_budget: Some(budget),
                        max_plies: usize::MAX,
                        opening_random_plies,
                        opening_top_k,
                    };
                    let record = play_game(&mut pool, seat_engine, [policy; 4], &options).unwrap();
                    let score_of = |c: &str| record.scores[SEAT_COLORS.iter().position(|s| *s == c).unwrap()];
                    let best = DISPLAY.iter().map(|c| score_of(c)).fold(f64::NEG_INFINITY, f64::max);
                    let scores: serde_json::Map<String, serde_json::Value> = DISPLAY.iter().map(|c| (c.to_string(), json!(score_of(c)))).collect();
                    let winner: Vec<&str> = DISPLAY.iter().copied().filter(|c| score_of(c) == best).collect();
                    let line = json!({
                        "seed": seed, "seat": color, "scores": scores, "winner": winner,
                        "label": label, "challenger": challenger_name, "champion": champion_name,
                    });
                    writeln!(log.lock().unwrap(), "{line}").unwrap();
                    let others: f64 = DISPLAY.iter().filter(|c| **c != color).map(|c| score_of(c)).sum::<f64>() / 3.0;
                    let mut adv = advantages.lock().unwrap();
                    adv.push(score_of(color) - others);
                    if adv.len() % 40 == 0 || adv.len() == assignments.len() {
                        let mean = adv.iter().sum::<f64>() / adv.len() as f64;
                        eprintln!("{}/{} games, running advantage {mean:+.2}, {:.1} min", adv.len(), assignments.len(), started.elapsed().as_secs_f64() / 60.0);
                    }
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    eprintln!("wrote {out}; score it with: npm run aggregate -- {out}");
}
