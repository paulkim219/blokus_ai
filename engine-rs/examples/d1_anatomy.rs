//! D1 game anatomy: per-decision and per-seat features of bridge games, reconstructed with the
//! engine's own `GameState` / `Position` code from a `blokee-pentobi --moves-out` file.
//!
//!   cargo run --release --example d1_anatomy -- turns <moves.jsonl> <block> <turns.csv> <seats.csv>
//!   cargo run --release --example d1_anatomy -- judge <moves.jsonl> <per-engine> <level> <threads> <out.csv>
//!   cargo run --release --example d1_anatomy -- shortlist <moves.jsonl> <judge.csv> <config.json> <threads> <out.csv>
//!
//! Run from the repo root (the config's rollout table path is relative). The D1 tables come from
//! `engine-rs/scripts/d1_report.py tmp/d1`; replay equality from `engine-rs/scripts/d1_compare.py`.
//!
//! `turns` writes one row per turn (ply), passes included, for the seat to move; `seats` one row per
//! seat per game. Features (all for the seat to move, measured on the board before its move unless
//! the name says `after`):
//! - `legal`: legal placements; `own_corners`/`own_corners_after`: open corners (empty, diagonal to
//!   own colour, not edge-adjacent to it); `own_live_after`: own open corners that some legal move
//!   (with the hand left after this move) still covers; `own_legal_after`: own legal placements on
//!   the board right after the move.
//! - `opp_*`: summed over the three opponents. `opp_cover`: opponent open corners the placement
//!   occupies; `opp_live_killed`: opponent "live" corners (an open corner some legal move of that
//!   opponent covers) that stop being live because of this move; `opp_legal_cut`: opponent legal
//!   placements removed by this move.
//! - Local response in Pentobi's sense (`PlayoutFeatures::set_local`, `LocalPoints`): for each of
//!   the last three placements on the board (passes are not moves) made by another colour c, its
//!   attach points (diagonal neighbours not edge-adjacent to the piece) that are not forbidden for c
//!   (occupied or edge-adjacent to c), plus their orthogonal neighbours not forbidden for c. A point
//!   counts 2 if it is also an open corner of the mover, else 1. `nu_local` is the move's sum;
//!   `local_any` = nu_local > 0; `local_attach` = covers an attach point itself (not just a
//!   neighbour). `legal_local_frac` and `legal_max_nu_local` describe all legal moves, the base rate.
//! - `territory_*`: `territory::compute_territory` with fractional ties (the evaluation's Voronoi).
//!
//! `judge` replays sampled decision positions into a fresh `pentobi-gtp` at `<level>` (book on, one
//! thread, seed 1) and asks `reg_genmove`; writes the decision's move and Pentobi's, with the
//! features of both.

use blokee::bitboard::*;
use blokee::game::GameState;
use blokee::gtp::{Gtp, Mapping};
use blokee::placements::*;
use blokee::position::{Position, SEAT_COLORS, SEAT_COUNT, new_move_buffer};
use blokee::rng::Rng;
use blokee::territory::{TerritoryMap, compute_territory};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct Game {
    seed: u64,
    lone: String,
    engines: [String; SEAT_COUNT],
    scores: [f64; SEAT_COUNT],
    moves: Vec<i32>,
}

fn read_games(path: &str) -> Vec<Game> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut games: Vec<Game> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            let order: Vec<String> = v["seatOrder"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
            assert_eq!(order, SEAT_COLORS.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "seat order");
            Game {
                seed: v["seed"].as_u64().unwrap(),
                lone: v["seat"].as_str().unwrap().to_string(),
                engines: std::array::from_fn(|s| v["engines"][s].as_str().unwrap().to_string()),
                scores: std::array::from_fn(|s| v["scores"][SEAT_COLORS[s]].as_f64().unwrap()),
                moves: v["moves"].as_array().unwrap().iter().map(|m| m.as_i64().unwrap() as i32).collect(),
            }
        })
        .collect();
    games.sort_by(|a, b| (a.seed, a.lone.clone()).cmp(&(b.seed, b.lone.clone())));
    games
}

fn legal(p: &Position, seat: usize, buf: &mut [i32]) -> usize {
    p.generate_moves(seat, buf, usize::MAX)
}

/// Open corners of `seat` that some legal move covers.
fn live_corners(p: &Position, seat: usize, buf: &mut [i32]) -> (Mask, usize) {
    let t = placements();
    let n = legal(p, seat, buf);
    let mut cover = EMPTY;
    for &m in &buf[..n] {
        or_into(&mut cover, &t.cells[m as usize]);
    }
    let mut live = p.open_corners(seat);
    and_into(&mut live, &cover);
    (live, n)
}

/// Pentobi's local-point values for the mover: 0, 1, or 2 per cell.
fn local_values(p: &Position, mover: usize, history: &[(usize, i32)]) -> ([u8; CELL_COUNT], Mask) {
    let t = placements();
    let mut value = [0u8; CELL_COUNT];
    let mut attach_any = EMPTY;
    let own_corners = p.open_corners(mover);
    let start = history.len().saturating_sub(3);
    let mut cells = [0i32; CELL_COUNT];
    for &(c, mv) in &history[start..] {
        if c == mover {
            continue;
        }
        let mut forbidden = p.occ;
        or_into(&mut forbidden, &p.edge_halo[c]);
        let mut attach = t.corner_halo[mv as usize];
        and_not_into(&mut attach, &t.edge_halo[mv as usize]);
        and_not_into(&mut attach, &forbidden);
        or_into(&mut attach_any, &attach);
        let n = to_indices(&attach, &mut cells);
        let add = |cell: usize, value: &mut [u8; CELL_COUNT]| {
            if value[cell] == 0 {
                value[cell] = 1 + test_bit(&own_corners, cell) as u8;
            }
        };
        for &j in &cells[..n] {
            let j = j as usize;
            add(j, &mut value);
            let (x, y) = (j % BOARD_SIZE, j / BOARD_SIZE);
            let mut nbrs = Vec::with_capacity(4);
            if x > 0 { nbrs.push(j - 1) }
            if x + 1 < BOARD_SIZE { nbrs.push(j + 1) }
            if y > 0 { nbrs.push(j - BOARD_SIZE) }
            if y + 1 < BOARD_SIZE { nbrs.push(j + BOARD_SIZE) }
            for k in nbrs {
                if !test_bit(&forbidden, k) {
                    add(k, &mut value);
                }
            }
        }
    }
    (value, attach_any)
}

fn nu_local(values: &[u8; CELL_COUNT], mv: i32) -> u32 {
    let t = placements();
    let (a, b) = (t.cell_start[mv as usize] as usize, t.cell_start[mv as usize + 1] as usize);
    t.cell_list[a..b].iter().map(|&c| values[c as usize] as u32).sum()
}

/// Features of placing `mv` for `seat` on `p` (the board before the move). Strings are CSV cells.
struct MoveFeatures {
    piece: usize,
    size: i32,
    centre: f32,
    own_corners_after: u32,
    own_live_after: u32,
    own_legal_after: usize,
    opp_cover: u32,
    opp_live_killed: i64,
    opp_legal_cut: i64,
    opp_corners_removed: i64,
    nu_local: u32,
    local_attach: bool,
    /// Per target seat (0 for the mover): live corners killed, legal placements removed.
    kill: [i64; SEAT_COUNT],
    cut: [i64; SEAT_COUNT],
    /// Closest Manhattan distance to the board centre of any placed cell, and of the seat's
    /// whole colour after the move.
    piece_min_centre: f64,
    own_min_centre_after: f64,
}

/// Minimum Manhattan distance from (9.5, 9.5) over the cells of `mask` (NaN if empty).
fn min_centre(mask: &Mask) -> f64 {
    let mut cells = [0i32; CELL_COUNT];
    let n = to_indices(mask, &mut cells);
    cells[..n].iter().map(|&c| ((c as usize % BOARD_SIZE) as f64 - 9.5).abs() + ((c as usize / BOARD_SIZE) as f64 - 9.5).abs()).fold(f64::NAN, f64::min)
}

struct Before {
    opp_live: [Mask; SEAT_COUNT],
    opp_legal: [usize; SEAT_COUNT],
    opp_corners: [u32; SEAT_COUNT],
}

fn before_state(p: &Position, seat: usize, buf: &mut [i32]) -> Before {
    let mut b = Before { opp_live: [EMPTY; SEAT_COUNT], opp_legal: [0; SEAT_COUNT], opp_corners: [0; SEAT_COUNT] };
    for o in (0..SEAT_COUNT).filter(|&o| o != seat) {
        let (live, n) = live_corners(p, o, buf);
        b.opp_live[o] = live;
        b.opp_legal[o] = n;
        b.opp_corners[o] = p.open_corner_count(o);
    }
    b
}

fn move_features(p: &Position, seat: usize, mv: i32, before: &Before, values: &[u8; CELL_COUNT], attach: &Mask, buf: &mut [i32]) -> MoveFeatures {
    let t = placements();
    let cells = &t.cells[mv as usize];
    let mut after = p.clone();
    after.force_turn(seat);
    after.apply(mv);
    let (own_live, own_legal_after) = live_corners(&after, seat, buf);
    let (mut opp_cover, mut killed, mut cut, mut removed) = (0u32, 0i64, 0i64, 0i64);
    let (mut kill, mut cut_by) = ([0i64; SEAT_COUNT], [0i64; SEAT_COUNT]);
    for o in (0..SEAT_COUNT).filter(|&o| o != seat) {
        let mut covered = p.open_corners(o);
        and_into(&mut covered, cells);
        opp_cover += popcount(&covered);
        let (live, n) = live_corners(&after, o, buf);
        kill[o] = popcount(&before.opp_live[o]) as i64 - popcount(&live) as i64;
        cut_by[o] = before.opp_legal[o] as i64 - n as i64;
        killed += kill[o];
        cut += cut_by[o];
        removed += before.opp_corners[o] as i64 - after.open_corner_count(o) as i64;
    }
    MoveFeatures {
        piece: t.piece_id[mv as usize] as usize,
        size: t.size[mv as usize] as i32,
        centre: t.centre_distance[mv as usize],
        own_corners_after: after.open_corner_count(seat),
        own_live_after: popcount(&own_live),
        own_legal_after,
        opp_cover,
        opp_live_killed: killed,
        opp_legal_cut: cut,
        opp_corners_removed: removed,
        nu_local: nu_local(values, mv),
        local_attach: intersects(attach, cells),
        kill,
        cut: cut_by,
        piece_min_centre: min_centre(cells),
        own_min_centre_after: min_centre(&after.own[seat]),
    }
}

const MOVE_HEADER: &str = "piece,size,centre,own_corners_after,own_live_after,own_legal_after,opp_cover,opp_live_killed,opp_legal_cut,opp_corners_removed,nu_local,local_any,local_attach,kill0,kill1,kill2,kill3,cut0,cut1,cut2,cut3,piece_min_centre,own_min_centre_after";

fn move_csv(f: &MoveFeatures) -> String {
    format!(
        "{},{},{:.3},{},{},{},{},{},{},{},{},{},{},{},{},{:.1},{:.1}",
        f.piece,
        f.size,
        f.centre,
        f.own_corners_after,
        f.own_live_after,
        f.own_legal_after,
        f.opp_cover,
        f.opp_live_killed,
        f.opp_legal_cut,
        f.opp_corners_removed,
        f.nu_local,
        (f.nu_local > 0) as u8,
        f.local_attach as u8,
        f.kill.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(","),
        f.cut.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(","),
        f.piece_min_centre,
        f.own_min_centre_after
    )
}

fn empty_move_csv() -> String {
    MOVE_HEADER.split(',').map(|_| "").collect::<Vec<_>>().join(",")
}

fn turns(path: &str, block: &str, turns_out: &str, seats_out: &str) {
    let games = read_games(path);
    let mut tw = std::io::BufWriter::new(std::fs::File::create(turns_out).unwrap());
    let mut sw = std::io::BufWriter::new(std::fs::File::create(seats_out).unwrap());
    writeln!(
        tw,
        "block,seed,lone,seat,color,engine,is_lone,ply,round,own_idx,pass,squares_before,legal,own_corners,own_live,territory,territory_opp_mean,legal_local_frac,legal_max_nu_local,{MOVE_HEADER},mv"
    )
    .unwrap();
    let size_cols: Vec<String> = (1..=5).map(|s| format!("left_size{s}")).collect();
    writeln!(sw, "block,seed,lone,seat,color,engine,is_lone,score,first_stuck_ply,first_stuck_round,pieces_placed,squares_placed,all_placed,{},left_pieces", size_cols.join(",")).unwrap();
    let mut buf = new_move_buffer();
    let mut map = TerritoryMap::new();
    let mut n_turns = 0usize;
    for g in &games {
        let mut state = GameState::new(false);
        let mut history: Vec<(usize, i32)> = Vec::new();
        let mut first_stuck: [Option<usize>; SEAT_COUNT] = [None; SEAT_COUNT];
        for (ply, &mv) in g.moves.iter().enumerate() {
            let seat = state.turn;
            assert_eq!(seat, ply % SEAT_COUNT, "turn order");
            let mut p = state.board.clone();
            p.force_turn(seat);
            let own_idx = 21 - p.hand[seat].count_ones();
            let squares_before = p.placed_squares(seat);
            let (own_live, n_legal) = live_corners(&p, seat, &mut buf);
            compute_territory(&p, &mut map, true);
            let terr = map.territory[seat];
            let terr_opp = (0..SEAT_COUNT).filter(|&o| o != seat).map(|o| map.territory[o]).sum::<f64>() / 3.0;
            let lone = SEAT_COLORS[seat] == g.lone;
            let prefix = format!(
                "{block},{},{},{seat},{},{},{},{ply},{},{own_idx},{},{squares_before},{n_legal},{},{},{terr:.2},{terr_opp:.2}",
                g.seed,
                g.lone,
                SEAT_COLORS[seat],
                g.engines[seat],
                lone as u8,
                ply / SEAT_COUNT,
                (mv < 0) as u8,
                p.open_corner_count(seat),
                popcount(&own_live)
            );
            if mv < 0 {
                assert_eq!(n_legal, 0, "pass with a legal move: seed {} ply {ply}", g.seed);
                if first_stuck[seat].is_none() {
                    first_stuck[seat] = Some(ply);
                }
                writeln!(tw, "{prefix},,,{},", empty_move_csv()).unwrap();
                state.pass();
            } else {
                assert!(p.is_legal(seat, mv), "illegal move in record: seed {} ply {ply}", g.seed);
                let (values, attach) = local_values(&p, seat, &history);
                let legal_moves: Vec<i32> = buf[..n_legal].to_vec();
                let locals: Vec<u32> = legal_moves.iter().map(|&m| nu_local(&values, m)).collect();
                let frac = locals.iter().filter(|&&v| v > 0).count() as f64 / n_legal as f64;
                let max_local = locals.iter().copied().max().unwrap_or(0);
                let before = before_state(&p, seat, &mut buf);
                let f = move_features(&p, seat, mv, &before, &values, &attach, &mut buf);
                writeln!(tw, "{prefix},{frac:.4},{max_local},{},{mv}", move_csv(&f)).unwrap();
                state.apply(mv);
                history.push((seat, mv));
            }
            n_turns += 1;
        }
        assert!(state.finished, "game seed {} lone {} did not finish", g.seed, g.lone);
        let scores = state.scores();
        assert_eq!(scores, g.scores, "replayed scores differ for seed {} lone {}", g.seed, g.lone);
        for seat in 0..SEAT_COUNT {
            let b = &state.board;
            let hand = b.hand[seat];
            let mut by_size = [0u32; 5];
            let mut names = Vec::new();
            for piece in 0..PIECE_COUNT {
                if hand & (1 << piece) != 0 {
                    by_size[PIECE_SIZES[piece] as usize - 1] += 1;
                    names.push(RAW_PIECES[piece].0);
                }
            }
            let stuck = first_stuck[seat];
            let placed = 21 - hand.count_ones();
            writeln!(
                sw,
                "{block},{},{},{seat},{},{},{},{},{},{},{placed},{},{},{},{}",
                g.seed,
                g.lone,
                SEAT_COLORS[seat],
                g.engines[seat],
                (SEAT_COLORS[seat] == g.lone) as u8,
                scores[seat],
                stuck.map(|s| s.to_string()).unwrap_or_default(),
                stuck.map(|s| (s / SEAT_COUNT).to_string()).unwrap_or_default(),
                b.placed_squares(seat),
                (hand == 0) as u8,
                by_size.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(","),
                names.join(" ")
            )
            .unwrap();
        }
    }
    eprintln!("{path}: {} games, {n_turns} turns; replayed scores equal the records", games.len());
}

fn judge(path: &str, per_engine: usize, level: u32, threads: usize, out: &str) {
    let games = read_games(path);
    let program = format!("{}/src/pentobi-build/pentobi_gtp/pentobi-gtp", std::env::var("HOME").unwrap());
    let book = format!("{}/src/pentobi/opening_books/book_classic.blksgf", std::env::var("HOME").unwrap());
    let args: Vec<String> = ["--game", "classic", "--level", &level.to_string(), "--seed", "1", "--threads", "1", "--noresign", "--quiet", "--book", &book]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mapping = {
        let mut probe = Gtp::spawn(&program, &args).unwrap();
        Mapping::discover(&mut probe).unwrap().0
    };
    // Candidate decisions: (game, ply, own index, engine), stratified by own-move index.
    let mut by: std::collections::BTreeMap<(String, u32), Vec<(usize, usize)>> = Default::default();
    for (gi, g) in games.iter().enumerate() {
        let mut state = GameState::new(false);
        for (ply, &mv) in g.moves.iter().enumerate() {
            let seat = state.turn;
            if mv >= 0 {
                let own_idx = 21 - state.board.hand[seat].count_ones();
                by.entry((g.engines[seat].clone(), own_idx)).or_default().push((gi, ply));
                state.apply(mv);
            } else {
                state.pass();
            }
        }
    }
    let mut rng = Rng::new(20261112);
    let mut samples: Vec<(usize, usize)> = Vec::new();
    for engine in ["blokee", "pentobi"] {
        let quota = per_engine / 21;
        let mut extra = per_engine - quota * 21;
        for k in 0..21u32 {
            let Some(pool) = by.get_mut(&(engine.to_string(), k)) else { continue };
            let mut want = quota + if extra > 0 { 1 } else { 0 };
            if extra > 0 {
                extra -= 1;
            }
            want = want.min(pool.len());
            for i in 0..want {
                let j = i + rng.next_int(pool.len() - i);
                pool.swap(i, j);
                samples.push(pool[i]);
            }
        }
    }
    eprintln!("judge: {} positions at level {level}, {threads} threads", samples.len());
    let next = AtomicUsize::new(0);
    let rows: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());
    let mapping = Arc::new(mapping);
    let started = std::time::Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut buf = new_move_buffer();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= samples.len() {
                        break;
                    }
                    let (gi, ply) = samples[i];
                    let g = &games[gi];
                    let mut gtp = Gtp::spawn(&program, &args).unwrap();
                    gtp.command("clear_board").unwrap();
                    let mut state = GameState::new(false);
                    let mut history: Vec<(usize, i32)> = Vec::new();
                    for &mv in &g.moves[..ply] {
                        let seat = state.turn;
                        if mv >= 0 {
                            gtp.command(&format!("play {} {}", mapping.colour[seat], mapping.to_gtp(mv))).unwrap();
                            state.apply(mv);
                            history.push((seat, mv));
                        } else {
                            state.pass();
                        }
                    }
                    let seat = state.turn;
                    let played = g.moves[ply];
                    let t0 = std::time::Instant::now();
                    let reply = gtp.command(&format!("reg_genmove {}", mapping.colour[seat])).unwrap();
                    let ms = t0.elapsed().as_secs_f64() * 1000.0;
                    let judged = mapping.from_gtp(reply.trim()).unwrap_or_else(|e| panic!("reg_genmove reply {reply}: {e}"));
                    let mut p = state.board.clone();
                    p.force_turn(seat);
                    assert!(p.is_legal(seat, judged) && p.is_legal(seat, played));
                    let n_legal = legal(&p, seat, &mut buf);
                    let (values, attach) = local_values(&p, seat, &history);
                    let before = before_state(&p, seat, &mut buf);
                    let fp = move_features(&p, seat, played, &before, &values, &attach, &mut buf);
                    let fj = move_features(&p, seat, judged, &before, &values, &attach, &mut buf);
                    let row = format!(
                        "{},{},{seat},{},{},{ply},{},{n_legal},{},{},{:.0},{},{}",
                        g.seed,
                        g.lone,
                        SEAT_COLORS[seat],
                        g.engines[seat],
                        21 - p.hand[seat].count_ones(),
                        played,
                        judged,
                        ms,
                        move_csv(&fp),
                        move_csv(&fj)
                    );
                    let mut r = rows.lock().unwrap();
                    r.push((i, row));
                    if r.len() % 50 == 0 {
                        eprintln!("judge: {}/{} positions, {:.1} min", r.len(), samples.len(), started.elapsed().as_secs_f64() / 60.0);
                    }
                }
            });
        }
    });
    let mut rows = rows.into_inner().unwrap();
    rows.sort();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    let header_p: Vec<String> = MOVE_HEADER.split(',').map(|h| format!("p_{h}")).collect();
    let header_j: Vec<String> = MOVE_HEADER.split(',').map(|h| format!("j_{h}")).collect();
    writeln!(w, "seed,lone,seat,color,engine,ply,own_idx,legal,played,judged,judge_ms,{},{}", header_p.join(","), header_j.join(",")).unwrap();
    for (_, row) in rows {
        writeln!(w, "{row}").unwrap();
    }
    eprintln!("judge: wrote {out} in {:.1} min", started.elapsed().as_secs_f64() / 60.0);
}

/// For each judged position: re-search with Blokee (`config`, budget 300, RNG seeded from the
/// game seed and ply) and report whether Pentobi's choice and the played move are in Blokee's root
/// candidate list, with their visits and visit ranks.
fn shortlist(moves_path: &str, judge_csv: &str, config: &str, threads: usize, out: &str) {
    use blokee::config::BitboardParams;
    use blokee::engine::{Engine, MoveStats};
    use blokee::rollout_policy::RolloutPolicy;
    let games = read_games(moves_path);
    let index: std::collections::HashMap<(u64, String), usize> = games.iter().enumerate().map(|(i, g)| ((g.seed, g.lone.clone()), i)).collect();
    let params: BitboardParams = serde_json::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(p)) => {
            let found = [p.clone(), format!("../{p}")].into_iter().find(|c| std::path::Path::new(c).exists()).expect("rollout table not found");
            Some(Arc::new(RolloutPolicy::from_file(&found).unwrap()))
        }
        _ => None,
    };
    let text = std::fs::read_to_string(judge_csv).unwrap();
    let mut lines = text.lines();
    let header: Vec<&str> = lines.next().unwrap().split(',').collect();
    let col = |name: &str| header.iter().position(|h| *h == name).unwrap();
    let (cs, cl, cp, cj, cd) = (col("seed"), col("lone"), col("ply"), col("judged"), col("played"));
    let jobs: Vec<(u64, String, usize, i32, i32)> = lines
        .map(|l| {
            let f: Vec<&str> = l.split(',').collect();
            (f[cs].parse().unwrap(), f[cl].to_string(), f[cp].parse().unwrap(), f[cj].parse().unwrap(), f[cd].parse().unwrap())
        })
        .collect();
    let next = AtomicUsize::new(0);
    let rows: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut engine = Engine::new(params.clone(), table.clone()).unwrap();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= jobs.len() {
                        break;
                    }
                    let (seed, lone, ply, judged, played) = &jobs[i];
                    let g = &games[index[&(*seed, lone.clone())]];
                    let mut state = GameState::new(false);
                    for &mv in &g.moves[..*ply] {
                        if mv >= 0 { state.apply(mv) } else { state.pass() }
                    }
                    let seat = state.turn;
                    let mut position = state.to_position();
                    let mut rng = Rng::new((*seed as u32) ^ (*ply as u32).wrapping_mul(0x9e37_79b9));
                    let mut stats = MoveStats::default();
                    let ranked = engine.search(&mut position, seat, 300, &mut rng, &mut stats);
                    let find = |m: i32| ranked.iter().position(|r| r.mv == m);
                    let (jr, pr) = (find(*judged), find(*played));
                    let row = format!(
                        "{seed},{lone},{ply},{:?},{},{},{},{},{},{},{}",
                        stats.source,
                        ranked.len(),
                        jr.is_some() as u8,
                        jr.map(|r| r.to_string()).unwrap_or_default(),
                        jr.map(|r| ranked[r].visits.to_string()).unwrap_or_default(),
                        pr.map(|r| r.to_string()).unwrap_or_default(),
                        (ranked.first().map(|r| r.mv) == Some(*played)) as u8,
                        ranked.first().map(|r| r.visits).unwrap_or(0)
                    );
                    rows.lock().unwrap().push((i, row));
                }
            });
        }
    });
    let mut rows = rows.into_inner().unwrap();
    rows.sort();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    writeln!(w, "seed,lone,ply,source,candidates,judged_in_list,judged_rank,judged_visits,played_rank,research_top_is_played,top_visits").unwrap();
    for (_, row) in rows {
        writeln!(w, "{row}").unwrap();
    }
    eprintln!("shortlist: wrote {out} ({} positions)", jobs.len());
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    match argv.get(1).map(String::as_str) {
        Some("turns") => turns(&argv[2], &argv[3], &argv[4], &argv[5]),
        Some("shortlist") => shortlist(&argv[2], &argv[3], &argv[4], argv[5].parse().unwrap(), &argv[6]),
        Some("judge") => judge(&argv[2], argv[3].parse().unwrap(), argv[4].parse().unwrap(), argv[5].parse().unwrap(), &argv[6]),
        _ => panic!("usage: d1_anatomy turns <moves.jsonl> <block> <turns.csv> <seats.csv> | judge <moves.jsonl> <per-engine> <level> <threads> <out.csv>"),
    }
}
