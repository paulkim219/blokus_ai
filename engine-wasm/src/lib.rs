//! The native engine (`engine-rs`, crate `blokee`) behind a JSON-in, JSON-out interface, compiled
//! to `wasm32-unknown-unknown` for the app's search worker (`src/ai/nativeWasm/`).
//!
//! Nothing here decides anything: a request is turned into exactly the `Position`, recent
//! placements, RNG and budget that `blokee::game::play_game` would hand `Engine::search`, and the
//! engine's ranked moves are written back. The same code is linked natively by
//! `src/bin/blokee-wasm-probe.rs`, so the identity check compares the two builds of the engine and
//! nothing else.
//!
//! Interface: plain `extern "C"` exports and UTF-8 JSON through linear memory, no wasm-bindgen.
//! The app needs four calls, the module imports nothing, and there is no generated JS glue whose
//! version has to match a CLI.
//!
//! - `blokee_alloc(len) -> ptr` / `blokee_free(ptr, len)`: buffers the host writes requests into.
//! - `blokee_engine_new(config_ptr, config_len, table_ptr, table_len) -> handle` (0 on error).
//!   `config` is a resolved native config (`engine-rs/configs/*.json`); `table` is the rollout
//!   table JSON the config's `playoutTablePath` names (len 0 when it names none).
//! - `blokee_engine_free(handle)`.
//! - `blokee_search(handle, request_ptr, request_len) -> 1 | 0`: 1 and a response, or 0 and an
//!   error message; either way the text is at `blokee_result_ptr()` / `blokee_result_len()` until
//!   the next call.

use blokee::bitboard::CELL_COUNT;
use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats, Ranked, Source};
use blokee::game::{GameState, recent_placements};
use blokee::position::{Position, SEAT_COUNT};
use blokee::rng::Rng;
use blokee::rollout_policy::{RawRolloutPolicy, RolloutPolicy};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::sync::Arc;

/// Builds an engine from a native config and, when the config's rollout policy is `"table"`, the
/// table's JSON text. Refuses what the browser cannot run instead of playing something else.
pub fn create_engine(config_json: &str, table_json: Option<&str>) -> Result<Engine, String> {
    let params: BitboardParams = serde_json::from_str(config_json).map_err(|e| format!("config: {e}"))?;
    if let Some(native) = params.native.as_ref() {
        if native.prior.is_some() {
            return Err("config asks for native.prior (a learned prior served over a Unix socket), which the WASM build cannot run".into());
        }
        if native.net.is_some() {
            return Err("config asks for native.net (a network served over a Unix socket), which the WASM build cannot run".into());
        }
    }
    let table = match (&params.search.playout_policy[..], &params.search.playout_table_path) {
        ("table", Some(path)) => {
            let text = table_json.filter(|t| !t.is_empty()).ok_or_else(|| format!("config needs the rollout table {path}, which was not passed"))?;
            let raw: RawRolloutPolicy = serde_json::from_str(text).map_err(|e| format!("rollout table {path}: {e}"))?;
            Some(Arc::new(RolloutPolicy::load(&raw)?))
        }
        _ => None,
    };
    Engine::new(params, table)
}

/// One decision. The position is either a game record (`moves`, replayed from the empty board as
/// `play_game` plays it) or a board (`cells`, `hand`, `lastPiece`, `turn`, as `toPosition` builds
/// it from a `GameState`, plus the game's `recent` placements).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequest {
    /// `"search"` (default): `Engine::search`. `"greedy"`: `Engine::rank_greedy`, no tree.
    #[serde(default)]
    pub mode: Option<String>,
    /// Seat to choose for (0 blue, 1 green, 2 purple, 3 yellow). Defaults to the side to move.
    #[serde(default)]
    pub seat: Option<usize>,
    /// Base iterations; the engine multiplies by the config's `iterationScale` (and shape) itself.
    #[serde(default)]
    pub budget: Option<u32>,
    /// Seeds the search's RNG (`Rng::new(seed)`).
    #[serde(default)]
    pub seed: u32,
    /// Greedy shortlist (default 48, as `rankMovesGreedyV12`).
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub moves: Option<Vec<i32>>,
    #[serde(default)]
    pub opening_anywhere: bool,
    /// 400 cell owners, row-major (`y * 20 + x`), seat index or -1.
    #[serde(default)]
    pub cells: Option<Vec<i8>>,
    /// Per seat, bit `p` set while piece `p` is still in hand.
    #[serde(default)]
    pub hand: Option<[u32; SEAT_COUNT]>,
    #[serde(default)]
    pub last_piece: Option<[i32; SEAT_COUNT]>,
    #[serde(default)]
    pub turn: Option<usize>,
    /// The game's placements so far as `[seat, placement]`, oldest first (the last three are used).
    #[serde(default)]
    pub recent: Option<Vec<(usize, i32)>>,
}

#[derive(Serialize)]
pub struct RankedOut {
    pub mv: i32,
    pub visits: i32,
    /// As `Engine::search` reports it: `logit(mean) * sigmoidScale` for a searched move.
    pub value: f64,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub source: &'static str,
    pub iterations: u32,
    pub ranked: Vec<RankedOut>,
}

fn source_name(source: Source) -> &'static str {
    match source {
        Source::Search => "search",
        Source::Heuristic => "heuristic",
        Source::Packer => "packer",
        Source::Greedy => "greedy",
    }
}

/// The position, the seat and the recent placements a request describes.
fn position_of(request: &SearchRequest) -> Result<(Position, usize, Vec<(usize, i32)>), String> {
    if let Some(moves) = &request.moves {
        if request.cells.is_some() {
            return Err("give either moves or cells, not both".into());
        }
        let mut state = GameState::new(request.opening_anywhere);
        for &mv in moves {
            if mv >= 0 {
                if !state.board.is_legal(state.turn, mv) {
                    return Err(format!("moves: placement {mv} is not legal for seat {}", state.turn));
                }
                state.apply(mv);
            } else {
                state.pass();
            }
        }
        let seat = request.seat.unwrap_or(state.turn);
        let recent = request.recent.clone().unwrap_or_else(|| recent_placements(moves));
        return Ok((state.to_position(), seat, recent));
    }
    let cells = request.cells.as_ref().ok_or("request needs moves or cells")?;
    if cells.len() != CELL_COUNT || cells.iter().any(|&c| !(-1..SEAT_COUNT as i8).contains(&c)) {
        return Err(format!("cells: expected {CELL_COUNT} owners in -1..=3"));
    }
    let hand = request.hand.ok_or("cells need hand")?;
    if hand.iter().any(|&h| h >= 1 << 21) {
        return Err("hand: masks are 21 bits".into());
    }
    let last_piece = request.last_piece.unwrap_or([-1; SEAT_COUNT]);
    if last_piece.iter().any(|&p| !(-1..21).contains(&p)) {
        return Err("lastPiece: piece ids are -1..=20".into());
    }
    let turn = request.turn.unwrap_or(0);
    let owners: [i8; CELL_COUNT] = cells[..].try_into().unwrap();
    let position = Position::from_cells(&owners, hand, last_piece, turn % SEAT_COUNT, request.opening_anywhere);
    let seat = request.seat.unwrap_or(turn);
    Ok((position, seat, request.recent.clone().unwrap_or_default()))
}

/// Runs one request on `engine` and returns the response JSON.
pub fn search(engine: &mut Engine, request_json: &str) -> Result<String, String> {
    let request: SearchRequest = serde_json::from_str(request_json).map_err(|e| format!("request: {e}"))?;
    let (mut position, seat, recent) = position_of(&request)?;
    if seat >= SEAT_COUNT {
        return Err(format!("seat {seat} out of range"));
    }
    let mut stats = MoveStats::default();
    let ranked: Vec<Ranked> = match request.mode.as_deref().unwrap_or("search") {
        "search" => {
            let budget = request.budget.ok_or("search needs a budget (base iterations)")?;
            engine.set_recent(&recent);
            let mut rng = Rng::new(request.seed);
            engine.search(&mut position, seat, budget, &mut rng, &mut stats)
        }
        "greedy" => {
            stats.source = Source::Greedy;
            engine.rank_greedy(&mut position, seat, request.limit.unwrap_or(48))
        }
        other => return Err(format!("unknown mode {other}")),
    };
    let response = SearchResponse {
        source: source_name(stats.source),
        iterations: stats.iterations,
        ranked: ranked.into_iter().map(|r| RankedOut { mv: r.mv, visits: r.visits, value: r.value }).collect(),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

// ---- extern "C" surface ---------------------------------------------------------------------

thread_local! {
    static ENGINES: RefCell<Vec<Option<Engine>>> = const { RefCell::new(Vec::new()) };
    static RESULT: RefCell<String> = const { RefCell::new(String::new()) };
}

fn set_result(text: String) {
    RESULT.with(|r| *r.borrow_mut() = text);
}

/// # Safety
/// `ptr`/`len` must name `len` initialised bytes the caller owns (from `blokee_alloc`).
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map_err(|e| format!("not UTF-8: {e}"))
}

#[unsafe(no_mangle)]
pub extern "C" fn blokee_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` must come from `blokee_alloc(len)` with the same `len`, and be freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn blokee_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// # Safety
/// Each pointer/length pair must name initialised bytes (see `blokee_alloc`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn blokee_engine_new(config_ptr: *const u8, config_len: usize, table_ptr: *const u8, table_len: usize) -> u32 {
    let built = (|| {
        let config = unsafe { text(config_ptr, config_len) }?;
        let table = unsafe { text(table_ptr, table_len) }?;
        create_engine(config, Some(table))
    })();
    match built {
        Ok(engine) => ENGINES.with(|engines| {
            let mut engines = engines.borrow_mut();
            engines.push(Some(engine));
            set_result(String::new());
            engines.len() as u32
        }),
        Err(e) => {
            set_result(e);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn blokee_engine_free(handle: u32) {
    ENGINES.with(|engines| {
        if let Some(slot) = engines.borrow_mut().get_mut((handle as usize).wrapping_sub(1)) {
            *slot = None;
        }
    });
}

/// # Safety
/// `request_ptr`/`request_len` must name initialised bytes (see `blokee_alloc`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn blokee_search(handle: u32, request_ptr: *const u8, request_len: usize) -> u32 {
    let outcome = ENGINES.with(|engines| {
        let mut engines = engines.borrow_mut();
        let engine = engines
            .get_mut((handle as usize).wrapping_sub(1))
            .and_then(|slot| slot.as_mut())
            .ok_or_else(|| format!("no engine {handle}"))?;
        let request = unsafe { text(request_ptr, request_len) }?;
        search(engine, request)
    });
    let ok = outcome.is_ok() as u32;
    set_result(outcome.unwrap_or_else(|e| e));
    ok
}

#[unsafe(no_mangle)]
pub extern "C" fn blokee_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn blokee_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}
