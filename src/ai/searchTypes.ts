import type { PlaceMove } from '../engine/types';

export interface RankedMove {
  move: PlaceMove;
  visits: number;
  winRate: number;
  value: number;
}

export interface SearchResult {
  bestMove: PlaceMove | null;
  rankedMoves: RankedMove[];
  confidence: number;
}

/** Toggles for batch/self-play runs — UI analysis keeps defaults (win-odds on). */
export interface SearchOptions {
  skipWinOddsRefinement?: boolean;
  lightRollouts?: boolean;
  version?: import('./algoVersions').AlgoVersionId;
  /**
   * Stop after exactly this many MCTS iterations instead of on the clock. Wall-clock budgets make
   * a result depend on machine load, which is fatal for parallel tournaments and for replaying a
   * game from a seed; an iteration budget is reproducible.
   */
  iterationBudget?: number;
  /** Real-game opponent beliefs captured before this root search. */
  oracle?: import('./oracle/types').OracleSearchSnapshot;
}
