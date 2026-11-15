//! N19 check: the engine's `PriorModel::add_extras` reproduces `n19_features` for one decision.
//!   n19_check <moves.jsonl> <game index> <ply>   -> one line per legal move: id f0..f8
use blokee::feature_prior::{EXTRA_NAMES, FEATURE_NAMES, PriorBand, PriorContext, PriorModel};
use blokee::game::GameState;
use blokee::position::new_move_buffer;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let line = std::fs::read_to_string(&a[1]).unwrap().lines().filter(|l| !l.trim().is_empty()).nth(a[2].parse().unwrap()).unwrap().to_string();
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
    let target: usize = a[3].parse().unwrap();
    let mut state = GameState::new(false);
    for (ply, &mv) in moves.iter().enumerate() {
        let seat = state.turn;
        if mv < 0 { state.pass(); continue; }
        if ply == target {
            let mut p = state.to_position();
            p.force_turn(seat);
            let mut buf = new_move_buffer();
            let n = p.generate_moves(seat, &mut buf, usize::MAX);
            let ctx = PriorContext::new(&p, seat, &[]);
            let mut cols = vec![vec![0f64; n]; 9];
            for k in 0..9 {
                let mut feats: Vec<String> = FEATURE_NAMES.iter().map(|s| s.to_string()).collect();
                feats.push(EXTRA_NAMES[k].to_string());
                let mut w = vec![0.0; feats.len()];
                w[feats.len() - 1] = 1.0;
                let json = serde_json::json!({"features": feats, "bands": [{"minOwnMove": 0, "maxOwnMove": 22, "weights": w}]});
                let model: PriorModel = serde_json::from_value(json).unwrap();
                model.check().unwrap();
                let _ = PriorBand::clone;
                model.add_extras(&p, seat, ctx.own_moves, &buf[..n], &mut cols[k]);
            }
            for i in 0..n {
                println!("{} {}", buf[i], (0..9).map(|k| format!("{}", cols[k][i])).collect::<Vec<_>>().join(" "));
            }
            return;
        }
        state.apply(mv);
    }
}
