//! P6/P7 gates: the identity points of `native.rave` and `native.lastGoodReply` search exactly as the
//! base config; with RAVE on, every root edge's AMAF weight is at least its real visits (the edge
//! chosen at the root always gets a weight-1 update) and interior statistics follow `scope`; the
//! reply table supplies legal rollout moves; `unsupported()` refuses the bad combinations.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::game::GameState;
use blokee::position::{MAX_MOVES, SEAT_COUNT};
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use serde_json::{Value, json};
use std::sync::Arc;

const BASE: &str = "configs/v5.0-p4-ultra.json";

fn config(extra: Value) -> BitboardParams {
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(BASE).unwrap()).unwrap();
    for (k, x) in extra.as_object().unwrap() {
        v["native"][k] = x.clone();
    }
    v["search"]["playoutTablePath"] = json!("../ml/v41-rollout-policy.json");
    serde_json::from_value(v).unwrap()
}

fn engine(p: BitboardParams) -> Engine {
    let table = Arc::new(RolloutPolicy::from_file(p.search.playout_table_path.as_ref().unwrap()).unwrap());
    Engine::new(p, Some(table)).unwrap()
}

/// Positions a few random moves into a game, with the seat to move having a move.
fn positions(count: usize, seed: u32) -> Vec<(GameState, Vec<i32>)> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::new();
    let mut buffer = vec![0i32; MAX_MOVES];
    while out.len() < count {
        let mut state = GameState::new(false);
        let mut moves = Vec::new();
        let stop = 16 + rng.next_int(40);
        for _ in 0..stop {
            let seat = state.turn;
            let n = state.board.generate_moves(seat, &mut buffer, MAX_MOVES);
            if n == 0 {
                state.pass();
                moves.push(-1);
            } else {
                let mv = buffer[rng.next_int(n)];
                state.apply(mv);
                moves.push(mv);
            }
            if state.finished {
                break;
            }
        }
        if !state.finished && state.has_move(state.turn) {
            out.push((state, moves));
        }
    }
    out
}

fn search(e: &mut Engine, state: &GameState, moves: &[i32], seed: u32, budget: u32) -> Vec<(i32, i32, f64)> {
    let mut position = state.to_position();
    let mut rng = Rng::new(seed);
    let mut stats = MoveStats::default();
    e.set_recent(&blokee::game::recent_placements(moves));
    e.search(&mut position, state.turn, budget, &mut rng, &mut stats).iter().map(|r| (r.mv, r.visits, r.value)).collect()
}

#[test]
fn identity_points_search_like_the_base() {
    let mut base = engine(config(json!({})));
    let mut id = engine(config(json!({"rave": {"weight": 0.0, "equivalence": 50.0, "distanceDecay": 0.5},
                                      "lastGoodReply": {"enabled": false}})));
    for (i, (state, moves)) in positions(12, 4242).iter().enumerate() {
        let a = search(&mut base, state, moves, 900 + i as u32, 20);
        let b = search(&mut id, state, moves, 900 + i as u32, 20);
        assert_eq!(a, b, "position {i}");
    }
}

#[test]
fn amaf_statistics_cover_real_visits_and_follow_scope() {
    for (scope, decay) in [("all", 0.0), ("all", 0.75), ("root", 0.0)] {
        let p = config(json!({"rave": {"weight": 1.0, "equivalence": 100.0, "distanceDecay": decay, "scope": scope}}));
        let mut e = engine(p);
        for (i, (state, moves)) in positions(6, 77).iter().enumerate() {
            search(&mut e, state, moves, 31 + i as u32, 20);
            let Some(stats) = e.root_edge_stats() else { continue };
            let visits: i32 = stats.iter().map(|s| s.0).sum();
            let amaf: f64 = stats.iter().map(|s| s.1).sum();
            assert!(visits > 0, "searched");
            for (edge, &(v, w)) in stats.iter().enumerate() {
                assert!(w + 1e-9 >= v as f64, "{scope}/{decay} position {i} edge {edge}: AMAF weight {w} below visits {v}");
                if decay == 0.0 {
                    assert_eq!(w, w.round(), "integer weights without distance decay");
                }
            }
            // Root-seat moves later in the simulation add more than one update per simulation.
            assert!(amaf > visits as f64, "{scope}/{decay} position {i}: AMAF {amaf} vs visits {visits}");
        }
    }
}

#[test]
fn reply_table_supplies_moves() {
    for rollout in [json!({"policy": "sampled"}), json!({"policy": "all", "sizeWeight": 1.4, "localWeight": 0.7, "localOwnExtra": 0.65})] {
        let p = config(json!({"lastGoodReply": {"enabled": true, "forget": true}, "rollout": rollout,
                              "rave": {"weight": 1.0, "equivalence": 100.0}}));
        let mut e = engine(p);
        for (i, (state, moves)) in positions(4, 99).iter().enumerate() {
            let ranked = search(&mut e, state, moves, 7 + i as u32, 20);
            assert!(!ranked.is_empty());
        }
        let (asked, supplied) = e.reply_stats().unwrap();
        assert!(asked > 1000 && supplied > 0 && supplied < asked, "asked {asked} supplied {supplied}");
    }
}

#[test]
fn unsupported_combinations_are_refused() {
    let refused = |extra: Value| !config(extra).unsupported().is_empty();
    assert!(!refused(json!({"rave": {"weight": 1.0, "equivalence": 10.0, "distanceDecay": 1.0, "scope": "root"}})));
    assert!(refused(json!({"rave": {"weight": -1.0}})));
    assert!(refused(json!({"rave": {"weight": 1.0, "equivalence": 0.0}})));
    assert!(refused(json!({"rave": {"weight": 1.0, "distanceDecay": 1.5}})));
    assert!(refused(json!({"rave": {"weight": 1.0, "scope": "interior"}})));
    let mut brs = config(json!({"rave": {"weight": 1.0}}));
    brs.search.opponent_policy = "brs".into();
    assert!(!brs.unsupported().is_empty());
    let mut brs = config(json!({"lastGoodReply": {"enabled": true}}));
    brs.search.opponent_policy = "brs".into();
    assert!(!brs.unsupported().is_empty());
    assert!(serde_json::from_value::<BitboardParams>({
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(BASE).unwrap()).unwrap();
        v["native"]["rave"] = json!({"weight": 1.0, "typo": 3});
        v
    }).is_err(), "unknown keys are refused");
    let _ = SEAT_COUNT;
}

#[test]
fn reuse_probe_finds_the_played_child() {
    let mut e = engine(config(json!({})));
    let mut checked = 0;
    for (i, (state, moves)) in positions(8, 5150).iter().enumerate() {
        let ranked = search(&mut e, state, moves, 61 + i as u32, 20);
        let Some(&(best, visits, _)) = ranked.first() else { continue };
        if visits <= 0 {
            continue;
        }
        let mut next = state.clone();
        next.apply(best);
        let (found, iterations) = e.reuse_probe(&next.to_position()).expect("last decision was a search");
        assert!(iterations > 0);
        // The child node holds at least the root edge's visits (more only through transpositions).
        assert!(found >= visits as f64, "position {i}: node {found} < edge {visits}");
        checked += 1;
    }
    assert!(checked >= 4);
}
