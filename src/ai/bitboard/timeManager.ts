/**
 * Time management (§6.1).
 *
 * "Nobody wins Blokus in the last three moves, but engines lose it by spending their clock there.
 * Allocate the budget by expected decision value: the opening is book-driven and cheap; plies
 * roughly 6 to 14 for the agent carry the largest branching factor and the largest score swings and
 * should receive the bulk of the clock; the endgame is exact and near-free."
 *
 * The repo's callers hand the engine a per-move millisecond budget rather than a game clock, so
 * this reshapes that budget across the game instead of dividing a total. The second half of §6.1 —
 * stopping once the best move's visit lead cannot be overturned — lives in the search itself, where
 * the visit counts are.
 */

import type { PhaseId, BitboardParams } from './config';

/** Own moves 1–5 are cheap, 6–14 are where the game is decided, the rest tails off. */
const MOVE_SHAPE: number[] = [
  0.45, 0.6, 0.8, 1.0, 1.15, 1.35, 1.45, 1.5, 1.5, 1.45, 1.35, 1.25, 1.15, 1.05, 0.95, 0.85, 0.75,
  0.65, 0.55, 0.5, 0.45,
];

const PHASE_SHAPE: Record<PhaseId, number> = {
  opening: 0.7,
  midgame: 1.15,
  endgame: 0.6,
};

/** A seat plays at most this many moves, so a shape has at most this many entries. */
export const OWN_MOVES = 21;

/**
 * The shape's multiplier at own-move `ownMovesPlayed`, with the last entry repeated.
 *
 * Repeating rather than clamping to 1 matters: a seat that has already placed every piece still
 * calls the search on its final legal move, and falling back to 1 there would quietly hand the
 * tail of the game a budget the shape was fitted to take away.
 */
export function shapeAt(shape: number[] | undefined, ownMovesPlayed: number): number {
  if (!shape || shape.length === 0) {
    return 1;
  }
  const index = Math.min(shape.length - 1, Math.max(0, ownMovesPlayed));
  const value = shape[index];
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Rescale a shape so it spends exactly a flat config's per-game budget.
 *
 * The match statistic has no compute discount in it, so a candidate that quietly spends 10% more
 * iterations is measuring `shape + 0.13 points of ladder` and calling it `shape`. Normalising here
 * means the only thing left to attribute is where the iterations went.
 */
export function normaliseShape(shape: number[]): number[] {
  const padded = Array.from({ length: OWN_MOVES }, (_, k) => shapeAt(shape, k));
  const total = padded.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return Array.from({ length: OWN_MOVES }, () => 1);
  }
  return padded.map((value) => (value * OWN_MOVES) / total);
}

export interface MovePlan {
  /** Milliseconds this move may spend in total. */
  budgetMs: number;
  /** Milliseconds for the first probe, after which the spread is re-read. */
  probeMs: number;
}

/**
 * `MOVE_SHAPE` is a hypothesis from the report, and until `search.iterationShape` existed there was
 * no way to test it — the clock path is the only path it reaches, and every tournament here is
 * iteration-budgeted. So a config that carries a *measured* shape uses that instead, on both paths.
 *
 * `PHASE_SHAPE` is deliberately dropped in that case rather than multiplied in. A fitted shape is
 * fitted against a flat baseline over the same 21 moves; layering the phase curve on top would ship
 * a curve nobody measured, and the phase boundaries already move with the board
 * (`detection.contestedFloor`) so the product would not even be a fixed function of move number.
 */
export function planMove(
  params: BitboardParams,
  baseBudgetMs: number,
  phase: PhaseId,
  ownMovesPlayed: number,
): MovePlan {
  const fitted = params.search.iterationShape;
  const budgetMs = fitted
    ? baseBudgetMs * shapeAt(fitted, ownMovesPlayed)
    : baseBudgetMs *
      MOVE_SHAPE[Math.min(MOVE_SHAPE.length - 1, Math.max(0, ownMovesPlayed))] *
      PHASE_SHAPE[phase];
  return {
    budgetMs,
    probeMs: budgetMs * params.time.probeFraction,
  };
}

/**
 * After the probe: a wide gap between the best and second-best root child means the decision is
 * already made and the rest of the budget buys nothing, while a narrow one means every extra
 * iteration is being spent where it matters.
 */
export function budgetAfterProbe(
  params: BitboardParams,
  plan: MovePlan,
  bestValue: number,
  secondValue: number,
): number {
  const keep = keepAfterProbe(params, bestValue, secondValue);
  return plan.probeMs + (plan.budgetMs - plan.probeMs) * keep;
}

/** Fraction of the post-probe pool worth spending at the current root. */
export function keepAfterProbe(
  params: BitboardParams,
  bestValue: number,
  secondValue: number,
): number {
  const spread = Math.abs(bestValue - secondValue);
  // Values are sigmoid outputs in [0, 1]; a spread of 0.1 is already a clear decision.
  return Math.max(0.25, Math.min(1, 1 - spread * params.time.spreadFactor * 4));
}

/** Fixed-iteration counterpart of `budgetAfterProbe`, including iterations banked earlier. */
export function iterationsAfterProbe(
  params: BitboardParams,
  available: number,
  probe: number,
  bestValue: number,
  secondValue: number,
): number {
  const boundedProbe = Math.min(available, Math.max(0, probe));
  const keep = keepAfterProbe(params, bestValue, secondValue);
  return Math.min(
    available,
    boundedProbe + Math.round((available - boundedProbe) * keep),
  );
}
