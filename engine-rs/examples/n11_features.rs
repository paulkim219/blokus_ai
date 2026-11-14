//! N11 feature extraction in a compact format: every legal move of every decision made by a Pentobi
//! seat in bridge games, with the move-prior features of `feature_prior.rs` (`PriorContext::features`,
//! the reference the search's scorer is tested against bit for bit).
//!
//!   cargo run --release --example n11_features -- <threads> <out-prefix> <moves.jsonl>...
//!
//! Features 0–22 depend only on the placement, so a row stores the placement id and features 23–38
//! (small non-negative integers) as bytes; `<prefix>.static.f32` holds, per placement, features 0–22
//! as the engine computes them (21 piece one-hots, centre, centre²/10), so the full vector of a row is
//! `static[id] ++ dynamic`. Files:
//!   <out-prefix>.bin         rows of 19 bytes: u16 LE placement id, 16 × u8 features 23–38, u8 label
//!   <out-prefix>.static.f32  placements × 23 little-endian f32
//!   <out-prefix>.csv         one line per decision: file, seed, lone, seat, ply, own_idx, legal, row
//! The engine of each seat comes from the record's `engines` list; only "pentobi" seats are used.

use blokee::feature_prior::{FEATURE_COUNT, PriorContext};
use blokee::game::GameState;
use blokee::placements::placements;
use blokee::position::{SEAT_COLORS, SEAT_COUNT, new_move_buffer};
use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

const STATIC: usize = 23;
const ROW: usize = 2 + (FEATURE_COUNT - STATIC) + 1;

struct Game {
    file: usize,
    seed: u64,
    lone: String,
    engines: [String; SEAT_COUNT],
    moves: Vec<i32>,
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 4 {
        panic!("usage: n11_features <threads> <out-prefix> <moves.jsonl>...");
    }
    let threads: usize = argv[1].parse().unwrap();
    let prefix = &argv[2];
    let files = &argv[3..];
    let mut games = Vec::new();
    for (fi, path) in files.iter().enumerate() {
        for l in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let order: Vec<&str> = v["seatOrder"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert_eq!(order, SEAT_COLORS.to_vec(), "seat order");
            games.push(Game {
                file: fi,
                seed: v["seed"].as_u64().unwrap(),
                lone: v["seat"].as_str().unwrap().to_string(),
                engines: std::array::from_fn(|s| v["engines"][s].as_str().unwrap().to_string()),
                moves: v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect(),
            });
        }
    }
    eprintln!("n11_features: {} games from {} files", games.len(), files.len());
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(usize, Vec<u8>, Vec<String>)>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut buf = new_move_buffer();
                loop {
                    let gi = next.fetch_add(1, Ordering::Relaxed);
                    if gi >= games.len() {
                        break;
                    }
                    let g = &games[gi];
                    let mut rows: Vec<u8> = Vec::new();
                    let mut lines: Vec<String> = Vec::new();
                    let mut state = GameState::new(false);
                    let mut history: Vec<(usize, i32)> = Vec::new();
                    for (ply, &mv) in g.moves.iter().enumerate() {
                        let seat = state.turn;
                        if mv < 0 {
                            state.pass();
                            continue;
                        }
                        if g.engines[seat] == "pentobi" {
                            let mut p = state.to_position();
                            p.force_turn(seat);
                            let n = p.generate_moves(seat, &mut buf, usize::MAX);
                            assert!(buf[..n].contains(&mv), "played move not legal: seed {} ply {ply}", g.seed);
                            let ctx = PriorContext::new(&p, seat, &history);
                            lines.push(format!("{},{},{},{seat},{ply},{},{n},ROW", g.file, g.seed, g.lone, ctx.own_moves));
                            let mut f = [0f32; FEATURE_COUNT];
                            for &m in &buf[..n] {
                                ctx.features(m, &mut f);
                                rows.extend_from_slice(&(m as u16).to_le_bytes());
                                for &x in &f[STATIC..] {
                                    assert!(x >= 0.0 && x <= 255.0 && x.fract() == 0.0, "feature value {x} does not fit a byte");
                                    rows.push(x as u8);
                                }
                                rows.push((m == mv) as u8);
                            }
                        }
                        state.apply(mv);
                        history.push((seat, mv));
                    }
                    let mut r = results.lock().unwrap();
                    r.push((gi, rows, lines));
                    if r.len() % 200 == 0 {
                        eprintln!("n11_features: {}/{} games", r.len(), games.len());
                    }
                }
            });
        }
    });
    let mut results = results.into_inner().unwrap();
    results.sort_by_key(|r| r.0);
    let mut bw = std::io::BufWriter::new(std::fs::File::create(format!("{prefix}.bin")).unwrap());
    let mut cw = std::io::BufWriter::new(std::fs::File::create(format!("{prefix}.csv")).unwrap());
    writeln!(cw, "file,seed,lone,seat,ply,own_idx,legal,row").unwrap();
    let (mut row, mut decisions) = (0usize, 0usize);
    for (_, rows, lines) in results {
        let mut at = 0usize;
        for line in lines {
            let n: usize = line.split(',').nth(6).unwrap().parse().unwrap();
            writeln!(cw, "{}", line.replace("ROW", &row.to_string())).unwrap();
            row += n;
            at += n;
            decisions += 1;
        }
        assert_eq!(at * ROW, rows.len());
        bw.write_all(&rows).unwrap();
    }
    let t = placements();
    let mut sw = std::io::BufWriter::new(std::fs::File::create(format!("{prefix}.static.f32")).unwrap());
    for m in 0..t.count {
        let mut f = [0f32; STATIC];
        f[t.piece_id[m] as usize] = 1.0;
        let centre = t.centre_distance[m];
        f[21] = centre;
        f[22] = centre * centre / 10.0;
        for x in f {
            sw.write_all(&x.to_le_bytes()).unwrap();
        }
    }
    eprintln!("n11_features: {decisions} decisions, {row} candidate rows; wrote {prefix}.bin/.csv/.static.f32");
}
