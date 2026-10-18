//! Probes `jsmath` against values printed by the local Node:
//!   node -e '<writes {xs, ex, pb, pe, pv}>' && cargo run --release --example mathcheck -- probe.json
use blokee::jsmath;
fn main() {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap()).unwrap();
    let get = |k: &str| -> Vec<f64> { serde_json::from_value(v[k].clone()).unwrap() };
    let (xs, ex, pb, pe, pv) = (get("xs"), get("ex"), get("pb"), get("pe"), get("pv"));
    let bad_exp = xs.iter().zip(&ex).filter(|(x, e)| jsmath::exp(**x).to_bits() != e.to_bits()).count();
    let bad_pow = (0..pb.len()).filter(|&i| jsmath::pow(pb[i], pe[i]).to_bits() != pv[i].to_bits()).count();
    println!("exp mismatches {bad_exp}/{}  pow mismatches {bad_pow}/{}", xs.len(), pb.len());
}
