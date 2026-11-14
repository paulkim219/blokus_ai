//! P9/P10 gates: the identity points of `native.selection`, the interior keys of `native.candidates`
//! and `native.opening` search exactly as the base config; the selection cut-off at 1 is exact (no
//! choice changes, under PUCT and under "priorLog"); P4 at interior nodes gives interior nodes every
//! legal move; the centre rule leaves only the most central moves at the root; the large-piece rollout
//! rule is live; `unsupported()` refuses the bad combinations.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::game::GameState;
use blokee::placements::placements;
use blokee::position::MAX_MOVES;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use serde_json::{Value, json};
use std::sync::Arc;

const BASE: &str = "configs/v5.0-p4-ultra.json";

/// The base config with each `(dotted path, value)` set.
fn config(changes: &[(&str, Value)]) -> BitboardParams {
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(BASE).unwrap()).unwrap();
    v["search"]["playoutTablePath"] = json!("../ml/v41-rollout-policy.json");
    for (path, x) in changes {
        let keys: Vec<&str> = path.split('.').collect();
        let mut node = &mut v;
        for k in &keys[..keys.len() - 1] {
            if node.get(*k).is_none() {
                node[*k] = json!({});
            }
            node = node.get_mut(*k).unwrap();
        }
        node[keys[keys.len() - 1]] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn engine(p: BitboardParams) -> Engine {
    let table = Arc::new(RolloutPolicy::from_file(p.search.playout_table_path.as_ref().unwrap()).unwrap());
    Engine::new(p, Some(table)).unwrap()
}

/// Positions a few random moves into a game, with the seat to move having a move.
fn positions(count: usize, seed: u32, min: usize, spread: usize) -> Vec<(GameState, Vec<i32>)> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::new();
    let mut buffer = vec![0i32; MAX_MOVES];
    while out.len() < count {
        let mut state = GameState::new(false);
        let mut moves = Vec::new();
        let stop = min + if spread > 0 { rng.next_int(spread) } else { 0 };
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

fn interior() -> Vec<(&'static str, Value)> {
    vec![
        ("native.candidates.interiorFull", json!(true)),
        ("native.candidates.interiorScorer", json!("fitted")),
        ("native.candidates.interiorNoWidening", json!(true)),
        ("native.candidates.interiorInitVisits", json!(3.0)),
    ]
}

/// Interior expansion + RAVE + the all-moves rollout + rank reward + last-good-reply (the package
/// without its selection rule, which each case adds).
fn package() -> Vec<(&'static str, Value)> {
    let mut v = interior();
    v.push(("native.rave", json!({"weight": 0.5, "equivalence": 100.0, "distanceDecay": 0.5, "scope": "all"})));
    v.push(("native.rollout", json!({"policy": "all", "sizeWeight": 1.3995, "localWeight": 0.7185, "localOwnExtra": 0.6515})));
    v.push(("native.reward", json!({"kind": "rank", "qualityWeight": 0.25, "qualitySlope": 1.0, "lengthWeight": 0.1})));
    v.push(("native.lastGoodReply", json!({"enabled": true, "forget": true})));
    v
}

#[test]
fn package_is_live_and_rave_reaches_interior_edges() {
    let mut base = engine(config(&interior()));
    let mut pkg = engine(config(&{ let mut v = package(); v.push(prior_log(0.2, 1.0)); v }));
    let mut differ = 0;
    for (i, (state, moves)) in positions(6, 5150, 16, 30).iter().enumerate() {
        let a = search(&mut base, state, moves, 60 + i as u32, 20);
        let b = search(&mut pkg, state, moves, 60 + i as u32, 20);
        assert!(!b.is_empty());
        differ += (a != b) as usize;
        let stats = pkg.root_edge_stats().unwrap();
        assert!(stats.iter().any(|s| s.1 > 0.0), "root AMAF statistics");
    }
    assert!(differ >= 4, "package differs from interior expansion alone: {differ}");
}

fn prior_log(c: f64, cutoff: f64) -> (&'static str, Value) {
    ("native.selection", json!({"rule": "priorLog", "exploration": c, "scope": "all", "countOffset": 1.0, "cutoff": cutoff}))
}

#[test]
fn identity_points_search_like_the_base() {
    let mut base = engine(config(&[]));
    let mut id = engine(config(&[
        ("native.selection", json!({"rule": "puct", "exploration": 0.3, "scope": "root", "countOffset": 2.0, "cutoff": 0.0})),
        ("native.candidates.interiorFull", json!(false)),
        ("native.candidates.interiorNoWidening", json!(false)),
        ("native.candidates.interiorInitVisits", json!(0.0)),
        ("native.opening", json!({"centreMaxOwnMove": 0.0, "centreSlack": 2.0, "rolloutMinSize": 5.0, "rolloutUntilPieces": 0.0})),
    ]));
    for (i, (state, moves)) in positions(12, 4242, 16, 40).iter().enumerate() {
        let a = search(&mut base, state, moves, 900 + i as u32, 20);
        let b = search(&mut id, state, moves, 900 + i as u32, 20);
        assert_eq!(a, b, "position {i}");
    }
}

#[test]
fn exact_cutoff_changes_no_choice() {
    let cases: Vec<(Vec<(&str, Value)>, Vec<(&str, Value)>)> = vec![
        (vec![], vec![("native.selection", json!({"rule": "puct", "cutoff": 1.0}))]),
        (vec![prior_log(0.2, 0.0)], vec![prior_log(0.2, 1.0)]),
        ({ let mut v = interior(); v.push(prior_log(0.4, 0.0)); v }, { let mut v = interior(); v.push(prior_log(0.4, 1.0)); v }),
        (interior(), { let mut v = interior(); v.push(("native.selection", json!({"rule": "puct", "cutoff": 1.0}))); v }),
        // Package (2026-11-14): with RAVE blended into Q the cut-off is still exact.
        ({ let mut v = package(); v.push(prior_log(0.2, 0.0)); v }, { let mut v = package(); v.push(prior_log(0.2, 1.0)); v }),
    ];
    for (k, (off, on)) in cases.iter().enumerate() {
        let mut a = engine(config(off));
        let mut b = engine(config(on));
        for (i, (state, moves)) in positions(8, 1717, 16, 40).iter().enumerate() {
            let x = search(&mut a, state, moves, 300 + i as u32, 20);
            let y = search(&mut b, state, moves, 300 + i as u32, 20);
            assert_eq!(x, y, "case {k}, position {i}");
            assert_eq!(a.tree_shape().map(|s| s.depth_mean), b.tree_shape().map(|s| s.depth_mean));
        }
    }
}

#[test]
fn prior_log_rule_and_interior_expansion_are_live() {
    let mut base = engine(config(&[]));
    let mut sel = engine(config(&[prior_log(0.2, 1.0)]));
    let mut full = engine(config(&interior()));
    let (mut differ_sel, mut differ_full, mut wide) = (0, 0, 0);
    for (i, (state, moves)) in positions(6, 2024, 16, 30).iter().enumerate() {
        let a = search(&mut base, state, moves, 40 + i as u32, 20);
        let b = search(&mut sel, state, moves, 40 + i as u32, 20);
        let c = search(&mut full, state, moves, 40 + i as u32, 20);
        differ_sel += (a != b) as usize;
        differ_full += (a != c) as usize;
        let s = full.tree_shape().unwrap();
        // Interior nodes hold every legal move (more than the base's 24 in these positions).
        if s.interior_nodes > 0 && s.interior_edges as f64 / s.interior_nodes as f64 > 24.0 {
            wide += 1;
        }
        let sb = base.tree_shape().unwrap();
        assert!(sb.interior_nodes == 0 || sb.interior_edges <= 24 * sb.interior_nodes, "base interior nodes keep at most 24 moves");
    }
    assert!(differ_sel >= 4 && differ_full >= 4, "selection {differ_sel}, interior {differ_full}");
    assert!(wide >= 4, "interior nodes with all legal moves: {wide}");
}

#[test]
fn centre_rule_keeps_only_the_most_central_moves() {
    let t = placements();
    let mut e = engine(config(&[
        ("native.opening", json!({"centreMaxOwnMove": 3.0, "centreSlack": 0.0})),
        ("search.openingHeuristicMaxOwnMove", json!(0)),
    ]));
    let mut base_open = engine(config(&[("search.openingHeuristicMaxOwnMove", json!(0))]));
    let mut buffer = vec![0i32; MAX_MOVES];
    for (i, (state, moves)) in positions(6, 99, 0, 9).iter().enumerate() {
        let seat = state.turn;
        let own = 21 - state.board.hand[seat].count_ones();
        let ranked = search(&mut e, state, moves, 7 + i as u32, 4);
        let n = state.board.generate_moves(seat, &mut buffer, MAX_MOVES);
        let min = buffer[..n].iter().map(|&m| t.centre_distance[m as usize]).fold(f32::INFINITY, f32::min);
        let wide = search(&mut base_open, state, moves, 7 + i as u32, 4);
        if own < 3 {
            assert!(!ranked.is_empty());
            assert!(ranked.iter().all(|r| t.centre_distance[r.0 as usize] <= min), "position {i}: a non-central candidate");
            assert!(ranked.len() < wide.len(), "position {i}: the rule removed nothing");
        } else {
            assert_eq!(ranked.len(), wide.len(), "position {i}: rule active at own move {own}");
        }
    }
}

#[test]
fn large_piece_rollout_rule_is_live() {
    let mut base = engine(config(&[]));
    let mut rule = engine(config(&[("native.opening", json!({"rolloutMinSize": 5.0, "rolloutUntilPieces": 31.0}))]));
    let mut differ = 0;
    // Early positions (about 12-20 pieces on the board), where the rule acts.
    for (i, (state, moves)) in positions(6, 31, 12, 8).iter().enumerate() {
        let a = search(&mut base, state, moves, 5 + i as u32, 10);
        let b = search(&mut rule, state, moves, 5 + i as u32, 10);
        differ += (a != b) as usize;
    }
    assert!(differ >= 4, "{differ}");
    // Late positions (more than 31 pieces on the board): the rule is off, the search unchanged.
    for (i, (state, moves)) in positions(4, 77, 60, 10).iter().enumerate() {
        let on_board: u32 = state.board.hand.iter().map(|h| 21 - h.count_ones()).sum();
        if on_board < 31 {
            continue;
        }
        let a = search(&mut base, state, moves, 9 + i as u32, 10);
        let b = search(&mut rule, state, moves, 9 + i as u32, 10);
        assert_eq!(a, b, "late position {i}");
    }
}

#[test]
fn unsupported_combinations_are_refused() {
    let refused = |c: &[(&str, Value)]| !config(c).unsupported().is_empty();
    assert!(!refused(&interior()));
    assert!(!refused(&[prior_log(0.2, 1.0)]));
    assert!(refused(&[("native.candidates.interiorFull", json!(true))]), "interiorFull needs the fitted scorer");
    assert!(refused(&[("native.candidates.interiorInitVisits", json!(-1.0))]));
    assert!(refused(&[("native.selection", json!({"rule": "ucb"}))]));
    assert!(refused(&[("native.selection", json!({"rule": "priorLog", "exploration": 0.0}))]));
    assert!(refused(&[("native.selection", json!({"rule": "priorLog", "scope": "leaves"}))]));
    assert!(refused(&[("native.selection", json!({"rule": "priorLog", "countOffset": 0.0}))]));
    assert!(refused(&[("native.selection", json!({"rule": "puct", "cutoff": 1.5}))]));
    // Package (2026-11-14): priorLog and value-initialised interior children work with RAVE.
    assert!(!refused(&[prior_log(0.2, 1.0), ("native.rave", json!({"weight": 0.5}))]));
    let mut pkg = interior();
    pkg.push(prior_log(0.2, 1.0));
    pkg.push(("native.rave", json!({"weight": 0.5, "equivalence": 100.0, "distanceDecay": 0.5, "scope": "all"})));
    assert!(!refused(&pkg));
    assert!(refused(&[("native.opening", json!({"centreSlack": -1.0}))]));
    assert!(refused(&[("native.opening", json!({"rolloutMinSize": 6.0}))]));
    assert!(refused(&[("native.opening", json!({"rolloutMinSize": 5.0, "rolloutUntilPieces": 31.0})), ("native.rollout", json!({"policy": "all", "sizeWeight": 1.0}))]));
    assert!(refused(&[("native.opening", json!({"rolloutMinSize": 5.0, "rolloutUntilPieces": 31.0})), ("native.lastGoodReply", json!({"enabled": true}))]));
    for block in ["selection", "opening"] {
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(BASE).unwrap()).unwrap();
        v["native"][block] = json!({"typo": 3});
        assert!(serde_json::from_value::<BitboardParams>(v).is_err(), "unknown keys in native.{block} are refused");
    }
}
