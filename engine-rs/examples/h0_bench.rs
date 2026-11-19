//! Hybrid H0 gate G4: the network's cost curve by batch size, per backend.
//!
//!   h0_bench --records <records.bin> --out <rows.csv> --label <name> [--batches 1,2,4,...,512]
//!            [--modes device,host,e2e] [--min-seconds 1] [--min-calls 50] [--pool 4096]
//!            ( --model <m.onnx> --device cuda|cpu [--threads N] [--tf32 0|1] [--library <libonnxruntime.so>]
//!            | --socket <path> )
//!
//! Positions come from `records.bin` (512-byte records, as `h0_encoding_parity.py` writes them):
//! each is decoded into a `Position` with its candidate list, so the end-to-end mode starts from
//! engine positions. Modes:
//!
//! - `device` (ort cuda only): inputs already on the GPU and outputs left there (`IoBinding`):
//!   the network's own time plus launch and synchronisation, no encoding, no host-device copies;
//! - `host`: inputs already encoded in host memory; `Session::run` copies them in and the outputs
//!   back (for the socket: pre-built records through `NetClient`, the server encodes in Python);
//! - `e2e`: from `Position`s: `encode_request`, the Rust encoder, the run and the per-record
//!   `NetOutput`s, exactly the in-process evaluator's path (for the socket, its client path).
//!
//! Each (mode, batch) runs once cold (reported as `first_ms`: the first call at that shape), then 3
//! warm-up calls, then repeats for at least `--min-seconds` and `--min-calls`; the median call and
//! its 10th / 90th percentiles are written. Session creation time goes to stderr and the csv's
//! `setup` rows.

use blokee::bitboard::{CELL_COUNT, WORDS, test_bit};
use blokee::evaluator::Evaluator;
use blokee::net::NetClient;
use blokee::net_features::Inputs;
use blokee::position::{Position, SEAT_COUNT};
use blokee::prior::{MAX_CANDIDATES, REQUEST_BYTES, encode_request};
use std::collections::HashMap;
use std::io::Write;
use std::time::Instant;

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

struct Args(HashMap<String, String>);

impl Args {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(|s| s.as_str())
    }
    fn or(&self, key: &str, default: &str) -> String {
        self.get(key).unwrap_or(default).to_string()
    }
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

/// One backend: something that can run a batch in each mode.
trait Bench {
    fn host(&mut self, inputs: &Inputs, records: &[[u8; REQUEST_BYTES]], candidates: &[usize]);
    fn e2e(&mut self, positions: &[(Position, usize, Vec<i32>)]);
    /// Prepares device-resident inputs for this batch; false if the backend has no device mode.
    fn prepare_device(&mut self, _inputs: &Inputs) -> bool {
        false
    }
    fn device(&mut self) {}
}

struct SocketBench {
    client: NetClient,
}

impl Bench for SocketBench {
    fn host(&mut self, _inputs: &Inputs, records: &[[u8; REQUEST_BYTES]], candidates: &[usize]) {
        std::hint::black_box(self.client.evaluate(records, candidates).unwrap());
    }

    fn e2e(&mut self, positions: &[(Position, usize, Vec<i32>)]) {
        let records: Vec<[u8; REQUEST_BYTES]> = positions.iter().map(|(p, s, m)| encode_request(p, *s, m)).collect();
        let candidates: Vec<usize> = positions.iter().map(|(_, _, m)| m.len()).collect();
        std::hint::black_box(Evaluator::evaluate(&mut self.client, &records, &candidates).unwrap());
    }
}

#[cfg(feature = "ort")]
mod ort_bench {
    use super::*;
    use blokee::evaluator::{EvaluatorOptions, split_outputs};
    use blokee::evaluator::ort_backend::{new_session, run};
    use ort::session::IoBinding;
    use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
    use ort::session::Session;
    use ort::value::Tensor;

    pub struct OrtBench {
        pub session: Session,
        pub cuda: bool,
        pub device_id: i32,
        inputs: Inputs,
        binding: Option<IoBinding>,
    }

    impl OrtBench {
        pub fn open(options: &EvaluatorOptions) -> OrtBench {
            let session = new_session(options).unwrap_or_else(|e| panic!("{e}"));
            OrtBench { session, cuda: options.device == "cuda", device_id: options.device_id, inputs: Inputs::with_capacity(512), binding: None }
        }
    }

    impl Bench for OrtBench {
        fn host(&mut self, inputs: &Inputs, _records: &[[u8; REQUEST_BYTES]], _candidates: &[usize]) {
            std::hint::black_box(run(&mut self.session, inputs).unwrap());
        }

        fn e2e(&mut self, positions: &[(Position, usize, Vec<i32>)]) {
            self.inputs.clear();
            let mut candidates = Vec::with_capacity(positions.len());
            for (p, s, m) in positions {
                self.inputs.push_record(&encode_request(p, *s, m));
                candidates.push(m.len());
            }
            let (logits, utilities) = run(&mut self.session, &self.inputs).unwrap();
            std::hint::black_box(split_outputs(&logits, &utilities, &candidates));
        }

        fn prepare_device(&mut self, inputs: &Inputs) -> bool {
            if !self.cuda {
                return false;
            }
            let b = inputs.batch;
            let mut binding = self.session.create_binding().unwrap();
            // Owned host tensors: bind_input copies each to the GPU once, here, not per call.
            binding.bind_input("planes", &Tensor::from_array(([b, 13, 20, 20], inputs.planes.clone())).unwrap()).unwrap();
            binding.bind_input("hands", &Tensor::from_array(([b, 4, 21], inputs.hands.clone())).unwrap()).unwrap();
            binding.bind_input("footprint", &Tensor::from_array(([b, 64, 5], inputs.footprint.clone())).unwrap()).unwrap();
            binding.bind_input("pieces", &Tensor::from_array(([b, 64], inputs.pieces.clone())).unwrap()).unwrap();
            binding.bind_input("mask", &Tensor::from_array(([b, 64], inputs.mask.clone())).unwrap()).unwrap();
            binding.bind_input("seat", &Tensor::from_array(([b], inputs.seat.clone())).unwrap()).unwrap();
            let gpu = MemoryInfo::new(AllocationDevice::CUDA, self.device_id, AllocatorType::Device, MemoryType::Default).unwrap();
            binding.bind_output_to_device("logits", &gpu).unwrap();
            binding.bind_output_to_device("utilities", &gpu).unwrap();
            binding.synchronize_inputs().unwrap();
            self.binding = Some(binding);
            true
        }

        fn device(&mut self) {
            let binding = self.binding.as_ref().unwrap();
            let outputs = self.session.run_binding(binding).unwrap();
            binding.synchronize_outputs().unwrap();
            std::hint::black_box(outputs);
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = Args(argv.chunks(2).map(|c| (c[0].trim_start_matches("--").to_string(), c.get(1).cloned().unwrap_or_default())).collect());
    let label = args.or("label", "run");
    let batches: Vec<usize> = args.or("batches", "1,2,4,8,16,32,64,128,256,512").split(',').map(|b| b.parse().unwrap()).collect();
    let modes: Vec<String> = args.or("modes", "device,host,e2e").split(',').map(String::from).collect();
    let min_seconds: f64 = args.or("min-seconds", "1").parse().unwrap();
    let min_calls: usize = args.or("min-calls", "50").parse().unwrap();
    let pool: usize = args.or("pool", "4096").parse().unwrap();

    let raw = std::fs::read(args.get("records").expect("--records")).unwrap();
    let records: Vec<[u8; REQUEST_BYTES]> = raw
        .chunks(REQUEST_BYTES)
        .map(|c| <[u8; REQUEST_BYTES]>::try_from(c).unwrap())
        .filter(|r| r[236] >= 2)
        .take(pool)
        .collect();
    let positions: Vec<(Position, usize, Vec<i32>)> = records.iter().map(|r| decode(r)).collect();
    // The record `encode_request` builds from the decoded position equals the stored one in every
    // field the network reads; check it so the modes are comparable.
    for (r, (p, s, m)) in records.iter().zip(&positions) {
        let again = encode_request(p, *s, m);
        assert!(again[6] == r[6] && again[8..237] == r[8..237] && again[240..240 + 2 * m.len()] == r[240..240 + 2 * m.len()]);
    }

    let setup = Instant::now();
    let (mut bench, backend): (Box<dyn Bench>, String) = if let Some(socket) = args.get("socket") {
        (Box::new(SocketBench { client: NetClient::connect(socket).unwrap() }), format!("socket {socket}"))
    } else {
        #[cfg(feature = "ort")]
        {
            let options = blokee::evaluator::EvaluatorOptions {
                backend: "ort".into(),
                model: args.get("model").expect("--model").into(),
                device: args.or("device", "cpu"),
                device_id: 0,
                threads: args.or("threads", "0").parse().unwrap(),
                tf32: args.or("tf32", "0") == "1",
                library: args.get("library").map(String::from),
                format: None,
                head: None,
            };
            (Box::new(ort_bench::OrtBench::open(&options)), format!("ort {} threads={} tf32={} {}", options.device, options.threads, options.tf32, options.model))
        }
        #[cfg(not(feature = "ort"))]
        panic!("built without the ort feature: only --socket");
    };
    let setup_ms = setup.elapsed().as_secs_f64() * 1e3;
    eprintln!("[{label}] {backend}: setup {setup_ms:.1} ms, {} positions in the pool", positions.len());

    let path = args.get("out").expect("--out");
    let fresh = !std::path::Path::new(path).exists();
    let mut out = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    if fresh {
        writeln!(out, "label,backend,mode,batch,calls,first_ms,median_us,p10_us,p90_us,us_per_position,positions_per_s").unwrap();
    }
    writeln!(out, "{label},{backend},setup,0,1,{setup_ms:.3},,,,,").unwrap();

    for mode in &modes {
        for &b in &batches {
            let window = |k: usize| -> std::ops::Range<usize> {
                let start = (k * b) % positions.len().saturating_sub(b).max(1);
                start..start + b
            };
            let mut inputs = Inputs::with_capacity(b);
            for r in &records[window(0)] {
                inputs.push_record(r);
            }
            let fixed_records = &records[window(0)];
            let candidates: Vec<usize> = fixed_records.iter().map(|r| r[236] as usize).collect();
            if mode == "device" && !bench.prepare_device(&inputs) {
                continue;
            }
            let call = |bench: &mut Box<dyn Bench>, k: usize| match mode.as_str() {
                "device" => bench.device(),
                "host" => bench.host(&inputs, fixed_records, &candidates),
                "e2e" => bench.e2e(&positions[window(k)]),
                other => panic!("mode {other}"),
            };
            let t = Instant::now();
            call(&mut bench, 0);
            let first_ms = t.elapsed().as_secs_f64() * 1e3;
            for k in 1..4 {
                call(&mut bench, k);
            }
            let mut times = Vec::new();
            let started = Instant::now();
            let mut k = 4;
            while times.len() < min_calls || started.elapsed().as_secs_f64() < min_seconds {
                let t = Instant::now();
                call(&mut bench, k);
                times.push(t.elapsed().as_secs_f64() * 1e6);
                k += 1;
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let median = percentile(&times, 0.5);
            let row = format!(
                "{label},{backend},{mode},{b},{},{first_ms:.3},{median:.1},{:.1},{:.1},{:.2},{:.0}",
                times.len(),
                percentile(&times, 0.1),
                percentile(&times, 0.9),
                median / b as f64,
                b as f64 * 1e6 / median
            );
            eprintln!("{row}");
            writeln!(out, "{row}").unwrap();
        }
    }
}
