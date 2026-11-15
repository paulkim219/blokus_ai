//! N19 (round 4): mobility features for the move prior, aligned row for row with an `n11_features`
//! dump of the same files (same games, same decisions, same legal-move order).
//!
//!   n19_features <threads> <out-prefix> <moves.jsonl>...
//!
//! Writes `<out-prefix>.mob.f32`: per row (every legal move of every Pentobi decision) K little-endian f32:
//!   0 own_gain      the mover's legal placements after the move minus before (exact), / 10
//!   1 rm_next       legal placements of the next seat in turn order that the move's cells intersect, / 10
//!   2 rm_opp        the same for the opposite seat, / 10
//!   3 rm_prev       the same for the previous seat, / 10
//!   4 rm_sum        1 + 2 + 3
//!   5 pr_next       cheap pressure: sum over the move's cells of how many next-seat placements cover it, / 10
//!   6 pr_opp        the same for the opposite seat
//!   7 pr_prev       the same for the previous seat
//!   8 own_live      the mover's open corners after the move minus before (cheap own-gain proxy)
//! A seat already out of the game (no legal move) contributes 0. Run from the repo root.

use blokee::bitboard::popcount;
use blokee::game::GameState;
use blokee::placements::placements;
use blokee::bitboard::CELL_COUNT;
use blokee::position::{SEAT_COLORS, SEAT_COUNT, new_move_buffer};
use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const K: usize = 9;

struct Game {
    seed: u64,
    engines: [String; SEAT_COUNT],
    moves: Vec<i32>,
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let threads: usize = argv[1].parse().unwrap();
    let prefix = &argv[2];
    let mut games = Vec::new();
    for path in &argv[3..] {
        for l in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let order: Vec<&str> = v["seatOrder"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert_eq!(order, SEAT_COLORS.to_vec(), "seat order");
            games.push(Game {
                seed: v["seed"].as_u64().unwrap(),
                engines: std::array::from_fn(|s| v["engines"][s].as_str().unwrap().to_string()),
                moves: v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect(),
            });
        }
    }
    eprintln!("n19_features: {} games", games.len());
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(usize, Vec<u8>)>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let t = placements();
                let mut buf = new_move_buffer();
                let mut obuf = new_move_buffer();
                let mut stamp = vec![0u32; t.count];
                let mut stamp_gen = 0u32;
                loop {
                    let gi = next.fetch_add(1, Ordering::Relaxed);
                    if gi >= games.len() {
                        break;
                    }
                    let g = &games[gi];
                    let mut out: Vec<u8> = Vec::new();
                    let mut state = GameState::new(false);
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
                            // Per opponent role: per-cell lists of its legal placements, and per-cell counts.
                            let mut cover: Vec<Vec<Vec<u32>>> = Vec::with_capacity(3);
                            let mut counts: Vec<[u16; CELL_COUNT]> = Vec::with_capacity(3);
                            for k in 1..SEAT_COUNT {
                                let o = (seat + k) % SEAT_COUNT;
                                let mut lists = vec![Vec::new(); CELL_COUNT];
                                let mut c = [0u16; CELL_COUNT];
                                let on = if p.out[o] == 0 { p.generate_moves(o, &mut obuf, usize::MAX) } else { 0 };
                                for (j, &om) in obuf[..on].iter().enumerate() {
                                    let m = om as usize;
                                    for i in t.cell_start[m]..t.cell_start[m + 1] {
                                        let cell = t.cell_list[i as usize] as usize;
                                        lists[cell].push(j as u32);
                                        c[cell] += 1;
                                    }
                                }
                                cover.push(lists);
                                counts.push(c);
                            }
                            let corners_before = popcount(&p.open_corners(seat)) as f32;
                            for &cand in &buf[..n] {
                                let m = cand as usize;
                                let mut f = [0f32; K];
                                // Own gain: apply, count, undo.
                                let undo = p.apply(cand);
                                let after = p.generate_moves(seat, &mut obuf, usize::MAX);
                                f[8] = popcount(&p.open_corners(seat)) as f32 - corners_before;
                                p.undo(&undo);
                                p.force_turn(seat);
                                f[0] = (after as f32 - n as f32) / 10.0;
                                for r in 0..3 {
                                    stamp_gen = stamp_gen.wrapping_add(1);
                                    let (mut removed, mut pressure) = (0u32, 0u32);
                                    for i in t.cell_start[m]..t.cell_start[m + 1] {
                                        let cell = t.cell_list[i as usize] as usize;
                                        pressure += counts[r][cell] as u32;
                                        for &j in &cover[r][cell] {
                                            if stamp[j as usize] != stamp_gen {
                                                stamp[j as usize] = stamp_gen;
                                                removed += 1;
                                            }
                                        }
                                    }
                                    f[1 + r] = removed as f32 / 10.0;
                                    f[5 + r] = pressure as f32 / 10.0;
                                }
                                f[4] = f[1] + f[2] + f[3];
                                for x in f {
                                    out.extend_from_slice(&x.to_le_bytes());
                                }
                            }
                        }
                        state.apply(mv);
                    }
                    let mut r = results.lock().unwrap();
                    r.push((gi, out));
                    if r.len() % 200 == 0 {
                        eprintln!("n19_features: {}/{} games", r.len(), games.len());
                    }
                }
            });
        }
    });
    let mut results = results.into_inner().unwrap();
    results.sort_by_key(|r| r.0);
    let mut w = std::io::BufWriter::new(std::fs::File::create(format!("{prefix}.mob.f32")).unwrap());
    let mut rows = 0usize;
    for (_, out) in results {
        rows += out.len() / (4 * K);
        w.write_all(&out).unwrap();
    }
    eprintln!("n19_features: {rows} rows; wrote {prefix}.mob.f32");
}
