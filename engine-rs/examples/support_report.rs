//! Which exported configs the native engine accepts.  cargo run --release --example support_report
use blokee::config::BitboardParams;
fn main() {
    let mut paths: Vec<_> = std::fs::read_dir(format!("{}/configs", env!("CARGO_MANIFEST_DIR"))).unwrap().map(|e| e.unwrap().path()).collect();
    paths.sort();
    let (mut ok, mut no) = (Vec::new(), Vec::new());
    for path in paths {
        let p: BitboardParams = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let problems = p.unsupported();
        if problems.is_empty() { ok.push(name) } else { no.push(format!("{name}: {}", problems.join(", "))) }
    }
    println!("supported {} of {}", ok.len(), ok.len() + no.len());
    for line in no { println!("  {line}"); }
}
