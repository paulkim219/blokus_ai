import { BOARD_SIZE, PLAYER_COLORS, START_CORNERS } from '../engine/types';
import type { GameState, PlaceMove, PlayerColor } from '../engine/types';
import { generateLegalMoves, hasLegalMove } from '../engine/game';
import { getRemainingSquareCount, PIECES } from '../engine/pieces';
import {
  ADJACENT_COLORS,
  DEFAULT_ALGO_VERSION,
  getAlgo,
  weightsFor,
  type AlgoVersionId,
  type ResolvedAlgoConfig,
} from './algoVersions';
import { computeTerritory, type TerritoryStats } from './territory';

export interface FeatureVector {
  placedSquares: number;
  remainingPenalty: number;
  cornerAccess: number;
  mobility: number;
  opponentMobility: number;
  centerControl: number;
  territory: number;
  blocking: number;
  uniqueLiberties: number;
  voronoiTerritory: number;
  reachableArea: number;
}

/** Reference liberty count that `blocking` measures each opponent's shortfall against. */
const LIBERTY_BASELINE = 20;

const DIAGONAL = [
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

const ORTHOGONAL = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

interface BoardStats {
  /** Empty cells each color may legally occupy while keeping corner contact. */
  liberties: Record<PlayerColor, number>;
  /** Liberties that no other color also has — private expansion room. */
  uniqueLiberties: Record<PlayerColor, number>;
  centerControl: Record<PlayerColor, number>;
  placedSquares: Record<PlayerColor, number>;
  /** Flat occupancy mask (1 = empty) and the liberty cells, both inputs to the territory BFS. */
  isEmpty: Uint8Array;
  libertyCells: Record<PlayerColor, number[]>;
  /** Filled in on first use — versions that weight no territory feature never pay for it. */
  territory: TerritoryStats | null;
}

const COLOR_BITS: Record<PlayerColor, number> = {
  blue: 1,
  yellow: 2,
  purple: 4,
  green: 8,
};

const statsCache = new WeakMap<object, BoardStats>();

function emptyCounts(): Record<PlayerColor, number> {
  return { blue: 0, yellow: 0, purple: 0, green: 0 };
}

function emptyCellLists(): Record<PlayerColor, number[]> {
  return { blue: [], yellow: [], purple: [], green: [] };
}

/** Total squares the four players could ever place — the denominator for game progress. */
const TOTAL_PLACEABLE_SQUARES = 89 * PLAYER_COLORS.length;

/**
 * All positional features for every color in one board pass. Scoring a single move used to
 * cost ~24 separate 20x20 scans, which starved the search of rollouts.
 */
function computeBoardStats(board: GameState['board']): BoardStats {
  const stats: BoardStats = {
    liberties: emptyCounts(),
    uniqueLiberties: emptyCounts(),
    centerControl: emptyCounts(),
    placedSquares: emptyCounts(),
    isEmpty: new Uint8Array(BOARD_SIZE * BOARD_SIZE),
    libertyCells: emptyCellLists(),
    territory: null,
  };
  const center = (BOARD_SIZE - 1) / 2;

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const occupant = board[y][x];
      if (occupant) {
        stats.placedSquares[occupant] += 1;
        const dist = Math.abs(x - center) + Math.abs(y - center);
        stats.centerControl[occupant] += Math.max(0, 18 - dist);
        continue;
      }
      stats.isEmpty[y * BOARD_SIZE + x] = 1;

      let diagonalMask = 0;
      for (const delta of DIAGONAL) {
        const nx = x + delta.x;
        const ny = y + delta.y;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) {
          continue;
        }
        const neighbor = board[ny][nx];
        if (neighbor) {
          diagonalMask |= COLOR_BITS[neighbor];
        }
      }
      if (diagonalMask === 0) {
        continue;
      }

      let orthogonalMask = 0;
      for (const delta of ORTHOGONAL) {
        const nx = x + delta.x;
        const ny = y + delta.y;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) {
          continue;
        }
        const neighbor = board[ny][nx];
        if (neighbor) {
          orthogonalMask |= COLOR_BITS[neighbor];
        }
      }

      const owners: PlayerColor[] = [];
      for (const color of PLAYER_COLORS) {
        const bit = COLOR_BITS[color];
        if (diagonalMask & bit && !(orthogonalMask & bit)) {
          stats.liberties[color] += 1;
          stats.libertyCells[color].push(y * BOARD_SIZE + x);
          owners.push(color);
        }
      }
      if (owners.length === 1) {
        stats.uniqueLiberties[owners[0]] += 1;
      }
    }
  }

  return stats;
}

/** Board arrays are cloned per move, so their identity is a safe memo key. */
function getBoardStats(state: GameState): BoardStats {
  const cached = statsCache.get(state.board);
  if (cached) {
    return cached;
  }
  const stats = computeBoardStats(state.board);
  statsCache.set(state.board, stats);
  return stats;
}

function getTerritoryStats(stats: BoardStats): TerritoryStats {
  if (!stats.territory) {
    stats.territory = computeTerritory(stats.isEmpty, stats.libertyCells);
  }
  return stats.territory;
}

/** Territory feature for one board, memoised alongside the rest of the board pass. */
export function territoryStatsFor(state: GameState): TerritoryStats {
  return getTerritoryStats(getBoardStats(state));
}

/** Share of all placeable squares already on the board. 0 at the opening, ~0.9 at the end. */
export function gameProgress(state: GameState): number {
  return boardProgress(getBoardStats(state));
}

/** Share of all placeable squares already on the board — drives the early→late weight schedule. */
function boardProgress(stats: BoardStats): number {
  let placed = 0;
  for (const color of PLAYER_COLORS) {
    placed += stats.placedSquares[color];
  }
  return placed / TOTAL_PLACEABLE_SQUARES;
}

/** Skip the BFS entirely for versions that give both territory features zero weight. */
function usesTerritory(config: ResolvedAlgoConfig): boolean {
  if (config.weights.voronoiTerritory !== 0 || config.weights.reachableArea !== 0) {
    return true;
  }
  const late = config.weightsLate;
  return !!late && (late.voronoiTerritory !== 0 || late.reachableArea !== 0);
}

function countMobility(state: GameState, color: PlayerColor, fast: boolean, stats: BoardStats): number {
  if (fast) {
    return stats.liberties[color] + state.remainingPieces[color].length * 2;
  }
  if (!hasLegalMove(state, color)) {
    return 0;
  }
  return generateLegalMoves(state, color).length;
}

function countTerritory(state: GameState, color: PlayerColor): number {
  let owned = 0;
  for (let y = 1; y < BOARD_SIZE - 1; y += 1) {
    for (let x = 1; x < BOARD_SIZE - 1; x += 1) {
      if (state.board[y][x] !== null) {
        continue;
      }
      let closestSelf = Number.POSITIVE_INFINITY;
      let closestOpponent = Number.POSITIVE_INFINITY;
      for (let py = 0; py < BOARD_SIZE; py += 1) {
        for (let px = 0; px < BOARD_SIZE; px += 1) {
          const occupant = state.board[py][px];
          if (!occupant) {
            continue;
          }
          const dist = Math.abs(px - x) + Math.abs(py - y);
          if (occupant === color) {
            closestSelf = Math.min(closestSelf, dist);
          } else {
            closestOpponent = Math.min(closestOpponent, dist);
          }
        }
      }
      if (closestSelf < closestOpponent) {
        owned += 1;
      }
    }
  }
  return owned;
}

/** Mean shortfall in opponent liberties — higher means we are restricting them more. */
function countBlocking(color: PlayerColor, stats: BoardStats): number {
  let shortfall = 0;
  for (const opponent of PLAYER_COLORS) {
    if (opponent === color) {
      continue;
    }
    shortfall += LIBERTY_BASELINE - stats.liberties[opponent];
  }
  return shortfall / 3;
}

export function extractFeatures(
  state: GameState,
  color: PlayerColor,
  fast = false,
  version: AlgoVersionId = DEFAULT_ALGO_VERSION,
): FeatureVector {
  const stats = getBoardStats(state);
  const remainingPenalty = getRemainingSquareCount(state.remainingPieces[color]);
  const mobility = countMobility(state, color, fast, stats);
  const opponentMobility =
    PLAYER_COLORS.filter((player) => player !== color).reduce(
      (sum, player) => sum + countMobility(state, player, fast, stats),
      0,
    ) / 3;
  const territory = usesTerritory(getAlgo(version)) ? getTerritoryStats(stats) : null;

  return {
    placedSquares: stats.placedSquares[color],
    remainingPenalty,
    cornerAccess: stats.liberties[color],
    mobility,
    opponentMobility,
    centerControl: stats.centerControl[color],
    territory: fast ? 0 : countTerritory(state, color),
    blocking: countBlocking(color, stats),
    uniqueLiberties: stats.uniqueLiberties[color],
    voronoiTerritory: territory ? territory.voronoi[color] : 0,
    reachableArea: territory ? territory.reachable[color] : 0,
  };
}

/**
 * Every feature, territory included, regardless of what the active version weights. Used when
 * logging training data: the regression decides what matters, so it must see all of it.
 */
export function extractAllFeatures(
  state: GameState,
  color: PlayerColor,
  fast = false,
): FeatureVector {
  const stats = getBoardStats(state);
  const territory = getTerritoryStats(stats);
  return {
    ...extractFeatures(state, color, fast),
    voronoiTerritory: territory.voronoi[color],
    reachableArea: territory.reachable[color],
  };
}

/**
 * `color` and `progress` are optional: without them the version's authored weights are used, which
 * is what every version without a phase schedule or seat profile wants.
 */
export function scoreFeatures(
  features: FeatureVector,
  version: AlgoVersionId = DEFAULT_ALGO_VERSION,
  color?: PlayerColor,
  progress?: number,
): number {
  const config = getAlgo(version);
  const weights =
    color !== undefined && progress !== undefined
      ? weightsFor(config, color, progress)
      : config.weights;
  return (
    features.placedSquares * weights.placedSquares +
    features.remainingPenalty * weights.remainingPenalty +
    features.cornerAccess * weights.cornerAccess +
    features.mobility * weights.mobility +
    features.opponentMobility * weights.opponentMobility +
    features.centerControl * weights.centerControl +
    features.territory * weights.territory +
    features.blocking * weights.blocking +
    features.uniqueLiberties * weights.uniqueLiberties +
    features.voronoiTerritory * weights.voronoiTerritory +
    features.reachableArea * weights.reachableArea
  );
}

function opponentTerm(
  perspective: PlayerColor,
  scores: Record<PlayerColor, number>,
  version: AlgoVersionId,
): number {
  const adjacentWeight = getAlgo(version).adjacentOpponentWeight;
  const [left, right] = ADJACENT_COLORS[perspective];
  const opposite = PLAYER_COLORS.find(
    (color) => color !== perspective && color !== left && color !== right,
  )!;
  const adjacentMean = (scores[left] + scores[right]) / 2;
  return adjacentMean * adjacentWeight + scores[opposite] * (1 - adjacentWeight);
}

export function evaluateState(
  state: GameState,
  perspective: PlayerColor,
  fast = false,
  version: AlgoVersionId = DEFAULT_ALGO_VERSION,
): number {
  // Every seat is scored through its own phase/seat weights, so the opponent term reflects how
  // that seat would actually play rather than how we would play from its chair.
  const progress = boardProgress(getBoardStats(state));
  const myScore = scoreFeatures(
    extractFeatures(state, perspective, fast, version),
    version,
    perspective,
    progress,
  );
  const opponentScores = Object.fromEntries(
    PLAYER_COLORS.filter((color) => color !== perspective).map((color) => [
      color,
      scoreFeatures(extractFeatures(state, color, fast, version), version, color, progress),
    ]),
  ) as Record<PlayerColor, number>;
  return myScore - opponentTerm(perspective, opponentScores, version);
}

/** Blokus convention the state features cannot express: spend big pieces early, keep small ones last. */
function phasePieceBonus(
  state: GameState,
  move: PlaceMove,
  version: AlgoVersionId,
): number {
  const piecesLeft = state.remainingPieces[move.color].length;
  const size = PIECES[move.pieceId].size;
  const config = getAlgo(version);
  if (piecesLeft >= 14) {
    return size * config.phaseBonusEarly;
  }
  if (piecesLeft <= 5) {
    return (5 - size) * config.phaseBonusLate;
  }
  return 0;
}

export function evaluateMovePrior(
  state: GameState,
  move: PlaceMove,
  fast = false,
  version: AlgoVersionId = DEFAULT_ALGO_VERSION,
): number {
  const next = applyMoveForEval(state, move);
  return evaluateState(next, move.color, fast, version) + phasePieceBonus(state, move, version);
}

function applyMoveForEval(state: GameState, move: PlaceMove): GameState {
  const board = state.board.map((row) => [...row]);
  for (const cell of move.absoluteCells) {
    board[cell.y][cell.x] = move.color;
  }
  return {
    ...state,
    board,
    remainingPieces: {
      ...state.remainingPieces,
      [move.color]: state.remainingPieces[move.color].filter((id) => id !== move.pieceId),
    },
    hasPlayed: { ...state.hasPlayed, [move.color]: true },
  };
}

export function featureDelta(before: FeatureVector, after: FeatureVector): Partial<FeatureVector> {
  const delta: Partial<FeatureVector> = {};
  (Object.keys(before) as Array<keyof FeatureVector>).forEach((key) => {
    delta[key] = after[key] - before[key];
  });
  return delta;
}

export function getStartCornerLabel(color: PlayerColor): string {
  const corner = START_CORNERS[color];
  return `(${corner.x}, ${corner.y})`;
}
