//! Hybrid H0 gate G2: encode request records with `net_features` and dump the model inputs, so
//! `ml/torch/h0_encoding_parity.py` can compare them with `ml/torch/features.py` element for element.
//!
//!   h0_encode <records.bin> <out-dir> [timing repeats]
//!
//! `records.bin` is a flat file of 512-byte records. Writes `<out-dir>/{planes.f32, hands.f32,
//! footprint.i64, pieces.i64, mask.u8, seat.i64}` (little-endian, row-major, one row per record)
//! and prints the encoding cost per record (best of the repeats, single thread).

use blokee::net_features::Inputs;
use blokee::prior::REQUEST_BYTES;
use std::io::Write;
use std::time::Instant;

fn write<T: Copy>(dir: &str, name: &str, data: &[T], bytes: impl Fn(T) -> Vec<u8>) {
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/{name}")).unwrap());
    for &v in data {
        out.write_all(&bytes(v)).unwrap();
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let (path, dir) = (&argv[1], &argv[2]);
    let repeats: usize = argv.get(3).map_or(5, |r| r.parse().unwrap());
    let raw = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    assert_eq!(raw.len() % REQUEST_BYTES, 0, "{path} is not a whole number of 512-byte records");
    let records: Vec<[u8; REQUEST_BYTES]> = raw.chunks(REQUEST_BYTES).map(|c| c.try_into().unwrap()).collect();
    std::fs::create_dir_all(dir).unwrap();

    let mut inputs = Inputs::with_capacity(records.len());
    let mut best = f64::INFINITY;
    for _ in 0..repeats.max(1) {
        inputs.clear();
        let started = Instant::now();
        for r in &records {
            inputs.push_record(r);
        }
        best = best.min(started.elapsed().as_secs_f64());
    }
    write(dir, "planes.f32", &inputs.planes, |v: f32| v.to_le_bytes().to_vec());
    write(dir, "hands.f32", &inputs.hands, |v: f32| v.to_le_bytes().to_vec());
    write(dir, "footprint.i64", &inputs.footprint, |v: i64| v.to_le_bytes().to_vec());
    write(dir, "pieces.i64", &inputs.pieces, |v: i64| v.to_le_bytes().to_vec());
    write(dir, "mask.u8", &inputs.mask, |v: bool| vec![v as u8]);
    write(dir, "seat.i64", &inputs.seat, |v: i64| v.to_le_bytes().to_vec());
    println!(
        "encoded {} records into {dir}; best of {repeats}: {:.3} us per record (one thread)",
        records.len(),
        best * 1e6 / records.len() as f64
    );
}
