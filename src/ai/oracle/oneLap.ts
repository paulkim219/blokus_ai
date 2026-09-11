import { applyMove, generateLegalMoves, moveKey, passTurn } from '../../engine/game';
import type { GameState, PlayerColor } from '../../engine/types';
import type { OracleSearchConfig } from '../algoVersions';
import { bitboardParamsFor, getAlgo } from '../algoVersions';
import {
  marginValue,
  objectiveBlend,
  valueVector,
} from '../bitboard/backup';
import { seatOf, toPosition } from '../bitboard/adapter';
import type { BitboardParams } from '../bitboard/config';
import {
  createEvalContext,
  detectPhase,
  evaluate,
  refreshContext,
} from '../bitboard/features';
import { searchBestMoveV12 } from '../bitboard/index';
import { createOutcome, Playout } from '../bitboard/playout';
import type { ProgressCallback } from '../progress';
import type { RankedMove, SearchOptions, SearchResult } from '../searchTypes';
import { withSeed } from '../rng';
import {
  advanceOracleInteraction,
  oracleSeat,
} from './interaction';
import { ORACLE_STYLE_PROTOTYPES, PrototypeBelief } from './prototypeBayes';
import {
  extractOracleCandidateFeatures,
  extractOracleMoveFeatures,
} from './styleFeatures';
import type { OracleInteractionState, OracleSearchSnapshot } from './types';

interface ChancePath {
  state: GameState;
  interaction: OracleInteractionState;
  probability: number;
  order: number;
}

export interface OracleSearchDiagnostics {
  calls: number;
  activeCalls: number;
  rerankedCalls: number;
  changedMoves: number;
  rootCandidatesEvaluated: number;
  leafEvaluations: number;
  continuationRollouts: number;
  baseMs: number;
  responseMs: number;
  activeByMode: Record<OracleSearchSnapshot['mode'], number>;
}

const diagnostics: OracleSearchDiagnostics = {
  calls: 0,
  activeCalls: 0,
  rerankedCalls: 0,
  changedMoves: 0,
  rootCandidatesEvaluated: 0,
  leafEvaluations: 0,
  continuationRollouts: 0,
  baseMs: 0,
  responseMs: 0,
  activeByMode: { personalized: 0, fixed: 0, shuffled: 0 },
};

export function resetOracleSearchDiagnostics(): void {
  diagnostics.calls = 0;
  diagnostics.activeCalls = 0;
  diagnostics.rerankedCalls = 0;
  diagnostics.changedMoves = 0;
  diagnostics.rootCandidatesEvaluated = 0;
  diagnostics.leafEvaluations = 0;
  diagnostics.continuationRollouts = 0;
  diagnostics.baseMs = 0;
  diagnostics.responseMs = 0;
  diagnostics.activeByMode.personalized = 0;
  diagnostics.activeByMode.fixed = 0;
  diagnostics.activeByMode.shuffled = 0;
}

export function getOracleSearchDiagnostics(): OracleSearchDiagnostics {
  return {
    ...diagnostics,
    activeByMode: { ...diagnostics.activeByMode },
  };
}

function logit(probability: number): number {
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(clamped / (1 - clamped));
}

function enoughEvidence(
  snapshot: OracleSearchSnapshot | undefined,
  rootPlayer: PlayerColor,
  minimum: number,
): snapshot is OracleSearchSnapshot {
  if (!snapshot) {
    return false;
  }
  const rootSeat = oracleSeat(rootPlayer);
  return snapshot.observations.every(
    (observations, seat) => seat === rootSeat || observations >= minimum,
  );
}

/** The same four-seat static value contract used at a truncated v4.1 search leaf. */
function staticRootValue(
  state: GameState,
  rootPlayer: PlayerColor,
  params: BitboardParams,
): number {
  diagnostics.leafEvaluations += 1;
  const position = toPosition(state);
  const rootSeat = seatOf(rootPlayer);
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  refreshContext(context, position, false);

  const scores = new Float64Array(4);
  position.scores(scores);
  let bestOther = Number.NEGATIVE_INFINITY;
  for (let seat = 0; seat < scores.length; seat += 1) {
    if (seat !== rootSeat) {
      bestOther = Math.max(bestOther, scores[seat]);
    }
  }
  const rankBlend = objectiveBlend(
    params.search.rankBlend,
    scores[rootSeat] - bestOther,
    params.search.objectiveShift,
  );
  const values = new Float64Array(4);

  if (state.finished) {
    valueVector(
      scores,
      params.search.sigmoidScale,
      rankBlend,
      values,
      params.search.opponentAggregation,
    );
  } else {
    const phase = detectPhase(position, context, params, rootSeat);
    const evaluation = evaluate(context, position, params, phase);
    valueVector(
      evaluation,
      params.search.evalScale,
      rankBlend,
      values,
      params.search.opponentAggregation,
    );
    const materialBlend = params.search.leafMaterialBlend;
    if (materialBlend > 0) {
      const material = new Float64Array(4);
      marginValue(
        scores,
        params.search.sigmoidScale,
        material,
        params.search.opponentAggregation,
      );
      for (let seat = 0; seat < values.length; seat += 1) {
        values[seat] = materialBlend * material[seat] + (1 - materialBlend) * values[seat];
      }
    }
  }

  return logit(values[rootSeat]) * params.search.sigmoidScale;
}

/** Long-horizon value for one predicted one-lap leaf, using v4.1's own terminal policy. */
function terminalRootValue(
  state: GameState,
  rootPlayer: PlayerColor,
  params: BitboardParams,
  playout: Playout,
  rollouts: number,
): number {
  diagnostics.leafEvaluations += 1;
  const position = toPosition(state);
  const rootSeat = seatOf(rootPlayer);
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  refreshContext(context, position, false);
  const phase = detectPhase(position, context, params, rootSeat);
  const leafScores = new Float64Array(4);
  position.scores(leafScores);
  let bestOther = Number.NEGATIVE_INFINITY;
  for (let seat = 0; seat < leafScores.length; seat += 1) {
    if (seat !== rootSeat) bestOther = Math.max(bestOther, leafScores[seat]);
  }
  const rankBlend = objectiveBlend(
    params.search.rankBlend,
    leafScores[rootSeat] - bestOther,
    params.search.objectiveShift,
  );
  const samples = Math.max(1, Math.floor(rollouts));
  let backedSum = 0;
  playout.resetLearning();
  for (let sample = 0; sample < samples; sample += 1) {
    const outcome = createOutcome();
    const seed = (
      position.hashLo ^
      Math.imul(position.hashHi, 0x9e3779b1) ^
      Math.imul(sample + 1, 0x85ebca6b)
    ) >>> 0;
    withSeed(seed, () => playout.run(position, context, phase, outcome));
    diagnostics.continuationRollouts += 1;
    if (outcome.learnedTail) {
      backedSum += outcome.values[rootSeat];
      continue;
    }
    const backed = new Float64Array(4);
    valueVector(
      outcome.values,
      outcome.terminal ? params.search.sigmoidScale : params.search.evalScale,
      rankBlend,
      backed,
      params.search.opponentAggregation,
    );
    if (!outcome.terminal && params.search.leafMaterialBlend > 0) {
      const material = new Float64Array(4);
      marginValue(
        leafScores,
        params.search.sigmoidScale,
        material,
        params.search.opponentAggregation,
      );
      backed[rootSeat] =
        params.search.leafMaterialBlend * material[rootSeat] +
        (1 - params.search.leafMaterialBlend) * backed[rootSeat];
    }
    backedSum += backed[rootSeat];
  }
  return logit(backedSum / samples) * params.search.sigmoidScale;
}

function topProbabilityIndices(probabilities: readonly number[], width: number): number[] {
  return probabilities
    .map((probability, index) => ({ probability, index }))
    .sort((a, b) => b.probability - a.probability || a.index - b.index)
    .slice(0, Math.max(1, width))
    .map((entry) => entry.index);
}

function expandOpponentTurn(
  paths: readonly ChancePath[],
  rootPlayer: PlayerColor,
  snapshot: OracleSearchSnapshot,
  predictor: PrototypeBelief,
  config: OracleSearchConfig,
  nextOrder: { value: number },
): ChancePath[] {
  const expanded: ChancePath[] = [];
  for (const path of paths) {
    const mover = path.state.currentTurn;
    if (path.state.finished || mover === rootPlayer) {
      expanded.push(path);
      continue;
    }
    const legal = generateLegalMoves(path.state, mover);
    if (legal.length === 0) {
      expanded.push({
        state: passTurn(path.state),
        interaction: advanceOracleInteraction(path.interaction, null),
        probability: path.probability,
        order: nextOrder.value++,
      });
      continue;
    }

    const rawFeatures = extractOracleCandidateFeatures(path.state, legal, path.interaction);
    const posterior = snapshot.posteriors[oracleSeat(mover)] ?? predictor.prior;
    const prediction = predictor.predictFromFeatures(rawFeatures, posterior);
    for (const moveIndex of topProbabilityIndices(prediction.probabilities, config.replyWidth)) {
      expanded.push({
        state: applyMove(path.state, legal[moveIndex]),
        interaction: advanceOracleInteraction(path.interaction, rawFeatures[moveIndex]),
        probability: path.probability * prediction.probabilities[moveIndex],
        order: nextOrder.value++,
      });
    }
  }
  expanded.sort((a, b) => b.probability - a.probability || a.order - b.order);
  return expanded.slice(0, Math.max(1, config.beamWidth));
}

function responseValue(
  state: GameState,
  rootMove: RankedMove,
  rootPlayer: PlayerColor,
  snapshot: OracleSearchSnapshot,
  predictor: PrototypeBelief,
  config: OracleSearchConfig,
  params: BitboardParams,
  playout: Playout | null,
): number {
  const rootFeatures = extractOracleMoveFeatures(state, rootMove.move, snapshot.interaction);
  let paths: ChancePath[] = [
    {
      state: applyMove(state, rootMove.move),
      interaction: advanceOracleInteraction(snapshot.interaction, rootFeatures),
      probability: 1,
      order: 0,
    },
  ];
  const nextOrder = { value: 1 };
  // A four-player lap contains at most the three opponents. Passes still consume their turn.
  for (let reply = 0; reply < 3; reply += 1) {
    if (paths.every((path) => path.state.finished || path.state.currentTurn === rootPlayer)) {
      break;
    }
    paths = expandOpponentTurn(paths, rootPlayer, snapshot, predictor, config, nextOrder);
  }

  const totalProbability = paths.reduce((sum, path) => sum + path.probability, 0);
  const weighted = paths.map((path) => ({
    probability: path.probability / Math.max(1e-12, totalProbability),
    value:
      config.responseEvaluator === 'terminal' && playout
        ? terminalRootValue(
            path.state,
            rootPlayer,
            params,
            playout,
            config.terminalRollouts,
          )
        : staticRootValue(path.state, rootPlayer, params),
  }));
  const mean = weighted.reduce(
    (sum, leaf) => sum + leaf.probability * leaf.value,
    0,
  );
  const variance = weighted.reduce(
    (sum, leaf) => sum + leaf.probability * (leaf.value - mean) ** 2,
    0,
  );
  return mean - config.riskWeight * Math.sqrt(Math.max(0, variance));
}

function sampleIndex(probabilities: readonly number[], quantile: number): number {
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index];
    if (quantile <= cumulative || index === probabilities.length - 1) {
      return index;
    }
  }
  return Math.max(0, probabilities.length - 1);
}

/**
 * Estimates only the value attributable to knowing who the opponents are. The target and
 * population policies share every sampled leaf, so generic response value cancels by construction.
 */
function counterfactualIdentityDelta(
  state: GameState,
  rootMove: RankedMove,
  rootPlayer: PlayerColor,
  snapshot: OracleSearchSnapshot,
  predictor: PrototypeBelief,
  config: OracleSearchConfig,
  params: BitboardParams,
  playout: Playout,
): number {
  const rootFeatures = extractOracleMoveFeatures(state, rootMove.move, snapshot.interaction);
  const initialState = applyMove(state, rootMove.move);
  const initialInteraction = advanceOracleInteraction(snapshot.interaction, rootFeatures);
  const scenarios = Math.max(1, Math.floor(config.scenarioCount));
  let targetWeightedValue = 0;
  let targetWeight = 0;
  let fixedWeightedValue = 0;
  let fixedWeight = 0;

  for (let scenario = 0; scenario < scenarios; scenario += 1) {
    let branchState = initialState;
    let branchInteraction = initialInteraction;
    let targetLikelihoodRatio = 1;
    let fixedLikelihoodRatio = 1;

    for (let reply = 0; reply < 3; reply += 1) {
      if (branchState.finished || branchState.currentTurn === rootPlayer) break;
      const mover = branchState.currentTurn;
      const legal = generateLegalMoves(branchState, mover);
      if (legal.length === 0) {
        branchState = passTurn(branchState);
        branchInteraction = advanceOracleInteraction(branchInteraction, null);
        continue;
      }
      const rawFeatures = extractOracleCandidateFeatures(
        branchState,
        legal,
        branchInteraction,
      );
      const target = predictor.predictFromFeatures(
        rawFeatures,
        snapshot.posteriors[oracleSeat(mover)] ?? predictor.prior,
      ).probabilities;
      const fixed = predictor.predictFromFeatures(rawFeatures, predictor.prior).probabilities;
      const proposal = target.map((probability, index) =>
        0.5 * probability + 0.5 * fixed[index],
      );
      // Each reply stage visits every one of the N strata once, in a different permutation. This
      // is deterministic stratified sampling, not a top-k truncation.
      const stratum = (scenario * 5 + reply * 7) % scenarios;
      const moveIndex = sampleIndex(proposal, (stratum + 0.5) / scenarios);
      const proposalProbability = Math.max(1e-12, proposal[moveIndex]);
      targetLikelihoodRatio *= target[moveIndex] / proposalProbability;
      fixedLikelihoodRatio *= fixed[moveIndex] / proposalProbability;
      branchState = applyMove(branchState, legal[moveIndex]);
      branchInteraction = advanceOracleInteraction(
        branchInteraction,
        rawFeatures[moveIndex],
      );
    }

    const value = terminalRootValue(
      branchState,
      rootPlayer,
      params,
      playout,
      config.terminalRollouts,
    );
    targetWeightedValue += targetLikelihoodRatio * value;
    targetWeight += targetLikelihoodRatio;
    fixedWeightedValue += fixedLikelihoodRatio * value;
    fixedWeight += fixedLikelihoodRatio;
  }

  return (
    targetWeightedValue / Math.max(1e-12, targetWeight) -
    fixedWeightedValue / Math.max(1e-12, fixedWeight)
  );
}

function resultFromRanked(rankedMoves: RankedMove[]): SearchResult {
  const best = rankedMoves[0];
  const second = rankedMoves[1];
  return {
    bestMove: best?.move ?? null,
    rankedMoves,
    confidence:
      best && second
        ? Math.min(1, Math.abs(best.value - second.value) / 8 + 0.35)
        : best
          ? 0.5
          : 0,
  };
}

/**
 * Bounded expectimax-like response layer. The base MCTS remains the proposal generator; learned
 * beliefs affect only this root re-ranking and are never written into its transposition table.
 */
export async function searchBestMoveOracle(
  state: GameState,
  rootPlayer: PlayerColor,
  timeLimitMs: number,
  config: OracleSearchConfig,
  snapshot: OracleSearchSnapshot | undefined,
  onProgress?: ProgressCallback,
  options: SearchOptions = {},
  engineKey = 'oracle',
): Promise<SearchResult> {
  diagnostics.calls += 1;
  const base = getAlgo(config.baseVersion);
  if (base.engine !== 'bitboard') {
    throw new Error(`Oracle base ${config.baseVersion} must use the bitboard engine`);
  }
  const params = bitboardParamsFor(base);
  const active = enoughEvidence(snapshot, rootPlayer, config.minimumObservations);
  const baseFraction = active
    ? Math.max(0.05, Math.min(1, config.baseSearchFraction))
    : 1;
  const baseIterations =
    options.iterationBudget === undefined
      ? undefined
      : Math.max(1, Math.round(options.iterationBudget * baseFraction));
  const baseStartedAt = performance.now();
  const baseline = await searchBestMoveV12(
    state,
    rootPlayer,
    Math.max(1, timeLimitMs * baseFraction),
    params,
    onProgress,
    {
      iterationBudget: baseIterations,
      engineKey: `${engineKey}:${config.baseVersion}`,
    },
  );
  diagnostics.baseMs += performance.now() - baseStartedAt;
  if (!active || baseline.rankedMoves.length < 2) {
    return baseline;
  }
  diagnostics.activeCalls += 1;
  diagnostics.activeByMode[snapshot.mode] += 1;
  if (config.responseBlend <= 0) {
    return baseline;
  }

  const predictor = new PrototypeBelief(ORACLE_STYLE_PROTOTYPES, {
    temperature: config.temperature,
    learningRate: 0.7,
    drift: 0.02,
    actionFloor: 0.01,
    standardizeFeatures: true,
  });
  const playout = config.responseEvaluator === 'terminal' ? new Playout(params) : null;
  const shortlistSize = Math.min(
    Math.max(2, config.rootCandidates),
    baseline.rankedMoves.length,
  );
  const responseByIndex = new Map<number, number>();
  const responseDeadline =
    options.iterationBudget === undefined
      ? performance.now() + Math.max(1, timeLimitMs * (1 - baseFraction))
      : Number.POSITIVE_INFINITY;

  const responseStartedAt = performance.now();
  for (let index = 0; index < shortlistSize; index += 1) {
    if (performance.now() >= responseDeadline) {
      break;
    }
    responseByIndex.set(
      index,
      config.responseMode === 'counterfactualSample' && playout
        ? counterfactualIdentityDelta(
            state,
            baseline.rankedMoves[index],
            rootPlayer,
            snapshot,
            predictor,
            config,
            params,
            playout,
          )
        : responseValue(
            state,
            baseline.rankedMoves[index],
            rootPlayer,
            snapshot,
            predictor,
            config,
            params,
            playout,
          ),
    );
  }
  // Partial clock-bound evaluation would privilege whichever baseline move happened to be first.
  // Keep the base result unless the whole preregistered shortlist was evaluated.
  if (responseByIndex.size !== shortlistSize) {
    diagnostics.responseMs += performance.now() - responseStartedAt;
    return baseline;
  }
  diagnostics.responseMs += performance.now() - responseStartedAt;
  diagnostics.rerankedCalls += 1;
  diagnostics.rootCandidatesEvaluated += shortlistSize;

  const blend = Math.max(0, Math.min(1, config.responseBlend));
  let ranked: Array<RankedMove & { oracleOrder: number; oracleScore?: number }>;
  if (config.responseMode === 'counterfactualSample') {
    const visitScale = Math.max(1e-6, config.responseVisitScale);
    const adjusted = baseline.rankedMoves.slice(0, shortlistSize).map((entry, index) => {
      const measured = responseByIndex.get(index) ?? 0;
      const delta = Math.abs(measured) < 1e-12 ? 0 : measured;
      return {
        ...entry,
        value: entry.value + blend * delta,
        oracleOrder: index,
        oracleScore: Math.log(Math.max(1, entry.visits)) + (blend * delta) / visitScale,
      };
    });
    adjusted.sort(
      (a, b) =>
        (b.oracleScore ?? 0) - (a.oracleScore ?? 0) || a.oracleOrder - b.oracleOrder,
    );
    ranked = [
      ...adjusted,
      ...baseline.rankedMoves.slice(shortlistSize).map((entry, index) => ({
        ...entry,
        oracleOrder: shortlistSize + index,
      })),
    ];
  } else {
    ranked = baseline.rankedMoves.map((entry, index) => {
      const response = responseByIndex.get(index);
      return response === undefined
        ? { ...entry, oracleOrder: index }
        : {
            ...entry,
            value: (1 - blend) * entry.value + blend * response,
            oracleOrder: index,
          };
    });
    ranked.sort((a, b) => b.value - a.value || a.oracleOrder - b.oracleOrder);
  }
  if (
    baseline.bestMove &&
    ranked[0]?.move &&
    moveKey(baseline.bestMove) !== moveKey(ranked[0].move)
  ) {
    diagnostics.changedMoves += 1;
  }
  return resultFromRanked(
    ranked.map(({ oracleOrder: _oracleOrder, oracleScore: _oracleScore, ...entry }) => entry),
  );
}
