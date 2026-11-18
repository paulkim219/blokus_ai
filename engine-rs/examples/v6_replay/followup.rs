//! Separate random streams for nomination, nested-budget choice and held-out scoring.
use super::*;

const ARMS: [&str; 5] = [
    "generic",
    "generic_repeat",
    "oracle",
    "history",
    "wrong_history",
];
type Beliefs = [[f64; 3]; 4];

fn infer(
    league: &mut League,
    prefix: &[i32],
    hero: usize,
    homogeneous: bool,
) -> (Beliefs, f64, usize) {
    let mut history_gain = 0.0;
    let mut observed = 0;
    let mut seen = [0; 4];
    let mut belief = [[1.0 / 3.0; 3]; 4];
    if homogeneous {
        return ([[1.0, 0.0, 0.0]; 4], 0.0, 0);
    }
    let mut board = GameState::new(false);
    for (t, &mv) in prefix.iter().enumerate() {
        let seat = board.turn;
        if mv >= 0 && seat != hero {
            let count = board
                .board
                .generate_moves(seat, &mut league.moves, usize::MAX);
            let legal = &league.moves[..count];
            let chosen = legal.iter().position(|&m| m == mv).unwrap();
            let context = PriorContext::new(&board.board, seat, &recent_placements(&prefix[..t]));
            let mut generic_likelihood = 0.0;
            for (k, weight) in belief[seat].iter_mut().enumerate() {
                league.models[k + 1].score(&context, legal, &mut league.scores[..count]);
                softmax_priors(
                    &league.scores[..count],
                    1.0,
                    &mut league.probabilities[..count],
                );
                let likelihood = league.probabilities[chosen].max(1e-300);
                generic_likelihood += likelihood / 3.0;
                *weight *= likelihood;
            }
            let total: f64 = belief[seat].iter().sum();
            // Both probabilities are for the observed action given only earlier public moves.
            if count > 1 {
                if seen[seat] >= 3 {
                    history_gain += total.ln() - generic_likelihood.ln();
                    observed += 1;
                }
                seen[seat] += 1;
            }
            for w in &mut belief[seat] {
                *w /= total;
            }
        }
        if mv < 0 {
            board.pass();
        } else {
            board.apply(mv);
        }
    }
    (belief, history_gain, observed)
}

struct Trial<'a> {
    root: &'a GameState,
    prefix: &'a [i32],
    seed: u32,
    actual: [usize; 4],
    // The oracle alone plays continuations with the true per-seat generators.
    beliefs: [Beliefs; 5],
}

impl Trial<'_> {
    fn scores(
        &self,
        league: &mut League,
        arm: usize,
        stage: u32,
        moves: &[i32],
        samples: u32,
        low: u32,
    ) -> (Vec<f64>, Vec<f64>) {
        let mut sums = vec![0.0; moves.len()];
        let mut early = Vec::new();
        if moves.is_empty() {
            return (early, sums);
        }
        // Only the independent generic repeat gets a separate random stream.
        let channel = stage + if arm == 1 { 2 } else { 0 };
        for rep in 0..samples {
            let mut rng = Rng::new(stream(self.seed, channel, rep));
            let mut profiles = [HERO; 4];
            for offset in 1..4 {
                let seat = (self.root.turn + offset) % 4;
                let p = self.beliefs[arm][seat];
                let u = rng.next_f64();
                profiles[seat] = if u < p[0] {
                    1
                } else if u < p[0] + p[1] {
                    2
                } else {
                    3
                };
            }
            if ARMS[arm] == "oracle" {
                profiles = self.actual;
            }
            let paired = stream(self.seed, channel + 1, rep);
            for (k, &mv) in moves.iter().enumerate() {
                sums[k] += finish(league, self.root, self.prefix, mv, &profiles, paired);
            }
            if rep + 1 == low {
                early = sums.iter().map(|x| x / f64::from(low)).collect();
            }
        }
        (
            early,
            sums.into_iter().map(|x| x / f64::from(samples)).collect(),
        )
    }
}

pub(super) fn replay(
    engine: &mut Engine,
    league: &mut League,
    block: u32,
    hero: usize,
    settings: Settings,
    low: u32,
    nominations: u32,
) -> Value {
    let (root, prefix, actual, own_turn, seed, base) =
        make_root(engine, league, block, hero, settings);
    let mut tail_moves = Vec::new();
    // Select a bounded set of legal alternatives outside the incumbent's shortlist.
    if !base.is_empty() {
        let n = root
            .board
            .generate_moves(hero, &mut league.moves, usize::MAX);
        let legal = &league.moves[..n];
        let ctx = PriorContext::new(&root.board, hero, &recent_placements(&prefix));
        league.models[HERO].score(&ctx, legal, &mut league.scores[..n]);
        let mut tail: Vec<_> = (0..n).filter(|i| !base.contains(&legal[*i])).collect();
        tail.sort_by(|&a, &b| {
            league.scores[b]
                .total_cmp(&league.scores[a])
                .then_with(|| legal[a].cmp(&legal[b]))
        });
        tail_moves.extend(tail.iter().take(8).map(|&i| legal[i]));
    }
    let generic = if settings.homogeneous {
        [[1.0, 0.0, 0.0]; 4]
    } else {
        [[1.0 / 3.0; 3]; 4]
    };
    let (history, prediction_gain, predictions) =
        infer(league, &prefix, hero, settings.homogeneous);
    let mut wrong = history;
    for offset in 1..4 {
        let seat = (hero + offset) % 4;
        wrong[seat] = history[(hero + 1 + offset % 3) % 4];
    }
    let trial = Trial {
        root: &root,
        prefix: &prefix,
        seed,
        actual,
        beliefs: [generic, generic, generic, history, wrong],
    };
    let tail = tail_moves.as_slice();
    let mut nominees = Vec::new();
    let mut pool = base.clone();
    for arm in 0..ARMS.len() {
        let (_, scores) = trial.scores(league, arm, 20, tail, nominations, 0);
        let nominee = tail.get(best(&scores)).copied();
        nominees.push(nominee);
        if let Some(mv) = nominee {
            if !pool.contains(&mv) {
                pool.push(mv);
            }
        }
    }
    let mut planning = serde_json::Map::new();
    for (i, arm) in ARMS.iter().enumerate() {
        let (early, full) = trial.scores(league, i, 30, &pool, settings.planning, low);
        planning.insert(arm.to_string(), json!([early, full]));
    }
    let mut evaluation = vec![0.0; pool.len()];
    for rep in 0..settings.evaluation {
        let draw = stream(seed, 40, rep);
        for (i, &mv) in pool.iter().enumerate() {
            evaluation[i] += finish(league, &root, &prefix, mv, &actual, draw);
        }
    }
    for v in &mut evaluation {
        *v /= f64::from(settings.evaluation);
    }
    let labels = actual.map(|p| {
        if p < PROFILES.len() {
            PROFILES[p]
        } else {
            TRANSFER_PROFILES[p - PROFILES.len()]
        }
    });
    let mut row = json!({"seed":block,"hero":hero,"own_turn":own_turn,"prefix":prefix,"policies":labels,
        "posterior":history,"base":base,"proposal_candidates":tail,"nominees":ARMS.into_iter().zip(nominees).collect::<std::collections::BTreeMap<_,_>>(),
        "pool":pool,"planning":planning,"evaluation":evaluation});
    if settings.transfer {
        row["observed_actions_after_warmup"] = json!(predictions);
        row["history_log_likelihood_gain_sum"] = json!(prediction_gain);
    }
    row
}
