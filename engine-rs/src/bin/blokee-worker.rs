//! Drop-in native replacement for `scripts/tournamentWorker.ts`.
//!
//! Reads one `GameAssignment` JSON per stdin line and writes one `GameOutcome` JSON per stdout
//! line. The TS parent (`scripts/lib/pool.ts` with `native: true`) resolves every seat's version to
//! its `BitboardParams` and ships them in `nativeParams`, so version semantics stay defined in one
//! place. Anything this engine cannot play identically is reported as an `error` outcome — never
//! silently played some other way.

use blokee::config::BitboardParams;
use blokee::engine::Engine;
use blokee::game::{GameOptions, Policy, play_game};
use blokee::position::SEAT_COLORS;
use blokee::rollout_policy::RolloutPolicy;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Assignment {
    id: String,
    seat_versions: HashMap<String, String>,
    seat_policies: HashMap<String, String>,
    seed: u32,
    #[serde(default)]
    opening_mode: Option<String>,
    #[serde(default)]
    iteration_budget: Option<u32>,
    #[serde(default)]
    max_plies: Option<usize>,
    #[serde(default)]
    opening_random_plies: Option<usize>,
    #[serde(default)]
    opening_top_k: Option<usize>,
    #[serde(default)]
    native_params: HashMap<String, Value>,
    #[serde(flatten)]
    rest: HashMap<String, Value>,
}

/// Fields the TS worker understands that change what a game reports or how it is played.
const UNSUPPORTED: [&str; 6] = [
    "seatPersonalities",
    "seatPersonalitySchedules",
    "logFeatures",
    "traceSeat",
    "oracleProbe",
    "oracleTrajectory",
];

struct Worker {
    /// Keyed by version id plus the exact params JSON, so a tuner candidate re-using an id with new
    /// params never plays a stale engine.
    engines: HashMap<(String, String), usize>,
    pool: Vec<Engine>,
    tables: HashMap<String, Arc<RolloutPolicy>>,
}

impl Worker {
    fn engine_for(&mut self, version: &str, params: &Value) -> Result<usize, String> {
        let key = (version.to_string(), params.to_string());
        if let Some(&index) = self.engines.get(&key) {
            return Ok(index);
        }
        let parsed: BitboardParams =
            serde_json::from_value(params.clone()).map_err(|e| format!("{version}: bad params: {e}"))?;
        let table = match (&parsed.search.playout_policy[..], &parsed.search.playout_table_path) {
            ("table", Some(path)) => Some(match self.tables.get(path) {
                Some(table) => Arc::clone(table),
                None => {
                    let table = Arc::new(RolloutPolicy::from_file(path)?);
                    self.tables.insert(path.clone(), Arc::clone(&table));
                    table
                }
            }),
            _ => None,
        };
        let engine = Engine::new(parsed, table).map_err(|e| format!("{version}: {e}"))?;
        self.pool.push(engine);
        self.engines.insert(key, self.pool.len() - 1);
        Ok(self.pool.len() - 1)
    }

    fn handle(&mut self, a: &Assignment) -> Result<Value, String> {
        for field in UNSUPPORTED {
            if a.rest.get(field).is_some_and(|v| !v.is_null() && v != &json!(false)) {
                return Err(format!("{field} is not supported by the native worker"));
            }
        }
        let mut seat_engine = [0usize; 4];
        let mut policies = [Policy::Greedy; 4];
        for (seat, color) in SEAT_COLORS.iter().enumerate() {
            let version = a.seat_versions.get(*color).ok_or(format!("no version for {color}"))?;
            let params = a
                .native_params
                .get(version)
                .ok_or(format!("{version}: not a bitboard engine, or the parent sent no nativeParams"))?;
            seat_engine[seat] = self.engine_for(version, params)?;
            policies[seat] = Policy::parse(a.seat_policies.get(*color).ok_or(format!("no policy for {color}"))?)?;
        }
        let options = GameOptions {
            seed: a.seed,
            opening_anywhere: a.opening_mode.as_deref() == Some("anywhere"),
            iteration_budget: a.iteration_budget,
            max_plies: a.max_plies.unwrap_or(usize::MAX),
            opening_random_plies: a.opening_random_plies.unwrap_or(0),
            opening_top_k: a.opening_top_k.unwrap_or(3),
        };
        let started = Instant::now();
        let record = play_game(&mut self.pool, seat_engine, policies, &options)?;
        // Scores and winners in PLAYER_COLORS order (blue, yellow, purple, green), as TS reports them.
        let display = ["blue", "yellow", "purple", "green"];
        let score_of = |color: &str| record.scores[SEAT_COLORS.iter().position(|c| *c == color).unwrap()];
        let best = display.iter().map(|c| score_of(c)).fold(f64::NEG_INFINITY, f64::max);
        let scores: serde_json::Map<String, Value> = display.iter().map(|c| (c.to_string(), json!(score_of(c)))).collect();
        let winner: Vec<&str> = display.iter().copied().filter(|c| score_of(c) == best).collect();
        Ok(json!({
            "id": a.id,
            "scores": scores,
            "winner": winner,
            "plies": record.plies,
            "finished": record.finished,
            "durationMs": started.elapsed().as_millis() as u64,
        }))
    }
}

fn main() {
    let mut worker = Worker { engines: HashMap::new(), pool: Vec::new(), tables: HashMap::new() };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let outcome = match serde_json::from_str::<Assignment>(&line) {
            Ok(assignment) => worker.handle(&assignment).unwrap_or_else(|error| {
                json!({
                    "id": assignment.id,
                    "scores": {"blue": 0, "yellow": 0, "purple": 0, "green": 0},
                    "winner": [], "plies": 0, "finished": false, "durationMs": 0,
                    "error": error,
                })
            }),
            Err(error) => {
                let id = serde_json::from_str::<Value>(&line).ok().and_then(|v| v["id"].as_str().map(String::from)).unwrap_or_default();
                json!({"id": id, "scores": {"blue": 0, "yellow": 0, "purple": 0, "green": 0},
                       "winner": [], "plies": 0, "finished": false, "durationMs": 0,
                       "error": format!("bad assignment: {error}")})
            }
        };
        writeln!(stdout, "{outcome}").unwrap();
        stdout.flush().unwrap();
    }
}
