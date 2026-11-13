//! E6 probe: run several configs' searches on the same fixed positions and compare root visits.
//!
//!   cargo run --release --example e6_probe -- <records-dir> <budget> <base.json> <arm.json>...
//!
//! Positions are the searched decisions in a `blokee-selfplay` output directory (shard-*.bin).
//! Each config searches each position from the same RNG seed; the first config is the reference.
//! Also counts the edge cases the E6 call has to survive: roots with one move, root children that
//! end the game, and positions where some seat is already out of moves.

use blokee::bitboard::{CELL_COUNT, WORDS, test_bit};
use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats, Source};
use blokee::position::{Position, SEAT_COUNT};
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use std::collections::BTreeMap;
use std::sync::Arc;

fn load(path: &str) -> (BitboardParams, Option<Arc<RolloutPolicy>>) {
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap();
    let table = params.search.playout_table_path.as_ref().map(|p| {
        let found = [p.clone(), format!("../{p}")].into_iter().find(|c| std::path::Path::new(c).exists()).expect("rollout table");
        Arc::new(RolloutPolicy::from_file(&found).unwrap())
    });
    (params, table)
}

fn decode(r: &[u8]) -> (Position, usize) {
    let mut own = [[0u32; WORDS]; SEAT_COUNT];
    let mut at = 8;
    for seat_own in own.iter_mut() {
        for w in seat_own.iter_mut() {
            *w = u32::from_le_bytes(r[at..at + 4].try_into().unwrap());
            at += 4;
        }
    }
    let hand: [u32; SEAT_COUNT] = std::array::from_fn(|s| u32::from_le_bytes(r[216 + 4 * s..220 + 4 * s].try_into().unwrap()));
    let last: [i32; SEAT_COUNT] = std::array::from_fn(|s| r[232 + s] as i8 as i32);
    let mut owners = [-1i8; CELL_COUNT];
    for (seat, mask) in own.iter().enumerate() {
        for (cell, owner) in owners.iter_mut().enumerate() {
            if test_bit(mask, cell) {
                *owner = seat as i8;
            }
        }
    }
    let seat = r[6] as usize;
    (Position::from_cells(&owners, hand, last, seat, false), seat)
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (dir, budget) = (&argv[1], argv[2].parse::<u32>().unwrap());
    let configs = &argv[3..];
    let mut shards: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "bin")).collect();
    shards.sort();
    let records: Vec<Vec<u8>> = shards.iter().flat_map(|p| std::fs::read(p).unwrap().chunks(512).map(|c| c.to_vec()).collect::<Vec<_>>()).filter(|r| r[7] == 0).collect();
    let mut engines: Vec<Engine> = configs.iter().map(|c| { let (p, t) = load(c); Engine::new(p, t).unwrap_or_else(|e| panic!("{c}: {e}")) }).collect();

    let (mut one_move, mut terminal_children, mut out_seats, mut positions) = (0, 0, 0, 0);
    let mut differ = vec![0usize; configs.len()];
    let mut choice = vec![0usize; configs.len()];
    let mut tv = vec![0f64; configs.len()];
    let mut evals = vec![0u64; configs.len()];
    for (i, r) in records.iter().enumerate() {
        let (base, seat) = decode(r);
        if !base.has_move(seat) {
            continue;
        }
        let mut reference: Option<(BTreeMap<i32, i32>, i32)> = None;
        let mut searched = true;
        for (k, engine) in engines.iter_mut().enumerate() {
            let mut position = base.clone();
            let mut stats = MoveStats::default();
            let ranked = engine.search(&mut position, seat, budget, &mut Rng::new(1000 + i as u32), &mut stats);
            if stats.source != Source::Search {
                searched = false;
                break;
            }
            evals[k] += stats.net_evaluations as u64;
            let visits: BTreeMap<i32, i32> = ranked.iter().map(|e| (e.mv, e.visits)).collect();
            let best = ranked[0].mv;
            if k == 0 {
                positions += 1;
                one_move += (ranked.len() == 1) as usize;
                // Root children that end the game, and seats already out at the root.
                for e in &ranked {
                    let mut p = base.clone();
                    p.force_turn(seat);
                    p.apply(e.mv);
                    let mut guard = 0;
                    while !p.finished() && guard < SEAT_COUNT {
                        if p.has_move(p.turn) {
                            break;
                        }
                        p.mark_out(p.turn);
                        p.advance_turn();
                        guard += 1;
                    }
                    terminal_children += p.finished() as usize;
                }
                out_seats += (0..SEAT_COUNT).any(|s| !base.has_move(s)) as usize;
                reference = Some((visits, best));
            } else if let Some((rv, rb)) = &reference {
                let (sa, sb) = (rv.values().sum::<i32>().max(1) as f64, visits.values().sum::<i32>().max(1) as f64);
                let keys: std::collections::BTreeSet<i32> = rv.keys().chain(visits.keys()).copied().collect();
                tv[k] += 0.5 * keys.iter().map(|m| (*rv.get(m).unwrap_or(&0) as f64 / sa - *visits.get(m).unwrap_or(&0) as f64 / sb).abs()).sum::<f64>();
                differ[k] += (rv != &visits) as usize;
                choice[k] += (*rb != best) as usize;
            }
        }
        if !searched {
            continue;
        }
    }
    println!("{positions} searched positions from {dir} at budget {budget}: {one_move} with one root move, {terminal_children} game-ending root children, {out_seats} with a seat out of moves");
    for (k, c) in configs.iter().enumerate() {
        println!(
            "{c}: {:.1} net evals/position; vs {}: visit vector differs in {}/{positions}, chosen move differs in {}, mean TV {:.3}",
            evals[k] as f64 / positions.max(1) as f64,
            configs[0],
            differ[k],
            choice[k],
            tv[k] / positions.max(1) as f64
        );
    }
}
