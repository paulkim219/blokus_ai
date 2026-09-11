/**
 * The Layer 2 search controller of §6, in the shape the rest of the repo already calls.
 *
 *     choose_move(state, seat):
 *         phase   = detect_phase(state)
 *         weights = W[phase][seat]
 *         if phase == OPENING and book.has(state): return book.get(state)
 *         if regions_sealed(state, seat):          return exact_pack(state, seat)
 *         tree = MCTS(...)
 *         run until time budget; return argmax_visits(tree.root)
 *
 * The returned `SearchResult` is the legacy one, so the worker, the self-play runner, the
 * tournament harness and the move-quality classifier all keep working unchanged. `value` is
 * reported in squares — the inverse of the backup's sigmoid — because that is the unit
 * `quality.ts` thresholds were calibrated in.
 */

import { PIECES } from '../../engine/pieces';
import { applyMove } from '../../engine/game';
import type { GameState, PlaceMove, PlayerColor } from '../../engine/types';
import type { ProgressCallback, SearchProgress } from '../progress';
import type { RankedMove, SearchResult } from '../searchTypes';
import { withSeed } from '../rng';
import { colorOf, placementFor, seatOf, toPlaceMove, toPosition } from './adapter';
import { forward, netFor } from './net';
import { FEATURE_COUNT, writeFeatures } from './netFeatures';
import { lookupBook } from './book';
import { DEFAULT_BITBOARD_PARAMS, type PhaseId, type BitboardParams } from './config';
import { createEvalContext, detectPhase, evaluate, refreshContext } from './features';
import { V12Search, type V12SearchResult } from './mcts';
import { MoveOrderer, sortByScore } from './ordering';
import { PLACEMENTS } from './placements';
import { solveSealedRegion } from './packer';
import { isSealed } from './territory';
import { budgetAfterProbe, iterationsAfterProbe, planMove, shapeAt } from './timeManager';
import { newMoveBuffer, type Position } from './position';
import { heuristicOpeningMoves, selectOpeningMoves } from './openingSelect';
import { createOutcome, Playout } from './playout';

export interface V12Options {
  /** Fixed iteration budget. Reproducible; overrides the clock, as the tournament runner needs. */
  iterationBudget?: number;
  /** Identifies the parameter set so the search instance (and its history table) can be reused. */
  engineKey?: string;
  /** Skip the book even in the opening — used by the book generator itself. */
  ignoreBook?: boolean;
}

const searchInstances = new Map<string, V12Search>();
const iterationBanks = new Map<string, number>();
const context = createEvalContext();
const reuseDiagnostics = { searches: 0, hits: 0, retainedVisits: 0, retainedChildren: 0 };
/**
 * Allocated-versus-spent iterations, which is exactly the budget dynamic banking harvests.
 *
 * `time.earlyExit` stops a search once the runner-up cannot catch up on visits, and the book and
 * the sealed-region packer return without searching at all. Under an iteration budget every one of
 * those unspent iterations is currently discarded. Whether banking is worth more at a larger tier
 * is a question about this number, and it costs a few self-play games rather than a match.
 */
const budgetDiagnostics = {
  searches: 0,
  allocated: 0,
  spent: 0,
  zeroSearchMoves: 0,
  /** Allocated and spent per own-move index, so banking's redeployment is visible by move. */
  allocatedByMove: new Array<number>(21).fill(0),
  spentByMove: new Array<number>(21).fill(0),
};

function instanceFor(key: string, params: BitboardParams): V12Search {
  const existing = searchInstances.get(key);
  if (existing) {
    existing.setParams(params);
    return existing;
  }
  const created = new V12Search(params);
  searchInstances.set(key, created);
  return created;
}

/** Frees the per-engine history tables. Self-play runners call this between matches. */
export function resetV12(): void {
  searchInstances.clear();
  iterationBanks.clear();
  reuseDiagnostics.searches = 0;
  reuseDiagnostics.hits = 0;
  reuseDiagnostics.retainedVisits = 0;
  reuseDiagnostics.retainedChildren = 0;
  budgetDiagnostics.searches = 0;
  budgetDiagnostics.allocated = 0;
  budgetDiagnostics.spent = 0;
  budgetDiagnostics.zeroSearchMoves = 0;
  budgetDiagnostics.allocatedByMove.fill(0);
  budgetDiagnostics.spentByMove.fill(0);
}

export function getV12BudgetDiagnostics(): Readonly<typeof budgetDiagnostics> {
  return {
    ...budgetDiagnostics,
    allocatedByMove: [...budgetDiagnostics.allocatedByMove],
    spentByMove: [...budgetDiagnostics.spentByMove],
  };
}

export function getV12ReuseDiagnostics(): Readonly<typeof reuseDiagnostics> {
  return { ...reuseDiagnostics };
}

function logit(p: number): number {
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(clamped / (1 - clamped));
}

function moveLabel(move: PlaceMove | null): string | undefined {
  if (!move) {
    return undefined;
  }
  return `${PIECES[move.pieceId].name} @ (${move.anchor.x},${move.anchor.y})`;
}

function terminalMargin(scores: Float64Array, seat: number): number {
  let bestOther = -Infinity;
  for (let other = 0; other < scores.length; other += 1) {
    if (other !== seat && scores[other] > bestOther) bestOther = scores[other];
  }
  return scores[seat] - bestOther;
}

/** Pool independent trees by the root statistic each tree would use on its own: visit count. */
function poolRootVisits(outcomes: readonly V12SearchResult[]): V12SearchResult {
  const combined = new Map<number, { visits: number; valueSum: number; priorSum: number }>();
  let iterations = 0;
  for (const outcome of outcomes) {
    iterations += outcome.iterations;
    for (const entry of outcome.ranked) {
      const current = combined.get(entry.move) ?? { visits: 0, valueSum: 0, priorSum: 0 };
      current.visits += entry.visits;
      current.valueSum += entry.value * entry.visits;
      current.priorSum += entry.prior;
      combined.set(entry.move, current);
    }
  }
  const ranked = [...combined.entries()].map(([move, aggregate]) => ({
    move,
    visits: aggregate.visits,
    value: aggregate.visits > 0 ? aggregate.valueSum / aggregate.visits : 0.5,
    prior: aggregate.priorSum / outcomes.length,
  }));
  ranked.sort((a, b) => b.visits - a.visits || b.value - a.value || a.move - b.move);
  return {
    best: ranked[0]?.move ?? -1,
    ranked,
    iterations,
    proven: outcomes.every((outcome) => outcome.proven),
    phase: outcomes[0]?.phase ?? 'midgame',
  };
}

/** Bounded root audit using terminal rollouts. Equal mode uses paired scenarios for every move;
 * variance mode starts paired, then races the empirical leader against its widest-CI challenger. */
function auditRoot(
  state: GameState,
  rootPlayer: PlayerColor,
  ranked: RankedMove[],
  params: BitboardParams,
  phase: PhaseId,
): RankedMove[] {
  const { rootAudit, rootAuditTopK, rootAuditRollouts, rootAuditBlend } = params.search;
  const k = Math.min(rootAuditTopK, ranked.length);
  if (rootAudit === 'none' || k < 2 || rootAuditRollouts < k) return ranked;

  const rootPosition = toPosition(state);
  const seat = seatOf(rootPlayer);
  const positions = ranked.slice(0, k).map((entry) => toPosition(applyMove(state, entry.move)));
  const contexts = positions.map(() => createEvalContext());
  const playout = new Playout(params);
  const sums = new Float64Array(k);
  const sumSquares = new Float64Array(k);
  const counts = new Int32Array(k);
  let spent = 0;

  const sample = (index: number, scenario: number): void => {
    const outcome = createOutcome();
    const seed = (
      rootPosition.hashLo ^
      Math.imul(rootPosition.hashHi, 0x9e3779b1) ^
      Math.imul(scenario + 1, 0x85ebca6b)
    ) >>> 0;
    withSeed(seed, () => playout.run(positions[index], contexts[index], phase, outcome));
    const margin = terminalMargin(outcome.values, seat);
    sums[index] += margin;
    sumSquares[index] += margin * margin;
    counts[index] += 1;
    spent += 1;
  };

  const initialRounds = rootAudit === 'variance'
    ? Math.min(3, Math.floor(rootAuditRollouts / k))
    : Math.floor(rootAuditRollouts / k);
  for (let scenario = 0; scenario < initialRounds; scenario += 1) {
    for (let index = 0; index < k && spent < rootAuditRollouts; index += 1) {
      sample(index, scenario);
    }
  }

  let scenario = initialRounds;
  while (rootAudit === 'variance' && spent + 2 <= rootAuditRollouts) {
    const mean = Array.from({ length: k }, (_, i) => sums[i] / Math.max(1, counts[i]));
    const leader = mean.reduce((best, value, i) => value > mean[best] ? i : best, 0);
    let challenger = leader === 0 ? 1 : 0;
    let widestUpper = -Infinity;
    for (let i = 0; i < k; i += 1) {
      if (i === leader) continue;
      const n = Math.max(1, counts[i]);
      const variance = n > 1
        ? Math.max(0, (sumSquares[i] - sums[i] * sums[i] / n) / (n - 1))
        : 64;
      const upper = mean[i] + 1.5 * Math.sqrt(variance / n);
      if (upper > widestUpper) {
        widestUpper = upper;
        challenger = i;
      }
    }
    sample(leader, scenario);
    sample(challenger, scenario);
    scenario += 1;
  }

  const audited = ranked.slice(0, k).map((entry, index) => {
    const auditValue = sums[index] / Math.max(1, counts[index]);
    const value = (1 - rootAuditBlend) * entry.value + rootAuditBlend * auditValue;
    return { ...entry, value };
  });
  audited.sort((a, b) => b.value - a.value || b.visits - a.visits);
  return [...audited, ...ranked.slice(k)];
}

async function emit(
  onProgress: ProgressCallback | undefined,
  progress: SearchProgress,
): Promise<void> {
  if (onProgress) {
    await onProgress(progress);
  }
}

function ownMovesPlayed(position: Position, seat: number): number {
  let played = 0;
  let bits = position.hand[seat];
  let held = 0;
  while (bits !== 0) {
    bits &= bits - 1;
    held += 1;
  }
  played = PIECES.length - held;
  return played;
}

export async function searchBestMoveV12(
  state: GameState,
  rootPlayer: PlayerColor,
  timeLimitMs: number,
  params: BitboardParams = DEFAULT_BITBOARD_PARAMS,
  onProgress?: ProgressCallback,
  options: V12Options = {},
): Promise<SearchResult> {
  const startedAt = performance.now();
  const position = toPosition(state);
  const seat = seatOf(rootPlayer);
  // Analysis can ask "what would this seat play" out of turn; the search is written from the seat
  // to move, so put them on move.
  if (position.turn !== seat) {
    position.forceTurn(seat);
  }

  context.fractionalTies = params.fractionalTerritoryTies;
  refreshContext(context, position, false);
  const phase: PhaseId = detectPhase(position, context, params, seat);
  const ownMoves = ownMovesPlayed(position, seat);
  const scaledIterations =
    options.iterationBudget === undefined
      ? undefined
      : Math.max(
          1,
          Math.round(
            options.iterationBudget *
              params.search.iterationScale *
              shapeAt(params.search.iterationShape, ownMoves),
          ),
        );
  const baseKey = options.engineKey ?? 'default';
  const bankKey = `${baseKey}:seat-${seat}`;
  const bankingAvailable =
    params.search.iterationBanking && scaledIterations !== undefined
      ? (iterationBanks.get(bankKey) ?? 0) + scaledIterations
      : undefined;
  if (bankingAvailable !== undefined) {
    // Deposit before book/packer exits: zero-search moves are exactly the free budget W3b banks.
    iterationBanks.set(bankKey, bankingAvailable);
  }

  await emit(onProgress, {
    phase: 'starting',
    percent: 2,
    iterations: 0,
    maxIterations: options.iterationBudget ?? 0,
    elapsedMs: 0,
    timeLimitMs,
    candidates: 0,
  });

  // 1. Opening book.
  if (!options.ignoreBook && phase === 'opening') {
    // Legality is re-checked per move: a book is keyed on the exact Zobrist hash, but a stale or
    // hand-edited book must never be able to return an illegal placement.
    const booked = lookupBook(params.search.bookPath, position).filter((entry) =>
      position.isLegal(seat, entry.move),
    );
    if (booked.length > 0) {
      // Ranked, not single. The harness samples the opening from the top `openingTopK`; returning
      // one move would make every seed replay the same line and collapse the seed bootstrap.
      const rankedMoves = booked.map((entry, index) => ({
        move: toPlaceMove(entry.move, rootPlayer),
        visits: booked.length - index,
        winRate: 0,
        value: entry.value,
      }));
      await emit(onProgress, {
        phase: 'done',
        percent: 100,
        iterations: 0,
        maxIterations: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        timeLimitMs,
        candidates: rankedMoves.length,
        currentBestLabel: moveLabel(rankedMoves[0].move),
      });
      // A book hit answers the move for free; its whole allocation is unspent.
      if (scaledIterations !== undefined) {
        budgetDiagnostics.searches += 1;
        budgetDiagnostics.allocated += scaledIterations;
        budgetDiagnostics.zeroSearchMoves += 1;
        budgetDiagnostics.allocatedByMove[Math.min(20, Math.max(0, ownMoves))] += scaledIterations;
      }
      return { bestMove: rankedMoves[0].move, rankedMoves, confidence: 0.9 };
    }
  }

  // 1b. Direct policy selection on the earliest own moves.
  //
  // Returns ranked alternatives for the same reason the book does: `choosePolicyMove` samples the
  // opening from the top `openingTopK`, and a single-move answer would collapse every seed onto one
  // line and destroy the statistic the promotion rule rests on.
  const selectMax = params.search.openingSelectMaxOwnMove ?? 0;
  const selectMin = params.search.openingSelectMinOwnMove ?? 1;
  const heuristicMax = params.search.openingHeuristicMaxOwnMove ?? 0;
  const ownMoveNumber = ownMoves + 1;
  const inSelectWindow = selectMax > 0 && ownMoveNumber >= selectMin && ownMoveNumber <= selectMax;
  if (inSelectWindow || (heuristicMax > 0 && ownMoves < heuristicMax)) {
    const selected =
      heuristicMax > 0 && ownMoves < heuristicMax
        ? heuristicOpeningMoves(position, seat, params, context, phase)
        : selectOpeningMoves(position, seat, params, context, phase);
    if (selected.length > 0) {
      const rankedMoves = selected.map((entry, index) => ({
        move: toPlaceMove(entry.move, rootPlayer),
        visits: selected.length - index,
        winRate: 0,
        value: entry.score,
      }));
      await emit(onProgress, {
        phase: 'done',
        percent: 100,
        iterations: 0,
        maxIterations: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        timeLimitMs,
        candidates: rankedMoves.length,
        currentBestLabel: moveLabel(rankedMoves[0].move),
      });
      if (scaledIterations !== undefined) {
        budgetDiagnostics.searches += 1;
        budgetDiagnostics.allocated += scaledIterations;
        budgetDiagnostics.zeroSearchMoves += 1;
        budgetDiagnostics.allocatedByMove[Math.min(20, Math.max(0, ownMoves))] += scaledIterations;
      }
      return { bestMove: rankedMoves[0].move, rankedMoves, confidence: 0.75 };
    }
  }

  // 2. A sealed region is not a game any more — pack it exactly.
  if (isSealed(context.territory, seat)) {
    const plan = solveSealedRegion(position, seat, context.territory, params.endgame);
    if (plan && plan.moves.length > 0) {
      const ranked = plan.moves.map((id, index) => ({
        move: toPlaceMove(id, rootPlayer),
        visits: plan.moves.length - index,
        winRate: 0,
        value: index === 0 ? plan.score : plan.score - index,
      }));
      await emit(onProgress, {
        phase: 'done',
        percent: 100,
        iterations: plan.nodes,
        maxIterations: params.endgame.nodeBudget,
        elapsedMs: Math.round(performance.now() - startedAt),
        timeLimitMs,
        candidates: ranked.length,
        currentBestLabel: moveLabel(ranked[0].move),
      });
      // The packer solved a sealed region exactly; the MCTS allocation went unspent.
      if (scaledIterations !== undefined) {
        budgetDiagnostics.searches += 1;
        budgetDiagnostics.allocated += scaledIterations;
        budgetDiagnostics.zeroSearchMoves += 1;
      }
      return {
        bestMove: ranked[0].move,
        rankedMoves: ranked,
        confidence: plan.proven ? 1 : 0.7,
      };
    }
  }

  // 3. MCTS.
  const treeCount = Math.max(1, Math.floor(params.search.rootEnsembleTrees));
  const searches = Array.from({ length: treeCount }, (_, tree) =>
    instanceFor(
      params.search.treeReuse
        ? `${baseKey}:seat-${seat}`
        : treeCount === 1
          ? baseKey
          : `${baseKey}:ensemble-${tree}`,
      params,
    ),
  );
  const candidates = searches[0].prepare(position, seat);
  for (let tree = 1; tree < searches.length; tree += 1) {
    searches[tree].prepare(position, seat);
  }
  const search = searches[0];
  if (params.search.treeReuse) {
    reuseDiagnostics.searches += 1;
    reuseDiagnostics.retainedVisits += search.reusedRootVisits;
    reuseDiagnostics.retainedChildren += search.reusedRootChildren;
    if (search.reusedRootVisits > 0) reuseDiagnostics.hits += 1;
  }
  if (candidates === 0) {
    await emit(onProgress, {
      phase: 'done',
      percent: 100,
      iterations: 0,
      maxIterations: 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      timeLimitMs,
      candidates: 0,
    });
    // No legal move: the whole allocation is unspent.
    if (scaledIterations !== undefined) {
      budgetDiagnostics.searches += 1;
      budgetDiagnostics.allocated += scaledIterations;
      budgetDiagnostics.zeroSearchMoves += 1;
    }
    return { bestMove: null, rankedMoves: [], confidence: 0 };
  }

  const plan = planMove(params, timeLimitMs, phase, ownMoves);
  // Equal-compute comparisons: a config whose iterations cost more runs proportionally fewer.
  // `iterationShape` then redistributes that budget across the seat's 21 moves; a shape summing to
  // 21 leaves the per-game total untouched, so only the distribution is under test.
  const banking = bankingAvailable !== undefined && treeCount === 1;
  const probeIterations = banking
    ? Math.min(
        bankingAvailable,
        Math.max(
          params.time.minIterations,
          Math.round(scaledIterations! * params.time.probeFraction),
        ),
      )
    : undefined;
  const limits = {
    iterations: probeIterations ?? scaledIterations,
    deadline: startedAt + plan.budgetMs,
    progressEvery: 64,
  };

  const outcomes: V12SearchResult[] = [];
  const chunk = 64;
  for (let tree = 0; tree < searches.length; tree += 1) {
    const activeSearch = searches[tree];
    let treeIterations = scaledIterations === undefined
      ? undefined
      : Math.floor(scaledIterations / treeCount) + (tree < scaledIterations % treeCount ? 1 : 0);
    if (banking) treeIterations = probeIterations;
    const treeLimits = { ...limits, iterations: treeIterations };
    let deadline = treeCount === 1
      ? startedAt + plan.probeMs
      : performance.now() + plan.budgetMs / treeCount;
    let probed = treeCount > 1;
    let iterationProbed = !banking;
    for (;;) {
      const running = activeSearch.advance(position, chunk, { ...treeLimits, deadline });
      if (!running) {
        if (!iterationProbed) {
          iterationProbed = true;
          const snapshot = activeSearch.result();
          const best = snapshot.ranked[0]?.value ?? 0.5;
          const second = snapshot.ranked[1]?.value ?? best;
          treeLimits.iterations = iterationsAfterProbe(
            params,
            bankingAvailable!,
            activeSearch.iterationCount,
            best,
            second,
          );
          if (treeLimits.iterations > activeSearch.iterationCount) {
            continue;
          }
        }
        if (probed || options.iterationBudget !== undefined) {
          break;
        }
        // End of probe: re-read the root spread and decide how much of the rest to spend (§6.1).
        probed = true;
        const snapshot = activeSearch.result();
        const best = snapshot.ranked[0]?.value ?? 0.5;
        const second = snapshot.ranked[1]?.value ?? best;
        deadline = startedAt + budgetAfterProbe(params, plan, best, second);
        if (deadline <= performance.now()) {
          break;
        }
        continue;
      }
      const completedIterations = outcomes.reduce((sum, item) => sum + item.iterations, 0);
      await emit(onProgress, {
        phase: 'searching',
        percent: Math.min(
          98,
          10 + ((performance.now() - startedAt) / Math.max(1, plan.budgetMs)) * 88,
        ),
        iterations: completedIterations + activeSearch.iterationCount,
        maxIterations: options.iterationBudget ?? 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        timeLimitMs,
        candidates,
        currentBestLabel: moveLabel(
          activeSearch.currentBest >= 0 ? toPlaceMove(activeSearch.currentBest, rootPlayer) : null,
        ),
      });
    }
    outcomes.push(activeSearch.result());
  }

  const outcome = outcomes.length === 1 ? outcomes[0] : poolRootVisits(outcomes);
  if (scaledIterations !== undefined) {
    budgetDiagnostics.searches += 1;
    budgetDiagnostics.allocated += scaledIterations;
    budgetDiagnostics.spent += outcome.iterations;
    const slot = Math.min(20, Math.max(0, ownMoves));
    budgetDiagnostics.allocatedByMove[slot] += scaledIterations;
    budgetDiagnostics.spentByMove[slot] += outcome.iterations;
  }
  if (banking) {
    iterationBanks.set(bankKey, Math.max(0, bankingAvailable! - outcome.iterations));
  }
  // Diagnostic: demote the search's own top choice on the earliest own moves, to ask whether the
  // opening has any headroom. Reordering the ranked list rather than picking one move keeps the
  // harness's opening sampling meaningful.
  const rankOffset = params.search.openingRankOffset ?? 0;
  const rankOffsetMax = params.search.openingRankOffsetMaxOwnMove ?? 0;
  const rankOffsetMin = params.search.openingRankOffsetMinOwnMove ?? 0;
  if (
    rankOffset > 0 &&
    rankOffsetMax > 0 &&
    ownMoves >= rankOffsetMin &&
    ownMoves < rankOffsetMax &&
    outcome.ranked.length > rankOffset
  ) {
    const promoted = outcome.ranked.splice(rankOffset, 1)[0];
    outcome.ranked.unshift(promoted);
  }

  const scale = params.search.sigmoidScale;
  let rankedMoves: RankedMove[] = outcome.ranked.map((entry) => ({
    move: toPlaceMove(entry.move, rootPlayer),
    visits: entry.visits,
    winRate: entry.value,
    // Back on the squares scale the quality thresholds were written for.
    value: entry.visits > 0 ? logit(entry.value) * scale : -scale,
  }));
  rankedMoves = auditRoot(state, rootPlayer, rankedMoves, params, outcome.phase);

  const best = rankedMoves[0] ?? null;
  const second = rankedMoves[1];
  const confidence =
    best && second && best.visits + second.visits > 0
      ? Math.min(
          1,
          Math.abs(best.value - second.value) / 8 + best.visits / (best.visits + second.visits),
        )
      : 0.5;

  await emit(onProgress, {
    phase: 'done',
    percent: 100,
    iterations: outcome.iterations,
    maxIterations: options.iterationBudget ?? outcome.iterations,
    elapsedMs: Math.round(performance.now() - startedAt),
    timeLimitMs,
    candidates,
    currentBestLabel: moveLabel(best?.move ?? null),
  });

  return {
    bestMove: best?.move ?? null,
    rankedMoves,
    confidence,
  };
}

/**
 * Tree-free ranking: every root move is applied and scored with the full E_i evaluation, which is
 * "V_i(m) = Δ own(m) + Σ λ_j Δ harm_j(m)" evaluated literally.
 *
 * This is the v12 counterpart of the repo's `greedy` policy, and it exists for the same reason: it
 * isolates the evaluation from the search, so `npm run match --policy greedy` measures one and not
 * the other. Routing a v12 config through the *legacy* greedy ranker instead would quietly measure
 * v11's evaluation under a v12 label.
 */
export async function rankMovesGreedyV12(
  state: GameState,
  rootPlayer: PlayerColor,
  params: BitboardParams = DEFAULT_BITBOARD_PARAMS,
  limit = 48,
): Promise<SearchResult> {
  const position = toPosition(state);
  const seat = seatOf(rootPlayer);
  if (position.turn !== seat) {
    position.forceTurn(seat);
  }

  const moves = newMoveBuffer();
  const count = position.generateMoves(seat, moves);
  if (count === 0) {
    return { bestMove: null, rankedMoves: [], confidence: 0 };
  }

  context.fractionalTies = params.fractionalTerritoryTies;
  refreshContext(context, position, false);
  const phase = detectPhase(position, context, params, seat);
  const scores = new Float64Array(count);
  const ordering = params.ordering[phase];
  for (let i = 0; i < count; i += 1) {
    scores[i] =
      PLACEMENTS.size[moves[i]] * ordering.pieceSize -
      PLACEMENTS.centreDistance[moves[i]] * ordering.centrePull;
  }
  sortByScore(moves, scores, count);
  const shortlist = Math.min(count, limit);

  const orderer = new MoveOrderer(params);
  const scratch = createEvalContext();
  // `deepScore` evaluates every candidate through this context, so it has to carry the same
  // territory rule as the one the baseline was measured with — otherwise a config flag that only
  // reaches the baseline cancels out of `E_after − E_before` and reads as a perfect null.
  scratch.fractionalTies = params.fractionalTerritoryTies;
  const before = evaluate(context, position, params, phase)[seat];

  // With a learned evaluation configured, score each candidate by asking the network directly.
  // This is the most on-distribution use it has: the training rows *are* candidate children of a
  // root, so a greedy match here measures the evaluation with the tree taken out of the comparison.
  const net = netFor(params.search.netPath);
  const useNet = net !== null && params.search.netBlend >= 1;
  const netInput = useNet ? new Float32Array(FEATURE_COUNT) : null;

  const ranked: RankedMove[] = [];
  for (let i = 0; i < shortlist; i += 1) {
    const id = moves[i];
    let value: number;
    if (useNet && net && netInput) {
      const undo = position.apply(id);
      refreshContext(scratch, position, false);
      writeFeatures(netInput, 0, position, scratch, seat);
      value = forward(net, netInput)[0];
      position.undo(undo);
    } else {
      value = orderer.deepScore(position, scratch, seat, id, phase, before);
    }
    ranked.push({ move: toPlaceMove(id, rootPlayer), visits: 1, winRate: 0, value });
  }
  ranked.sort((a, b) => b.value - a.value);

  const gap = ranked.length > 1 ? Math.abs(ranked[0].value - ranked[1].value) : 0;
  return {
    bestMove: ranked[0].move,
    rankedMoves: ranked,
    confidence: Math.min(0.85, 0.35 + gap / 20),
  };
}

/**
 * Score a *given* set of moves at one ply, in `E_i` units.
 *
 * `rankMovesGreedyV12` generates and shortlists its own candidates; the committee needs the same
 * evaluation applied to a set someone else chose, so the two share the scoring and not the
 * selection. The returned numbers are `E_after − E_before` for the mover — comparable within one
 * call and meaningless across calls, which is why the committee combines *ranks* rather than values.
 *
 * A move the placement table does not know scores `-Infinity` rather than throwing: the committee
 * must never be able to turn a legal search result into a crash.
 */
export function scoreMovesV12(
  state: GameState,
  rootPlayer: PlayerColor,
  params: BitboardParams,
  moves: readonly PlaceMove[],
): number[] {
  if (moves.length === 0) {
    return [];
  }
  const position = toPosition(state);
  const seat = seatOf(rootPlayer);
  if (position.turn !== seat) {
    position.forceTurn(seat);
  }

  context.fractionalTies = params.fractionalTerritoryTies;
  refreshContext(context, position, false);
  const phase = detectPhase(position, context, params, seat);

  const orderer = new MoveOrderer(params);
  const scratch = createEvalContext();
  // Same reason as in `rankMovesGreedyV12`: `deepScore` evaluates candidates through this context,
  // so a territory flag that only reaches the baseline cancels out of `E_after − E_before` and
  // reads as a perfect null.
  scratch.fractionalTies = params.fractionalTerritoryTies;
  const before = evaluate(context, position, params, phase)[seat];

  const net = netFor(params.search.netPath);
  const useNet = net !== null && params.search.netBlend >= 1;
  const netInput = useNet ? new Float32Array(FEATURE_COUNT) : null;

  return moves.map((move) => {
    const id = placementFor(move);
    if (id < 0) {
      return Number.NEGATIVE_INFINITY;
    }
    if (useNet && net && netInput) {
      const undo = position.apply(id);
      refreshContext(scratch, position, false);
      writeFeatures(netInput, 0, position, scratch, seat);
      // `forward` returns the net's own reused buffer, so read the value out before the next call.
      const value = forward(net, netInput)[0];
      position.undo(undo);
      return value;
    }
    return orderer.deepScore(position, scratch, seat, id, phase, before);
  });
}

export { colorOf, placementFor, seatOf, toPosition, toPlaceMove };
export { DEFAULT_BITBOARD_PARAMS } from './config';
export type { BitboardParams } from './config';
