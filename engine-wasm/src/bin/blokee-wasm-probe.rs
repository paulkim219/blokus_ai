//! Native twin of the .wasm, for the identity check: the same `blokee_wasm::search` code linked
//! into a native binary.
//!
//!   blokee-wasm-probe <config.json> <rollout-table.json | -> < requests.jsonl > responses.jsonl
//!
//! One request per stdin line (the JSON the app sends `blokee_search`); one line out per request,
//! `{"ms": <wall time of the call>, "response": <response JSON>}` or `{"ms": ..., "error": ...}`.
//! One engine serves every request in order, as one engine serves a version's searches in the
//! app's worker (`scripts/nativeWasmCheck.ts` feeds the .wasm the same sequence).

use std::io::{BufRead, Write};
use std::time::Instant;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 3 {
        eprintln!("usage: blokee-wasm-probe <config.json> <rollout-table.json | -> < requests.jsonl");
        std::process::exit(2);
    }
    let config = std::fs::read_to_string(&argv[1]).unwrap_or_else(|e| panic!("{}: {e}", argv[1]));
    let table = if argv[2] == "-" { None } else { Some(std::fs::read_to_string(&argv[2]).unwrap_or_else(|e| panic!("{}: {e}", argv[2]))) };
    let mut engine = blokee_wasm::create_engine(&config, table.as_deref()).unwrap_or_else(|e| panic!("{e}"));
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let started = Instant::now();
        let result = blokee_wasm::search(&mut engine, &line);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(response) => writeln!(out, "{{\"ms\":{ms:.3},\"response\":{response}}}").unwrap(),
            Err(e) => writeln!(out, "{{\"ms\":{ms:.3},\"error\":{}}}", serde_json::to_string(&e).unwrap()).unwrap(),
        }
        out.flush().unwrap();
    }
}
