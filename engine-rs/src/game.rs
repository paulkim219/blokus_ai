//! One seeded four-player game (`playSeatedGame` in `src/ai/selfplay.ts`).
//!
//! The RNG discipline is the TS one: a single global stream seeded with the game seed is consumed
//! by every search in game order, and opening sampling draws from its own stream
//! (`seed ^ 0x9e3779b9`) so it advances once per sampled ply regardless of rollout counts.

use crate::bitboard::*;
use crate::engine::{Engine, MoveStats, Ranked, Source};
use crate::placements::*;
use crate::position::{Position, SEAT_COLORS, SEAT_COUNT};
use crate::rng::Rng;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Greedy,
    Search,
}

impl Policy {
    pub fn parse(value: &str) -> Result<Policy, String> {
        match value {
            "greedy" => Ok(Policy::Greedy),
            "mcts-bench" | "mcts-short" | "mcts-long" => Ok(Policy::Search),
            other => Err(format!("unknown policy {other}")),
        }
    }
}

/// The legacy `GameState` reduced to what play needs. `board.out` is never set: the game loop,
/// like `src/engine/game.ts`, asks each seat in turn and counts consecutive passes.
#[derive(Clone)]
pub struct GameState {
    pub board: Position,
    pub turn: usize,
    pub consecutive_passes: usize,
    pub finished: bool,
}

impl GameState {
    pub fn new(opening_anywhere: bool) -> Self {
        GameState { board: Position::initial(opening_anywhere), turn: 0, consecutive_passes: 0, finished: false }
    }

    /// `toPosition(state)`: a fresh bitboard position rebuilt from occupancy, as the TS adapter does.
    pub fn to_position(&self) -> Position {
        let mut owners = [-1i8; CELL_COUNT];
        for seat in 0..SEAT_COUNT {
            for cell in 0..CELL_COUNT {
                if test_bit(&self.board.own[seat], cell) {
                    owners[cell] = seat as i8;
                }
            }
        }
        Position::from_cells(&owners, self.board.hand, self.board.last_piece, self.turn, self.board.opening_anywhere)
    }

    pub fn has_move(&self, seat: usize) -> bool {
        self.board.has_move(seat)
    }

    pub fn apply(&mut self, mv: i32) {
        self.board.force_turn(self.turn);
        self.board.apply(mv);
        self.consecutive_passes = 0;
        self.turn = (self.turn + 1) % SEAT_COUNT;
    }

    pub fn pass(&mut self) {
        self.consecutive_passes += 1;
        if self.consecutive_passes >= SEAT_COUNT {
            self.finished = true;
        } else {
            self.turn = (self.turn + 1) % SEAT_COUNT;
        }
    }

    pub fn scores(&self) -> [f64; SEAT_COUNT] {
        self.board.scores()
    }
}

pub struct SeatSetup<'a> {
    pub engine: &'a mut Engine,
    pub policy: Policy,
}

pub struct GameOptions {
    pub seed: u32,
    pub opening_anywhere: bool,
    pub iteration_budget: Option<u32>,
    pub max_plies: usize,
    pub opening_random_plies: usize,
    pub opening_top_k: usize,
}

pub struct GameRecord {
    /// Per seat in turn order.
    pub scores: [f64; SEAT_COUNT],
    pub plies: usize,
    pub finished: bool,
    pub moves: Vec<i32>,
    pub iterations: [u64; SEAT_COUNT],
}

/// One decision, as an observer sees it: the state before the move and what the mover considered.
pub struct Decision<'a> {
    pub state: &'a GameState,
    pub ply: usize,
    pub seat: usize,
    pub ranked: &'a [Ranked],
    pub chosen: i32,
    pub stats: &'a MoveStats,
}

pub fn play_game(pool: &mut [Engine], seat_engine: [usize; SEAT_COUNT], policies: [Policy; SEAT_COUNT], options: &GameOptions) -> Result<GameRecord, String> {
    play_game_observed(pool, seat_engine, policies, options, &mut |_| {})
}

/// Plays one game. `seat_engine[seat]` indexes into `pool`, so seats sharing a version share an
/// engine. `observe` sees every decision that had at least one legal move.
pub fn play_game_observed(
    pool: &mut [Engine],
    seat_engine: [usize; SEAT_COUNT],
    policies: [Policy; SEAT_COUNT],
    options: &GameOptions,
    observe: &mut dyn FnMut(Decision),
) -> Result<GameRecord, String> {
    let mut rng = Rng::new(options.seed);
    let mut opening_rng = Rng::new(options.seed ^ 0x9e37_79b9);
    let mut state = GameState::new(options.opening_anywhere);
    let mut plies = 0;
    let mut moves = Vec::new();
    let mut iterations = [0u64; SEAT_COUNT];
    while !state.finished && plies < options.max_plies {
        let seat = state.turn;
        let mut chosen: Option<i32> = None;
        if state.has_move(seat) {
            let engine = &mut pool[seat_engine[seat]];
            let mut position = state.to_position();
            let mut stats = MoveStats::default();
            let ranked: Vec<Ranked> = match policies[seat] {
                Policy::Greedy => {
                    stats.source = Source::Greedy;
                    engine.rank_greedy(&mut position, seat, 48)
                }
                Policy::Search => {
                    let budget = options
                        .iteration_budget
                        .ok_or("the native engine plays iteration-budgeted searches only")?;
                    engine.search(&mut position, seat, budget, &mut rng, &mut stats)
                }
            };
            iterations[seat] += stats.iterations as u64;
            let top_k = if plies < options.opening_random_plies { options.opening_top_k } else { 1 };
            chosen = ranked.first().map(|r| r.mv);
            if top_k > 1 && !ranked.is_empty() {
                let pool_size = top_k.min(ranked.len());
                chosen = Some(ranked[(opening_rng.next_f64() * pool_size as f64).floor() as usize].mv);
            }
            if let Some(mv) = chosen {
                observe(Decision { state: &state, ply: plies, seat, ranked: &ranked, chosen: mv, stats: &stats });
            }
        }
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
    Ok(GameRecord { scores: state.scores(), plies, finished: state.finished, moves, iterations })
}

/// Seat index → colour, for the protocol.
pub fn color(seat: usize) -> &'static str {
    SEAT_COLORS[seat]
}

pub fn piece_name(mv: i32) -> &'static str {
    RAW_PIECES[placements().piece_id[mv as usize] as usize].0
}
