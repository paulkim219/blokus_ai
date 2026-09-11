/**
 * Generation 2 — generation 1's structure with its evaluation CEM-fitted over ~46k self-play games.
 *
 * `v2-lite` and `v2-pro` share that evaluation and differ **only in rollout length**: lite truncates
 * at 24/14 plies (faster), pro plays the rollout out. That one field is worth +4.86 [2.91, 6.89]
 * compute-matched on held-out seeds, and had been hard-coded since generation 1.
 */

import type { AlgoConfig, AlgoVersionId } from '../algoVersions';

const V2_LITE: AlgoConfig = {
    id: 'v2-lite',
    summary:
      'v10 with CEM-tuned evaluation: weights, phase split, phase bonuses, adjacent-opponent weight and seat profile learned from 46k self-play games. Search identical to v10.',
    weights: {
      placedSquares: 1.9572,
      remainingPenalty: -1.7231,
      cornerAccess: 2.5519,
      mobility: 1.0055,
      opponentMobility: -1.0699,
      centerControl: 0.3613,
      territory: 1.1,
      blocking: 1.4629,
      uniqueLiberties: 0.8562,
      voronoiTerritory: 0.4757,
      reachableArea: 0.1857,
    },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: true,
    adjacentOpponentWeight: 0.7571,
    phaseBonusEarly: 0.3326,
    phaseBonusLate: 0.0405,
    // Late-game mobility comes out negative. In fast mode mobility is
    // `liberties + 2 × piecesRemaining`, so a negative weight late is the tuner reinforcing the
    // packing objective: spare capacity at the end is unspent squares, not opportunity.
    weightsLate: {
      placedSquares: 2.8575,
      remainingPenalty: -2.6076,
      cornerAccess: 0.8618,
      mobility: -0.873,
      opponentMobility: -0.6205,
      centerControl: 0.006,
      territory: 1.1,
      blocking: 0.1352,
      uniqueLiberties: 0.6935,
      voronoiTerritory: 0.1156,
      reachableArea: 0.3076,
    },
    phaseSplit: { earlyEnd: 0.2654, lateStart: 0.6224 },
    // Independently reproduces the shape the seat strategy predicted: the first seat expands and
    // barely blocks, the last seat blocks hardest and expands least.
    seatProfile: {
      blue: { aggression: 0.7958, expansion: 1.1458 },
      green: { aggression: 1.0447, expansion: 1.0277 },
      purple: { aggression: 1.0824, expansion: 1.0219 },
      yellow: { aggression: 1.2428, expansion: 0.8906 },
    },
    selection: 'puct',
    puctC: 1.6,
    priorTemp: 6,
    rootWidening: { initial: 8, growth: 0.8 },
    leafValue: 'rollout',
    endgame: { maxOwnMoves: 60, nodeBudget: 20000 },
};

export const V2_VERSIONS: Record<AlgoVersionId, AlgoConfig> = {
  /** Formerly `v11`: v10's structure with its evaluation CEM-fitted over ~46k self-play games. */
  'v2-lite': V2_LITE,

  /**
   * v2-lite with rollouts played to the end instead of truncated at 24/14 plies — one field.
   *
   * +5.00 [2.78, 7.22] against v2-lite on held-out seeds at 300 iterations, and +4.86 [2.91, 6.89]
   * compute-matched (longer rollouts cost this engine 2.23x per iteration, so the equal-compute run
   * gives it only 45% of the iterations and it still wins). The truncation had been hard-coded since
   * v1 and was never a parameter until the v3 line made it one.
   */
  'v2-pro': {
    ...V2_LITE,
    id: 'v2-pro',
    summary:
      'v2-lite with full-length rollouts (24/14 -> 84). Promote-rule candidate: +4.86 [2.91, 6.89] compute-matched on held-out seeds.',
    rolloutSteps: 84,
    rolloutStepsLight: 84,
  },

};
