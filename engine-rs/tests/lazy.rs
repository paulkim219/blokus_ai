//! High-budget §3 gates: `interiorCap.lazy` searches exactly as the eager layout with the same cap
//! (every ranked root move, its visits and the bits of its value, and the tree's shape), across cap
//! shapes, RAVE scopes and distance decay, and holds less tree memory. The cross-binary identity
//! (option absent vs the round-9 binary) is checked by whole games, not here.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::game::GameState;
use blokee::position::MAX_MOVES;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use serde_json::{Value, json};
use std::sync::Arc;

const BASE: &str = "configs/v5.3-turbo.json";

fn config(cap: Value, rave: Option<Value>) -> BitboardParams {
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(BASE).unwrap()).unwrap();
    v["native"]["candidates"]["interiorCap"] = cap;
    if let Some(r) = rave {
        v["native"]["rave"] = r;
    }
    v["search"]["playoutTablePath"] = json!("../ml/v41-rollout-policy.json");
    serde_json::from_value(v).unwrap()
}

fn engine(p: BitboardParams) -> Engine {
    let table = Arc::new(RolloutPolicy::from_file(p.search.playout_table_path.as_ref().unwrap()).unwrap());
    Engine::new(p, Some(table)).unwrap()
}

fn positions(count: usize, seed: u32) -> Vec<(GameState, Vec<i32>)> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::new();
    let mut buffer = vec![0i32; MAX_MOVES];
    while out.len() < count {
        let mut state = GameState::new(false);
        let mut moves = Vec::new();
        let stop = 12 + rng.next_int(44);
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

type Digest = (Vec<(i32, i32, u64)>, Vec<usize>, Vec<u64>, usize, usize);

fn search(e: &mut Engine, state: &GameState, moves: &[i32], seed: u32, budget: u32) -> Digest {
    let mut position = state.to_position();
    let mut rng = Rng::new(seed);
    let mut stats = MoveStats::default();
    e.set_recent(&blokee::game::recent_placements(moves));
    let ranked = e.search(&mut position, state.turn, budget, &mut rng, &mut stats).iter().map(|r| (r.mv, r.visits, r.value.to_bits())).collect();
    match e.tree_shape() {
        Some(s) => (ranked, s.nodes_by_depth, s.visits_by_depth.iter().map(|v| v.to_bits()).collect(), s.interior_visited, s.busy_visited),
        None => (ranked, vec![], vec![], 0, 0),
    }
}

#[test]
fn lazy_searches_exactly_as_eager() {
    let caps = [json!({"init": 16, "growth": 4}), json!({"init": 4, "growth": 1}), json!({"init": 2, "growth": 0.5})];
    let raves = [
        None,
        Some(json!({"weight": 1.0, "equivalence": 100.0, "distanceDecay": 0.0, "scope": "all"})),
        Some(json!({"weight": 1.0, "equivalence": 100.0, "distanceDecay": 0.5, "scope": "root"})),
    ];
    let mut compared = 0;
    let mut moved = 0;
    for cap in &caps {
        for rave in &raves {
            let mut lazy_cap = cap.clone();
            lazy_cap["lazy"] = json!(true);
            let mut eager = engine(config(cap.clone(), rave.clone()));
            let mut lazy = engine(config(lazy_cap, rave.clone()));
            for (i, (state, moves)) in positions(5, 1234).iter().enumerate() {
                // budget 40 × iterationScale 25.091 ≈ 1,000 iterations.
                let a = search(&mut eager, state, moves, 500 + i as u32, 40);
                let b = search(&mut lazy, state, moves, 500 + i as u32, 40);
                assert_eq!(a, b, "cap {cap} rave {rave:?} position {i}");
                let (ma, mb) = (eager.tree_memory().map(|m| m.3), lazy.tree_memory().map(|m| m.3));
                if let (Some(ma), Some(mb)) = (ma, mb) {
                    assert!(mb < ma, "lazy tree {mb} bytes not below eager {ma}");
                }
                if rave.as_ref().is_some_and(|r| r["scope"] == "all") {
                    moved += lazy.lazy_stats().map_or(0, |s| s.3);
                }
                compared += 1;
            }
        }
    }
    assert_eq!(compared, 45);
    // The pending list was exercised: AMAF pairs did wait for their edge and moved in.
    assert!(moved > 100, "only {moved} pending pairs moved");
    eprintln!("lazy identity: {compared} searches, {moved} pending pairs moved");
}

#[test]
fn lazy_is_refused_with_the_network() {
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(BASE).unwrap()).unwrap();
    v["native"]["candidates"]["interiorCap"]["lazy"] = json!(true);
    v["native"]["net"] = json!({"socket": "/nonexistent"});
    let p: Result<BitboardParams, _> = serde_json::from_value(v);
    if let Ok(p) = p {
        assert!(p.unsupported().iter().any(|r| r.contains("lazy")), "{:?}", p.unsupported());
    }
}
