//! Hybrid H0 gate G3d: the same positions through two `native.net` evaluators (normally the
//! `serve.py --protocol 2` socket and an in-process `ort` evaluator), compared output for output.
//!
//!   h0_e2e <records.bin> <positions> <batch> <net-a.json> <net-b.json>
//!
//! Each `net-*.json` is a `native.net` block (`{"socket": ...}` or `{"evaluator": {...}}`). Positions
//! are the first `<positions>` records with at least two candidates, decoded into `Position`s and
//! re-encoded with `encode_request`, the engine's own path; they go in calls of `<batch>` records
//! (1 is E6's root-prior call, 41 roughly a call with child records). Prints one JSON line.

use blokee::bitboard::{CELL_COUNT, WORDS, test_bit};
use blokee::evaluator::connect;
use blokee::net::NetOptions;
use blokee::position::{Position, SEAT_COUNT};
use blokee::prior::{MAX_CANDIDATES, REQUEST_BYTES, encode_request};

fn decode(r: &[u8]) -> (Position, usize, Vec<i32>) {
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
    let n = (r[236] as usize).min(MAX_CANDIDATES);
    let moves = (0..n).map(|i| u16::from_le_bytes([r[240 + 2 * i], r[241 + 2 * i]]) as i32).collect();
    (Position::from_cells(&owners, hand, last, seat, false), seat, moves)
}

fn argmax(v: &[f32]) -> usize {
    (0..v.len()).fold(0, |best, i| if v[i] > v[best] { i } else { best })
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (path, wanted, batch) = (&argv[1], argv[2].parse::<usize>().unwrap(), argv[3].parse::<usize>().unwrap());
    let load = |p: &str| -> NetOptions { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap_or_else(|e| panic!("{p}: {e}")) };
    let (a_options, b_options) = (load(&argv[4]), load(&argv[5]));
    let mut a = connect(&a_options).unwrap_or_else(|e| panic!("a: {e}"));
    let mut b = connect(&b_options).unwrap_or_else(|e| panic!("b: {e}"));

    let raw = std::fs::read(path).unwrap();
    let positions: Vec<(Position, usize, Vec<i32>)> =
        raw.chunks(REQUEST_BYTES).filter(|r| r[236] >= 2).take(wanted).map(decode).collect();
    let (mut logit_max, mut utility_max, mut prior_max, mut top1_same, mut n) = (0f64, 0f64, 0f64, 0usize, 0usize);
    for chunk in positions.chunks(batch) {
        let records: Vec<[u8; REQUEST_BYTES]> = chunk.iter().map(|(p, s, m)| encode_request(p, *s, m)).collect();
        let sizes: Vec<usize> = chunk.iter().map(|(_, _, m)| m.len()).collect();
        let out_a = a.evaluate(&records, &sizes).unwrap();
        let out_b = b.evaluate(&records, &sizes).unwrap();
        for (x, y) in out_a.iter().zip(&out_b) {
            assert_eq!(x.logits.len(), y.logits.len());
            for (p, q) in x.logits.iter().zip(&y.logits) {
                logit_max = logit_max.max((p - q).abs() as f64);
            }
            for (p, q) in x.utility.iter().zip(&y.utility) {
                utility_max = utility_max.max((p - q).abs() as f64);
            }
            // The root prior the search would blend in: softmax at temperature 1.
            let soft = |l: &[f32]| -> Vec<f64> {
                let m = l.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as f64;
                let e: Vec<f64> = l.iter().map(|&v| (v as f64 - m).exp()).collect();
                let s: f64 = e.iter().sum();
                e.iter().map(|v| v / s).collect()
            };
            for (p, q) in soft(&x.logits).iter().zip(soft(&y.logits)) {
                prior_max = prior_max.max((p - q).abs());
            }
            top1_same += (argmax(&x.logits) == argmax(&y.logits)) as usize;
            n += 1;
        }
    }
    println!(
        "{{\"a\": \"{}\", \"b\": \"{}\", \"positions\": {n}, \"batch\": {batch}, \"logitsMaxAbs\": {logit_max:.3e}, \"utilitiesMaxAbs\": {utility_max:.3e}, \"priorMaxAbs\": {prior_max:.3e}, \"top1Agreement\": {:.6}}}",
        a.describe(),
        b.describe(),
        top1_same as f64 / n as f64
    );
}
