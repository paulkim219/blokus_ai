//! X1: Blokee against Pentobi through Pentobi's GTP engine (`pentobi-gtp`, run as a subprocess).
//!
//! Seat-rotated like `blokee-match`: each seed four times, the lone challenger once in every seat.
//! `--mode one-blokee` puts one Blokee seat against three Pentobi seats; `--mode one-pentobi` one
//! Pentobi seat against three Blokee seats. One `pentobi-gtp` process per game plays every Pentobi
//! colour and receives every Blokee move with `play`. Blokee seats search and choose exactly as the
//! match harness does (first 8 plies sampled from the top 3). The JSONL is blokee-match's, scored
//! by Blokee's own rules; score it with `npx tsx scripts/aggregateMatches.ts <out>` only.
//!
//!   blokee-pentobi --blokee engine-rs/configs/v4.2-ultra.json \
//!       --pentobi ~/src/pentobi-build/pentobi_gtp/pentobi-gtp \
//!       --book ~/src/pentobi/opening_books/book_classic.blksgf \
//!       --level 9 --mode one-blokee --seeds 100 --seed-base 79000000 --budget 300 --threads 5 \
//!       --label x1a --out tmp/x1/x1a.jsonl
//!
//! Any rules disagreement (a move Pentobi rejects, a pass while the other side has a move,
//! different legal-move sets, different final scores) hard-fails that game: it is reported on
//! stderr and in `<out>.failures.jsonl` and never written to `<out>`. Runs resume: seed/seat
//! pairs already in `<out>` are skipped. Per-move wall-clock for both engines goes to
//! `<out>.timing.jsonl`.
//!
//! `--moves-out <file>` (optional) also appends one JSONL line per scored game with the seed, the
//! lone challenger's display seat, which engine sat in each seat (turn order blue, green, purple,
//! yellow) and the full move sequence (placement ids, -1 for a pass). It is written alongside
//! `<out>` and never read back, so a resumed run only adds the games it actually plays.
//!
//! `--validate <n>` is the validity gate instead of a match: n complete Blokee self-play games
//! (the `--blokee` config, seeds from `--seed-base`) replayed into Pentobi with the full legal-move
//! sets compared before every ply, then one game with Pentobi in all four seats through the bridge.

use blokee::config::BitboardParams;
use blokee::engine::Engine;
use blokee::game::{GameOptions, Policy, play_game};
use blokee::gtp::{Gtp, Mapping, Player, play_bridge_game, ranks, replay_into_gtp};
use blokee::position::SEAT_COLORS;
use blokee::rollout_policy::RolloutPolicy;
use serde_json::json;
use std::collections::HashSet;
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

fn flag(argv: &[String], name: &str) -> bool {
    argv.iter().any(|a| a == &format!("--{name}"))
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

fn expand_home(path: &str) -> String {
    match (path.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) => format!("{home}/{rest}"),
        _ => path.to_string(),
    }
}

struct PentobiSpec {
    program: String,
    level: u32,
    book: Option<String>,
}

impl PentobiSpec {
    fn args(&self, seed: u32) -> Vec<String> {
        let mut args: Vec<String> = ["--game", "classic", "--level", &self.level.to_string(), "--seed", &seed.to_string(), "--threads", "1", "--noresign", "--quiet"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        match &self.book {
            Some(book) => args.extend(["--book".to_string(), book.clone()]),
            None => args.push("--nobook".to_string()),
        }
        args
    }

    fn spawn(&self, seed: u32) -> Result<Gtp, String> {
        Gtp::spawn(&self.program, &self.args(seed))
    }

    fn version(&self) -> String {
        std::process::Command::new(&self.program)
            .arg("--version")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|e| format!("unknown ({e})"))
    }
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() { f64::NAN } else { v.iter().sum::<f64>() / v.len() as f64 }
}

fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = s.len();
    if n % 2 == 1 { s[n / 2] } else { (s[n / 2 - 1] + s[n / 2]) / 2.0 }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let blokee_path = arg(&argv, "blokee", "engine-rs/configs/v4.2-ultra.json");
    let spec = Arc::new(PentobiSpec {
        program: expand_home(&arg(&argv, "pentobi", "~/src/pentobi-build/pentobi_gtp/pentobi-gtp")),
        level: arg(&argv, "level", "9").parse().unwrap(),
        book: if flag(&argv, "nobook") { None } else { Some(expand_home(&arg(&argv, "book", "~/src/pentobi/opening_books/book_classic.blksgf"))) },
    });
    if let Some(book) = &spec.book {
        assert!(std::path::Path::new(book).exists(), "opening book {book} not found (pass --book <file> or --nobook)");
    }
    let budget: u32 = arg(&argv, "budget", "300").parse().unwrap();
    let seed_base: u32 = arg(&argv, "seed-base", "79000000").parse().unwrap();
    let threads: usize = arg(&argv, "threads", "4").parse().unwrap();
    let opening_random_plies: usize = arg(&argv, "opening-random-plies", "8").parse().unwrap();
    let opening_top_k: usize = arg(&argv, "opening-top-k", "3").parse().unwrap();
    let check_legal = !flag(&argv, "no-legal-check");
    let version = spec.version();
    let options = move |seed: u32| GameOptions {
        seed,
        opening_anywhere: false,
        iteration_budget: Some(budget),
        max_plies: usize::MAX,
        opening_random_plies,
        opening_top_k,
    };

    // Discover the board mapping once, on a fresh engine.
    let (mapping, report) = {
        let mut probe = spec.spawn(1).unwrap_or_else(|e| panic!("{e}"));
        Mapping::discover(&mut probe).unwrap_or_else(|e| panic!("mapping discovery failed: {e}"))
    };
    eprintln!("{version} at {} (args: {})", spec.program, spec.args(0).join(" "));
    eprint!("{report}");
    let mapping = Arc::new(mapping);
    let blokee = load(&blokee_path);

    if let Some(n) = argv.iter().position(|a| a == "--validate").and_then(|i| argv.get(i + 1)) {
        let n: u32 = n.parse().unwrap();
        std::process::exit(validate(n, seed_base, threads, &blokee, &spec, &mapping, &options));
    }

    let seeds: u32 = arg(&argv, "seeds", "10").parse().unwrap();
    let mode = arg(&argv, "mode", "one-blokee");
    let one_blokee = match &mode[..] {
        "one-blokee" => true,
        "one-pentobi" => false,
        other => panic!("--mode must be one-blokee or one-pentobi, not {other}"),
    };
    let blokee_name = arg(&argv, "blokee-name", &stem(&blokee_path));
    let pentobi_name = format!("pentobi-{}-L{}", version.trim_start_matches("Pentobi ").replace(' ', "_"), spec.level);
    let (challenger_name, champion_name) = if one_blokee { (blokee_name.clone(), pentobi_name.clone()) } else { (pentobi_name.clone(), blokee_name.clone()) };
    let label = arg(&argv, "label", &format!("{challenger_name}-vs-{champion_name}"));
    let out = arg(&argv, "out", &format!("tmp/x1/{label}.jsonl"));
    let timing_out = format!("{}.timing.jsonl", out.trim_end_matches(".jsonl"));
    let failures_out = format!("{}.failures.jsonl", out.trim_end_matches(".jsonl"));
    let moves_out: Option<String> = argv.iter().position(|a| a == "--moves-out").and_then(|i| argv.get(i + 1)).cloned();
    for path in std::iter::once(&out).chain(moves_out.iter()) {
        if let Some(dir) = std::path::Path::new(path).parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir).unwrap();
            }
        }
    }
    let moves_log: Option<Arc<Mutex<std::fs::File>>> =
        moves_out.as_ref().map(|p| Arc::new(Mutex::new(OpenOptions::new().create(true).append(true).open(p).unwrap_or_else(|e| panic!("{p}: {e}")))));

    // Resume: skip seed/seat pairs already logged.
    let mut done: HashSet<(u32, String)> = HashSet::new();
    if let Ok(text) = std::fs::read_to_string(&out) {
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("{out}: unreadable line ({e}): {line}"));
            if v["label"].as_str() != Some(&label[..]) {
                panic!("{out} holds games labelled {:?}, not {label}; refusing to mix runs", v["label"]);
            }
            done.insert((v["seed"].as_u64().unwrap() as u32, v["seat"].as_str().unwrap().to_string()));
        }
    }
    let assignments: Vec<(u32, usize)> = (0..seeds)
        .flat_map(|i| (0..4).map(move |seat| (seed_base + i, seat)))
        .filter(|(seed, seat)| !done.contains(&(*seed, DISPLAY[*seat].to_string())))
        .collect();
    eprintln!(
        "{label}: {mode}, {} at level {}, {} of {} games to play ({} already in {out}), {threads} threads, budget {budget}",
        version,
        spec.level,
        assignments.len(),
        seeds * 4,
        done.len()
    );

    let next = Arc::new(AtomicUsize::new(0));
    let log = Arc::new(Mutex::new(OpenOptions::new().create(true).append(true).open(&out).unwrap()));
    let timing = Arc::new(Mutex::new(OpenOptions::new().create(true).append(true).open(&timing_out).unwrap()));
    let failures = Arc::new(Mutex::new(Vec::<String>::new()));
    // (advantages, blokee ms, pentobi ms)
    let tally = Arc::new(Mutex::new((Vec::<f64>::new(), Vec::<f64>::new(), Vec::<f64>::new())));
    let started = Instant::now();
    let total = assignments.len();
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let (next, log, timing, failures, tally) = (Arc::clone(&next), Arc::clone(&log), Arc::clone(&timing), Arc::clone(&failures), Arc::clone(&tally));
            let (assignments, blokee, spec, mapping) = (assignments.clone(), blokee.clone(), Arc::clone(&spec), Arc::clone(&mapping));
            let (label, challenger_name, champion_name, failures_out) = (label.clone(), challenger_name.clone(), champion_name.clone(), failures_out.clone());
            let moves_log = moves_log.clone();
            std::thread::spawn(move || {
                let mut pool = vec![Engine::new(blokee.0, blokee.1).unwrap_or_else(|e| panic!("blokee: {e}"))];
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= assignments.len() {
                        break;
                    }
                    let (seed, display_seat) = assignments[i];
                    let color = DISPLAY[display_seat];
                    let challenger_seat = SEAT_COLORS.iter().position(|c| *c == color).unwrap();
                    let (lone, rest) = if one_blokee { (Player::Blokee(0), Player::Gtp) } else { (Player::Gtp, Player::Blokee(0)) };
                    let mut players = [rest; 4];
                    players[challenger_seat] = lone;
                    let game_started = Instant::now();
                    let result = spec.spawn(seed).and_then(|mut gtp| play_bridge_game(&mut pool, players, &options(seed), &mut gtp, &mapping, check_legal));
                    let record = match result {
                        Ok(r) => r,
                        Err(e) => {
                            eprintln!("HARD FAIL seed {seed} seat {color}: {e}");
                            let line = json!({"seed": seed, "seat": color, "label": label, "error": e});
                            let mut f = OpenOptions::new().create(true).append(true).open(&failures_out).unwrap();
                            writeln!(f, "{line}").unwrap();
                            failures.lock().unwrap().push(format!("{seed}/{color}: {e}"));
                            continue;
                        }
                    };
                    let score_of = |c: &str| record.scores[SEAT_COLORS.iter().position(|s| *s == c).unwrap()];
                    let best = DISPLAY.iter().map(|c| score_of(c)).fold(f64::NEG_INFINITY, f64::max);
                    let scores: serde_json::Map<String, serde_json::Value> = DISPLAY.iter().map(|c| (c.to_string(), json!(score_of(c)))).collect();
                    let winner: Vec<&str> = DISPLAY.iter().copied().filter(|c| score_of(c) == best).collect();
                    let mut blokee_ms = Vec::new();
                    let mut pentobi_ms = Vec::new();
                    for seat in 0..4 {
                        match players[seat] {
                            Player::Blokee(_) => blokee_ms.extend(&record.move_ms[seat]),
                            Player::Gtp => pentobi_ms.extend(&record.move_ms[seat]),
                        }
                    }
                    let challenger_secs: f64 = record.move_ms[challenger_seat].iter().sum::<f64>() / 1000.0;
                    let line = json!({
                        "seed": seed, "seat": color, "scores": scores, "winner": winner,
                        "label": label, "challenger": challenger_name, "champion": champion_name,
                        "challengerMoves": record.move_ms[challenger_seat].len(),
                        "challengerSeconds": (challenger_secs * 1000.0).round() / 1000.0,
                        "pentobiLevel": spec.level,
                    });
                    let round = |v: &Vec<f64>| v.iter().map(|x| (x * 10.0).round() / 10.0).collect::<Vec<f64>>();
                    let timing_line = json!({
                        "seed": seed, "seat": color, "label": label,
                        "gameSeconds": (game_started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                        "blokeeMs": round(&blokee_ms), "pentobiMs": round(&pentobi_ms),
                        "msBySeat": SEAT_COLORS.iter().enumerate().map(|(s, c)| (c.to_string(), json!(round(&record.move_ms[s])))).collect::<serde_json::Map<_, _>>(),
                        "pentobiPoints": record.gtp_points, "legalChecks": record.legal_checks, "plies": record.plies,
                    });
                    writeln!(log.lock().unwrap(), "{line}").unwrap();
                    writeln!(timing.lock().unwrap(), "{timing_line}").unwrap();
                    if let Some(moves_log) = &moves_log {
                        let engines: Vec<&str> = players.iter().map(|p| if matches!(p, Player::Blokee(_)) { "blokee" } else { "pentobi" }).collect();
                        let moves_line = json!({
                            "seed": seed, "seat": color, "label": label,
                            "seatOrder": SEAT_COLORS, "engines": engines,
                            "scores": scores, "moves": record.moves,
                        });
                        writeln!(moves_log.lock().unwrap(), "{moves_line}").unwrap();
                    }
                    let others: f64 = DISPLAY.iter().filter(|c| **c != color).map(|c| score_of(c)).sum::<f64>() / 3.0;
                    let mut t = tally.lock().unwrap();
                    t.0.push(score_of(color) - others);
                    t.1.extend(blokee_ms);
                    t.2.extend(pentobi_ms);
                    let n = t.0.len();
                    if n % 4 == 0 || n == total {
                        let elapsed = started.elapsed().as_secs_f64() / 60.0;
                        eprintln!(
                            "{n}/{total} games, challenger advantage {:+.2} (progress only), ms/move blokee {:.0} pentobi {:.0}, {elapsed:.1} min, ETA {:.0} min",
                            mean(&t.0),
                            mean(&t.1),
                            mean(&t.2),
                            elapsed * (total - n) as f64 / n as f64
                        );
                    }
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let t = tally.lock().unwrap();
    eprintln!(
        "wall ms/move: blokee mean {:.1} median {:.1} over {} moves; pentobi mean {:.1} median {:.1} over {} moves",
        mean(&t.1),
        median(&t.1),
        t.1.len(),
        mean(&t.2),
        median(&t.2),
        t.2.len()
    );
    let failures = failures.lock().unwrap();
    if !failures.is_empty() {
        eprintln!("{} HARD FAILURES (not in {out}; details in {failures_out}):", failures.len());
        for f in failures.iter() {
            eprintln!("  {f}");
        }
        eprintln!("wrote {out}");
        std::process::exit(1);
    }
    eprintln!("wrote {out}; score it with: npx tsx scripts/aggregateMatches.ts {out}");
}

/// The validity gate. Returns the process exit code: 0 only if everything agreed.
fn validate(
    n: u32,
    seed_base: u32,
    threads: usize,
    blokee: &(BitboardParams, Option<Arc<RolloutPolicy>>),
    spec: &Arc<PentobiSpec>,
    mapping: &Arc<Mapping>,
    options: &(dyn Fn(u32) -> GameOptions + Sync),
) -> i32 {
    let started = Instant::now();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(u32, Result<String, String>)>> = Mutex::new(Vec::new());
    // The Pentobi-vs-Pentobi game runs alongside the replays.
    let pvp: Mutex<Option<Result<String, String>>> = Mutex::new(None);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let seed = seed_base + 9_999;
            let outcome = spec.spawn(seed).and_then(|mut gtp| {
                let record = play_bridge_game(&mut Vec::<Engine>::new(), [Player::Gtp; 4], &options(seed), &mut gtp, mapping, true)?;
                let blokee_rank = ranks(&record.scores);
                let pentobi_rank = ranks(&record.gtp_points);
                if blokee_rank != pentobi_rank {
                    return Err(format!("rank order differs: bridge {blokee_rank:?}, pentobi {pentobi_rank:?}"));
                }
                let moves = record.moves.iter().filter(|&&m| m >= 0).count();
                Ok(format!(
                    "seed {seed}: {} plies ({moves} moves), {} legal-set checks; bridge scores (blue, green, purple, yellow) {:?}; pentobi final_score per seat {:?}; ranks agree {:?}; pentobi ms/move per seat {:?}; {:.1} min",
                    record.plies,
                    record.legal_checks,
                    record.scores,
                    record.gtp_points,
                    blokee_rank,
                    record.move_ms.iter().map(|v| mean(v).round()).collect::<Vec<_>>(),
                    started.elapsed().as_secs_f64() / 60.0
                ))
            });
            *pvp.lock().unwrap() = Some(outcome);
        });
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                let mut pool = vec![Engine::new(blokee.0.clone(), blokee.1.clone()).unwrap_or_else(|e| panic!("blokee: {e}"))];
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed) as u32;
                    if i >= n {
                        break;
                    }
                    let seed = seed_base + i;
                    let outcome = (|| {
                        let record = play_game(&mut pool, [0; 4], [Policy::Search; 4], &options(seed))?;
                        if !record.finished {
                            return Err("self-play game did not finish".to_string());
                        }
                        let mut gtp = spec.spawn(seed)?;
                        let r = replay_into_gtp(&record.moves, &mut gtp, mapping)?;
                        if record.scores != r.scores {
                            return Err(format!("replayed scores {:?} differ from the game's {:?}", r.scores, record.scores));
                        }
                        let (br, pr) = (ranks(&r.scores), ranks(&r.gtp_points));
                        if br != pr {
                            return Err(format!("rank order differs: blokee {br:?}, pentobi {pr:?}"));
                        }
                        Ok(format!(
                            "{} plies, {} moves accepted, {} passes, {} legal sets equal ({} moves compared), scores {:?}, pentobi points {:?}, ranks {:?}",
                            r.plies, r.moves_played, r.passes, r.legal_checks, r.legal_moves_compared, r.scores, r.gtp_points, br
                        ))
                    })();
                    match &outcome {
                        Ok(s) => println!("replay seed {seed}: OK  {s}"),
                        Err(e) => println!("replay seed {seed}: FAIL {e}"),
                    }
                    results.lock().unwrap().push((seed, outcome));
                }
            });
        }
    });
    let results = results.into_inner().unwrap();
    let failed = results.iter().filter(|(_, r)| r.is_err()).count();
    let pvp = pvp.into_inner().unwrap().unwrap();
    match &pvp {
        Ok(s) => println!("pentobi-vs-pentobi through the bridge: OK  {s}"),
        Err(e) => println!("pentobi-vs-pentobi through the bridge: FAIL {e}"),
    }
    let pass = failed == 0 && results.len() == n as usize && pvp.is_ok();
    println!(
        "VALIDITY GATE {}: {}/{} replays agree, pentobi-vs-pentobi {}, {:.1} min",
        if pass { "PASSED" } else { "FAILED" },
        results.len() - failed,
        n,
        if pvp.is_ok() { "agrees" } else { "disagrees" },
        started.elapsed().as_secs_f64() / 60.0
    );
    if pass { 0 } else { 1 }
}
