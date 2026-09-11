/**
 * Generation 1 — the object-board engine, and the versions built on it before the evaluation was
 * fitted. `v1` (formerly `v4`) is the best of them and the baseline every later result is quoted
 * against; `v5`–`v9` and `v4-explore` are its single-axis ablations, and `v10` plus `v10a`–`v10f`
 * are the structure that generation 2 then fitted.
 */

import type { AlgoConfig, AlgoVersionId, HeuristicWeights, SeatModifiers } from '../algoVersions';
import type { PlayerColor } from '../../engine/types';

const V4_WEIGHTS: HeuristicWeights = {
  placedSquares: 2.6,
  remainingPenalty: -1.9,
  cornerAccess: 2.2,
  mobility: 1.3,
  opponentMobility: -1.1,
  centerControl: 0.5,
  territory: 1.1,
  blocking: 1.2,
  uniqueLiberties: 0,
  voronoiTerritory: 0,
  reachableArea: 0,
};

/**
 * v10's early weights: v4 plus the two BFS features and the v8 adjacent-opponent split.
 * Blocking stays high — the early game is about projecting influence, not packing.
 */
const V10_EARLY_WEIGHTS: HeuristicWeights = {
  ...V4_WEIGHTS,
  uniqueLiberties: 0.8,
  voronoiTerritory: 0.35,
  reachableArea: 0,
};

/** v10's late weights: packing takes over. Cheap squares in, blocking out, room-left in. */
const V10_LATE_WEIGHTS: HeuristicWeights = {
  ...V4_WEIGHTS,
  remainingPenalty: -2.6,
  cornerAccess: 1.2,
  mobility: 0.9,
  centerControl: 0,
  blocking: 0.5,
  uniqueLiberties: 0.8,
  voronoiTerritory: 0.2,
  reachableArea: 0.15,
};

/**
 * Seat dials for v10. The published Blokus seat statistics assume a different turn order and
 * colour mapping than this repo (here: blue → green → purple → yellow, and classic red is
 * purple), so these are only a starting point for the tuner — not measured facts.
 */
const V10_SEAT_PROFILE: Record<PlayerColor, SeatModifiers> = {
  blue: { aggression: 0.9, expansion: 1.1 },
  green: { aggression: 1.0, expansion: 1.05 },
  purple: { aggression: 1.1, expansion: 1.0 },
  yellow: { aggression: 1.25, expansion: 0.95 },
};

export { V4_WEIGHTS, V10_EARLY_WEIGHTS, V10_LATE_WEIGHTS, V10_SEAT_PROFILE };

export const V1_VERSIONS: Record<AlgoVersionId, AlgoConfig> = {
  v1: {
    id: 'v1',
    summary:
      'Fast eval + cheap rollouts + tanh UCB. Equal opponent mean. Final move by mean value.',
    weights: V4_WEIGHTS,
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
  },
  v5: {
    id: 'v5',
    summary:
      'v4 + most-visited move, adjacent-opponent weighting, unique (unshared) liberties, more positional rollout blend.',
    weights: {
      ...V4_WEIGHTS,
      uniqueLiberties: 1.6,
      blocking: 1.0,
      centerControl: 0.35,
    },
    exploration: 1.5,
    materialScale: 20,
    positionalScale: 50,
    materialBlend: 0.45,
    selectByVisits: true,
    adjacentOpponentWeight: 0.8,
    phaseBonusEarly: 0.3,
    phaseBonusLate: 0.15,
  },
  v6: {
    id: 'v6',
    summary:
      'v4 plus most-visited final move only. Isolates the robust-MCTS change that was bundled into the rejected v5.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: true,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
  },
  v7: {
    id: 'v7',
    summary:
      'v4 plus unique (unshared) liberties only. Isolates the eval feature that was bundled into the rejected v5.',
    weights: {
      ...V4_WEIGHTS,
      uniqueLiberties: 1.6,
    },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
  },
  v8: {
    id: 'v8',
    summary:
      'v4 plus adjacent-opponent weighting only (80% adjacent seats, 20% opposite). Isolates the last unused v5 eval change.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 0.8,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
  },
  v9: {
    id: 'v9',
    summary:
      'v4 plus more positional truncated-rollout blend (materialBlend 0.45, positionalScale 50). Isolates the remaining unused v5 search-eval mix.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 50,
    materialBlend: 0.45,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
  },
  'v4-explore': {
    id: 'v4-explore',
    summary:
      'v4 plus UCB c = 1.7. Isolates more tree exploration given noisy truncated rollouts. Named separately from the bundled v10 challenger.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.7,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
  },

  /** The hand-designed structure generation 2 then fitted. */
  v10: {
    id: 'v10',
    summary:
      'Full challenger: BFS Voronoi territory + reachable area live in fast mode, PUCT tree policy with heuristic priors, root progressive widening, early→late weight schedule, seat profile, adjacent-opponent 0.8, exact endgame packer in sealed regions.',
    weights: V10_EARLY_WEIGHTS,
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    // PUCT deliberately starves the moves it does not believe in, so a child can hold a high mean
    // off a single lucky rollout. Visit count is the only robust readout once priors concentrate
    // the search — mean-value selection picked 1-visit children in testing.
    selectByVisits: true,
    adjacentOpponentWeight: 0.8,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    weightsLate: V10_LATE_WEIGHTS,
    phaseSplit: { earlyEnd: 0.3, lateStart: 0.65 },
    seatProfile: V10_SEAT_PROFILE,
    selection: 'puct',
    puctC: 1.6,
    priorTemp: 6,
    rootWidening: { initial: 8, growth: 0.8 },
    leafValue: 'rollout',
    endgame: { maxOwnMoves: 60, nodeBudget: 20000 },
  },


  // --- Ablations: v4 plus exactly one v10 axis, so the league can attribute the gain. ---
  'v10a-voronoi': {
    id: 'v10a-voronoi',
    summary: 'v4 plus BFS Voronoi territory weight 0.35 (the first territory term that is live during search).',
    weights: { ...V4_WEIGHTS, voronoiTerritory: 0.35 },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
  },
  'v10b-puct': {
    id: 'v10b-puct',
    summary:
      'v4 plus PUCT tree policy with softmax heuristic priors, and the visit-count move selection PUCT requires. No eval change.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: true,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    selection: 'puct',
    puctC: 1.6,
    priorTemp: 6,
  },
  'v10c-widen': {
    id: 'v10c-widen',
    summary: 'v4 plus root progressive widening (8 children, +0.8 per √visits). No eval change.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    rootWidening: { initial: 8, growth: 0.8 },
  },
  'v10d-phase': {
    id: 'v10d-phase',
    summary: 'v4 plus the early→late weight schedule (block early, pack late). No new features.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    weightsLate: { ...V10_LATE_WEIGHTS, voronoiTerritory: 0, reachableArea: 0, uniqueLiberties: 0 },
    phaseSplit: { earlyEnd: 0.3, lateStart: 0.65 },
  },
  'v10e-seat': {
    id: 'v10e-seat',
    summary: 'v4 plus per-seat aggression/expansion multipliers.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    seatProfile: V10_SEAT_PROFILE,
  },
  'v10f-endgame': {
    id: 'v10f-endgame',
    summary: 'v4 plus the exact packer for sealed endgame regions. No eval or tree-policy change.',
    weights: { ...V4_WEIGHTS },
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: false,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    endgame: { maxOwnMoves: 60, nodeBudget: 20000 },
  },
};
