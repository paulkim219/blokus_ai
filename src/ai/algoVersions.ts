import { PLAYER_COLORS } from '../engine/types';
import type { PlayerColor } from '../engine/types';
import { V1_VERSIONS } from './versions/v1';
import { V2_VERSIONS } from './versions/v2';
import { V3_VERSIONS } from './versions/v3';
import { V4_VERSIONS } from './versions/v4';
import { V5_VERSIONS } from './versions/v5';
import {
  DEFAULT_BITBOARD_PARAMS,
  withOverrides,
  type DeepPartial,
  type BitboardParams,
} from './bitboard/config';
import type { CommitteeParams } from './committee';
import type { OracleProfileMode } from './oracle/types';

/**
 * Version ids are plain strings so the tuner can register generated candidates at runtime
 * (`registerAlgoConfig`) without editing this file. `ALGO_VERSIONS` stays the source of truth for
 * what exists; `isAlgoVersionId` checks membership.
 */
export type AlgoVersionId = string;

export interface HeuristicWeights {
  placedSquares: number;
  remainingPenalty: number;
  cornerAccess: number;
  mobility: number;
  opponentMobility: number;
  centerControl: number;
  /** Legacy O(cells²) Voronoi. Only reaches explanations — the search always runs in fast mode. */
  territory: number;
  blocking: number;
  uniqueLiberties: number;
  /** Empty cells strictly closer to this colour's frontier than to any rival's (BFS, fast-mode safe). */
  voronoiTerritory: number;
  /** Empty cells this colour's frontier can reach at all — room left to spend pieces in. */
  reachableArea: number;
}

export const WEIGHT_KEYS: Array<keyof HeuristicWeights> = [
  'placedSquares',
  'remainingPenalty',
  'cornerAccess',
  'mobility',
  'opponentMobility',
  'centerControl',
  'territory',
  'blocking',
  'uniqueLiberties',
  'voronoiTerritory',
  'reachableArea',
];

/** Per-seat strategy dial. Multipliers on groups of weights, not new features. */
export interface SeatModifiers {
  /** Scales the restrict-the-opponent weights (`blocking`, `opponentMobility`). */
  aggression: number;
  /** Scales the grow-my-own-position weights (corners, mobility, territory, centre). */
  expansion: number;
}

export interface PhaseSplit {
  /** Progress (share of all placeable squares played) where the early weights stop applying. */
  earlyEnd: number;
  /** Progress where the late weights fully apply. Between the two, weights interpolate. */
  lateStart: number;
}

export interface RootWidening {
  /** Children considered at the root before any widening. */
  initial: number;
  /** Extra children allowed per √visits. */
  growth: number;
}

export interface EndgameConfig {
  /** Only attempt the exact packer at or below this many own legal moves. */
  maxOwnMoves: number;
  /** Search nodes before giving up and handing the position back to MCTS. */
  nodeBudget: number;
}

/** Bounded opponent-aware re-ranking layered over an existing search version. */
export interface OracleSearchConfig {
  baseVersion: AlgoVersionId;
  profileMode: OracleProfileMode;
  temperature: number;
  minimumObservations: number;
  rootCandidates: number;
  replyWidth: number;
  beamWidth: number;
  baseSearchFraction: number;
  responseBlend: number;
  riskWeight: number;
  responseEvaluator: 'static' | 'terminal';
  terminalRollouts: number;
  responseMode: 'absoluteBeam' | 'counterfactualSample';
  scenarioCount: number;
  responseVisitScale: number;
}

/** Authored config: the optional fields default to v4 behaviour. */
export interface AlgoConfig {
  id: AlgoVersionId;
  /** Human-readable summary stored in ALGORITHMS.md as well. */
  summary: string;
  weights: HeuristicWeights;
  exploration: number;
  materialScale: number;
  positionalScale: number;
  /** Fraction of truncated-rollout value that comes from material (rest is positional). */
  materialBlend: number;
  /**
   * If true, the move actually played is the most-visited child (tie-break by value).
   * If false, highest mean value wins — noisier with truncated rollouts.
   */
  selectByVisits: boolean;
  /**
   * How much of the opponent term comes from the two adjacent seats (the rest is the
   * opposite seat). 1/3-equal mean is `adjacentOpponentWeight = 2/3`.
   */
  adjacentOpponentWeight: number;
  phaseBonusEarly: number;
  phaseBonusLate: number;

  /** Weights at full game progress. Absent means one weight set for the whole game. */
  weightsLate?: HeuristicWeights | null;
  phaseSplit?: PhaseSplit;
  seatProfile?: Partial<Record<PlayerColor, SeatModifiers>> | null;
  /** Tree policy. `ucb1` ignores priors; `puct` weights exploration by the heuristic prior. */
  selection?: 'ucb1' | 'puct';
  puctC?: number;
  /** Softmax temperature turning prior scores into a distribution. Higher = flatter. */
  priorTemp?: number;
  rootWidening?: RootWidening | null;
  /** `rollout` = truncated playout, `eval` = static eval at the leaf, `mixed` = mean of both. */
  leafValue?: 'rollout' | 'eval' | 'mixed';
  endgame?: EndgameConfig | null;

  /**
   * Plies a truncated rollout runs before its value is read. The legacy engine hard-coded these at
   * 24 / 14 (light), which is the same early-termination choice the v12 engine made at 12 — and
   * which measured as the largest single error in that design. Exposed so the incumbent can be
   * tested with the same fix rather than only its challenger.
   */
  rolloutSteps?: number;
  rolloutStepsLight?: number;
  /**
   * Multiplier on this config's iteration budget, so two configs with different per-iteration costs
   * can meet at equal *compute* rather than equal iterations. Lengthening the legacy engine's
   * rollouts costs 2.23x per iteration (measured), which an equal-iteration comparison silently
   * hands it as extra budget.
   */
  iterationScale?: number;

  /**
   * Which engine plays this config. `legacy` is everything from v4 to v11: the object-board search
   * in `src/ai/mcts.ts`. `v12` is the bitboard engine of `src/ai/bitboard`, which implements the
   * research report and ignores every field above — its parameters live in `bitboard` below.
   *
   * `committee` is not a fourth engine but a layer over one: it delegates the whole search to
   * `committee.primary` and only re-ranks the root children that search left tied.
   */
  engine?: 'legacy' | 'bitboard' | 'committee' | 'oracle';
  /** Overrides on `DEFAULT_BITBOARD_PARAMS`; only read when `engine === 'bitboard'`. */
  bitboard?: DeepPartial<BitboardParams> | null;
  /** Committee membership and arbitration band; only read when `engine === 'committee'`. */
  committee?: CommitteeParams | null;
  /** Opponent-response layer; only read when `engine === 'oracle'`. */
  oracle?: OracleSearchConfig | null;
}

/** Same shape with every optional field filled in. What the search actually reads. */
export type ResolvedAlgoConfig = Required<AlgoConfig>;

/** Blue/Yellow and Blue/Green share an edge of the board; Purple sits opposite Blue. */
export const ADJACENT_COLORS: Record<PlayerColor, [PlayerColor, PlayerColor]> = {
  blue: ['yellow', 'green'],
  yellow: ['blue', 'purple'],
  purple: ['yellow', 'green'],
  green: ['blue', 'purple'],
};


type OptionalAlgoFields = Required<
  Pick<
    AlgoConfig,
    | 'weightsLate'
    | 'phaseSplit'
    | 'seatProfile'
    | 'selection'
    | 'puctC'
    | 'priorTemp'
    | 'rootWidening'
    | 'leafValue'
    | 'endgame'
    | 'engine'
    | 'bitboard'
    | 'committee'
    | 'oracle'
    | 'rolloutSteps'
    | 'rolloutStepsLight'
    | 'iterationScale'
  >
>;

/** Every default here reproduces v4 behaviour, so an authored config only states its deltas. */
const DEFAULT_OPTIONALS: OptionalAlgoFields = {
  weightsLate: null,
  phaseSplit: { earlyEnd: 1, lateStart: 1 },
  seatProfile: null,
  selection: 'ucb1',
  puctC: 1.6,
  priorTemp: 6,
  rootWidening: null,
  leafValue: 'rollout',
  endgame: null,
  engine: 'legacy',
  bitboard: null,
  committee: null,
  oracle: null,
  rolloutSteps: 24,
  rolloutStepsLight: 14,
  iterationScale: 1,
};





/**
 * Every registered version, assembled from the three generations. The definitions live in
 * `src/ai/versions/`; this module keeps the types, resolution and alias machinery.
 */
export const ALGO_VERSIONS: Record<AlgoVersionId, AlgoConfig> = {
  ...V1_VERSIONS,
  ...V2_VERSIONS,
  ...V3_VERSIONS,
  ...V4_VERSIONS,
  ...V5_VERSIONS,
};

export const DEFAULT_ALGO_VERSION: AlgoVersionId = 'v1';

/**
 * Versions offered in the live-game dropdown. `v3.1` is the default next-move engine; the others
 * are the same family at less/more compute, generation 2's full-rollout player, the promoted
 * v3.7 Pro Max effort tier, and the v4.1 lite and Pro Max tiers.
 *
 * The UI search uses a shared base iteration count so each config's `iterationScale` (and rollout
 * length) is what actually distinguishes lite from pro — a wall-clock budget would collapse the
 * v3.1 tiers into the same search. Width-sweep ids (`v3.1-pro-w*`) stay off this list: they are
 * attribution probes, not effort levels.
 */
export const UI_ALGO_VERSIONS = [
  'v2-pro',
  'v3.1-lite',
  'v3.1',
  'v3.1-pro-mid',
  'v3.1-pro',
  'v3.1-pro-max',
  'v3.7-pro-max',
  'v4.1-lite',
  'v4.1-pro-max',
] as const;
export type UiAlgoVersion = (typeof UI_ALGO_VERSIONS)[number];
export const DEFAULT_UI_ALGO_VERSION: UiAlgoVersion = 'v3.1';
/** Tournament/measurement base; lite/default/pro multiply this by their authored `iterationScale`. */
export const UI_SEARCH_ITERATIONS = 300;

export function isUiAlgoVersion(value: string | undefined): value is UiAlgoVersion {
  return !!value && (UI_ALGO_VERSIONS as readonly string[]).includes(value);
}

/**
 * Historical ids kept resolvable. Every measurement in `docs/ALGORITHMS.md` and the research-paper
 * postmortem is recorded against the left-hand names, so breaking them would sever the record from
 * the configs it describes.
 */
/**
 * Pre-rename ids, kept so stored tuner output and old scripts still resolve.
 *
 * `v4` is deliberately **not** here. It was the old name for `v1`, and it now names the learned
 * evaluation — a live version, not an alias. Anything still saying `v4` and meaning generation 1
 * must say `v1`. This is exactly the failure mode that cost a day when 23 configs kept declaring
 * `engine: "v12"` after that rename and silently ran on the legacy engine, so it is worth being
 * blunt about: the collision is resolved in favour of the new version, and the old meaning is gone.
 */
const ALIASES: Record<string, AlgoVersionId> = {
  v11: 'v2-lite',
  'v11-deep': 'v2-pro',
  v12: 'v3',
};

function canonical(version: AlgoVersionId): AlgoVersionId {
  return ALIASES[version] ?? version;
}

const resolvedCache = new Map<AlgoVersionId, ResolvedAlgoConfig>();

function resolve(config: AlgoConfig): ResolvedAlgoConfig {
  return {
    ...config,
    weightsLate: config.weightsLate ?? DEFAULT_OPTIONALS.weightsLate,
    phaseSplit: config.phaseSplit ?? DEFAULT_OPTIONALS.phaseSplit,
    seatProfile: config.seatProfile ?? DEFAULT_OPTIONALS.seatProfile,
    selection: config.selection ?? DEFAULT_OPTIONALS.selection,
    puctC: config.puctC ?? DEFAULT_OPTIONALS.puctC,
    priorTemp: config.priorTemp ?? DEFAULT_OPTIONALS.priorTemp,
    rootWidening: config.rootWidening ?? DEFAULT_OPTIONALS.rootWidening,
    leafValue: config.leafValue ?? DEFAULT_OPTIONALS.leafValue,
    endgame: config.endgame ?? DEFAULT_OPTIONALS.endgame,
    iterationScale: config.iterationScale ?? DEFAULT_OPTIONALS.iterationScale,
    rolloutSteps: config.rolloutSteps ?? DEFAULT_OPTIONALS.rolloutSteps,
    rolloutStepsLight: config.rolloutStepsLight ?? DEFAULT_OPTIONALS.rolloutStepsLight,
    engine: config.engine ?? DEFAULT_OPTIONALS.engine,
    bitboard: config.bitboard ?? DEFAULT_OPTIONALS.bitboard,
    committee: config.committee ?? DEFAULT_OPTIONALS.committee,
    oracle: config.oracle ?? DEFAULT_OPTIONALS.oracle,
  };
}

const v12ParamCache = new Map<AlgoVersionId, BitboardParams>();

/** Resolved v12 parameters for a config, memoised per version id. */
export function bitboardParamsFor(config: ResolvedAlgoConfig): BitboardParams {
  const cached = v12ParamCache.get(config.id);
  if (cached) {
    return cached;
  }
  const params = config.bitboard
    ? withOverrides(DEFAULT_BITBOARD_PARAMS, config.bitboard)
    : structuredClone(DEFAULT_BITBOARD_PARAMS);
  v12ParamCache.set(config.id, params);
  return params;
}

export function isAlgoVersionId(value: string | undefined): value is AlgoVersionId {
  return !!value && (value in ALGO_VERSIONS || value in ALIASES);
}

export function getAlgo(version: AlgoVersionId = DEFAULT_ALGO_VERSION): ResolvedAlgoConfig {
  const id = canonical(version);
  const cached = resolvedCache.get(id);
  if (cached) {
    return cached;
  }
  const authored = ALGO_VERSIONS[id] ?? ALGO_VERSIONS.v1;
  const config = resolve(authored);
  resolvedCache.set(id, config);
  return config;
}

/** Register a generated candidate (tuner, JSON file) so it can be played like any other version. */
/**
 * The bitboard parameter block was called `v12` before the versions were renamed. A stored config
 * still using that key would otherwise be dropped silently and resolve to defaults — a config that
 * looks registered but plays as something else. Migrate it and say so.
 */
function migrateLegacyKeys(input: AlgoConfig): AlgoConfig {
  let config = input;

  // The engine discriminator was `'v12'` before the rename. Left unmigrated it simply fails the
  // `=== 'bitboard'` check and the config silently plays on the *legacy* engine with whatever inert
  // legacy weights it happens to carry — a config that looks loaded and is a different engine.
  if ((config.engine as string) === 'v12') {
    console.warn(
      `[algoVersions] config "${config.id}" declares engine "v12"; treating it as "bitboard".`,
    );
    config = { ...config, engine: 'bitboard' };
  }

  const legacy = (config as unknown as { v12?: DeepPartial<BitboardParams> | null }).v12;
  if (legacy !== undefined && config.bitboard === undefined) {
    console.warn(
      `[algoVersions] config "${config.id}" uses the old \`v12\` parameter key; treating it as \`bitboard\`.`,
    );
    const { v12: _dropped, ...rest } = config as unknown as Record<string, unknown>;
    config = { ...(rest as unknown as AlgoConfig), bitboard: legacy };
  }

  return config;
}

export function registerAlgoConfig(input: AlgoConfig): AlgoVersionId {
  const config = migrateLegacyKeys(input);
  ALGO_VERSIONS[config.id] = config;
  resolvedCache.delete(config.id);
  v12ParamCache.delete(config.id);
  weightCache.clear();
  return config.id;
}

export function unregisterAlgoConfig(id: AlgoVersionId): void {
  delete ALGO_VERSIONS[id];
  resolvedCache.delete(id);
  v12ParamCache.delete(id);
  weightCache.clear();
}

/** Progress is quantised so the per-(version, seat, phase) weight vector can be memoised. */
const PROGRESS_BUCKETS = 20;
const weightCache = new Map<string, HeuristicWeights>();

function lerpWeights(a: HeuristicWeights, b: HeuristicWeights, t: number): HeuristicWeights {
  const out = {} as HeuristicWeights;
  for (const key of WEIGHT_KEYS) {
    out[key] = a[key] + (b[key] - a[key]) * t;
  }
  return out;
}

const AGGRESSION_KEYS: Array<keyof HeuristicWeights> = ['blocking', 'opponentMobility'];
const EXPANSION_KEYS: Array<keyof HeuristicWeights> = [
  'cornerAccess',
  'mobility',
  'centerControl',
  'uniqueLiberties',
  'voronoiTerritory',
  'reachableArea',
];

function applySeat(weights: HeuristicWeights, seat: SeatModifiers): HeuristicWeights {
  const out = { ...weights };
  for (const key of AGGRESSION_KEYS) {
    out[key] *= seat.aggression;
  }
  for (const key of EXPANSION_KEYS) {
    out[key] *= seat.expansion;
  }
  return out;
}

/**
 * Weight vector for one colour at one point in the game. Versions without a phase schedule or a
 * seat profile get their authored weights back unchanged, so v4–v9 evaluate exactly as before.
 */
export function weightsFor(
  config: ResolvedAlgoConfig,
  color: PlayerColor,
  progress: number,
): HeuristicWeights {
  const seat = config.seatProfile?.[color];
  if (!config.weightsLate && !seat) {
    return config.weights;
  }

  const bucket = Math.round(Math.max(0, Math.min(1, progress)) * PROGRESS_BUCKETS);
  const key = `${config.id}|${color}|${bucket}`;
  const cached = weightCache.get(key);
  if (cached) {
    return cached;
  }

  let weights = config.weights;
  if (config.weightsLate) {
    const { earlyEnd, lateStart } = config.phaseSplit;
    const span = Math.max(1e-6, lateStart - earlyEnd);
    const t = Math.max(0, Math.min(1, (bucket / PROGRESS_BUCKETS - earlyEnd) / span));
    weights = t <= 0 ? config.weights : lerpWeights(config.weights, config.weightsLate, t);
  }
  if (seat) {
    weights = applySeat(weights, seat);
  }

  weightCache.set(key, weights);
  return weights;
}

export function defaultSeatProfile(): Record<PlayerColor, SeatModifiers> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, { aggression: 1, expansion: 1 }]),
  ) as Record<PlayerColor, SeatModifiers>;
}
