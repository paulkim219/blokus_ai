/**
 * The tunable surface of the v12 engine.
 *
 * §5 asks for "a per-seat vector (θ_centre, θ_corners, θ_territory, θ_waste, λ_next, λ_prev,
 * λ_diag) tuned by round-robin self-play in which the agent is rotated through all seats", and §4
 * asks for the same vector to differ by phase. Both axes are here, addressed by dotted path so
 * `scripts/lib/paramSpace.ts` can hand the whole thing to the CEM tuner without new plumbing.
 *
 * Every number below is a hypothesis, not a measurement. §8 is explicit that "every quantity that
 * will determine playing strength is still an untested hypothesis"; these are starting points
 * chosen to match the qualitative claims of §4 (opening: reach and corners; mid-game: aggression
 * and territory; endgame: packing) so the tuner starts somewhere defensible.
 */

export type PhaseId = 'opening' | 'midgame' | 'endgame';

export interface PhaseWeights {
  /** a — squares already placed. */
  squares: number;
  /** b — f(C_i), the transform of the open-corner count. */
  corners: number;
  /** c — |T_i|, Voronoi territory. */
  territory: number;
  /** d — empty cells in own territory that no remaining piece can fill. */
  waste: number;
  /** Centre reachability: Σ over open corners of a decreasing function of distance to centre. */
  centre: number;
  /** Discount on corners an opponent can reach within two steps. */
  frontier: number;
  /** e — opponent territory, scaled by λ_j. */
  oppTerritory: number;
  /** g — opponent corners, scaled by λ_j. */
  oppCorners: number;
  /**
   * Opponent squares already placed, scaled by λ_j. **Not in the report.** §3.2's E_i weighs
   * opponents only by territory and corners, so the engine cannot see a rival out-placing it on
   * raw squares — which is the quantity the game actually scores. 0 reproduces the report.
   */
  oppSquares: number;
  /**
   * `|C_i| + 2·(pieces still in hand)` — v11's fast-mode proxy for the legal move count |A_i|.
   *
   * §3.1 of the report names this feature ("Legal move count |A_i|. More expensive but captures
   * piece-shape compatibility") and §3.2's E_i then omits it. Corner count cannot substitute:
   * two positions with identical corners differ in legal placements according to whether the
   * remaining *shapes* fit around those corners. In v11 it carries a fitted weight of 1.01 early
   * and −0.87 late — negative at the end, where spare capacity is unspent squares rather than
   * opportunity. 0 reproduces the report.
   */
  mobility: number;
  /**
   * Open corners this seat holds that no opponent also holds — §3.1's frontier pressure at radius
   * zero, and v11's `uniqueLiberties` (fitted weight 0.86).
   *
   * Not subsumed by |T_i|: territory is a distance statement about cells, this is a legality
   * statement about corners, and a cell can sit firmly inside my territory while the only corner I
   * have into it is one an opponent can also play. 0 reproduces the report.
   */
  uniqueCorners: number;
  /**
   * Exponent in f(C_i) = Σ over regions of (corners in region)^p. The report fixes p = 0.5
   * ("a diminishing-returns transform such as Σ over regions of sqrt(corners in region)"), but
   * before the board fragments there is one region, so f = |C|^p and p = 0.5 cuts the marginal
   * value of a corner at |C| = 10 to 0.16 of its linear value — on the feature §3.1 itself calls
   * "the cheapest and most predictive single". p = 1 is the linear count v11 uses.
   */
  cornerExponent: number;
}

/** Aggression coefficients λ_j, by the seat's relation to the mover (§5). */
export interface LambdaProfile {
  next: number;
  prev: number;
  diag: number;
  /**
   * Extra λ against whoever currently leads. "Under a rank objective, blocking the current leader
   * is worth more because rank is zero-sum among the top places" (§3.2).
   */
  leaderBoost: number;
}

/** Per-seat multipliers (§5). Seat 0 moves first. */
export interface SeatProfile {
  centre: number;
  corners: number;
  territory: number;
  waste: number;
  /** Scales every λ for this seat: seat 1 expansionist, seat 4 the most obstructive. */
  aggression: number;
}

export interface MoveOrderWeights {
  /** Bonus proportional to piece size, decaying over the game (§3.2, packing efficiency). */
  pieceSize: number;
  /** Weight on Δsplit — what makes the search look at cut moves at all (§3.1). */
  split: number;
  /** New open corners the move creates. */
  newCorners: number;
  /** Opponent open corners the move covers. */
  denyCorners: number;
  /** Pull toward the centre, which matters most in the opening. */
  centrePull: number;
}

export interface SearchParams {
  /** Root simulation allocator. Sequential halving is deterministic and spends visits evenly
   * within each round before discarding the weaker half of the candidates. */
  rootPolicy: 'puct' | 'sequentialHalving';
  /** Blend of implicit max^n guidance into the sampled child mean used by tree selection. */
  implicitMaxnWeight: number;
  /** Piece-level RAVE pseudo-count; 0 disables all-moves-as-first statistics. */
  raveEquivalence: number;
  /** Scale exploration by the backed-up variance, following the UCB1-Tuned confidence term. */
  varianceTuned: boolean;
  /** Apply variance tuning only while selecting a root child. */
  varianceTunedRootOnly: boolean;
  /** Optional terminal-rollout audit over the root shortlist after the main tree search. */
  rootAudit: 'none' | 'paired' | 'variance';
  /** Root moves considered by the audit. */
  rootAuditTopK: number;
  /** Total terminal rollouts spent by the audit, across every audited move. */
  rootAuditRollouts: number;
  /** Weight of the audit's score-margin estimate in the final root ranking. */
  rootAuditBlend: number;
  /** Two-level root selection over spatial destinations or piece identities. */
  rootGrouping: 'none' | 'spatial' | 'piece';
  /**
   * Weights file for the v4 learned evaluation, or undefined for the hand-written one.
   *
   * Set, the network replaces `E_i` at truncated leaves: it is asked for each seat's margin in
   * turn, and those four numbers go through the same aggregation, rank blend and material anchor
   * the hand-written evaluation feeds. Everything downstream of the leaf is unchanged, so a match
   * against v3 isolates the evaluation and nothing else.
   */
  netPath?: string;
  /** Shared-board, action-mask policy artifact. Multiple members are averaged in logit space. */
  pooledNetPath?: string;
  /** Divisor on the network's margin output before the sigmoid. Its outputs are in score units. */
  netScale: number;
  /** 0 = hand-written evaluation only, 1 = network only, in between blends the two margins. */
  netBlend: number;
  /**
   * Contract of the network's four outputs.
   *
   * `scores` preserves the original v4 implementation: outputs are treated as per-seat scores and
   * collapsed to a margin by `valueVector`. `meanMargins` is the contract used by the current
   * training exporter, whose labels are already `score - mean(other three)`; those values must be
   * squashed directly rather than having a second opponent margin subtracted from them.
   */
  netOutputKind: 'scores' | 'meanMargins' | 'values';
  /** Use the distribution head's log variances to sample a synthetic rollout return at the leaf. */
  netValueSampling: 'mean' | 'gaussian' | 'gaussianJoint';
  /** Multiplier on the learned conditional standard deviation; 0 collapses to the mean. */
  netSampleScale: number;
  /**
   * Run this many real rollout plies before asking the learned value model to finish the
   * continuation. Zero preserves the historical v4 behaviour (evaluate the expanded leaf
   * immediately). Positive values turn the model into a rollout-tail bootstrap.
   */
  netTailPrefix: number;
  /**
   * Maximum predicted standard deviation accepted by the rollout-tail bootstrap. Zero disables
   * the gate. Rejected predictions continue the incumbent rollout to its normal cutoff/terminal.
   */
  netTailMaxStd: number;
  /**
   * With full network replacement, retain a real terminal rollout at this fraction of leaves.
   * This is a Bernoulli mixture, not an average: it preserves some native rollout exploration while
   * converting the remaining leaves into faster network evaluations.
   */
  netRolloutProbability: number;
  /**
   * Use the network to score the root shortlist and set the PUCT prior from it.
   *
   * This is the use the network was actually *trained* for: its loss is listwise over one search
   * node's candidate children, which is the prior's job, not the leaf value's. Root-only by
   * design — a network call per child at every interior node would cost more than the search.
   */
  netPrior: boolean;
  /** Limit learned-prior use to the phase where its held-out sibling ranking is strongest. */
  netPriorPhase: 'all' | 'endgame' | 'openingMidgame';
  /** Probability-space blend between the hand prior (0) and learned root prior (1). */
  netPriorBlend: number;
  /** Softmax temperature over the network's prior scores, which are in score units. */
  netPriorTemp: number;
  /** Total policy pseudo-visits added only when reading the final root ranking. */
  rootPriorPseudoVisits: number;

  /** PUCT constant. The tree policy is AlphaZero's with a heuristic prior standing in for a net. */
  cPuct: number;
  /** Value subtracted from the parent mean for an unvisited child (first-play urgency). */
  fpuReduction: number;
  /** Softmax temperature over ordering scores. Higher is flatter. */
  priorTemp: number;
  /** Progressive widening: children allowed = init + growth · √visits. */
  wideningInit: number;
  wideningGrowth: number;
  /** Apply widening at interior nodes too, not just the root. */
  wideningAllNodes: boolean;
  /** ε-greedy playout policy: probability of a uniform random move (§6, "ε ≈ 0.1–0.2"). */
  playoutEps: number;
  /** Optional phase-specific ε values; null uses `playoutEps` in every phase. */
  playoutEpsByPhase: Record<PhaseId, number> | null;
  /** Plies before the playout is truncated and E_i is read instead (§2.2, early termination). */
  playoutCutoff: number;
  /** Moves considered per playout ply — playouts must stay cheap. */
  playoutMoveCap: number;
  /**
   * How many *distinct open corners* a playout ply pools candidates from before choosing.
   *
   * The implementation draws one corner at random and enumerates only the placements covering it,
   * which avoids the spatial bias of capping a full generation but leaves the policy unable to
   * compare a move at one corner against a move at another. 1 is that original behaviour.
   */
  playoutCorners: number;
  /**
   * Terminal-rollout policy shape.
   *
   * `'legacy'` is the shipped two-term argmax (piece size and centre pull) behind an ε-uniform
   * mixture. `'linear'` adds two more *static* per-placement terms and a sampling temperature, so
   * the policy can be fitted rather than hand-set.
   *
   * The extra terms are deliberately table lookups, not board queries. §3.1 of the v4 programme
   * prices a rollout candidate at roughly 40 ns — about a hundred cycles — because a pro-tier move
   * scores something like 1.2 million of them. Anything that touches the board per candidate spends
   * that budget; a precomputed popcount does not.
   */
  playoutPolicy: 'legacy' | 'linear' | 'table';
  /**
   * Weights for `playoutPolicy: 'linear'`, on top of the phase ordering's size/centre pair.
   * `cornerHalo` and `edgeHalo` are the static popcounts of the placement's diagonal and orthogonal
   * haloes: how much new frontier the move offers, and how much of its own it burns.
   */
  playoutCornerWeight: number;
  playoutEdgeWeight: number;
  /**
   * Softmax temperature for `'linear'`. 0 reproduces argmax exactly; larger values sample softly.
   * This generalises ε — ε is a uniform mixture, temperature is a graded one — and both are kept so
   * the fitted policy can reproduce the shipped ε=0.60 configuration exactly.
   */
  playoutTemp: number;
  /** Node/browser registry path for the v4.1 compiled rollout-policy student. */
  playoutTablePath?: string;
  /** Overrides the artifact's validation-selected blend when set; 0 is the exact v3 identity. */
  playoutTableBlend?: number;
  /** Weight on online piece-level Move-Average Sampling in terminal playouts. */
  playoutMastWeight: number;
  /** Whether MAST shares outcomes by piece identity or by exact board placement. */
  playoutMastGranularity: 'piece' | 'placement';
  /** Clear MAST at every root, or retain it until the self-play runner resets the game instance. */
  playoutMastLifetime: 'root' | 'game';
  /** Scale inside the sigmoid of the final score margin, in squares (Shibahara & Kotani). */
  sigmoidScale: number;
  /**
   * Scale for the same sigmoid applied to an E_i margin at a truncated leaf. E is not in squares,
   * so it needs its own denominator; sharing one would silently saturate every truncated value.
   */
  evalScale: number;
  /** 0 = pure sigmoid-margin backup, 1 = pure rank backup. §5's per-seat objective blend. */
  rankBlend: number;
  /**
   * How the three opponents are collapsed into one number before the margin is taken.
   *
   * The report never says, and `backup.ts` picked `max` — "beat the leader". The statistic the
   * engine is actually promoted on is `score − mean(other three)` (`scripts/lib/stats.ts`), and
   * v11's rollout value uses the mean. `max` reproduces the report as implemented; `mean` matches
   * the metric.
   */
  opponentAggregation: 'mean' | 'max';
  /**
   * Fraction of a truncated leaf's value taken from the *actual* score margin rather than from the
   * E_i margin, mirroring `materialBlend` in the legacy engine (`src/ai/mcts.ts:rolloutValue`,
   * which sits at 0.6). The report's §2.2 prescribes early termination with "a heuristic
   * evaluation" and never says the leaf must stay anchored to the score; 0 reproduces that.
   */
  leafMaterialBlend: number;
  /**
   * Whether §5's standing-based objective shift is applied on top of `rankBlend`. It has to be
   * switchable because it ignores its own base: `objectiveBlend(0, −20) = 1.0`, so setting
   * `rankBlend: 0` does *not* buy a pure-margin engine when it is behind.
   */
  objectiveShift: boolean;
  /** Progressive-history bias weight in selection (Nijssen & Winands). */
  historyWeight: number;
  /**
   * Opponent-node selection policy. `auto` follows §5: paranoid when leading (opponents really do
   * coalesce against the leader), max^n otherwise.
   */
  opponentPolicy: 'maxn' | 'paranoid' | 'brs' | 'auto';
  /** Score lead, in squares, at which `auto` switches to the paranoid model. */
  paranoidLead: number;
  /** Share node statistics across transposing parents (the DAG of §6). */
  transpositions: boolean;
  /** Preserve the searched descendant and promote it to the root on this seat's next turn. */
  treeReuse: boolean;
  /** Independent root searches whose visit counts are pooled; total iterations are divided evenly. */
  rootEnsembleTrees: number;
  /** Standard-deviation weight added to the root prior for remaining-piece playability. */
  rootPieceFeasibilityWeight: number;
  /** Open the best placement of each piece before widening to duplicate-piece alternatives. */
  rootPieceDiversity: boolean;
  /** Reserved for tree parallelism; a single-threaded search leaves it at 0. */
  virtualLoss: number;
  /**
   * Multiplier on the iteration budget this config receives. 1 is the harness budget unchanged.
   *
   * Exists so that two configs with different per-iteration costs can be compared at equal
   * *compute* rather than equal iterations. A config whose iterations cost 1.3x should run at
   * `iterationScale` 1/1.3 to meet a 1x config on even terms; comparing them at equal iteration
   * counts silently hands the expensive one a larger budget.
   */
  iterationScale: number;
  /**
   * Per-own-move multiplier on the iteration budget, indexed by how many of this seat's 21 pieces
   * are already down. Absent reproduces a flat budget exactly, which is what every measurement in
   * the record was taken with.
   *
   * `timeManager.ts` has carried a hand-authored curve of this shape since the report was first
   * implemented, but it only ever reached the *clock* path and every tournament here is
   * iteration-budgeted, so it has never affected a measured game. This is the iteration-path
   * twin, and it is meant to be fitted rather than guessed.
   *
   * Keep `sum(iterationShape) === 21` for a budget-neutral candidate: the total spent over a game
   * is then identical to a flat config's and the match statistic needs no compute discount. The
   * array is read with the last entry repeated, so a short array is legal.
   */
  iterationShape?: number[];
  /**
   * Path of the opening book this config plays, as registered by `registerBook`. Unset plays no
   * book, which is every config that predates one.
   *
   * Path-keyed for the same reason `netPath` is: a config that names a book it did not get should
   * play without one, never fall through to whichever book another config happened to load.
   */
  bookPath?: string;
  /**
   * Play the pooled policy net's top-ranked move directly on a seat's first `openingSelectMaxOwnMove`
   * moves, instead of searching.
   *
   * This is not the `netPrior` channel. E1 measured that channel's entire capacity at 0.12 points and
   * five v4 generations exhausted it. This is direct *selection*, and it is gated on own-move index
   * because that is where the two disagree: on 416 oracle-labelled positions the net picks a deep
   * oracle's move 45.1% of the time on own moves 1-3 against the search's 10.5%, and 30.7% against
   * 30.3% on moves 4-5. The search is bad early and good late; the net is the reverse.
   *
   * It also *removes* compute — those moves are answered without a search — so the candidate is
   * cheaper as well as, on the offline evidence, stronger.
   */
  openingSelectMaxOwnMove?: number;
  /** First one-based own move eligible for direct policy selection. Defaults to 1. */
  openingSelectMinOwnMove?: number;
  /**
   * Optional calibrated abstention head for direct policy selection.
   *
   * The feature contract lives in `openingSelect.ts`. A score below `threshold` returns no move and
   * the caller executes the unmodified search, making model failure a loss of efficiency rather than
   * an unconditional loss of playing strength.
   */
  openingSelectGate?: {
    mean: number[];
    scale: number[];
    weights: number[];
    intercept: number;
    threshold: number;
  };
  /**
   * Play the search's *k*-th ranked root move instead of its best, on a seat's first
   * `openingRankOffsetMaxOwnMove` moves. A diagnostic, never a candidate.
   *
   * It exists to test whether the opening has any headroom at all. Four separate results suggest it
   * may not: the exact book covered 9.4% and died past ply 2; the compute-doubling slope there is
   * 0.067 [−0.167, 0.274]; 48% of opening positions have no majority answer across three
   * 9,600-iteration searches; and a policy net 34.6 pp better at matching the oracle measured −0.76.
   *
   * If deliberately playing the second-best opening move costs nothing, then opening moves are
   * largely equivalent, the 0.62 squares of "opening regret" is an artifact of grading against a
   * referee picking arbitrarily among near-equals, and the whole channel is closed.
   */
  openingRankOffset?: number;
  openingRankOffsetMaxOwnMove?: number;
  /** Lower bound of the demotion window, so a single band can be isolated. */
  openingRankOffsetMinOwnMove?: number;
  /**
   * Play the tier-1 move ordering's top choice on a seat's first `openingHeuristicMaxOwnMove` moves
   * without running MCTS at all.
   *
   * `MEASURED` Demoting the search's own top choice to second on own moves 1-3 measured
   * **+0.68 [−0.13, 1.53]** — its top two are interchangeable there, so the tree is not buying a
   * decision. On own moves 4-5 the same demotion measured **−0.58 [−1.25, 0.10]**, so this must not
   * extend past move 3.
   *
   * Distinct from `openingSelectMaxOwnMove`, which used the policy net and measured −0.76: the net's
   * picks fall outside the search's top two often enough to hurt. This uses the ordering the search
   * itself starts from, so it keeps the candidate set and drops only the tree.
   */
  openingHeuristicMaxOwnMove?: number;
  /**
   * Carry unused fixed-budget iterations forward within a game, then release the pool in
   * proportion to how contested the next root is. Absent/false is byte-identical to the static
   * per-move budget.
   */
  iterationBanking?: boolean;
  /** Root children kept after deep (apply-and-evaluate) ordering. */
  rootShortlist: number;
  /** Candidate moves considered at interior nodes before widening. */
  nodeShortlist: number;
  /** Compute Δsplit at interior nodes too, not only at the root. */
  splitAtInterior: boolean;
  /** Δsplit relabellings allowed per interior node. */
  interiorSplitBudget: number;
  /**
   * Shortlist slots reserved for moves the cheap pre-filter would otherwise delete: those covering
   * an articulation point, and those covering an opponent's open corner.
   *
   * Without this the funnel's first stage is `piece size − centre distance`, which removes exactly
   * the small-piece cut moves §3.1 says Δsplit exists to surface — the heuristic is computed only
   * on candidates that never needed it. 0 reproduces the report as implemented.
   */
  funnelReserve: number;
}

export interface EndgameParams {
  /** Skip the exact packer above this many cells in the sealed region — DFS cost explodes. */
  maxRegionCells: number;
  /** Skip when the seat still has more legal moves than this. */
  maxOwnMoves: number;
  /** Search nodes before falling back to the packing bound. */
  nodeBudget: number;
  /** Entries kept in the (region, hand) memo before it is cleared. */
  memoLimit: number;
  /** Use the pessimistic/optimistic bracket on near-sealed regions (§4.3). */
  nearSealed: boolean;
  /**
   * Skip the sealed-region check at a leaf while more than this many squares are still in hand
   * across all four seats. The check costs a territory pass, and regions do not close while the
   * board is still one connected fight.
   */
  gateRemainingSquares: number;
}

export interface TimeParams {
  /** Fraction of the move budget spent probing before the budget is re-estimated. */
  probeFraction: number;
  /** Never stop below this many iterations. */
  minIterations: number;
  /** Multiplier on the root value spread when allocating the rest of the budget (§6.1). */
  spreadFactor: number;
  /** Stop early once the second-best root child cannot catch up on visits. */
  earlyExit: boolean;
}

export interface PhaseDetection {
  /** Own moves 1–5 are the opening (§4.1). */
  openingMoves: number;
  /** Own moves 6–15 are the mid-game (§4.2). */
  midgameMoves: number;
  /** Fall into the endgame early once the board is this fragmented. */
  contestedFloor: number;
}

export interface BitboardParams {
  /**
   * Split a cell that several seats reach in the same number of steps 1/k between them, instead of
   * awarding it whole to whoever moves soonest. Winner-take-all makes |T_i| jump by whole regions
   * between siblings that differ by one placement. `false` reproduces the report.
   */
  fractionalTerritoryTies: boolean;
  /**
   * Global multiplier on every seat's `aggression`, and so on every opponent-directed term the
   * engine has: `E_i`'s `oppTerritory` / `oppCorners` / `oppSquares` block, the move ordering's
   * `denyCorners`, the Δsplit harm term, and the greedy policy's ΔE. All four route through
   * `lambdaFor`, so this one scalar reaches all of them.
   *
   * `1` is the fitted behaviour and the default. `0` is a purely self-directed engine — the
   * EFFICIENT pole, and also the λ = 0 ablation the report flags as never run. Above 1 is the
   * GREEDY pole: spend more to cost opponents more.
   *
   * It is a *global* multiplier rather than a replacement so the fitted per-seat profile survives.
   *
   * **Scope note.** This scales the evaluation and the ordering, not the backup. With
   * `playoutCutoff: 84` almost every leaf is terminal and its value is σ(score margin), which is
   * margin-maximising whatever this is set to — so the dial is fully load-bearing at `greedy` and
   * at truncated tiers, and progressively attenuated as rollouts run to the end.
   */
  aggressionScale: number;
  phases: Record<PhaseId, PhaseWeights>;
  lambda: Record<PhaseId, LambdaProfile>;
  ordering: Record<PhaseId, MoveOrderWeights>;
  seats: SeatProfile[];
  search: SearchParams;
  endgame: EndgameParams;
  time: TimeParams;
  detection: PhaseDetection;
}

/**
 * §4.1: "The objective weights should be almost entirely on corner count and centre-reachability…
 * Blocking is rarely justified in this phase because opponents' territories are far away and a
 * block wastes tempo."
 */
const OPENING_WEIGHTS: PhaseWeights = {
  squares: 0.6,
  corners: 3.0,
  territory: 0.30,
  waste: 0,
  centre: 2.2,
  frontier: 0.15,
  oppTerritory: 0.10,
  oppCorners: 0.30,
  oppSquares: 0,
  mobility: 0,
  uniqueCorners: 0,
  cornerExponent: 0.5,
};

/**
 * §4.2: "Objectives shift toward territory delineation… Aggression coefficients λ_j should be
 * highest here."
 */
const MIDGAME_WEIGHTS: PhaseWeights = {
  squares: 1.4,
  corners: 2.0,
  territory: 0.55,
  waste: 0.35,
  centre: 0.5,
  frontier: 0.25,
  oppTerritory: 0.45,
  oppCorners: 0.90,
  oppSquares: 0,
  mobility: 0,
  uniqueCorners: 0,
  cornerExponent: 0.5,
};

/** §4.3: the position stops being a game and becomes a packing problem. */
const ENDGAME_WEIGHTS: PhaseWeights = {
  squares: 2.6,
  corners: 1.0,
  territory: 0.45,
  waste: 0.90,
  centre: 0,
  frontier: 0.05,
  oppTerritory: 0.15,
  oppCorners: 0.20,
  oppSquares: 0,
  mobility: 0,
  uniqueCorners: 0,
  cornerExponent: 0.5,
};

/**
 * §5: "the ordering heuristic discounts new corners near the *next* player's reach most heavily
 * (they act first), less for the player after that, and least for the previous player. Conversely,
 * blocking the *previous* player is slightly more efficient… blocking the *next* player is more
 * urgent."
 */
const OPENING_LAMBDA: LambdaProfile = { next: 0.30, prev: 0.20, diag: 0.10, leaderBoost: 0.10 };
const MIDGAME_LAMBDA: LambdaProfile = { next: 0.85, prev: 0.65, diag: 0.35, leaderBoost: 0.35 };
const ENDGAME_LAMBDA: LambdaProfile = { next: 0.40, prev: 0.30, diag: 0.15, leaderBoost: 0.20 };

const OPENING_ORDERING: MoveOrderWeights = {
  pieceSize: 1.6,
  split: 0.15,
  newCorners: 1.2,
  denyCorners: 0.4,
  centrePull: 0.55,
};
const MIDGAME_ORDERING: MoveOrderWeights = {
  pieceSize: 0.9,
  split: 0.65,
  newCorners: 0.9,
  denyCorners: 1.1,
  centrePull: 0.15,
};
const ENDGAME_ORDERING: MoveOrderWeights = {
  pieceSize: 1.3,
  split: 0.35,
  newCorners: 0.5,
  denyCorners: 0.5,
  centrePull: 0,
};

/**
 * §5: "Seat 1 should be maximally expansionist… Seat 4 has the least central access and the most
 * information; it should weight territory security and packing efficiency higher." Seats are in
 * turn order, so index 0 is the seat that moves first.
 */
const SEAT_PROFILES: SeatProfile[] = [
  { centre: 1.15, corners: 1.05, territory: 1.00, waste: 0.90, aggression: 0.80 },
  { centre: 1.05, corners: 1.00, territory: 1.02, waste: 0.97, aggression: 0.95 },
  { centre: 1.00, corners: 1.00, territory: 1.05, waste: 1.03, aggression: 1.10 },
  { centre: 0.90, corners: 0.98, territory: 1.10, waste: 1.15, aggression: 1.25 },
];

export const DEFAULT_BITBOARD_PARAMS: BitboardParams = {
  fractionalTerritoryTies: false,
  aggressionScale: 1,
  phases: {
    opening: OPENING_WEIGHTS,
    midgame: MIDGAME_WEIGHTS,
    endgame: ENDGAME_WEIGHTS,
  },
  lambda: {
    opening: OPENING_LAMBDA,
    midgame: MIDGAME_LAMBDA,
    endgame: ENDGAME_LAMBDA,
  },
  ordering: {
    opening: OPENING_ORDERING,
    midgame: MIDGAME_ORDERING,
    endgame: ENDGAME_ORDERING,
  },
  seats: SEAT_PROFILES,
  search: {
    rootPolicy: 'puct',
    implicitMaxnWeight: 0,
    raveEquivalence: 0,
    varianceTuned: false,
    varianceTunedRootOnly: false,
    rootAudit: 'none',
    rootAuditTopK: 4,
    rootAuditRollouts: 0,
    rootAuditBlend: 0.35,
    rootGrouping: 'none',
    cPuct: 1.6,
    fpuReduction: 0,
    priorTemp: 6,
    wideningInit: 8,
    wideningGrowth: 0.8,
    wideningAllNodes: true,
    playoutEps: 0.15,
    playoutEpsByPhase: null,
    playoutCutoff: 12,
    playoutMoveCap: 12,
    playoutCorners: 1,
    playoutPolicy: 'legacy',
    playoutCornerWeight: 0,
    playoutEdgeWeight: 0,
    playoutTemp: 0,
    playoutTablePath: undefined,
    playoutTableBlend: undefined,
    playoutMastWeight: 0,
    playoutMastGranularity: 'piece',
    playoutMastLifetime: 'root',
    sigmoidScale: 12,
    evalScale: 28,
    rankBlend: 0.35,
    netScale: 12,
    netBlend: 0,
    netOutputKind: 'scores',
    netValueSampling: 'mean',
    netSampleScale: 1,
    netTailPrefix: 0,
    netTailMaxStd: 0,
    netRolloutProbability: 0,
    netPrior: false,
    netPriorPhase: 'all',
    netPriorBlend: 1,
    netPriorTemp: 4,
    rootPriorPseudoVisits: 0,
    opponentAggregation: 'max',
    leafMaterialBlend: 0,
    objectiveShift: true,
    historyWeight: 0.6,
    opponentPolicy: 'auto',
    paranoidLead: 8,
    transpositions: true,
    treeReuse: false,
    rootEnsembleTrees: 1,
    rootPieceFeasibilityWeight: 0,
    rootPieceDiversity: false,
    virtualLoss: 0,
    iterationScale: 1,
    rootShortlist: 40,
    nodeShortlist: 24,
    splitAtInterior: false,
    interiorSplitBudget: 0,
    funnelReserve: 0,
  },
  endgame: {
    maxRegionCells: 44,
    maxOwnMoves: 80,
    nodeBudget: 30000,
    memoLimit: 40000,
    nearSealed: true,
    gateRemainingSquares: 160,
  },
  time: {
    probeFraction: 0.2,
    minIterations: 64,
    spreadFactor: 1.5,
    earlyExit: true,
  },
  detection: {
    openingMoves: 5,
    midgameMoves: 15,
    contestedFloor: 0.08,
  },
};

export function cloneParams(params: BitboardParams): BitboardParams {
  return structuredClone(params);
}

/** Deep-merges a partial override onto the defaults; used by `algoVersions` to declare variants. */
export function withOverrides(base: BitboardParams, overrides: DeepPartial<BitboardParams>): BitboardParams {
  const merged = cloneParams(base) as unknown as Record<string, unknown>;
  mergeInto(merged, overrides as Record<string, unknown>);
  return merged as unknown as BitboardParams;
}

/** Arrays are replaced wholesale rather than merged element-wise, which is what `mergeInto` does. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const existing = target[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      mergeInto(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}
