//! Bit-exact parity with the TS engine, against fixtures from `scripts/dumpGoldens.ts`.
//!
//! Floats are compared with `==` on purpose: the harness's mirror-match identity and its common
//! random numbers both need the native engine to make *identical* decisions, and the cheapest
//! evidence of that is identical arithmetic.

use blokee::bitboard::CELL_COUNT;
use blokee::config::{BitboardParams, Phase};
use blokee::engine::{Engine, MoveStats};
use blokee::features::{EvalContext, detect_phase, evaluate, refresh_context};
use blokee::game::{Policy, GameOptions, play_game};
use blokee::ordering::MoveOrderer;
use blokee::placements::placements;
use blokee::playout::Playout;
use blokee::position::{Position, new_move_buffer, zobrist};
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use blokee::search::V12Search;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

const POLICY_PATH: &str = "../ml/v41-rollout-policy.json";

fn golden(name: &str) -> Value {
    let path = format!("{}/tests/goldens/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

fn params() -> &'static HashMap<String, BitboardParams> {
    static P: OnceLock<HashMap<String, BitboardParams>> = OnceLock::new();
    P.get_or_init(|| serde_json::from_value(golden("params.json")).unwrap())
}

fn table() -> Arc<RolloutPolicy> {
    static T: OnceLock<Arc<RolloutPolicy>> = OnceLock::new();
    Arc::clone(T.get_or_init(|| Arc::new(RolloutPolicy::from_file(&format!("{}/{POLICY_PATH}", env!("CARGO_MANIFEST_DIR"))).unwrap())))
}

fn table_for(p: &BitboardParams) -> Option<Arc<RolloutPolicy>> {
    if p.search.playout_policy == "table" { Some(table()) } else { None }
}

fn fnv(words: impl IntoIterator<Item = u32>) -> u64 {
    let mut hash: u32 = 0x811c9dc5;
    for mut v in words {
        for _ in 0..4 {
            hash ^= v & 0xff;
            hash = hash.wrapping_mul(0x01000193);
            v >>= 8;
        }
    }
    hash as u64
}

fn decode(record: &Value) -> Position {
    let owners: Vec<i64> = serde_json::from_value(record["owners"].clone()).unwrap();
    let mut cells = [-1i8; CELL_COUNT];
    for (i, &o) in owners.iter().enumerate() {
        cells[i] = o as i8;
    }
    let hand: Vec<u32> = serde_json::from_value(record["hand"].clone()).unwrap();
    let last: Vec<i32> = serde_json::from_value(record["lastPiece"].clone()).unwrap();
    Position::from_cells(&cells, [hand[0], hand[1], hand[2], hand[3]], [last[0], last[1], last[2], last[3]], record["turn"].as_u64().unwrap() as usize, false)
}

fn phase_of(name: &str) -> Phase {
    serde_json::from_value(Value::String(name.into())).unwrap()
}

fn f64s(value: &Value) -> Vec<f64> {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn rng_matches() {
    let g = golden("tables.json");
    let mut rng = Rng::new(12345);
    for expected in f64s(&g["rngPrefix"]) {
        assert_eq!(rng.next_f64(), expected);
    }
}

#[test]
fn placement_table_matches() {
    let g = golden("tables.json");
    let t = placements();
    assert_eq!(t.count as u64, g["placementCount"].as_u64().unwrap());
    let flat = |v: &Vec<[u32; 13]>| v.iter().flat_map(|m| m.iter().copied()).collect::<Vec<u32>>();
    // Byte-wide TS arrays hash one word per element in `fnv`, which reads `values[i] >>> 0`.
    let check = |name: &str, actual: u64| assert_eq!(actual, g[name].as_u64().unwrap(), "{name}");
    check("cells", fnv(flat(&t.cells)));
    check("edgeHalo", fnv(flat(&t.edge_halo)));
    check("cornerHalo", fnv(flat(&t.corner_halo)));
    check("maskLo", fnv(t.mask_lo.iter().map(|&v| v as u32)));
    check("maskHi", fnv(t.mask_hi.iter().map(|&v| v as u32)));
    check("pieceId", fnv(t.piece_id.iter().map(|&v| v as u32)));
    check("orientation", fnv(t.orientation.iter().map(|&v| v as u32)));
    check("anchorX", fnv(t.anchor_x.iter().map(|&v| v as u32)));
    check("anchorY", fnv(t.anchor_y.iter().map(|&v| v as u32)));
    check("centreDistance", fnv(t.centre_distance.iter().map(|v| v.to_bits())));
    check("cellList", fnv(t.cell_list.iter().map(|&v| v as u32)));
    check("coverList", fnv(t.cover_list.iter().map(|&v| v as u32)));
    check("coverPieceStart", fnv(t.cover_piece_start.iter().map(|&v| v as u32)));
    let z = zobrist();
    check("zobristCells", fnv(z.cell_lo.iter().chain(z.cell_hi.iter()).copied()));
    check("zobristTurn", fnv(z.turn_lo.iter().chain(z.turn_hi.iter()).copied()));
    check("zobristLast", fnv(z.last_lo.iter().chain(z.last_hi.iter()).copied()));
}

#[test]
fn rollout_policy_table_matches() {
    let g = golden("rollout-policy.json");
    let p = table();
    assert_eq!(fnv(p.static_scores.iter().map(|v| v.to_bits())), g["staticScores"].as_u64().unwrap());
    assert_eq!(fnv(p.hand_slopes.iter().map(|v| v.to_bits())), g["handSlopes"].as_u64().unwrap());
    assert_eq!(fnv(p.piece_slopes.iter().map(|v| v.to_bits())), g["pieceSlopes"].as_u64().unwrap());
}

#[test]
fn positions_legality_territory_evaluation_ordering() {
    let records = golden("positions.json");
    let mut buffer = new_move_buffer();
    for (i, record) in records.as_array().unwrap().iter().enumerate() {
        let position = decode(&record["position"]);
        assert_eq!(position.hash_lo as u64, record["hashLo"].as_u64().unwrap(), "hashLo #{i}");
        assert_eq!(position.hash_hi as u64, record["hashHi"].as_u64().unwrap(), "hashHi #{i}");
        assert_eq!(position.ply as i64, record["ply"].as_i64().unwrap());
        for seat in 0..4 {
            let count = position.generate_moves(seat, &mut buffer, usize::MAX);
            let expected: Vec<i32> = serde_json::from_value(record["legal"][seat].clone()).unwrap();
            assert_eq!(&buffer[..count], &expected[..], "legal moves #{i} seat {seat}");
        }
        for (version, expected) in record["versions"].as_object().unwrap() {
            let p = &params()[version];
            let mut context = EvalContext::new(p.fractional_territory_ties);
            refresh_context(&mut context, &position, true);
            assert_eq!(context.territory.territory.to_vec(), f64s(&expected["territory"]), "territory #{i} {version}");
            assert_eq!(context.territory.contested as i64, expected["contested"].as_i64().unwrap());
            assert_eq!(context.regions.count as i64, expected["regions"].as_i64().unwrap());
            let articulation: i64 = context.articulation.iter().map(|&a| a as i64).sum();
            assert_eq!(articulation, expected["articulation"].as_i64().unwrap(), "articulation #{i}");
            assert_eq!(context.leader as i64, expected["leader"].as_i64().unwrap());
            for (pi, phase) in [Phase::Opening, Phase::Midgame, Phase::Endgame].into_iter().enumerate() {
                let values = evaluate(&mut context, &position, p, phase);
                assert_eq!(values.to_vec(), f64s(&expected["evaluations"][pi]), "evaluate #{i} {version} {phase:?}");
            }
            let phases: Vec<Phase> = (0..4).map(|s| detect_phase(&position, &context, p, s)).collect();
            let expected_phases: Vec<Phase> = expected["phases"].as_array().unwrap().iter().map(|v| phase_of(v.as_str().unwrap())).collect();
            assert_eq!(phases, expected_phases);
            let moves: Vec<i32> = serde_json::from_value(expected["orderingMoves"].clone()).unwrap();
            let mut scores = vec![0.0; moves.len()];
            MoveOrderer::new().score_moves(p, &position, &context, position.turn, &moves, &mut scores, phases[position.turn], true, 24);
            assert_eq!(scores, f64s(&expected["orderingScores"]), "ordering #{i} {version}");
        }
    }
}

#[test]
fn greedy_ranking_matches() {
    let p = params()["v4.1-ultra"].clone();
    let mut engine = Engine::new(p, Some(table())).unwrap();
    for (i, record) in golden("greedy.json").as_array().unwrap().iter().enumerate() {
        let mut position = decode(&record["position"]);
        let seat = position.turn;
        let ranked = engine.rank_greedy(&mut position, seat, 48);
        let expected = record["ranked"].as_array().unwrap();
        assert_eq!(ranked.len(), expected.len(), "greedy #{i}");
        for (a, e) in ranked.iter().zip(expected) {
            assert_eq!(a.mv as i64, e["move"].as_i64().unwrap(), "greedy move #{i}");
            assert_eq!(a.value, e["value"].as_f64().unwrap(), "greedy value #{i}");
        }
    }
}

fn golden_positions() -> Vec<Position> {
    golden("positions.json").as_array().unwrap().iter().map(|r| decode(&r["position"])).collect()
}

#[test]
fn playouts_match() {
    let positions = golden_positions();
    for record in golden("playouts.json").as_array().unwrap() {
        let version = record["version"].as_str().unwrap();
        let p = &params()[version];
        let mut playout = Playout::new(table_for(p));
        let mut context = EvalContext::new(p.fractional_territory_ties);
        let index = record["index"].as_u64().unwrap() as usize;
        let mut position = positions[index].clone();
        let mut rng = Rng::new(record["seed"].as_u64().unwrap() as u32);
        let phase = phase_of(record["phase"].as_str().unwrap());
        let outcome = playout.run(p, &mut position, &mut context, phase, None, &mut rng);
        assert_eq!(outcome.values.to_vec(), f64s(&record["values"]), "playout {version} #{index}");
        assert_eq!(outcome.terminal, record["terminal"].as_bool().unwrap());
        assert_eq!(rng.next_f64(), record["nextDraw"].as_f64().unwrap(), "rng stream after playout {version} #{index}");
        assert_eq!(position.hash_lo as u64, record["hashLo"].as_u64().unwrap(), "position restored");
    }
}

#[test]
fn searches_match() {
    let positions = golden_positions();
    for record in golden("searches.json").as_array().unwrap() {
        let version = record["version"].as_str().unwrap();
        let p = Arc::new(params()[version].clone());
        let mut search = V12Search::new(Arc::clone(&p), table_for(&p));
        let index = record["index"].as_u64().unwrap() as usize;
        let mut position = positions[index].clone();
        let seat = position.turn;
        let mut rng = Rng::new(record["seed"].as_u64().unwrap() as u32);
        let result = search.run(&mut position, seat, record["budget"].as_u64().unwrap() as u32, &mut rng);
        assert_eq!(result.iterations as u64, record["iterations"].as_u64().unwrap(), "iterations {version} #{index}");
        let expected = record["ranked"].as_array().unwrap();
        assert_eq!(result.ranked.len(), expected.len(), "ranked length {version} #{index}");
        for (a, e) in result.ranked.iter().zip(expected) {
            let e = e.as_array().unwrap();
            assert_eq!(
                (a.mv as i64, a.visits as i64, a.value),
                (e[0].as_i64().unwrap(), e[1].as_i64().unwrap(), e[2].as_f64().unwrap()),
                "ranked {version} #{index}"
            );
        }
        assert_eq!(result.best as i64, record["best"].as_i64().unwrap());
        assert_eq!(rng.next_f64(), record["nextDraw"].as_f64().unwrap(), "rng stream after search {version} #{index}");
    }
}

#[test]
fn whole_games_match() {
    for record in golden("games.json").as_array().unwrap() {
        let label = record["label"].as_str().unwrap();
        let seats: Vec<String> = serde_json::from_value(record["seats"].clone()).unwrap();
        let mut ids: Vec<String> = Vec::new();
        let mut seat_engine = [0usize; 4];
        for (seat, version) in seats.iter().enumerate() {
            seat_engine[seat] = match ids.iter().position(|v| v == version) {
                Some(i) => i,
                None => {
                    ids.push(version.clone());
                    ids.len() - 1
                }
            };
        }
        let mut pool: Vec<Engine> = ids
            .iter()
            .map(|v| {
                let p = params()[v].clone();
                let t = table_for(&p);
                Engine::new(p, t).unwrap()
            })
            .collect();
        let policy = Policy::parse(record["policy"].as_str().unwrap()).unwrap();
        let options = GameOptions {
            seed: record["seed"].as_u64().unwrap() as u32,
            opening_anywhere: false,
            iteration_budget: record["budget"].as_u64().map(|b| b as u32),
            max_plies: usize::MAX,
            opening_random_plies: 8,
            opening_top_k: 3,
        };
        let game = play_game(&mut pool, seat_engine, [policy; 4], &options).unwrap();
        let expected: Vec<i32> = serde_json::from_value(record["moves"].clone()).unwrap();
        let first_divergence = game.moves.iter().zip(&expected).position(|(a, b)| a != b);
        assert_eq!(first_divergence, None, "game {label} diverges at ply {first_divergence:?}");
        assert_eq!(game.moves, expected, "game {label} moves");
        assert_eq!(game.scores.to_vec(), f64s(&record["scores"]), "game {label} scores");
        let _ = MoveStats::default();
    }
}
