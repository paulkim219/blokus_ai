//! Round 3, Stage C: move-level interaction diagnostic on bridge games (no search, no games played).
//!
//!   c_moves <threads> <out.csv> <moves.jsonl>...
//!
//! Replays every recorded game (`blokee-pentobi --moves-out`, which records the engine of each seat in
//! turn order). For every placement, with the position before and after it, writes one row per
//! (mover, target) where the target is the next, opposite or previous seat in turn order and still has
//! a legal move before the placement:
//!   legal_before, d_legal      the target's legal placements before, and the change the move causes;
//!   live_before, d_live        the target's live attach points (open corners covered by at least one of
//!                              its legal placements) before, and the change;
//!   covered, killed            target live attach points the move occupies / leaves alive-free but dead;
//! plus, once per placement (role "self"): the mover's own change in legal placements and live attach
//! points, the number of new live attach points it creates, and how many of those the very next
//! placement (by whichever seat moves next) covers or kills (reply_covered, reply_killed; the replier's
//! engine in `replier`). Run from the repo root.
use blokee::bitboard::{EMPTY, Mask, popcount};
use blokee::game::GameState;
use blokee::placements::placements;
use blokee::position::{Position, SEAT_COUNT, new_move_buffer};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct Game {
    file: usize,
    seed: u64,
    lone: String,
    engines: [String; SEAT_COUNT],
    moves: Vec<i32>,
}

#[derive(Clone, Copy)]
struct Seat {
    legal: usize,
    live: Mask,
    corners: Mask,
}

fn seat_info(p: &Position, seat: usize, buf: &mut [i32]) -> Seat {
    let n = p.generate_moves(seat, buf, usize::MAX);
    let t = placements();
    let corners = p.open_corners(seat);
    let mut live = EMPTY;
    for &mv in &buf[..n] {
        let c = &t.cells[mv as usize];
        for w in 0..live.len() {
            live[w] |= c[w] & corners[w];
        }
    }
    Seat { legal: n, live, corners }
}

fn count_and(a: &Mask, b: &Mask) -> u32 {
    let mut m = EMPTY;
    for w in 0..m.len() {
        m[w] = a[w] & b[w];
    }
    popcount(&m)
}

fn count_and_not2(a: &Mask, not1: &Mask, not2: &Mask) -> u32 {
    let mut m = EMPTY;
    for w in 0..m.len() {
        m[w] = a[w] & !not1[w] & !not2[w];
    }
    popcount(&m)
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let threads: usize = argv[1].parse().unwrap();
    let out = argv[2].clone();
    let mut all = Vec::new();
    for (file, path) in argv[3..].iter().enumerate() {
        for line in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let e = v["engines"].as_array().unwrap();
            all.push(Game {
                file,
                seed: v["seed"].as_u64().unwrap(),
                lone: v["seat"].as_str().unwrap().to_string(),
                engines: std::array::from_fn(|s| e[s].as_str().unwrap().to_string()),
                moves: v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect(),
            });
        }
    }
    let all = Arc::new(all);
    let next = Arc::new(AtomicUsize::new(0));
    let w = Arc::new(Mutex::new(std::io::BufWriter::new(std::fs::File::create(&out).unwrap())));
    writeln!(w.lock().unwrap(), "file,seed,lone,ply,mover,mover_engine,role,target_engine,legal_before,d_legal,live_before,d_live,covered,killed,new_live,reply_covered,reply_killed,replier").unwrap();
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let (all, next, w) = (Arc::clone(&all), Arc::clone(&next), Arc::clone(&w));
            std::thread::spawn(move || {
                let mut buf = new_move_buffer();
                let t = placements();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= all.len() {
                        break;
                    }
                    let g = &all[i];
                    let mut state = GameState::new(false);
                    let mut rows = String::new();
                    let mut info: [Seat; SEAT_COUNT] = std::array::from_fn(|s| seat_info(&state.board, s, &mut buf));
                    // Pending reply check: (row prefix, mover, new live mask).
                    let mut pending: Option<(String, usize, Mask)> = None;
                    for (ply, &mv) in g.moves.iter().enumerate() {
                        let m = state.turn;
                        if mv < 0 {
                            state.pass();
                            continue;
                        }
                        let before = info;
                        state.apply(mv);
                        let after: [Seat; SEAT_COUNT] = std::array::from_fn(|s| seat_info(&state.board, s, &mut buf));
                        let cells = &t.cells[mv as usize];
                        // Resolve the previous placement's reply check with this placement.
                        if let Some((prefix, pm, new_live)) = pending.take() {
                            let covered = count_and(&new_live, cells);
                            let killed = count_and_not2(&new_live, cells, &after[pm].live);
                            rows.push_str(&format!("{prefix},{covered},{killed},{}:{}\n", g.engines[m], (m + SEAT_COUNT - pm) % SEAT_COUNT));
                        }
                        let phase_ply = ply;
                        for (k, role) in [(1usize, "next"), (2, "opposite"), (3, "previous")] {
                            let tg = (m + k) % SEAT_COUNT;
                            if before[tg].legal == 0 {
                                continue;
                            }
                            let covered = count_and(&before[tg].live, cells);
                            let killed = count_and_not2(&before[tg].live, cells, &after[tg].live);
                            rows.push_str(&format!(
                                "{},{},{},{phase_ply},{m},{},{role},{},{},{},{},{},{covered},{killed},,,,\n",
                                g.file, g.seed, g.lone, g.engines[m], g.engines[tg], before[tg].legal,
                                after[tg].legal as i64 - before[tg].legal as i64, popcount(&before[tg].live),
                                popcount(&after[tg].live) as i64 - popcount(&before[tg].live) as i64
                            ));
                        }
                        // Self row; its reply columns are filled when the next placement comes.
                        let mut new_live = EMPTY;
                        for k in 0..new_live.len() {
                            new_live[k] = after[m].live[k] & !before[m].live[k] & !before[m].corners[k];
                        }
                        let prefix = format!(
                            "{},{},{},{phase_ply},{m},{},self,{},{},{},{},{},0,0,{}",
                            g.file, g.seed, g.lone, g.engines[m], g.engines[m], before[m].legal,
                            after[m].legal as i64 - before[m].legal as i64, popcount(&before[m].live),
                            popcount(&after[m].live) as i64 - popcount(&before[m].live) as i64, popcount(&new_live)
                        );
                        pending = Some((prefix, m, new_live));
                        info = after;
                    }
                    if let Some((prefix, _, _)) = pending.take() {
                        rows.push_str(&format!("{prefix},,,\n"));
                    }
                    w.lock().unwrap().write_all(rows.as_bytes()).unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    eprintln!("c_moves: {} games; wrote {out}", all.len());
}
