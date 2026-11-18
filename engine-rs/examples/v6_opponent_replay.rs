//! One seed block of the Stage 1 diagnostic. The Python driver builds this once,
//! distributes independent blocks and reports paired results. See docs/V6_OPPONENT_REPLAY.md.
use blokee::config::BitboardParams;
use blokee::engine::{Engine, MoveStats};
use blokee::feature_prior::{PriorContext, PriorModel};
use blokee::game::{GameState, recent_placements};
use blokee::ordering::softmax_priors;
use blokee::position::new_move_buffer;
use blokee::rng::Rng;
use blokee::rollout_policy::RolloutPolicy;
use serde_json::{Value, json};
use std::{env, fs, sync::Arc};

const HERO: usize = 0;
const PROFILES: [&str; 4] = ["population-prior", "denial", "frontier", "center"];
const CONFIG: &str = "engine-rs/configs/v5.2-pro.json";

/// Derive independent, deterministic streams without depending on thread scheduling.
fn stream(seed: u32, purpose: u32, index: u32) -> u32 {
    let mut x = seed ^ purpose.wrapping_mul(0x9e3779b9) ^ index.wrapping_mul(0x85ebca6b);
    x = (x ^ (x >> 16)).wrapping_mul(0x7feb352d);
    x = (x ^ (x >> 15)).wrapping_mul(0x846ca68b);
    x ^ (x >> 16)
}

/// Opponent slots in turn order relative to the hero. Each is drawn independently.
fn lineup(rng: &mut Rng, hero: usize, homogeneous: bool) -> [usize; 4] {
    let mut seats = [HERO; 4];
    for offset in 1..4 {
        seats[(hero + offset) % 4] = if homogeneous {
            1
        } else {
            1 + rng.next_int(PROFILES.len() - 1)
        };
    }
    seats
}

struct League {
    models: Vec<PriorModel>,
    moves: Vec<i32>,
    scores: Vec<f64>,
    probabilities: Vec<f64>,
}

impl League {
    fn new(base: &PriorModel) -> Self {
        // All four models share the fitted v5 prior. Modify cold clones before
        // the scorer lazily caches position-independent logit contributions.
        let mut models = vec![base.clone()];
        for (feature, delta) in [("opp_cover", 2.0), ("new_f2", 2.0), ("centre", -0.8)] {
            let index = base.features.iter().position(|f| f == feature).unwrap();
            let mut profile = base.clone();
            for band in &mut profile.bands {
                band.weights[index] += delta;
            }
            models.push(profile);
        }
        let moves = new_move_buffer();
        Self {
            scores: vec![0.0; moves.len()],
            probabilities: vec![0.0; moves.len()],
            moves,
            models,
        }
    }

    fn choose(&mut self, state: &GameState, history: &[i32], profile: usize, uniform: f64) -> i32 {
        let seat = state.turn;
        let count = state
            .board
            .generate_moves(seat, &mut self.moves, usize::MAX);
        if count == 0 {
            return -1;
        }
        let moves = &self.moves[..count];
        let ctx = PriorContext::new(&state.board, seat, &recent_placements(history));
        self.models[profile].score(&ctx, moves, &mut self.scores[..count]);
        softmax_priors(&self.scores[..count], 1.0, &mut self.probabilities[..count]);
        let mut remaining = uniform;
        for (&mv, &p) in moves.iter().zip(&self.probabilities) {
            remaining -= p;
            if remaining <= 0.0 {
                return mv;
            }
        }
        moves[count - 1]
    }
}

fn play(state: &mut GameState, history: &mut Vec<i32>, mv: i32) {
    if mv < 0 {
        state.pass();
    } else {
        state.apply(mv);
    }
    history.push(mv);
}

// Simulate a forced candidate through four consecutive passes. Consume a uniform
// on every ply (including passes) so common random numbers stay aligned by turn.
fn finish(
    league: &mut League,
    root: &GameState,
    prefix: &[i32],
    mv: i32,
    seats: &[usize; 4],
    seed: u32,
) -> f64 {
    let mut rng = Rng::new(seed);
    let mut state = root.clone();
    let mut history = prefix.to_vec();
    play(&mut state, &mut history, mv);
    while !state.finished {
        let mv = league.choose(&state, &history, seats[state.turn], rng.next_f64());
        play(&mut state, &mut history, mv);
    }
    let scores = state.scores();
    (4.0 * scores[root.turn] - scores.iter().sum::<f64>()) / 3.0
}

fn best(scores: &[f64]) -> usize {
    let mut picked = 0;
    for i in 1..scores.len() {
        if scores[i] > scores[picked] {
            picked = i;
        }
    }
    picked
}

#[derive(Clone, Copy)]
struct Settings {
    candidates: usize,
    planning: u32,
    evaluation: u32,
    budget: u32,
    homogeneous: bool,
}

fn replay(
    engine: &mut Engine,
    league: &mut League,
    block: u32,
    hero: usize,
    settings: Settings,
) -> Value {
    let mut root = GameState::new(false);
    let mut prefix = Vec::new();
    let actual = lineup(
        &mut Rng::new(stream(block, 1, 0)),
        hero,
        settings.homogeneous,
    );
    let turn_index = 8 + Rng::new(stream(block, 2, 0)).next_int(6);
    let seed = stream(block, 3, hero as u32);
    let mut rng = Rng::new(stream(seed, 4, 0));
    while prefix.len() < turn_index * 4 + hero && !root.finished {
        let mv = league.choose(&root, &prefix, actual[root.turn], rng.next_f64());
        play(&mut root, &mut prefix, mv);
    }
    let mut candidates = Vec::new();
    if !root.finished && root.has_move(hero) {
        engine.set_recent(&recent_placements(&prefix));
        let ranked = engine.search(
            &mut root.to_position(),
            hero,
            settings.budget,
            &mut Rng::new(stream(seed, 5, 0)),
            &mut MoveStats::default(),
        );
        candidates.extend(ranked.iter().take(settings.candidates).map(|r| r.mv));
        assert!(!candidates.is_empty());
    }
    let mut generic = vec![0.0; candidates.len()];
    let mut informed = generic.clone();
    for rep in 0..settings.planning {
        // Generic knows the exact league prior but never reads this game's
        // hidden types. Each hypothesis persists for the whole continuation.
        let hypothesis = lineup(
            &mut Rng::new(stream(seed, 6, rep)),
            hero,
            settings.homogeneous,
        );
        let paired_seed = stream(seed, 7, rep);
        for (k, &mv) in candidates.iter().enumerate() {
            generic[k] += finish(league, &root, &prefix, mv, &hypothesis, paired_seed);
            informed[k] += finish(league, &root, &prefix, mv, &actual, paired_seed);
        }
    }
    let selected = |scores: &[f64]| candidates.get(best(scores)).copied();
    let (generic_move, informed_move) = (selected(&generic), selected(&informed));
    let mut delta = 0.0;
    if let (Some(g), Some(i)) = (generic_move, informed_move) {
        if g != i {
            for rep in 0..settings.evaluation {
                let paired_seed = stream(seed, 8, rep);
                delta += finish(league, &root, &prefix, i, &actual, paired_seed)
                    - finish(league, &root, &prefix, g, &actual, paired_seed);
            }
        }
    }
    json!({"seed":block,"hero":hero,"own_turn":turn_index+1,"prefix":prefix,
        "policies":actual.map(|p| PROFILES[p]),"candidate_moves":candidates,
        "generic_planning_margin":generic.iter().map(|x| x / f64::from(settings.planning)).collect::<Vec<_>>(),
        "informed_planning_margin":informed.iter().map(|x| x / f64::from(settings.planning)).collect::<Vec<_>>(),
        "generic_move":generic_move,"informed_move":informed_move,"delta":delta / f64::from(settings.evaluation)})
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args()
        .skip(1)
        .map(|s| s.parse::<u32>())
        .collect::<Result<Vec<_>, _>>()?;
    let [seed, k, planning, evaluation, budget, homogeneous] = args.as_slice() else {
        return Err(
            "expected SEED CANDIDATES PLANNING EVALUATION ROOT_BUDGET HOMOGENEOUS_0_OR_1".into(),
        );
    };
    if *k < 2 || [planning, evaluation, budget].iter().any(|&&n| n == 0) || *homogeneous > 1 {
        return Err("need at least two candidates and positive budgets".into());
    }
    let settings = Settings {
        candidates: *k as usize,
        planning: *planning,
        evaluation: *evaluation,
        budget: *budget,
        homogeneous: *homogeneous == 1,
    };
    let params: BitboardParams = serde_json::from_str(&fs::read_to_string(CONFIG)?)?;
    let prior = params
        .native
        .as_ref()
        .unwrap()
        .candidates
        .as_ref()
        .unwrap()
        .model
        .as_ref()
        .unwrap();
    prior.check()?;
    assert!(!prior.has_extras());
    let mut league = League::new(prior);
    let table = RolloutPolicy::from_file(params.search.playout_table_path.as_ref().unwrap())?;
    let mut engine = Engine::new(params, Some(Arc::new(table)))?;
    let rows: Vec<_> = (0..4)
        .map(|hero| replay(&mut engine, &mut league, *seed, hero, settings))
        .collect();
    println!("{}", serde_json::to_string(&rows)?);
    Ok(())
}
