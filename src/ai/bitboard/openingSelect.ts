/**
 * Direct policy selection for a seat's earliest moves.
 *
 * `netPrior` blends a network into the PUCT prior, a channel E1 measured at 0.12 points of total
 * capacity. This is a different thing: on own moves below a threshold the network *chooses*, and no
 * search runs at all.
 *
 * The justification is an asymmetry measured on 416 oracle-labelled opening positions — top-1
 * agreement with a majority label from three 9,600-iteration searches:
 *
 *   own moves 1-3   net 45.1%   deployed search 10.5%
 *   own moves 4-5   net 30.7%   deployed search 30.3%
 *
 * The search is bad early and good late; the net is the reverse. Own-move index is therefore the
 * abstention rule, and it is the only one that separated them — the net's own score margin did not
 * (accuracy by margin quartile ran 42.9 / 57.1 / 57.1 / 12.5, with no monotone relationship).
 *
 * The candidate list is built through both of the engine's real funnels, because a network asked to
 * rank moves the search would never have surfaced is being asked a different question than the one
 * it is graded on.
 */

import type { BitboardParams, PhaseId } from './config';
import type { EvalContext } from './features';
import { createEvalContext, refreshContext } from './features';
import { FEATURE_COUNT, writeFeatures } from './netFeatures';
import { POLICY_V2_FEATURE_COUNT, writePolicyFeaturesV2 } from './policyFeaturesV2';
import { MoveOrderer, sortByScore } from './ordering';
import { PLACEMENTS } from './placements';
import { newMoveBuffer, type Position } from './position';
import {
  pooledPolicyNetFor,
  preparePooledPosition,
  scorePooledPlacement,
  scorePooledPlacementMembers,
} from './spatialNet';

export interface SelectedMove {
  move: number;
  score: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  );
}

function popcount32(value: number): number {
  let word = value >>> 0;
  word -= (word >>> 1) & 0x55555555;
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
  return (((word + (word >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Scratch reused across calls; this runs once per move, not per node. */
const parentFeatures = new Float32Array(FEATURE_COUNT);
const netInput = new Float32Array(POLICY_V2_FEATURE_COUNT);
/** A real context, not a stub: `writePolicyFeaturesV2` reads territory and region fields from it. */
const priorContext: EvalContext = createEvalContext();

/**
 * The net's ranked top moves, or an empty array when it cannot answer — no registered net, no legal
 * moves, or the config never asked. An empty result means the caller searches normally, which is the
 * abstention path.
 */
/**
 * The tier-1 heuristic ordering's top moves, with no network and no tree.
 *
 * This is the candidate set the root search would have started from, ranked the way it ranks them
 * before a single simulation runs.
 */
export function heuristicOpeningMoves(
  position: Position,
  seat: number,
  params: BitboardParams,
  context: EvalContext,
  phase: PhaseId,
  topK = 3,
): SelectedMove[] {
  const buffer = newMoveBuffer();
  const legal = position.generateMoves(seat, buffer);
  if (legal === 0) return [];
  const ordering = params.ordering[phase];
  const ids = Array.from({ length: legal }, (_, i) => buffer[i]);
  ids.sort(
    (a, b) =>
      PLACEMENTS.size[b] * ordering.pieceSize -
      PLACEMENTS.centreDistance[b] * ordering.centrePull -
      (PLACEMENTS.size[a] * ordering.pieceSize -
        PLACEMENTS.centreDistance[a] * ordering.centrePull),
  );
  const kept = Math.min(Math.max(params.search.rootShortlist * 2, 96), ids.length);
  const moves = new Int32Array(kept);
  for (let i = 0; i < kept; i += 1) moves[i] = ids[i];
  const scores = new Float64Array(kept);
  new MoveOrderer(params).scoreMoves(position, context, seat, moves, kept, scores, phase, {
    withSplit: true,
    splitBudget: params.search.interiorSplitBudget > 0 ? params.search.interiorSplitBudget : 24,
  });
  sortByScore(moves, scores, kept);
  const out: SelectedMove[] = [];
  for (let i = 0; i < Math.min(topK, kept); i += 1) out.push({ move: moves[i], score: scores[i] });
  return out;
}

export function selectOpeningMoves(
  position: Position,
  seat: number,
  params: BitboardParams,
  context: EvalContext,
  phase: PhaseId,
  topK = 3,
): SelectedMove[] {
  const net = pooledPolicyNetFor(params.search.pooledNetPath);
  if (!net) return [];

  const buffer = newMoveBuffer();
  const legal = position.generateMoves(seat, buffer);
  if (legal === 0) return [];

  // Tier 0: the same O(1) cut the root applies before any evaluation runs.
  const ordering = params.ordering[phase];
  const ids = Array.from({ length: legal }, (_, i) => buffer[i]);
  ids.sort(
    (a, b) =>
      PLACEMENTS.size[b] * ordering.pieceSize -
      PLACEMENTS.centreDistance[b] * ordering.centrePull -
      (PLACEMENTS.size[a] * ordering.pieceSize -
        PLACEMENTS.centreDistance[a] * ordering.centrePull),
  );
  const funnel = Math.max(params.search.rootShortlist * 2, 96);
  const kept = Math.min(funnel, ids.length);
  const moves = new Int32Array(kept);
  for (let i = 0; i < kept; i += 1) moves[i] = ids[i];

  // Tier 1: the real ordering heuristic, including Δsplit, exactly as the root does it.
  const scores = new Float64Array(kept);
  new MoveOrderer(params).scoreMoves(position, context, seat, moves, kept, scores, phase, {
    withSplit: true,
    splitBudget: params.search.interiorSplitBudget > 0 ? params.search.interiorSplitBudget : 24,
  });
  sortByScore(moves, scores, kept);

  const shortlist = Math.min(params.search.rootShortlist, kept);
  writeFeatures(parentFeatures, 0, position, context, seat);
  preparePooledPosition(net, position, seat);

  const gate = params.search.openingSelectGate;
  const memberScores: number[][] = [];
  const out: SelectedMove[] = [];
  for (let i = 0; i < shortlist; i += 1) {
    const undo = position.apply(moves[i]);
    refreshContext(priorContext, position, false);
    writePolicyFeaturesV2(netInput, position, priorContext, seat, moves[i], parentFeatures);
    if (gate) {
      const members = scorePooledPlacementMembers(net, moves[i], seat, netInput);
      memberScores.push(members);
      out.push({ move: moves[i], score: mean(members) });
    } else {
      out.push({ move: moves[i], score: scorePooledPlacement(net, moves[i], seat, netInput) });
    }
    position.undo(undo);
  }
  out.sort((a, b) => b.score - a.score);

  if (gate && out.length >= 3) {
    // `memberScores` was collected in heuristic order; address it by move after the policy sort.
    const byMove = new Map<number, number[]>();
    for (let i = 0; i < shortlist; i += 1) byMove.set(moves[i], memberScores[i]);
    const chosen = out[0];
    const chosenMembers = byMove.get(chosen.move) ?? [];
    const margins = chosenMembers.map((score, member) => {
      const runner = Math.max(...out.slice(1).map((candidate) => byMove.get(candidate.move)?.[member] ?? -Infinity));
      return score - runner;
    });
    const votes = chosenMembers.map((_, member) => {
      const best = [...out].sort(
        (a, b) => (byMove.get(b.move)?.[member] ?? -Infinity) - (byMove.get(a.move)?.[member] ?? -Infinity),
      )[0];
      return best.move === chosen.move ? 1 : 0;
    });
    const maxLogit = Math.max(...out.map((entry) => entry.score));
    const exps = out.map((entry) => Math.exp(entry.score - maxLogit));
    const total = exps.reduce((sum, value) => sum + value, 0);
    const probs = exps.map((value) => value / Math.max(1e-12, total));
    const entropy = -probs.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0) /
      Math.log(probs.length);
    const heuristicRank = Array.from(moves.slice(0, shortlist)).indexOf(chosen.move);
    const features = [
      popcount32(position.hand[seat]) === 17 ? 1 : 0,
      Math.log1p(legal),
      chosen.score - out[1].score,
      chosen.score - out[2].score,
      entropy,
      mean(votes),
      sd(chosenMembers),
      mean(margins),
      sd(margins),
      chosen.move === moves[0] ? 1 : 0,
      heuristicRank / Math.max(1, shortlist - 1),
      PLACEMENTS.size[chosen.move] / 5,
      PLACEMENTS.centreDistance[chosen.move] / 20,
    ];
    if (
      features.length !== gate.weights.length ||
      gate.mean.length !== gate.weights.length ||
      gate.scale.length !== gate.weights.length
    ) {
      return [];
    }
    const confidence = gate.intercept + features.reduce(
      (sum, value, index) =>
        sum + gate.weights[index] * ((value - gate.mean[index]) / Math.max(1e-12, gate.scale[index])),
      0,
    );
    if (!Number.isFinite(confidence) || confidence < gate.threshold) return [];
  }
  return out.slice(0, Math.max(1, topK));
}
