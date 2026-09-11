import { PLAYER_COLORS } from '../../src/engine/types.ts';
import type { AlgoConfig } from '../../src/ai/algoVersions.ts';

/**
 * The tunable surface of a config, as a flat numeric vector.
 *
 * Everything is addressed by a dotted path into the config object so adding a knob is a one-line
 * change here rather than new plumbing in the optimiser.
 */
export interface ParamSpec {
  path: string;
  min: number;
  max: number;
  /** Initial standard deviation for the sampling distribution. */
  sigma: number;
  /**
   * Round to a whole number before writing.
   *
   * Required for anything the engine uses as an array length or a loop bound. CEM samples
   * continuously, so a shortlist of 37.4 reaches `new Float64Array(37.4)` and throws
   * "Invalid array length" — which the pool reports as a failed game, the tuner used to skip in
   * silence, and `rotationAdvantage([])` then scored as a tidy 0.00. That combination is almost
   * certainly why the search space was never successfully tuned.
   */
  int?: boolean;
}

/**
 * `territory` is deliberately absent: it is only computed on the explanation path, so its weight
 * has no effect on play and tuning it would burn samples on a no-op.
 */
const EVAL_WEIGHT_RANGES: Array<[string, number, number, number]> = [
  ['placedSquares', 0, 6, 0.5],
  ['remainingPenalty', -5, 0, 0.4],
  ['cornerAccess', 0, 6, 0.5],
  ['mobility', -2, 4, 0.4],
  ['opponentMobility', -4, 1, 0.4],
  ['centerControl', 0, 2, 0.15],
  ['blocking', -1, 3, 0.3],
  ['uniqueLiberties', 0, 3, 0.3],
  ['voronoiTerritory', 0, 1.5, 0.15],
  ['reachableArea', 0, 1, 0.1],
];

export const WEIGHT_SPACE: ParamSpec[] = [
  ...EVAL_WEIGHT_RANGES.map(([key, min, max, sigma]) => ({
    path: `weights.${key}`,
    min,
    max,
    sigma,
  })),
  ...EVAL_WEIGHT_RANGES.map(([key, min, max, sigma]) => ({
    path: `weightsLate.${key}`,
    min,
    max,
    sigma,
  })),
];

export const SEARCH_SPACE: ParamSpec[] = [
  { path: 'exploration', min: 0.6, max: 2.5, sigma: 0.3 },
  { path: 'puctC', min: 0.4, max: 4, sigma: 0.5 },
  { path: 'priorTemp', min: 1, max: 20, sigma: 3 },
  { path: 'rootWidening.initial', min: 3, max: 24, sigma: 3 },
  { path: 'rootWidening.growth', min: 0.3, max: 4, sigma: 0.5 },
  { path: 'materialBlend', min: 0, max: 1, sigma: 0.15 },
  { path: 'materialScale', min: 8, max: 40, sigma: 5 },
  { path: 'positionalScale', min: 25, max: 120, sigma: 12 },
];

export const PHASE_SPACE: ParamSpec[] = [
  { path: 'phaseSplit.earlyEnd', min: 0.05, max: 0.5, sigma: 0.06 },
  { path: 'phaseSplit.lateStart', min: 0.35, max: 0.95, sigma: 0.08 },
  { path: 'phaseBonusEarly', min: 0, max: 0.8, sigma: 0.08 },
  { path: 'phaseBonusLate', min: 0, max: 0.5, sigma: 0.05 },
  { path: 'adjacentOpponentWeight', min: 1 / 3, max: 1, sigma: 0.08 },
];

export const SEAT_SPACE: ParamSpec[] = PLAYER_COLORS.flatMap((color) => [
  { path: `seatProfile.${color}.aggression`, min: 0.6, max: 1.6, sigma: 0.12 },
  { path: `seatProfile.${color}.expansion`, min: 0.6, max: 1.6, sigma: 0.12 },
]);

/* --- v12 -------------------------------------------------------------------------------------
 * The research-report engine keeps its parameters under `v12`, split by phase and by seat exactly
 * as §4 and §5 ask. Tune against a base config that carries a materialised `v12` block (the `v12`
 * version does) — a partial one reads as zeros. */

const V12_PHASES = ['opening', 'midgame', 'endgame'] as const;

const V12_WEIGHT_RANGES: Array<[string, number, number, number]> = [
  ['squares', 0, 4, 0.3],
  ['corners', 0, 6, 0.4],
  ['territory', 0, 2, 0.15],
  ['waste', 0, 2, 0.15],
  ['centre', 0, 4, 0.3],
  ['frontier', 0, 1, 0.1],
  ['oppTerritory', 0, 1.5, 0.12],
  ['oppCorners', 0, 3, 0.2],
  // Added by the postmortem: the report's E_i has no opponent-material term, and fixes the corner
  // transform at 0.5. Both were hard-coded, so no earlier tune could have searched them.
  ['oppSquares', 0, 3, 0.2],
  ['cornerExponent', 0.3, 1, 0.08],
  // §3.1 names these two and §3.2's E_i omits them. v11 fits mobility to 1.01 early and −0.87 late,
  // so the range has to admit negatives: spare capacity at the end is unspent squares.
  ['mobility', -2, 3, 0.25],
  ['uniqueCorners', 0, 3, 0.2],
];

const V12_LAMBDA_RANGES: Array<[string, number, number, number]> = [
  ['next', 0, 2, 0.15],
  ['prev', 0, 2, 0.15],
  ['diag', 0, 2, 0.15],
  ['leaderBoost', 0, 1, 0.1],
];

const V12_ORDER_RANGES: Array<[string, number, number, number]> = [
  ['pieceSize', 0, 4, 0.25],
  ['split', 0, 3, 0.2],
  ['newCorners', 0, 3, 0.2],
  ['denyCorners', 0, 3, 0.2],
  ['centrePull', 0, 2, 0.12],
];

export const V12_WEIGHT_SPACE: ParamSpec[] = V12_PHASES.flatMap((phase) =>
  V12_WEIGHT_RANGES.map(([key, min, max, sigma]) => ({
    path: `bitboard.phases.${phase}.${key}`,
    min,
    max,
    sigma,
  })),
);

export const V12_LAMBDA_SPACE: ParamSpec[] = V12_PHASES.flatMap((phase) =>
  V12_LAMBDA_RANGES.map(([key, min, max, sigma]) => ({
    path: `bitboard.lambda.${phase}.${key}`,
    min,
    max,
    sigma,
  })),
);

export const V12_ORDER_SPACE: ParamSpec[] = V12_PHASES.flatMap((phase) =>
  V12_ORDER_RANGES.map(([key, min, max, sigma]) => ({
    path: `bitboard.ordering.${phase}.${key}`,
    min,
    max,
    sigma,
  })),
);

/** Seats are indexed in turn order, so 0 is the seat that moves first (§5). */
export const V12_SEAT_SPACE: ParamSpec[] = [0, 1, 2, 3].flatMap((seat) => [
  { path: `bitboard.seats.${seat}.centre`, min: 0.6, max: 1.6, sigma: 0.1 },
  { path: `bitboard.seats.${seat}.corners`, min: 0.6, max: 1.6, sigma: 0.1 },
  { path: `bitboard.seats.${seat}.territory`, min: 0.6, max: 1.6, sigma: 0.1 },
  { path: `bitboard.seats.${seat}.waste`, min: 0.6, max: 1.6, sigma: 0.1 },
  { path: `bitboard.seats.${seat}.aggression`, min: 0.5, max: 1.8, sigma: 0.12 },
]);

/**
 * What shapes a leaf's value inside the tree. **Only fit this at a policy that has a tree.** At
 * `greedy` these four are inert — `rankMovesGreedyV12` ranks by ΔE and never calls the backup — so
 * including them in a greedy fit applies no fitness pressure and lets them drift under selection
 * noise, which is exactly what happened and cost ~1 point at search level.
 *
 * `opponentAggregation` is deliberately absent: it is categorical, and CEM searches a continuous
 * vector. It has to be settled by the `v12-mean` ablation instead.
 */
export const V12_VALUE_SPACE: ParamSpec[] = [
  { path: 'bitboard.search.sigmoidScale', min: 4, max: 40, sigma: 4 },
  { path: 'bitboard.search.evalScale', min: 8, max: 80, sigma: 8 },
  { path: 'bitboard.search.rankBlend', min: 0, max: 1, sigma: 0.1 },
  { path: 'bitboard.search.leafMaterialBlend', min: 0, max: 1, sigma: 0.1 },
];

export const V12_SEARCH_SPACE: ParamSpec[] = [
  { path: 'bitboard.search.cPuct', min: 0.4, max: 4, sigma: 0.4 },
  { path: 'bitboard.search.priorTemp', min: 1, max: 20, sigma: 2.5 },
  { path: 'bitboard.search.wideningInit', min: 3, max: 24, sigma: 3, int: true },
  { path: 'bitboard.search.wideningGrowth', min: 0.2, max: 4, sigma: 0.4 },
  { path: 'bitboard.search.playoutEps', min: 0, max: 0.6, sigma: 0.06 },
  { path: 'bitboard.search.playoutCutoff', min: 4, max: 30, sigma: 3, int: true },
  { path: 'bitboard.search.playoutMoveCap', min: 4, max: 32, sigma: 3, int: true },
  { path: 'bitboard.search.playoutCorners', min: 1, max: 8, sigma: 1, int: true },
  { path: 'bitboard.search.historyWeight', min: 0, max: 3, sigma: 0.2 },
  { path: 'bitboard.search.paranoidLead', min: 0, max: 30, sigma: 3, int: true },
  { path: 'bitboard.search.rootShortlist', min: 12, max: 96, sigma: 8, int: true },
  { path: 'bitboard.search.nodeShortlist', min: 6, max: 48, sigma: 5, int: true },
  { path: 'bitboard.search.funnelReserve', min: 0, max: 48, sigma: 5, int: true },
  ...V12_VALUE_SPACE,
];

/**
 * The space for the `v3.1` / `v3.1-pro` time-budget tiers.
 *
 * Two deliberate differences from `V12_SEARCH_SPACE`.
 *
 * `playoutCutoff` is **absent**. It is the property that defines these tiers — rollouts played to
 * the end are worth +5.71 [5.05, 6.35] — and the generic search space caps it at 30, so including
 * it would let the tuner quietly undo the tier while reporting an improvement.
 *
 * `playoutMoveCap` and `playoutCorners` get wider ranges than the generic space allows, because at
 * 200-400 ms/move rollout *width* is the lever with headroom: the 200 ms bake-off put a 24x2 mix
 * ahead of both depth-only and width-only.
 *
 * The evaluation weights are deliberately not here. With rollouts reaching the end of the game the
 * leaf evaluation is rarely read as a value at all — it survives mainly through move ordering — so
 * fitting phase weights in this regime would repeat the mistake of tuning parameters the policy
 * being measured cannot see.
 */
export const V31_TIER_SPACE: ParamSpec[] = [
  { path: 'bitboard.search.cPuct', min: 0.4, max: 4, sigma: 0.4 },
  { path: 'bitboard.search.priorTemp', min: 1, max: 20, sigma: 2.5 },
  { path: 'bitboard.search.wideningInit', min: 3, max: 24, sigma: 3, int: true },
  { path: 'bitboard.search.wideningGrowth', min: 0.2, max: 4, sigma: 0.4 },
  { path: 'bitboard.search.playoutEps', min: 0, max: 0.6, sigma: 0.06 },
  { path: 'bitboard.search.playoutMoveCap', min: 6, max: 64, sigma: 6, int: true },
  { path: 'bitboard.search.playoutCorners', min: 1, max: 8, sigma: 1, int: true },
  { path: 'bitboard.search.historyWeight', min: 0, max: 3, sigma: 0.2 },
  { path: 'bitboard.search.paranoidLead', min: 0, max: 30, sigma: 3, int: true },
  { path: 'bitboard.search.rootShortlist', min: 12, max: 96, sigma: 8, int: true },
  { path: 'bitboard.search.nodeShortlist', min: 6, max: 48, sigma: 5, int: true },
  { path: 'bitboard.search.funnelReserve', min: 0, max: 48, sigma: 5, int: true },
  ...V12_VALUE_SPACE,
];

export const SPACES: Record<string, ParamSpec[]> = {
  'v48-rollout': [
    { path: 'bitboard.search.playoutEpsByPhase.opening', min: 0, max: 1, sigma: 0.15 },
    { path: 'bitboard.search.playoutEpsByPhase.midgame', min: 0, max: 1, sigma: 0.15 },
    { path: 'bitboard.search.playoutEpsByPhase.endgame', min: 0, max: 1, sigma: 0.15 },
    { path: 'bitboard.search.playoutCornerWeight', min: -1, max: 1, sigma: 0.25 },
    { path: 'bitboard.search.playoutEdgeWeight', min: -1, max: 1, sigma: 0.25 },
    { path: 'bitboard.search.playoutTemp', min: 0, max: 4, sigma: 0.6 },
  ],
  'v31-tier': V31_TIER_SPACE,
  weights: WEIGHT_SPACE,
  search: SEARCH_SPACE,
  phase: PHASE_SPACE,
  seat: SEAT_SPACE,
  eval: [...WEIGHT_SPACE, ...PHASE_SPACE, ...SEAT_SPACE],
  all: [...WEIGHT_SPACE, ...SEARCH_SPACE, ...PHASE_SPACE, ...SEAT_SPACE],

  'v12-weights': V12_WEIGHT_SPACE,
  'v12-lambda': V12_LAMBDA_SPACE,
  'v12-order': V12_ORDER_SPACE,
  'v12-seat': V12_SEAT_SPACE,
  'v12-value': V12_VALUE_SPACE,
  /**
   * The two parameters that full-length playouts made load-bearing. With `playoutCutoff` high,
   * almost every playout reaches a terminal position, so leaf values come from real final scores:
   * `evalScale` and `leafMaterialBlend` go nearly inert and these two shape every leaf. Two
   * dimensions is small enough to fit at `mcts-bench`, which the four-parameter space was not.
   */
  'v12-leafvalue': [
    { path: 'bitboard.search.sigmoidScale', min: 4, max: 40, sigma: 4 },
    { path: 'bitboard.search.rankBlend', min: 0, max: 1, sigma: 0.1 },
  ],
  /**
   * The global aggression dial (`v3.5`), on its own axis.
   *
   * One dimension, so it is affordable at `mcts-bench` — and it has to be fitted there if the
   * intent is a search-level value. At `greedy` the dial is fully load-bearing (`rankMovesGreedyV12`
   * ranks by ΔE, which carries the whole λ block), but a value fitted there describes the one-ply
   * policy, not the tree: with full-length rollouts λ only shapes the prior and the ordering, while
   * the leaf value stays σ(score margin) regardless.
   *
   * The upper bound is 2.5 rather than the seat profiles' 1.8 because this multiplies them: the
   * fitted seats already reach 1.25, so 2.5 admits an effective λ of ~3x the fitted one.
   */
  'v35-aggr': [{ path: 'bitboard.aggressionScale', min: 0, max: 2.5, sigma: 0.2 }],
  'v12-search': V12_SEARCH_SPACE,
  // `v12-value` is deliberately NOT folded in. Those four parameters only affect leaf values inside
  // the tree, and the eval-level policy (`greedy`) has no tree — `rankMovesGreedyV12` ranks by ΔE
  // and never calls the backup. Tuning them at greedy applies no fitness pressure at all, so they
  // drift under selection noise and the resulting config carries randomly-walked tree parameters.
  // Fit them with `--space v12-value --policy mcts-bench`, where they are actually read.
  'v12-eval': [
    ...V12_WEIGHT_SPACE,
    ...V12_LAMBDA_SPACE,
    ...V12_SEAT_SPACE,
  ],
  /**
   * `v12-eval` without the 20 seat parameters. Seat conditioning as *guessed* constants measured
   * −0.10 [−0.36, 0.16] (`v10e-seat`) and the seat dimension is a third of `v12-eval`, so spending
   * a quarter of the search budget on it costs more in samples-per-dimension than it can return.
   * Fit this first; add seats back only if they earn their way in.
   */
  'v12-eval-noseat': [...V12_WEIGHT_SPACE, ...V12_LAMBDA_SPACE],
  'v12-all': [
    ...V12_WEIGHT_SPACE,
    ...V12_LAMBDA_SPACE,
    ...V12_ORDER_SPACE,
    ...V12_SEAT_SPACE,
    ...V12_SEARCH_SPACE,
  ],
};

type Mutable = Record<string, unknown>;

export function getPath(config: AlgoConfig, path: string): number {
  let node: unknown = config;
  for (const part of path.split('.')) {
    node = (node as Mutable)?.[part];
  }
  return typeof node === 'number' ? node : 0;
}

function setPath(config: AlgoConfig, path: string, value: number): void {
  const parts = path.split('.');
  let node = config as unknown as Mutable;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) {
      node[part] = {};
    }
    node = node[part] as Mutable;
  }
  node[parts[parts.length - 1]] = value;
}

export function clampToSpace(specs: ParamSpec[], values: number[]): number[] {
  return values.map((value, i) => {
    const clamped = Math.min(specs[i].max, Math.max(specs[i].min, value));
    return specs[i].int ? Math.round(clamped) : clamped;
  });
}

export function readParams(config: AlgoConfig, specs: ParamSpec[]): number[] {
  return specs.map((spec) => getPath(config, spec.path));
}

/**
 * Builds a playable config from a parameter vector. The base supplies everything untuned, so a
 * candidate always differs from its parent only on the axes being searched.
 */
export function buildCandidate(
  base: AlgoConfig,
  specs: ParamSpec[],
  values: number[],
  id: string,
): AlgoConfig {
  const config = structuredClone(base) as AlgoConfig;
  config.id = id;
  config.summary = `tuned candidate from ${base.id}`;
  specs.forEach((spec, i) => {
    const clamped = Math.min(spec.max, Math.max(spec.min, values[i]));
    setPath(config, spec.path, spec.int ? Math.round(clamped) : clamped);
  });

  // The schedule only makes sense if the early phase ends before the late phase begins.
  if (config.phaseSplit && config.phaseSplit.lateStart <= config.phaseSplit.earlyEnd) {
    config.phaseSplit.lateStart = Math.min(0.98, config.phaseSplit.earlyEnd + 0.05);
  }
  return config;
}
