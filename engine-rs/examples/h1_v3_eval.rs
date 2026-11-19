//! Hybrid H1 parity: the engine's network-v3 path (Rust encoder, `net_v3` policy table, ONNX Runtime)
//! on recorded positions, for `ml/torch/h1_parity.py` to compare against PyTorch.
//!
//!   cargo run --release --features ort --example h1_v3_eval -- <model.onnx> <cuda|cpu> <run-dir> <out-prefix> [limit] [tf32]
//!
//! Reads the first `limit` (default all) records of the run's v3 shards in file order and writes:
//!   <out-prefix>.logits.f32      per record, per listed move: [policy head, teacher head] logits (f32 LE)
//!   <out-prefix>.utilities.f32   per record: 12 utilities from the teacher-head evaluator
//!   <out-prefix>.index.jsonl     per record: shard, game, ply, number of moves
//!   <out-prefix>.policy_table.u16  the engine's policy table: 4 seats × placements, u16 LE
//! It also checks that `Evaluator::evaluate_moves` (as the search calls it) returns exactly the
//! logits read from the raw session outputs, for both heads.

#[cfg(feature = "ort")]
fn main() {
    use blokee::evaluator::{EvaluatorOptions, open, ort_backend};
    use blokee::net_features::Inputs;
    use blokee::net_v3::{POLICY_SIZE, policy_table};
    use blokee::prior::REQUEST_BYTES;
    use blokee::record_v3::RecordV3;
    use std::io::Write;

    let argv: Vec<String> = std::env::args().collect();
    let (model, device, run, out) = (&argv[1], &argv[2], &argv[3], &argv[4]);
    let limit: usize = argv.get(5).map_or(usize::MAX, |s| s.parse().unwrap());
    let tf32 = argv.get(6).is_some_and(|s| s == "tf32");
    let options = |head: &str| EvaluatorOptions {
        backend: "ort".into(),
        model: model.clone(),
        device: device.clone(),
        device_id: 0,
        threads: 0,
        tf32,
        library: None,
        format: Some("v3".into()),
        head: Some(head.into()),
    };
    let mut shards: Vec<_> = std::fs::read_dir(run).unwrap().map(|e| e.unwrap().path()).filter(|p| {
        p.file_name().unwrap().to_string_lossy().starts_with("v3-shard-")
    }).collect();
    shards.sort();
    let mut records: Vec<(String, RecordV3)> = Vec::new();
    'outer: for path in &shards {
        let bytes = std::fs::read(path).unwrap();
        let mut at = 0;
        while at < bytes.len() {
            let (r, len) = RecordV3::decode(&bytes[at..]).unwrap();
            at += len;
            records.push((path.file_name().unwrap().to_string_lossy().to_string(), r));
            if records.len() >= limit {
                break 'outer;
            }
        }
    }
    let request = |r: &RecordV3| -> [u8; REQUEST_BYTES] {
        let mut q = [0u8; REQUEST_BYTES];
        q[6] = r.seat;
        let mut at = 8;
        for s in 0..4 {
            for w in 0..13 {
                q[at..at + 4].copy_from_slice(&r.own[s][w].to_le_bytes());
                at += 4;
            }
        }
        for s in 0..4 {
            q[at..at + 4].copy_from_slice(&r.hand[s].to_le_bytes());
            at += 4;
        }
        for s in 0..4 {
            q[at] = r.last_piece[s] as u8;
            at += 1;
        }
        q
    };
    let mut session = ort_backend::new_session(&options("teacher")).unwrap_or_else(|e| panic!("{e}"));
    let mut teacher_eval = open(&options("teacher")).unwrap_or_else(|e| panic!("{e}"));
    let mut policy_eval = open(&options("policy")).unwrap_or_else(|e| panic!("{e}"));
    let table = policy_table();
    let mut logits_out = std::io::BufWriter::new(std::fs::File::create(format!("{out}.logits.f32")).unwrap());
    let mut util_out = std::io::BufWriter::new(std::fs::File::create(format!("{out}.utilities.f32")).unwrap());
    let mut index_out = std::io::BufWriter::new(std::fs::File::create(format!("{out}.index.jsonl")).unwrap());
    let mut inputs = Inputs::with_capacity(64);
    let (mut checked, started) = (0usize, std::time::Instant::now());
    for chunk in records.chunks(64) {
        let reqs: Vec<[u8; REQUEST_BYTES]> = chunk.iter().map(|(_, r)| request(r)).collect();
        let moves: Vec<Vec<i32>> = chunk.iter().map(|(_, r)| r.moves.iter().map(|&m| m as i32).collect()).collect();
        let lists: Vec<&[i32]> = moves.iter().map(|m| &m[..]).collect();
        inputs.clear();
        for q in &reqs {
            inputs.push_board(q);
        }
        let (pol, _) = ort_backend::run_v3(&mut session, &inputs, "policy").unwrap();
        let (tea, util) = ort_backend::run_v3(&mut session, &inputs, "teacher").unwrap();
        let via_teacher = teacher_eval.evaluate_moves(&reqs, &lists).unwrap();
        let via_policy = policy_eval.evaluate_moves(&reqs, &lists).unwrap();
        for (i, (shard, r)) in chunk.iter().enumerate() {
            let mover = r.seat as usize;
            for (k, &m) in moves[i].iter().enumerate() {
                let slot = i * POLICY_SIZE + table.policy[mover][m as usize] as usize;
                let (p, t) = (pol[slot], tea[slot]);
                assert_eq!(via_policy[i].logits[k].to_bits(), p.to_bits(), "evaluate_moves (policy) differs from the raw output");
                assert_eq!(via_teacher[i].logits[k].to_bits(), t.to_bits(), "evaluate_moves (teacher) differs from the raw output");
                logits_out.write_all(&p.to_le_bytes()).unwrap();
                logits_out.write_all(&t.to_le_bytes()).unwrap();
            }
            for u in 0..12 {
                assert_eq!(via_teacher[i].utility[u].to_bits(), util[i * 12 + u].to_bits());
                util_out.write_all(&util[i * 12 + u].to_le_bytes()).unwrap();
            }
            writeln!(index_out, "{{\"shard\":\"{shard}\",\"game\":{},\"ply\":{},\"n\":{}}}", r.game, r.ply, moves[i].len()).unwrap();
            checked += 1;
        }
    }
    let mut t_out = std::io::BufWriter::new(std::fs::File::create(format!("{out}.policy_table.u16")).unwrap());
    for s in 0..4 {
        for &v in &table.policy[s] {
            t_out.write_all(&v.to_le_bytes()).unwrap();
        }
    }
    eprintln!("h1_v3_eval: {checked} records ({device}, tf32 {tf32}) in {:.1}s; evaluate_moves equals the raw outputs bit for bit", started.elapsed().as_secs_f64());
}

#[cfg(not(feature = "ort"))]
fn main() {
    eprintln!("h1_v3_eval needs --features ort");
}
