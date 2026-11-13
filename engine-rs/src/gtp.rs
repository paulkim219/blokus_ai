//! Bridge to an external GTP Blokus engine (Pentobi's `pentobi-gtp`), for the X1 benchmark.
//!
//! Three pieces:
//! - [`Gtp`]: a GTP client over a child process's stdin/stdout. The engine only ever runs as a
//!   separate process.
//! - [`Mapping`]: Blokee placement id ↔ GTP move string. Nothing about the other engine's board
//!   orientation is assumed. [`Mapping::discover`] reads each colour's start corner from
//!   `all_legal` on an empty board, then picks the board symmetry under which Blokee seat `i` is
//!   colour `i + 1` (so both engines see the same turn order) and every home corner lands on that
//!   colour's start corner. It then checks that the full first-move sets agree for every seat.
//! - [`play_bridge_game`] and [`replay_into_gtp`]: a seeded game with some seats played by Blokee
//!   and the rest by the GTP engine, and the validity-gate replay of a finished Blokee game. Both
//!   return `Err` on any rules disagreement: a move the engine rejects, a pass while the other side
//!   has a legal move, different legal-move sets, or different final scores.
//!
//! Blokee seats choose exactly as `play_game_observed` does: the same [`Engine::search`], the same
//! global search RNG consumed in game order, the same opening sampling ([`choose_ranked`]).

use crate::bitboard::*;
use crate::engine::{Engine, MoveStats, Ranked};
use crate::game::{GameOptions, GameState, choose_ranked};
use crate::placements::*;
use crate::position::{HOME_CORNER, SEAT_COUNT, new_move_buffer};
use crate::rng::Rng;
use rustc_hash::FxHashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Instant;

// ---------------------------------------------------------------------------------------------
// GTP client
// ---------------------------------------------------------------------------------------------

pub struct Gtp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Gtp {
    /// Starts `program args…` with stderr discarded (pass `--quiet` as well where supported).
    pub fn spawn(program: &str, args: &[String]) -> Result<Gtp, String> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("cannot start {program}: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(Gtp { child, stdin, stdout })
    }

    /// Sends one command. `Ok(body)` for `=`, `Err` for `?` (the engine's message) or I/O failure.
    /// The body has the status character and the following space stripped; lines are kept.
    pub fn command(&mut self, cmd: &str) -> Result<String, String> {
        writeln!(self.stdin, "{cmd}").map_err(|e| format!("gtp write '{cmd}': {e}"))?;
        self.stdin.flush().map_err(|e| format!("gtp flush: {e}"))?;
        let mut lines: Vec<String> = Vec::new();
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line).map_err(|e| format!("gtp read: {e}"))?;
            if n == 0 {
                return Err(format!("gtp engine exited during '{cmd}'"));
            }
            let line = line.trim_end_matches(['\n', '\r']).to_string();
            if line.is_empty() {
                if lines.is_empty() {
                    continue; // stray blank line before a response
                }
                break;
            }
            lines.push(line);
        }
        let first = &lines[0];
        let ok = match first.chars().next() {
            Some('=') => true,
            Some('?') => false,
            _ => return Err(format!("gtp: malformed response to '{cmd}': {first}")),
        };
        lines[0] = first[1..].trim_start().to_string();
        let body = lines.join("\n").trim().to_string();
        if ok { Ok(body) } else { Err(body) }
    }

    /// Pid of the engine process (for logs).
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for Gtp {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "quit");
        let _ = self.stdin.flush();
        // Give it a moment to exit cleanly, then make sure it is gone.
        for _ in 0..50 {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------------------------
// Board mapping
// ---------------------------------------------------------------------------------------------

/// The eight symmetries of the square, as maps from Blokee `(x, y)` (y = 0 at the top) to the
/// GTP engine's `(column, y from the top)`.
pub const SYMMETRY_NAMES: [&str; 8] =
    ["identity", "mirror x", "mirror y", "rotate 180", "transpose", "rotate 90 cw", "rotate 90 ccw", "anti-transpose"];

fn apply_symmetry(sym: usize, x: usize, y: usize) -> (usize, usize) {
    let n = BOARD_SIZE - 1;
    match sym {
        0 => (x, y),
        1 => (n - x, y),
        2 => (x, n - y),
        3 => (n - x, n - y),
        4 => (y, x),
        5 => (n - y, x),
        6 => (y, n - x),
        _ => (n - y, n - x),
    }
}

/// `a20` style square (column letter, row 1 at the bottom) → GTP-frame cell `col + 20 * y_top`.
pub fn parse_square(s: &str) -> Result<usize, String> {
    let s = s.trim();
    let mut chars = s.chars();
    let col = chars.next().ok_or_else(|| format!("empty square in move"))?;
    let col = col.to_ascii_lowercase();
    if !col.is_ascii_lowercase() {
        return Err(format!("bad square '{s}'"));
    }
    let x = (col as u8 - b'a') as usize;
    let row: usize = chars.as_str().parse().map_err(|_| format!("bad square '{s}'"))?;
    if x >= BOARD_SIZE || row == 0 || row > BOARD_SIZE {
        return Err(format!("square off the board '{s}'"));
    }
    Ok(x + BOARD_SIZE * (BOARD_SIZE - row))
}

pub fn format_square(cell: usize) -> String {
    let (x, y_top) = (cell % BOARD_SIZE, cell / BOARD_SIZE);
    format!("{}{}", (b'a' + x as u8) as char, BOARD_SIZE - y_top)
}

/// Cells of a GTP move string (`e8,d9,e9`), in the GTP frame.
pub fn parse_move_cells(s: &str) -> Result<Vec<usize>, String> {
    s.split(',').map(parse_square).collect()
}

pub struct Mapping {
    pub symmetry: usize,
    /// Blokee cell → GTP-frame cell, and back.
    pub forward: [u16; CELL_COUNT],
    pub inverse: [u16; CELL_COUNT],
    /// Blokee seat → GTP colour argument (`"1"`..`"4"`).
    pub colour: [String; SEAT_COUNT],
    /// Start corner of each GTP colour (index 0 = colour 1), in the GTP frame.
    pub gtp_corners: [usize; SEAT_COUNT],
    by_cells: FxHashMap<Mask, i32>,
}

impl Mapping {
    pub fn with_symmetry(symmetry: usize, colour: [String; SEAT_COUNT], gtp_corners: [usize; SEAT_COUNT]) -> Mapping {
        let mut forward = [0u16; CELL_COUNT];
        let mut inverse = [0u16; CELL_COUNT];
        for y in 0..BOARD_SIZE {
            for x in 0..BOARD_SIZE {
                let (gx, gy) = apply_symmetry(symmetry, x, y);
                let b = x + BOARD_SIZE * y;
                let g = gx + BOARD_SIZE * gy;
                forward[b] = g as u16;
                inverse[g] = b as u16;
            }
        }
        let t = placements();
        let mut by_cells = FxHashMap::default();
        for id in 0..t.count {
            let previous = by_cells.insert(t.cells[id], id as i32);
            assert!(previous.is_none(), "placement {id} duplicates the cells of {previous:?}");
        }
        Mapping { symmetry, forward, inverse, colour, gtp_corners, by_cells }
    }

    /// Placement id → GTP move string (squares in GTP-frame reading order).
    pub fn to_gtp(&self, id: i32) -> String {
        let t = placements();
        let mut buffer = [0i32; 8];
        let n = to_indices(&t.cells[id as usize], &mut buffer);
        let mut cells: Vec<usize> = buffer[..n].iter().map(|&c| self.forward[c as usize] as usize).collect();
        cells.sort_unstable();
        cells.iter().map(|&c| format_square(c)).collect::<Vec<_>>().join(",")
    }

    /// GTP move string → placement id.
    pub fn from_gtp(&self, s: &str) -> Result<i32, String> {
        let cells = parse_move_cells(s)?;
        let mut mask = EMPTY;
        for &g in &cells {
            set_bit(&mut mask, self.inverse[g] as usize);
        }
        if popcount(&mask) as usize != cells.len() {
            return Err(format!("move '{s}' repeats a square"));
        }
        self.by_cells.get(&mask).copied().ok_or_else(|| format!("move '{s}' is not a Blokee placement"))
    }

    /// Reads the start corners from `all_legal` on the engine's (empty) board and returns the
    /// mapping under which seat `i` ↔ colour `i + 1` with every home corner on its colour's start
    /// corner. Then requires the complete first-move sets to agree for every seat. Also returns a
    /// human-readable account of what was found.
    pub fn discover(gtp: &mut Gtp) -> Result<(Mapping, String), String> {
        gtp.command("clear_board")?;
        let mut corners = [0usize; SEAT_COUNT];
        let mut report = String::new();
        let mut legal_strings: Vec<Vec<String>> = Vec::new();
        for c in 0..SEAT_COUNT {
            let body = gtp.command(&format!("all_legal {}", c + 1))?;
            let moves: Vec<String> = body.split_whitespace().map(str::to_string).collect();
            if moves.is_empty() {
                return Err(format!("colour {} has no legal move on an empty board", c + 1));
            }
            let mut common: Option<Vec<usize>> = None;
            for m in &moves {
                let cells = parse_move_cells(m)?;
                common = Some(match common {
                    None => cells,
                    Some(prev) => prev.into_iter().filter(|x| cells.contains(x)).collect(),
                });
            }
            let common = common.unwrap();
            if common.len() != 1 {
                return Err(format!("colour {}: first moves share {} squares, expected exactly one start corner", c + 1, common.len()));
            }
            corners[c] = common[0];
            report.push_str(&format!("colour {} starts at {} ({} first moves)\n", c + 1, format_square(corners[c]), moves.len()));
            legal_strings.push(moves);
        }
        let mut candidates = Vec::new();
        for sym in 0..8 {
            for offset in 0..SEAT_COUNT {
                let ok = (0..SEAT_COUNT).all(|seat| {
                    let (x, y) = (HOME_CORNER[seat] % BOARD_SIZE, HOME_CORNER[seat] / BOARD_SIZE);
                    let (gx, gy) = apply_symmetry(sym, x, y);
                    gx + BOARD_SIZE * gy == corners[(seat + offset) % SEAT_COUNT]
                });
                if ok {
                    candidates.push((sym, offset));
                }
            }
        }
        report.push_str(&format!(
            "symmetry/offset pairs that put every home corner on a start corner: {}\n",
            candidates.iter().map(|(s, o)| format!("{} (seat i -> colour i+{})", SYMMETRY_NAMES[*s], o + 1)).collect::<Vec<_>>().join("; ")
        ));
        let Some(&(sym, _)) = candidates.iter().find(|(_, o)| *o == 0) else {
            return Err(format!("no symmetry lines up turn order (seat i -> colour i+1) with the corners\n{report}"));
        };
        let colour: [String; SEAT_COUNT] = std::array::from_fn(|seat| (seat + 1).to_string());
        let mapping = Mapping::with_symmetry(sym, colour, corners);
        report.push_str(&format!("chosen: {} with Blokee seat i -> colour i+1\n", SYMMETRY_NAMES[sym]));
        // The whole first-move set must agree, not just the corner.
        let state = GameState::new(false);
        for seat in 0..SEAT_COUNT {
            let theirs = legal_strings[seat].iter().map(|m| mapping.from_gtp(m)).collect::<Result<Vec<_>, _>>()?;
            compare_legal(&state, seat, theirs, "empty board")?;
        }
        report.push_str("first-move sets agree for all four seats\n");
        Ok((mapping, report))
    }
}

fn blokee_legal(state: &GameState, seat: usize) -> Vec<i32> {
    let mut buffer = new_move_buffer();
    let n = state.board.generate_moves(seat, &mut buffer, usize::MAX);
    let mut ids = buffer[..n].to_vec();
    ids.sort_unstable();
    ids
}

/// Errs unless the GTP engine's legal set equals Blokee's for `seat`.
fn compare_legal(state: &GameState, seat: usize, mut theirs: Vec<i32>, at: &str) -> Result<usize, String> {
    theirs.sort_unstable();
    let ours = blokee_legal(state, seat);
    if theirs != ours {
        let only_ours = ours.iter().filter(|m| theirs.binary_search(m).is_err()).count();
        let only_theirs = theirs.iter().filter(|m| ours.binary_search(m).is_err()).count();
        return Err(format!(
            "legal-move sets differ at {at}, seat {seat}: Blokee {} moves, GTP {} ({only_ours} only in Blokee, {only_theirs} only in GTP)",
            ours.len(),
            theirs.len()
        ));
    }
    Ok(ours.len())
}

fn gtp_legal(gtp: &mut Gtp, map: &Mapping, seat: usize) -> Result<Vec<i32>, String> {
    let body = gtp.command(&format!("all_legal {}", map.colour[seat]))?;
    body.split_whitespace().map(|m| map.from_gtp(m)).collect()
}

/// `final_score` from the GTP engine, per Blokee seat. Pentobi lists colours 1..4.
pub fn gtp_points(gtp: &mut Gtp, map: &Mapping) -> Result<[i64; SEAT_COUNT], String> {
    let body = gtp.command("final_score")?;
    let values: Vec<i64> = body.split_whitespace().map(|v| v.parse::<i64>().map_err(|_| format!("final_score: bad value '{v}'"))).collect::<Result<_, _>>()?;
    if values.len() != SEAT_COUNT {
        return Err(format!("final_score: expected {SEAT_COUNT} values, got '{body}'"));
    }
    Ok(std::array::from_fn(|seat| values[map.colour[seat].parse::<usize>().unwrap() - 1]))
}

/// Pentobi's points are squares placed plus the same bonuses Blokee scores (15 for all pieces,
/// 5 more if the monomino was last), so `points - 89` must equal Blokee's score exactly.
fn compare_scores(scores: &[f64; SEAT_COUNT], points: &[i64; SEAT_COUNT]) -> Result<(), String> {
    for seat in 0..SEAT_COUNT {
        if (points[seat] - TOTAL_SQUARES as i64) as f64 != scores[seat] {
            return Err(format!("final scores differ: Blokee {scores:?}, GTP points {points:?} (expected points - {TOTAL_SQUARES} = Blokee)"));
        }
    }
    Ok(())
}

/// Ranks (1 = best, ties share the better rank) of four scores.
pub fn ranks<T: PartialOrd + Copy>(values: &[T; SEAT_COUNT]) -> [usize; SEAT_COUNT] {
    std::array::from_fn(|i| 1 + values.iter().filter(|&&v| v > values[i]).count())
}

// ---------------------------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Player {
    /// Index into the engine pool.
    Blokee(usize),
    Gtp,
}

pub struct BridgeRecord {
    pub scores: [f64; SEAT_COUNT],
    pub gtp_points: [i64; SEAT_COUNT],
    pub moves: Vec<i32>,
    pub plies: usize,
    /// Wall-clock milliseconds of every decision that produced a move, per seat.
    pub move_ms: [Vec<f64>; SEAT_COUNT],
    /// Legal-move sets compared (one per decision when `check_legal`).
    pub legal_checks: usize,
}

/// One seeded game. `Player::Blokee` seats search with the pool engine and choose as the match
/// harness does; `Player::Gtp` seats are `genmove` from the engine, which also receives every other
/// seat's move with `play`. `check_legal` compares the full legal-move set before every decision.
pub fn play_bridge_game(
    pool: &mut [Engine],
    players: [Player; SEAT_COUNT],
    options: &GameOptions,
    gtp: &mut Gtp,
    map: &Mapping,
    check_legal: bool,
) -> Result<BridgeRecord, String> {
    let budget = options.iteration_budget.ok_or("the bridge plays iteration-budgeted searches only")?;
    let mut rng = Rng::new(options.seed);
    let mut opening_rng = Rng::new(options.seed ^ 0x9e37_79b9);
    let mut state = GameState::new(options.opening_anywhere);
    let mut plies = 0usize;
    let mut moves = Vec::new();
    let mut move_ms: [Vec<f64>; SEAT_COUNT] = Default::default();
    let mut legal_checks = 0usize;
    while !state.finished && plies < options.max_plies {
        let seat = state.turn;
        let colour = &map.colour[seat];
        let ours_has_move = state.has_move(seat);
        let at = format!("ply {plies}, seat {seat} (GTP colour {colour})");
        if check_legal {
            let theirs = gtp_legal(gtp, map, seat)?;
            compare_legal(&state, seat, theirs, &at)?;
            legal_checks += 1;
        }
        let chosen: Option<i32> = match players[seat] {
            Player::Blokee(index) => {
                if !ours_has_move {
                    let theirs = gtp_legal(gtp, map, seat)?;
                    if !theirs.is_empty() {
                        return Err(format!("pass disagreement at {at}: Blokee has no move, GTP lists {}", theirs.len()));
                    }
                    None
                } else {
                    let engine = &mut pool[index];
                    let mut position = state.to_position();
                    let mut stats = MoveStats::default();
                    let started = Instant::now();
                    engine.set_recent(&crate::game::recent_placements(&moves));
                    let ranked: Vec<Ranked> = engine.search(&mut position, seat, budget, &mut rng, &mut stats);
                    move_ms[seat].push(started.elapsed().as_secs_f64() * 1000.0);
                    let mv = choose_ranked(&ranked, plies, options, &mut opening_rng)
                        .ok_or_else(|| format!("Blokee returned no move at {at} although it has one"))?;
                    let text = map.to_gtp(mv);
                    gtp.command(&format!("play {colour} {text}")).map_err(|e| format!("GTP rejected Blokee's move {text} at {at}: {e}"))?;
                    Some(mv)
                }
            }
            Player::Gtp => {
                let started = Instant::now();
                let reply = gtp.command(&format!("genmove {colour}")).map_err(|e| format!("genmove failed at {at}: {e}"))?;
                let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                let reply = reply.trim().to_string();
                if reply.eq_ignore_ascii_case("pass") {
                    if ours_has_move {
                        return Err(format!("pass disagreement at {at}: GTP passed, Blokee has a legal move"));
                    }
                    None
                } else if reply.eq_ignore_ascii_case("resign") {
                    return Err(format!("GTP resigned at {at} (run it with --noresign)"));
                } else {
                    let mv = map.from_gtp(&reply).map_err(|e| format!("at {at}: {e}"))?;
                    if !ours_has_move || !state.board.is_legal(seat, mv) {
                        return Err(format!("GTP played {reply} at {at}, which Blokee holds illegal"));
                    }
                    move_ms[seat].push(elapsed);
                    Some(mv)
                }
            }
        };
        match chosen {
            Some(mv) => {
                state.apply(mv);
                moves.push(mv);
            }
            None => {
                state.pass();
                moves.push(-1);
            }
        }
        plies += 1;
    }
    if !state.finished {
        return Err(format!("game did not finish in {} plies", options.max_plies));
    }
    let scores = state.scores();
    let points = gtp_points(gtp, map)?;
    compare_scores(&scores, &points)?;
    Ok(BridgeRecord { scores, gtp_points: points, moves, plies, move_ms, legal_checks })
}

pub struct ReplayReport {
    pub plies: usize,
    pub moves_played: usize,
    pub passes: usize,
    pub legal_checks: usize,
    pub legal_moves_compared: usize,
    pub scores: [f64; SEAT_COUNT],
    pub gtp_points: [i64; SEAT_COUNT],
}

/// The validity-gate replay: feeds a finished Blokee game (`-1` = pass) into a fresh GTP board.
/// Before every ply the full legal sets must agree; every move must be accepted (Pentobi always
/// rejects illegal `play` arguments); every Blokee pass must be a GTP position with no legal move;
/// and the final scores must agree exactly (hence also in rank).
pub fn replay_into_gtp(moves: &[i32], gtp: &mut Gtp, map: &Mapping) -> Result<ReplayReport, String> {
    gtp.command("clear_board")?;
    let mut state = GameState::new(false);
    let (mut moves_played, mut passes, mut legal_checks, mut compared) = (0, 0, 0, 0);
    for (ply, &mv) in moves.iter().enumerate() {
        let seat = state.turn;
        let colour = map.colour[seat].clone();
        let at = format!("ply {ply}, seat {seat} (GTP colour {colour})");
        let theirs = gtp_legal(gtp, map, seat)?;
        compared += compare_legal(&state, seat, theirs, &at)?;
        legal_checks += 1;
        if mv < 0 {
            if state.has_move(seat) {
                return Err(format!("record passes at {at} but Blokee has a move"));
            }
            state.pass();
            passes += 1;
        } else {
            let text = map.to_gtp(mv);
            gtp.command(&format!("play {colour} {text}")).map_err(|e| format!("GTP rejected {text} at {at}: {e}"))?;
            state.apply(mv);
            moves_played += 1;
        }
    }
    if !state.finished {
        return Err("record ends before the game is finished".into());
    }
    let scores = state.scores();
    let points = gtp_points(gtp, map)?;
    compare_scores(&scores, &points)?;
    Ok(ReplayReport { plies: moves.len(), moves_played, passes, legal_checks, legal_moves_compared: compared, scores, gtp_points: points })
}
