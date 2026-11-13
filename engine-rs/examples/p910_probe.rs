//! P9/P10 tree-shape diagnostics (no strength claims).
//!
//!   p910_probe shape <moves.jsonl> <positions> <out.csv> <config.json>...
//!   p910_probe pentobi <moves.jsonl> <positions> <out.csv> <pentobi-gtp> <level> <work-dir>
//!
//! Positions: the lone Blokee seat's decisions at own moves 3–20 in a `blokee-pentobi --moves-out`
//! file, sampled evenly (as `p67_probe stats`). `shape`: each config searches each position at budget
//! 300 with the same RNG seed as `p4_cost`, and one CSV row describes the tree it left (`TreeShape`).
//! `pentobi`: a fresh `pentobi-gtp` per position (level as given, one thread, book off, subtree reuse
//! off, seed 1), the game replayed with `play`, `genmove` for the lone seat's colour, then the tree is
//! read back with `save_tree` and the search statistics from the engine's log (`Sim`, `Vst`, `Dp`).
//! Pentobi is only driven through its GTP commands; nothing of it is modified. Same CSV columns.
//! Run from the repo root.

use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::game::{GameState, recent_placements};
use blokee::gtp::{Gtp, Mapping};
use blokee::position::SEAT_COLORS;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use blokee::search::TreeShape;
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

const DEPTHS: usize = 8;

fn load(path: &str) -> Engine {
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(p)) => Some(Arc::new(RolloutPolicy::from_file(p).unwrap())),
        _ => None,
    };
    Engine::new(params, table).unwrap()
}

/// (seed, moves before the decision, seat, own move index)
fn jobs(path: &str, wanted: usize) -> Vec<(u32, Vec<i32>, usize, u32)> {
    let mut jobs = Vec::new();
    for l in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
        let v: serde_json::Value = serde_json::from_str(l).unwrap();
        let lone = SEAT_COLORS.iter().position(|c| *c == v["seat"].as_str().unwrap()).unwrap();
        let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
        let mut state = GameState::new(false);
        for (ply, &mv) in moves.iter().enumerate() {
            let seat = state.turn;
            if seat == lone && mv >= 0 {
                let own = 21 - state.board.hand[seat].count_ones();
                if (3..=20).contains(&own) {
                    jobs.push((v["seed"].as_u64().unwrap() as u32, moves[..ply].to_vec(), seat, own));
                }
            }
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
    }
    let step = (jobs.len() / wanted).max(1);
    jobs.into_iter().step_by(step).take(wanted).collect()
}

fn header() -> String {
    let mut h = String::from("pos,seed,own_idx,config,iterations,root_visits,depth_mean,depth_max,root_edges,root_visited,root_50,root_90,root_top_share");
    for d in 1..=DEPTHS {
        h += &format!(",pv{d}");
    }
    for d in 1..=DEPTHS {
        h += &format!(",vd{d}");
    }
    for d in 1..=DEPTHS {
        h += &format!(",nd{d}");
    }
    h += ",interior_nodes,interior_edges,interior_visited,busy_nodes,busy_edges,busy_visited,busy_top_share_sum,nodes_total,ms";
    h
}

fn row(pos: usize, seed: u32, own: u32, config: &str, s: &TreeShape, root_visits: f64, ms: f64) -> String {
    let at = |v: &Vec<f64>, d: usize| v.get(d).copied().unwrap_or(0.0);
    let mut r = format!(
        "{pos},{seed},{own},{config},{},{root_visits},{:.4},{},{},{},{},{},{:.4}",
        s.iterations, s.depth_mean, s.depth_max, s.root_edges, s.root_visited, s.root_50, s.root_90, s.root_top_share
    );
    for d in 0..DEPTHS {
        r += &format!(",{}", at(&s.pv_visits, d));
    }
    for d in 1..=DEPTHS {
        r += &format!(",{}", at(&s.visits_by_depth, d));
    }
    for d in 1..=DEPTHS {
        r += &format!(",{}", s.nodes_by_depth.get(d).copied().unwrap_or(0));
    }
    r += &format!(
        ",{},{},{},{},{},{},{:.4},{},{ms:.2}",
        s.interior_nodes, s.interior_edges, s.interior_visited, s.busy_nodes, s.busy_edges, s.busy_visited, s.busy_top_share_sum, s.nodes_total
    );
    r
}

fn shape(argv: &[String]) {
    let (moves_path, wanted, out) = (&argv[2], argv[3].parse::<usize>().unwrap(), &argv[4]);
    let configs: Vec<String> = argv[5..].to_vec();
    let mut engines: Vec<Engine> = configs.iter().map(|c| load(c)).collect();
    let jobs = jobs(moves_path, wanted);
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "{}", header()).unwrap();
    for (i, (seed, prefix, seat, own)) in jobs.iter().enumerate() {
        let mut state = GameState::new(false);
        for &mv in prefix {
            if mv >= 0 { state.apply(mv) } else { state.pass() }
        }
        for (k, engine) in engines.iter_mut().enumerate() {
            let mut position = state.to_position();
            // The seed `p4_cost` and `p67_probe stats` use for this position.
            let mut rng = Rng::new(*seed ^ (prefix.len() as u32).wrapping_mul(0x9e37_79b9));
            let mut st = MoveStats::default();
            engine.set_recent(&recent_placements(prefix));
            let started = Instant::now();
            engine.search(&mut position, *seat, 300, &mut rng, &mut st);
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            let Some(s) = engine.tree_shape() else { continue };
            let root_visits = s.visits_by_depth.first().copied().unwrap_or(0.0);
            let name = std::path::Path::new(&configs[k]).file_stem().unwrap().to_string_lossy().to_string();
            writeln!(w, "{}", row(i, *seed, *own, &name, &s, root_visits, ms)).unwrap();
        }
        w.flush().unwrap();
    }
    eprintln!("p910_probe shape: {} positions, configs: {}; wrote {out}", jobs.len(), configs.join(" "));
}

/// A node of Pentobi's `save_tree` output: visits, parent, depth, children.
struct TNode {
    visits: f64,
    depth: usize,
    children: Vec<usize>,
}

/// Reads the SGF tree `save_tree` writes: every node `;` with a comment `C[Visits: n ...]`, each
/// child in its own variation. Depth 0 is the root.
fn parse_tree(text: &str) -> Vec<TNode> {
    let bytes = text.as_bytes();
    let mut nodes: Vec<TNode> = Vec::new();
    let mut stack: Vec<Option<usize>> = Vec::new();
    let mut cur: Option<usize> = None;
    let mut ident = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '(' => {
                stack.push(cur);
                ident.clear();
            }
            ')' => {
                cur = stack.pop().unwrap_or(None);
                ident.clear();
            }
            ';' => {
                let depth = cur.map_or(0, |p| nodes[p].depth + 1);
                nodes.push(TNode { visits: 0.0, depth, children: Vec::new() });
                let id = nodes.len() - 1;
                if let Some(p) = cur {
                    nodes[p].children.push(id);
                }
                cur = Some(id);
                ident.clear();
            }
            '[' => {
                let start = i + 1;
                let mut j = start;
                while j < bytes.len() && !(bytes[j] == b']' && bytes[j - 1] != b'\\') {
                    j += 1;
                }
                if ident == "C"
                    && let Some(id) = cur
                {
                    let value = &text[start..j];
                    if let Some(rest) = value.strip_prefix("Visits:") {
                        let n = rest.split_whitespace().next().unwrap_or("0");
                        nodes[id].visits = n.parse().unwrap_or(0.0);
                    }
                }
                i = j;
            }
            c if c.is_ascii_uppercase() => ident.push(c),
            _ => {
                if !c.is_whitespace() {
                    ident.clear();
                }
            }
        }
        i += 1;
    }
    nodes
}

fn pentobi_shape(nodes: &[TNode]) -> TreeShape {
    let mut s = TreeShape { nodes_total: nodes.len(), ..Default::default() };
    if nodes.is_empty() {
        return s;
    }
    for n in nodes {
        while s.nodes_by_depth.len() <= n.depth {
            s.nodes_by_depth.push(0);
            s.visits_by_depth.push(0.0);
        }
        s.nodes_by_depth[n.depth] += 1;
        s.visits_by_depth[n.depth] += n.visits;
    }
    let root = &nodes[0];
    s.root_edges = root.children.len();
    let mut v: Vec<f64> = root.children.iter().map(|&c| nodes[c].visits).collect();
    v.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let total: f64 = v.iter().sum();
    s.root_visited = v.iter().filter(|&&x| x > 0.0).count();
    if total > 0.0 {
        s.root_top_share = v[0] / total;
        let mut acc = 0.0;
        for (i, &x) in v.iter().enumerate() {
            acc += x;
            if s.root_50 == 0 && acc * 2.0 >= total {
                s.root_50 = i + 1;
            }
            if acc * 10.0 >= total * 9.0 {
                s.root_90 = i + 1;
                break;
            }
        }
    }
    let mut id = 0;
    for _ in 0..16 {
        let Some(&best) = nodes[id].children.iter().filter(|&&c| nodes[c].visits > 0.0).max_by(|&&a, &&b| nodes[a].visits.partial_cmp(&nodes[b].visits).unwrap().then(b.cmp(&a))) else { break };
        s.pv_visits.push(nodes[best].visits);
        id = best;
    }
    for (i, n) in nodes.iter().enumerate() {
        if i == 0 || n.children.is_empty() {
            continue;
        }
        let visited = n.children.iter().filter(|&&c| nodes[c].visits > 0.0).count();
        s.interior_nodes += 1;
        s.interior_edges += n.children.len();
        s.interior_visited += visited;
        if n.visits >= 100.0 {
            let total: f64 = n.children.iter().map(|&c| nodes[c].visits).sum();
            let top = n.children.iter().map(|&c| nodes[c].visits).fold(0.0, f64::max);
            s.busy_nodes += 1;
            s.busy_edges += n.children.len();
            s.busy_visited += visited;
            s.busy_top_share_sum += if total > 0.0 { top / total } else { 0.0 };
        }
    }
    s
}

/// `Sim`, `Vst` and the in-tree depth (`Dp` mean and max) from the last search block in the log.
fn log_stats(log: &str) -> (f64, f64, f64, f64) {
    let (mut sim, mut vst, mut dp_mean, mut dp_max) = (f64::NAN, f64::NAN, f64::NAN, f64::NAN);
    for line in log.lines() {
        for part in line.split(", ") {
            if let Some(x) = part.strip_prefix("Sim ") {
                sim = x.trim().parse().unwrap_or(f64::NAN);
            }
            if let Some(x) = part.strip_prefix("Vst ") {
                vst = x.trim().parse().unwrap_or(f64::NAN);
            }
        }
        if let Some(rest) = line.strip_prefix("Dp ") {
            dp_mean = rest.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(f64::NAN);
            // "Dp 4.3 dev=1.8 [1...10]": mean, deviation, [min...max].
            if let Some(range) = rest.split('[').nth(1).and_then(|r| r.split(']').next()) {
                dp_max = range.split("...").nth(1).and_then(|x| x.trim().parse().ok()).unwrap_or(f64::NAN);
            }
        }
    }
    (sim, vst, dp_mean, dp_max)
}

fn pentobi(argv: &[String]) {
    let (moves_path, wanted, out, program, level, work) =
        (&argv[2], argv[3].parse::<usize>().unwrap(), &argv[4], &argv[5], &argv[6], std::path::PathBuf::from(&argv[7]));
    std::fs::create_dir_all(&work).unwrap();
    let jobs = jobs(moves_path, wanted);
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "{}", header()).unwrap();
    let args: Vec<String> = ["--game", "classic", "--level", level, "--seed", "1", "--threads", "1", "--noresign", "--nobook"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for (i, (seed, prefix, seat, own)) in jobs.iter().enumerate() {
        let log = work.join(format!("pos{i}.log"));
        let _ = std::fs::remove_file(&log);
        let tree = work.join(format!("pos{i}.sgf"));
        let mut gtp = Gtp::spawn_logged(program, &args, &log).unwrap();
        let (map, _) = Mapping::discover(&mut gtp).unwrap();
        gtp.command("clear_board").unwrap();
        gtp.command("param reuse_subtree 0").unwrap();
        let mut state = GameState::new(false);
        for &mv in prefix {
            if mv >= 0 {
                gtp.command(&format!("play {} {}", map.colour[state.turn], map.to_gtp(mv))).unwrap();
                state.apply(mv);
            } else {
                state.pass();
            }
        }
        assert_eq!(state.turn, *seat, "position {i}: turn mismatch");
        let started = Instant::now();
        let reply = gtp.command(&format!("genmove {}", map.colour[*seat])).unwrap();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        gtp.command(&format!("save_tree {}", tree.display())).unwrap();
        drop(gtp);
        let text = std::fs::read_to_string(&tree).unwrap();
        let nodes = parse_tree(&text);
        let mut s = pentobi_shape(&nodes);
        let (sim, vst, dp_mean, dp_max) = log_stats(&std::fs::read_to_string(&log).unwrap_or_default());
        s.iterations = if sim.is_finite() { sim as u32 } else { 0 };
        s.depth_mean = dp_mean;
        s.depth_max = if dp_max.is_finite() { dp_max as u32 } else { 0 };
        let root_visits = if vst.is_finite() { vst } else { nodes.first().map_or(0.0, |n| n.visits) };
        writeln!(w, "{}", row(i, *seed, *own, &format!("pentobi-L{level}"), &s, root_visits, ms)).unwrap();
        w.flush().unwrap();
        let _ = std::fs::remove_file(&tree);
        eprintln!("pos {i}: own {own}, {reply}, sim {sim}, vst {vst}, dp {dp_mean}/{dp_max}, nodes {}", nodes.len());
    }
    eprintln!("p910_probe pentobi: {} positions; wrote {out}", jobs.len());
}

/// P9 grid data: Pentobi's own moves in recorded games (seats whose `engines` entry is "pentobi").
/// (a) At own moves 0–5: the move's centre distance minus the smallest among the seat's legal moves.
/// (b) By pieces on the board before the move: how many of Pentobi's moves are 5-square pieces.
fn opening(argv: &[String]) {
    use blokee::placements::{PIECE_SIZES, placements};
    use blokee::position::MAX_MOVES;
    let t = placements();
    let mut deltas: Vec<Vec<f64>> = vec![Vec::new(); 6];
    let mut by_board: Vec<(u32, u32)> = vec![(0, 0); 90];
    let mut buffer = vec![0i32; MAX_MOVES];
    for path in &argv[2..] {
        for l in std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let order: Vec<&str> = v["seatOrder"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
            let engines: Vec<&str> = v["engines"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
            let pentobi: Vec<bool> = SEAT_COLORS
                .iter()
                .map(|c| order.iter().position(|o| o == c).is_some_and(|i| engines[i] == "pentobi"))
                .collect();
            let moves: Vec<i32> = v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect();
            let mut state = GameState::new(false);
            for &mv in &moves {
                let seat = state.turn;
                if mv >= 0 && pentobi[seat] {
                    let own = (21 - state.board.hand[seat].count_ones()) as usize;
                    let on_board: u32 = state.board.hand.iter().map(|h| 21 - h.count_ones()).sum();
                    let b = &mut by_board[(on_board as usize).min(89)];
                    b.0 += 1;
                    b.1 += (PIECE_SIZES[t.piece_id[mv as usize] as usize] == 5) as u32;
                    if own < 6 {
                        let n = state.board.generate_moves(seat, &mut buffer, MAX_MOVES);
                        let min = buffer[..n].iter().map(|&m| t.centre_distance[m as usize] as f64).fold(f64::INFINITY, f64::min);
                        deltas[own].push(t.centre_distance[mv as usize] as f64 - min);
                    }
                }
                if mv >= 0 { state.apply(mv) } else { state.pass() }
            }
        }
    }
    println!("(a) centre distance of Pentobi's move minus the smallest legal one, by own move");
    println!("own,moves,share_at_0,p50,p75,p90,p95,max");
    for (own, d) in deltas.iter_mut().enumerate() {
        if d.is_empty() {
            continue;
        }
        d.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let q = |p: f64| d[((d.len() - 1) as f64 * p).round() as usize];
        let zero = d.iter().filter(|&&x| x < 1e-6).count() as f64 / d.len() as f64;
        println!("{own},{},{zero:.3},{:.3},{:.3},{:.3},{:.3},{:.3}", d.len(), q(0.5), q(0.75), q(0.9), q(0.95), d[d.len() - 1]);
    }
    println!("(b) Pentobi's moves that are 5-square pieces, by pieces on the board before the move");
    println!("on_board,moves,five_share");
    for (b, &(n, five)) in by_board.iter().enumerate() {
        if n > 0 && b < 60 {
            println!("{b},{n},{:.3}", five as f64 / n as f64);
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    match argv.get(1).map(String::as_str) {
        Some("shape") => shape(&argv),
        Some("pentobi") => pentobi(&argv),
        Some("opening") => opening(&argv),
        _ => {
            eprintln!("usage: p910_probe shape <moves.jsonl> <positions> <out.csv> <config>... | pentobi <moves.jsonl> <positions> <out.csv> <pentobi-gtp> <level> <work-dir>");
            std::process::exit(2);
        }
    }
}
