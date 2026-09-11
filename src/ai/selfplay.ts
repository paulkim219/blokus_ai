import { applyMove, calculateScores, createInitialState, generateLegalMoves, passTurn } from '../engine/game';
import { PLAYER_COLORS } from '../engine/types';
import type { GameState, OpeningMode, PlaceMove, PlayerColor } from '../engine/types';
import { clearLegalMoveCache } from './legalMoveCache';
import { rankMovesGreedy, searchBestMove } from './mcts';
import { resetV12 } from './bitboard';
import type { SearchOptions } from './searchTypes';
import { DEFAULT_ALGO_VERSION, type AlgoVersionId } from './algoVersions';
import { createRng, setSeed, type Rng } from './rng';
import { getAlgo } from './algoVersions';
import { OracleRuntimeTracker } from './oracle/runtime';
import {
  createStrategicInteractionState,
  observeStrategicMove,
  activeStrategicPersonality,
  rerankStrategicMoves,
  type StrategicPersonalityId,
  type StrategicPersonalitySchedule,
} from './oracle/strategicPersonalities';
import type { OracleInteractionState } from './oracle/types';

export type PolicyId = 'greedy' | 'mcts-short' | 'mcts-long' | 'mcts-bench';

export const POLICY_TIME_MS: Record<PolicyId, number> = {
  greedy: 400,
  'mcts-bench': 1200,
  'mcts-short': 3200,
  'mcts-long': 8000,
};

/** Faster search path for self-play: skip UI win-odds playouts, lighter rollouts. */
export const SELFPLAY_SEARCH_OPTIONS: SearchOptions = {
  skipWinOddsRefinement: true,
  lightRollouts: true,
};

export interface SelfPlayOptions {
  hero: PolicyId;
  opponents: PolicyId;
  heroColor?: PlayerColor;
  maxPlies?: number;
  searchOptions?: SearchOptions;
  heroVersion?: AlgoVersionId;
  opponentVersion?: AlgoVersionId;
  /**
   * Explicit per-seat assignment, overriding hero/opponent. A tournament fills all four seats so
   * one game yields four data points instead of one, and so a version is measured in every seat.
   */
  seatVersions?: Record<PlayerColor, AlgoVersionId>;
  seatPolicies?: Record<PlayerColor, PolicyId>;
  /** Prediction-research personalities layered over the ordinary legal move ranking. */
  seatPersonalities?: Partial<Record<PlayerColor, StrategicPersonalityId>>;
  /**
   * Seats whose objective changes mid-game. A schedule overrides `seatPersonalities` for that
   * seat and switches on the seat's own move count, so the change point is expressed in the same
   * units as the observation-count metrics.
   */
  seatPersonalitySchedules?: Partial<Record<PlayerColor, StrategicPersonalitySchedule>>;
  /** Fixes rollout randomness: the same seed replays the same game for the same seat assignment. */
  seed?: number;
  openingMode?: OpeningMode;
  /**
   * Plies at the start of the game where a move is sampled from the top `openingTopK` instead of
   * taken outright. Without this, greedy play is fully deterministic and every seed replays one
   * single game — no variance, but also no information.
   */
  openingRandomPlies?: number;
  openingTopK?: number;
  /** Called before each move is chosen — the hook the training-data collector logs features from. */
  onPly?: (state: GameState, ply: number) => void;
  /**
   * Called after each move is chosen, with the state it was chosen in. The oracle-loss analysis of
   * §7 needs the (position, played move) pair, which `onPly` alone cannot give it.
   */
  onMove?: (
    state: GameState,
    move: PlaceMove | null,
    ply: number,
    /** The objective in force for the mover, which a schedule may change mid-game. */
    personality?: StrategicPersonalityId,
  ) => void;
}

/** One finished game, reported per seat so any pair of versions in it can be compared. */
export interface GameRecord {
  scores: Record<PlayerColor, number>;
  seatVersions: Record<PlayerColor, AlgoVersionId>;
  seatPolicies: Record<PlayerColor, PolicyId>;
  winner: PlayerColor[];
  plies: number;
  finished: boolean;
  seed: number;
  openingMode: OpeningMode;
  durationMs: number;
}

export interface SelfPlayResult {
  hero: PolicyId;
  opponents: PolicyId;
  heroColor: PlayerColor;
  scores: Record<PlayerColor, number>;
  winner: PlayerColor[];
  plies: number;
  finished: boolean;
  /** Hero score minus the best opponent score: continuous, so far less noisy than win rate. */
  margin: number;
  heroVersion: AlgoVersionId;
  opponentVersion: AlgoVersionId;
}

export async function choosePolicyMove(
  state: GameState,
  color: PlayerColor,
  policy: PolicyId,
  searchOptions?: SearchOptions,
  version: AlgoVersionId = DEFAULT_ALGO_VERSION,
  /** Sample uniformly from this many top-ranked moves instead of always taking the best. */
  sampleTopK = 1,
  sampler?: Rng,
  personality?: StrategicPersonalityId,
  interaction?: OracleInteractionState,
): Promise<PlaceMove | null> {
  const timeLimitMs = POLICY_TIME_MS[policy];
  const options: SearchOptions = { ...searchOptions, version };
  const result =
    policy === 'greedy' || timeLimitMs <= 900
      ? await rankMovesGreedy(state, color, undefined, timeLimitMs, undefined, undefined, version)
      : await searchBestMove(state, color, timeLimitMs, undefined, options);

  const rankedMoves =
    personality && interaction
      ? rerankStrategicMoves(state, result.rankedMoves, personality, interaction)
      : result.rankedMoves;
  const bestMove = rankedMoves[0]?.move ?? result.bestMove;
  if (sampleTopK <= 1 || !sampler || rankedMoves.length === 0) {
    return bestMove;
  }
  const pool = Math.min(sampleTopK, rankedMoves.length);
  return rankedMoves[Math.floor(sampler() * pool)].move ?? bestMove;
}

function bySeat<T>(heroColor: PlayerColor, heroValue: T, otherValue: T): Record<PlayerColor, T> {
  return Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, color === heroColor ? heroValue : otherValue]),
  ) as Record<PlayerColor, T>;
}

/**
 * Plays one game with an explicit seat assignment. `seed` fixes every stochastic choice, so the
 * same seed replays the same game — which is what lets a tournament compare two configs on
 * identical rollout luck (common random numbers) instead of on independent noise.
 */
export async function playSeatedGame(options: SelfPlayOptions): Promise<GameRecord> {
  const heroColor = options.heroColor ?? 'blue';
  const heroVersion = options.heroVersion ?? DEFAULT_ALGO_VERSION;
  const seatVersions =
    options.seatVersions ?? bySeat(heroColor, heroVersion, options.opponentVersion ?? heroVersion);
  const seatPolicies = options.seatPolicies ?? bySeat(heroColor, options.hero, options.opponents);
  const maxPlies = options.maxPlies ?? Number.POSITIVE_INFINITY;
  const openingMode = options.openingMode ?? 'corner';
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff);

  clearLegalMoveCache();
  // Search instances are deliberately persistent within a game for subtree-reuse candidates, but
  // no statistics may leak from a previous tournament game in the same worker process.
  resetV12();
  setSeed(seed);
  // Opening sampling draws from its own stream so it advances once per ply no matter how many
  // rollouts a config ran. Two configs on the same seed therefore see the same draws, which keeps
  // the paired comparison tight.
  const openingRng = createRng(seed ^ 0x9e3779b9);
  const openingRandomPlies = options.openingRandomPlies ?? 0;
  const openingTopK = options.openingTopK ?? 3;
  const startedAt = Date.now();
  const oracleTracker = PLAYER_COLORS.some(
    (color) => getAlgo(seatVersions[color]).engine === 'oracle',
  )
    ? new OracleRuntimeTracker({ temperature: 0.6 })
    : null;
  const seatMoveCounts: Record<PlayerColor, number> = Object.fromEntries(
    PLAYER_COLORS.map((color) => [color, 0]),
  ) as Record<PlayerColor, number>;
  /** The objective in force for this seat right now; a schedule wins over a fixed personality. */
  const personalityFor = (color: PlayerColor): StrategicPersonalityId | undefined => {
    const schedule = options.seatPersonalitySchedules?.[color];
    if (schedule) return activeStrategicPersonality(schedule, seatMoveCounts[color]);
    return options.seatPersonalities?.[color];
  };
  let strategicInteraction = PLAYER_COLORS.some(
    (color) => options.seatPersonalities?.[color] ?? options.seatPersonalitySchedules?.[color],
  )
    ? createStrategicInteractionState()
    : null;

  let state = createInitialState(openingMode);
  let plies = 0;

  while (!state.finished && plies < maxPlies) {
    const color = state.currentTurn;
    options.onPly?.(state, plies);
    let move: PlaceMove | null = null;
    const legal = generateLegalMoves(state, color, 1);
    if (legal.length > 0) {
      const moverConfig = getAlgo(seatVersions[color]);
      const searchOptions =
        oracleTracker && moverConfig.engine === 'oracle' && moverConfig.oracle
          ? {
              ...options.searchOptions,
              oracle: oracleTracker.snapshot(moverConfig.oracle.profileMode),
            }
          : options.searchOptions;
      move = await choosePolicyMove(
        state,
        color,
        seatPolicies[color],
        searchOptions,
        seatVersions[color],
        plies < openingRandomPlies ? openingTopK : 1,
        openingRng,
        personalityFor(color),
        strategicInteraction ?? undefined,
      );
    }
    options.onMove?.(state, move, plies, personalityFor(color));
    if (move) seatMoveCounts[color] += 1;
    oracleTracker?.observe(state, move);
    if (strategicInteraction) {
      strategicInteraction = observeStrategicMove(state, move, strategicInteraction);
    }
    if (!move) {
      state = passTurn(state);
    } else {
      state = applyMove(state, move);
    }
    plies += 1;
  }

  const table = calculateScores(state);
  const scores = Object.fromEntries(table.map((entry) => [entry.color, entry.score])) as Record<
    PlayerColor,
    number
  >;
  const best = Math.max(...table.map((entry) => entry.score));

  return {
    scores,
    seatVersions,
    seatPolicies,
    winner: table.filter((entry) => entry.score === best).map((entry) => entry.color),
    plies,
    finished: state.finished,
    seed,
    openingMode,
    durationMs: Date.now() - startedAt,
  };
}

/** Fields a caller may pass straight through to {@link playSeatedGame}. */
export type GameSetup = Pick<
  SelfPlayOptions,
  | 'seatVersions'
  | 'seatPolicies'
  | 'seatPersonalities'
  | 'seatPersonalitySchedules'
  | 'seed'
  | 'openingMode'
  | 'openingRandomPlies'
  | 'openingTopK'
  | 'maxPlies'
  | 'searchOptions'
>;

/** Hero-vs-three view of {@link playSeatedGame}, kept for the existing ladder scripts. */
export async function playGame(options: SelfPlayOptions): Promise<SelfPlayResult> {
  const heroColor = options.heroColor ?? 'blue';
  const record = await playSeatedGame(options);
  const bestOpponent = Math.max(
    ...PLAYER_COLORS.filter((color) => color !== heroColor).map((color) => record.scores[color]),
  );

  return {
    hero: options.hero,
    opponents: options.opponents,
    heroColor,
    scores: record.scores,
    winner: record.winner,
    plies: record.plies,
    finished: record.finished,
    margin: record.scores[heroColor] - bestOpponent,
    heroVersion: record.seatVersions[heroColor],
    opponentVersion:
      record.seatVersions[PLAYER_COLORS.find((color) => color !== heroColor)!],
  };
}

export async function runLadder(options: {
  hero: PolicyId;
  opponents: PolicyId;
  games: number;
  heroColor?: PlayerColor;
  maxPlies?: number;
  searchOptions?: SearchOptions;
  heroVersion?: AlgoVersionId;
  opponentVersion?: AlgoVersionId;
}): Promise<{
  games: number;
  firstPlace: number;
  wins: number;
  meanHeroScore: number;
  meanMargin: number;
  results: SelfPlayResult[];
}> {
  const results: SelfPlayResult[] = [];
  for (let i = 0; i < options.games; i += 1) {
    results.push(
      await playGame({
        hero: options.hero,
        opponents: options.opponents,
        heroColor: options.heroColor,
        maxPlies: options.maxPlies,
        searchOptions: options.searchOptions ?? SELFPLAY_SEARCH_OPTIONS,
        heroVersion: options.heroVersion,
        opponentVersion: options.opponentVersion,
      }),
    );
  }

  const firstPlace = results.filter((result) => result.winner.includes(result.heroColor)).length;
  const wins = results.filter(
    (result) => result.winner.length === 1 && result.winner[0] === result.heroColor,
  ).length;
  const meanHeroScore =
    results.reduce((sum, result) => sum + result.scores[result.heroColor], 0) / Math.max(results.length, 1);
  const meanMargin =
    results.reduce((sum, result) => sum + result.margin, 0) / Math.max(results.length, 1);

  return {
    games: results.length,
    firstPlace,
    wins,
    meanHeroScore,
    meanMargin,
    results,
  };
}

export function formatLadderSummary(ladder: Awaited<ReturnType<typeof runLadder>>): string {
  const { games, firstPlace, wins, meanHeroScore, meanMargin, results } = ladder;
  const sample = results[0];
  const lines = [
    `Hero ${sample?.hero ?? ''} ${sample?.heroVersion ?? ''} as ${sample?.heroColor ?? 'blue'} vs 3× ${sample?.opponents ?? ''} ${sample?.opponentVersion ?? ''}`,
    `Games: ${games}`,
    `Sole wins: ${wins}/${games} (${((wins / games) * 100).toFixed(1)}%)`,
    `First place (incl. ties): ${firstPlace}/${games} (${((firstPlace / games) * 100).toFixed(1)}%)`,
    `Mean hero score: ${meanHeroScore.toFixed(2)}`,
    `Mean margin vs best opponent: ${meanMargin.toFixed(2)}`,
  ];
  return lines.join('\n');
}
