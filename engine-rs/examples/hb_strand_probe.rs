//! High-budget §1 development probe: will a remaining piece still fit after the opponents reply?
//!
//!   hb_strand_probe <positions.jsonl> <search.json> <continuation.json> <K> <R> <out.jsonl> [first] [count]
//!
//! `positions.jsonl` lines: {"id", "seed", "moves" (the game's moves before the decision), "seat"}.
//! Per position:
//! (a) the current search: `search.json` at budget 300 (RNG seeded as `p4_cost` seeds it); its eight
//!     most-visited root moves are the candidates (with visits, value and prior);
//! (b) per candidate, the mover's fit opportunities right after it: for every piece left in hand,
//!     the mover's open corners that some legal placement of that piece covers, merged into regions
//!     (open corners within one square of each other, diagonals included, are one region, so two
//!     orientations through the same corner are one opportunity); also legal placements per piece;
//! (c) the same counts after K sampled reply sequences: the next three seats in turn order each
//!     play a move drawn from the fitted interior prior (softmax at the config's temperature; a seat
//!     with no move passes), stopping at the mover's next decision. Reply sample k uses the same RNG
//!     seed for every candidate of the position (common random numbers);
//! outcome: R forced-move continuations per candidate, all four seats played by `continuation.json`
//!     at budget 300 to the end of the game (continuation r seeded the same for every candidate);
//!     final scores and the mover's unplayed pieces.
//! One JSON line per candidate. Single-threaded. Run from the repo root.

use blokee::bitboard::*;
use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::feature_prior::PriorContext;
use blokee::game::{GameState, recent_placements};
use blokee::ordering::{softmax_priors, sort_by_score};
use blokee::placements::{PIECE_COUNT, placements};
use blokee::position::{MAX_MOVES, Position, SEAT_COUNT};
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use serde_json::json;
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

fn load(path: &str) -> (BitboardParams, Option<Arc<RolloutPolicy>>) {
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(p)) => Some(Arc::new(RolloutPolicy::from_file(p).unwrap())),
        _ => None,
    };
    (params, table)
}

/// Per piece: (regions, legal placements); regions -1 when the piece is not in hand.
fn fits(position: &Position, seat: usize, buffer: &mut [i32]) -> ([i32; PIECE_COUNT], [i32; PIECE_COUNT]) {
    let t = placements();
    let mut regions = [-1i32; PIECE_COUNT];
    let mut legal = [0i32; PIECE_COUNT];
    let mut anchors_of = [EMPTY; PIECE_COUNT];
    for p in 0..PIECE_COUNT {
        if position.hand[seat] & (1 << p) != 0 {
            regions[p] = 0;
        }
    }
    let n = position.generate_moves(seat, buffer, usize::MAX);
    let open = position.open_corners(seat);
    for &mv in &buffer[..n] {
        let m = mv as usize;
        let p = t.piece_id[m] as usize;
        legal[p] += 1;
        let mut a = t.cells[m];
        and_into(&mut a, &open);
        or_into(&mut anchors_of[p], &a);
    }
    let mut cells = [0i32; CELL_COUNT];
    for p in 0..PIECE_COUNT {
        if regions[p] < 0 {
            continue;
        }
        let k = to_indices(&anchors_of[p], &mut cells);
        // Components under the king-move neighbourhood.
        let mut comp = vec![usize::MAX; k];
        let mut count = 0;
        for s in 0..k {
            if comp[s] != usize::MAX {
                continue;
            }
            comp[s] = count;
            let mut stack = vec![s];
            while let Some(i) = stack.pop() {
                let (xi, yi) = (cells[i] as i32 % BOARD_SIZE as i32, cells[i] as i32 / BOARD_SIZE as i32);
                for j in 0..k {
                    if comp[j] == usize::MAX {
                        let (xj, yj) = (cells[j] as i32 % BOARD_SIZE as i32, cells[j] as i32 / BOARD_SIZE as i32);
                        if (xi - xj).abs() <= 1 && (yi - yj).abs() <= 1 {
                            comp[j] = count;
                            stack.push(j);
                        }
                    }
                }
            }
            count += 1;
        }
        regions[p] = count as i32;
    }
    (regions, legal)
}

fn mix(a: u64, b: u64, c: u64) -> u32 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in [a, b, c] {
        for byte in x.to_le_bytes() {
            h ^= byte as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    }
    (h ^ (h >> 32)) as u32
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (pos_path, search_cfg, cont_cfg) = (&argv[1], &argv[2], &argv[3]);
    let (k_replies, r_conts) = (argv[4].parse::<usize>().unwrap(), argv[5].parse::<usize>().unwrap());
    let out = &argv[6];
    let first: usize = argv.get(7).map_or(0, |s| s.parse().unwrap());
    let count: usize = argv.get(8).map_or(usize::MAX, |s| s.parse().unwrap());
    let (sp, st) = load(search_cfg);
    let c = sp.native.as_ref().and_then(|n| n.candidates.as_ref()).unwrap().clone();
    let model = c.interior_prior().unwrap().clone();
    assert!(c.next_pressure == 0.0 && !model.has_extras());
    let mut search = Engine::new(sp, st).unwrap();
    let (cp, ct) = load(cont_cfg);
    let mut cont = Engine::new(cp, ct).unwrap();
    let t = placements();
    let mut piece_size = [0i32; PIECE_COUNT];
    for m in 0..t.count {
        piece_size[t.piece_id[m] as usize] = t.size[m] as i32;
    }
    let mut buffer = vec![0i32; MAX_MOVES];
    let lines: Vec<String> = std::fs::read_to_string(pos_path).unwrap().lines().filter(|l| !l.trim().is_empty()).map(String::from).collect();
    let mut w = std::io::BufWriter::new(std::fs::OpenOptions::new().create(true).append(true).open(out).unwrap());
    for line in lines.iter().skip(first).take(count) {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        let id = v["id"].as_u64().unwrap();
        let seed = v["seed"].as_u64().unwrap();
        let seat = v["seat"].as_u64().unwrap() as usize;
        let prefix: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
        let mut state = GameState::new(false);
        for &mv in &prefix {
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
        assert_eq!(state.turn, seat, "position {id}: seat to move");
        let started = Instant::now();
        // (a) the current search.
        let mut position = state.to_position();
        let mut rng = Rng::new((seed as u32) ^ (prefix.len() as u32).wrapping_mul(0x9e37_79b9));
        let mut stats = MoveStats::default();
        search.set_recent(&recent_placements(&prefix));
        let ranked = search.search(&mut position, seat, 300, &mut rng, &mut stats);
        let root_priors: std::collections::HashMap<i32, f64> = {
            // The fitted root prior for each candidate, recomputed as the root builds it.
            let p = state.to_position();
            let n = p.generate_moves(seat, &mut buffer, usize::MAX);
            let mut ms = buffer[..n].to_vec();
            let ctx = PriorContext::new(&p, seat, &recent_placements(&prefix));
            let mut sc = vec![0.0; n];
            c.model.as_ref().unwrap().score(&ctx, &ms, &mut sc);
            sort_by_score(&mut ms, &mut sc);
            let mut pr = vec![0.0; n];
            softmax_priors(&sc, c.temperature, &mut pr);
            ms.into_iter().zip(pr).collect()
        };
        let search_ms = started.elapsed().as_secs_f64() * 1000.0;
        let before = fits(&state.board, seat, &mut buffer);
        for (ci, cand) in ranked.iter().take(8).enumerate() {
            let mv = cand.mv;
            let mut after = state.clone();
            after.apply(mv);
            let mut moves_after = prefix.clone();
            moves_after.push(mv);
            // (b) immediately.
            let (b_regions, b_legal) = fits(&after.board, seat, &mut buffer);
            // (c) after K sampled reply sequences.
            let mut c_regions: Vec<[i32; PIECE_COUNT]> = Vec::new();
            for k in 0..k_replies {
                let mut rng = Rng::new(mix(seed, prefix.len() as u64, 1_000_000 + k as u64));
                let mut s = after.clone();
                let mut ms_hist = moves_after.clone();
                for _ in 0..SEAT_COUNT - 1 {
                    if s.finished {
                        break;
                    }
                    let who = s.turn;
                    let p = s.to_position();
                    let n = p.generate_moves(who, &mut buffer, usize::MAX);
                    if n == 0 {
                        s.pass();
                        ms_hist.push(-1);
                        continue;
                    }
                    let mut ms = buffer[..n].to_vec();
                    let ctx = PriorContext::new(&p, who, &recent_placements(&ms_hist));
                    let mut sc = vec![0.0; n];
                    model.score(&ctx, &ms, &mut sc);
                    sort_by_score(&mut ms, &mut sc);
                    let mut pr = vec![0.0; n];
                    softmax_priors(&sc, c.temperature, &mut pr);
                    let mut x = rng.next_f64();
                    let mut pick = n - 1;
                    for (i, &q) in pr.iter().enumerate() {
                        if x < q {
                            pick = i;
                            break;
                        }
                        x -= q;
                    }
                    s.apply(ms[pick]);
                    ms_hist.push(ms[pick]);
                }
                c_regions.push(fits(&s.board, seat, &mut buffer).0);
            }
            // Outcome: R forced-move continuations.
            let mut finals: Vec<[f64; SEAT_COUNT]> = Vec::new();
            let mut hands: Vec<u32> = Vec::new();
            for r in 0..r_conts {
                let mut rng = Rng::new(mix(seed, prefix.len() as u64, 2_000_000 + r as u64));
                let mut s = after.clone();
                let mut hist = moves_after.clone();
                let mut plies = 0;
                while !s.finished && plies < 200 {
                    let who = s.turn;
                    if s.has_move(who) {
                        let mut p = s.to_position();
                        let mut st = MoveStats::default();
                        cont.set_recent(&recent_placements(&hist));
                        let rk = cont.search(&mut p, who, 300, &mut rng, &mut st);
                        let m = rk[0].mv;
                        s.apply(m);
                        hist.push(m);
                    } else {
                        s.pass();
                        hist.push(-1);
                    }
                    plies += 1;
                }
                finals.push(s.scores());
                hands.push(s.board.hand[seat]);
            }
            let row = json!({
                "id": id, "seed": seed, "ply": prefix.len(), "seat": seat,
                "own": 21 - state.board.hand[seat].count_ones(),
                "cand": ci, "mv": mv, "piece": t.piece_id[mv as usize], "size": t.size[mv as usize],
                "visits": cand.visits, "value": cand.value, "prior": root_priors.get(&mv).copied().unwrap_or(0.0),
                "iterations": stats.iterations, "search_ms": search_ms,
                "before_regions": before.0.to_vec(),
                "b_regions": b_regions.to_vec(), "b_legal": b_legal.to_vec(),
                "c_regions": c_regions.iter().map(|x| x.to_vec()).collect::<Vec<_>>(),
                "finals": finals, "hands": hands,
                "hand_after": after.board.hand[seat], "piece_size": piece_size.to_vec(),
            });
            writeln!(w, "{row}").unwrap();
        }
        w.flush().unwrap();
        eprintln!("position {id}: {} candidates, {:.1} s", ranked.len().min(8), started.elapsed().as_secs_f64());
    }
}
