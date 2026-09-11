import { applyMove, calculateScores, generateLegalMoves, moveKey } from '../engine/game';
import { evaluateMovePrior, evaluateState } from './heuristics';
import type { GameState, PlaceMove, PlayerColor } from '../engine/types';
import { PLAYER_COLORS } from '../engine/types';
import { PIECES } from '../engine/pieces';
import type { ProgressCallback, SearchProgress } from './progress';
import { estimateMoveWinRate } from './winOdds';
import {
  setActiveLegalMoveCache,
  storeRankedMoves,
  syncActiveLegalMoveCache,
} from './legalMoveCache';
import type { RankedMove, SearchResult, SearchOptions } from './searchTypes';
import { random, randomInt } from './rng';
import {
  DEFAULT_ALGO_VERSION,
  getAlgo,
  bitboardParamsFor,
  type AlgoVersionId,
  type ResolvedAlgoConfig,
} from './algoVersions';
import { solveSealedEndgame } from './endgame';
import { rankMovesGreedyV12, searchBestMoveV12 } from './bitboard';
import { rankMovesGreedyCommittee, searchBestMoveCommittee } from './committee';
import { searchBestMoveOracle } from './oracle/oneLap';

export type { RankedMove, SearchResult };

interface MCTSNode {
  state: GameState;
  move: PlaceMove | null;
  parent: MCTSNode | null;
  children: MCTSNode[];
  untriedMoves: PlaceMove[];
  /** Prior probability of each untried move, popped in step with `untriedMoves`. */
  untriedPriors: number[];
  /** Prior of the move that created this node — the P(a) term in PUCT. */
  prior: number;
  visits: number;
  value: number;
}

const ROLLOUT_MOVE_CAP = 12;
const ROLLOUT_MOVE_CAP_LIGHT = 8;
const ROOT_MOVE_CAP = 36;
const CHILD_MOVE_CAP = 16;
const GREEDY_MOVE_CAP = 80;
const GREEDY_SAMPLE = 24;
const PROGRESS_MIN_GAP_MS = 150;

let lastEmitAt = 0;
let lastEmitPhase: SearchProgress['phase'] | null = null;

function quickMoveScore(state: GameState, move: PlaceMove): number {
  const size = PIECES[move.pieceId].size;
  const piecesLeft = state.remainingPieces[move.color]?.length ?? 21;
  const center = 9.5;
  const avgDist =
    move.absoluteCells.reduce(
      (sum, cell) => sum + Math.abs(cell.x - center) + Math.abs(cell.y - center),
      0,
    ) / move.absoluteCells.length;
  const sizeWeight = piecesLeft >= 12 ? 5 : piecesLeft >= 6 ? 3 : 1.5;
  return size * sizeWeight - avgDist * 0.25;
}

function moveLabel(move: PlaceMove | null | undefined): string | undefined {
  if (!move) {
    return undefined;
  }
  return `${PIECES[move.pieceId].name} @ (${move.anchor.x},${move.anchor.y})`;
}

function capByQuickScore(state: GameState, moves: PlaceMove[], cap: number): PlaceMove[] {
  if (moves.length <= cap) {
    return moves;
  }
  return moves
    .map((move) => ({ move, score: quickMoveScore(state, move) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((entry) => entry.move);
}

interface ScoredMoves {
  moves: PlaceMove[];
  scores: number[];
}

/** Ascending order so `expand` pops the most promising move first. */
function orderByPrior(state: GameState, moves: PlaceMove[], version: AlgoVersionId): ScoredMoves {
  const scored = moves
    .map((move) => ({
      move,
      score: evaluateMovePrior(state, move, true, version) + quickMoveScore(state, move) * 0.05,
    }))
    .sort((a, b) => a.score - b.score);
  return {
    moves: scored.map((entry) => entry.move),
    scores: scored.map((entry) => entry.score),
  };
}

function orderByQuickScore(state: GameState, moves: PlaceMove[]): ScoredMoves {
  const scored = moves
    .map((move) => ({ move, score: quickMoveScore(state, move) }))
    .sort((a, b) => a.score - b.score);
  return {
    moves: scored.map((entry) => entry.move),
    scores: scored.map((entry) => entry.score),
  };
}

/**
 * Softmax over heuristic scores, standing in for AlphaZero's policy head. Only PUCT reads these;
 * UCB1 versions keep a uniform prior so their behaviour is unchanged.
 */
function toPriors(scores: number[], temperature: number): number[] {
  if (scores.length === 0) {
    return [];
  }
  const max = Math.max(...scores);
  const temp = Math.max(1e-6, temperature);
  const exps = scores.map((score) => Math.exp((score - max) / temp));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function resultFromRanked(rankedMoves: RankedMove[]): SearchResult {
  const sorted = [...rankedMoves].sort((a, b) => b.value - a.value);
  const best = sorted[0];
  const second = sorted[1];
  const confidence = best
    ? second
      ? Math.min(0.85, 0.35 + Math.abs(best.value - second.value) / 20)
      : 0.5
    : 0;
  return {
    bestMove: best?.move ?? null,
    rankedMoves: sorted,
    confidence,
  };
}

/** Put `move` at the head of an existing ranked list (adding it if the shortlist missed it). */
function promoteMove(rankedMoves: RankedMove[], move: PlaceMove): RankedMove[] {
  const key = moveKey(move);
  const existing = rankedMoves.find((entry) => moveKey(entry.move) === key);
  const rest = rankedMoves.filter((entry) => moveKey(entry.move) !== key);
  return [existing ?? { move, visits: 1, winRate: 0, value: 0 }, ...rest];
}

async function emit(
  onProgress: ProgressCallback | undefined,
  partial: Omit<SearchProgress, 'elapsedMs'> & { startedAt: number },
): Promise<void> {
  if (!onProgress) {
    return;
  }
  const force =
    partial.phase === 'done' ||
    partial.phase === 'starting' ||
    partial.phase !== lastEmitPhase;
  const now = performance.now();
  if (!force && now - lastEmitAt < PROGRESS_MIN_GAP_MS) {
    return;
  }
  lastEmitAt = now;
  lastEmitPhase = partial.phase;
  await onProgress({
    phase: partial.phase,
    percent: Math.max(0, Math.min(100, partial.percent)),
    iterations: partial.iterations,
    maxIterations: partial.maxIterations,
    elapsedMs: Math.round(now - partial.startedAt),
    timeLimitMs: partial.timeLimitMs,
    candidates: partial.candidates,
    currentBestLabel: partial.currentBestLabel,
  });
}

function createNode(
  state: GameState,
  move: PlaceMove | null,
  parent: MCTSNode | null,
  config: ResolvedAlgoConfig,
  prior: number,
  rootCandidates?: PlaceMove[],
): MCTSNode {
  const isRoot = !parent;
  const cap = isRoot ? ROOT_MOVE_CAP : CHILD_MOVE_CAP;
  const source =
    isRoot && rootCandidates && rootCandidates.length > 0
      ? rootCandidates
      : generateLegalMoves(state, state.currentTurn, cap * 3);
  const shortlist = capByQuickScore(state, source, cap);
  // Heuristic ordering pays off at the root; deeper nodes need the search budget instead.
  const ordered = isRoot
    ? orderByPrior(state, shortlist, config.id)
    : orderByQuickScore(state, shortlist);

  return {
    state,
    move,
    parent,
    children: [],
    untriedMoves: ordered.moves,
    untriedPriors:
      config.selection === 'puct'
        ? toPriors(ordered.scores, config.priorTemp)
        : ordered.moves.map(() => 1 / Math.max(1, ordered.moves.length)),
    prior,
    visits: 0,
    value: 0,
  };
}

function selectChild(node: MCTSNode, config: ResolvedAlgoConfig): MCTSNode {
  let best: MCTSNode | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const puct = config.selection === 'puct';
  const sqrtParent = puct ? Math.sqrt(node.visits) : 0;

  for (const child of node.children) {
    let score: number;
    if (puct) {
      // AlphaZero's PUCT with the heuristic prior in place of a policy network.
      const exploitation = child.visits > 0 ? child.value / child.visits : 0;
      score = exploitation + config.puctC * child.prior * (sqrtParent / (1 + child.visits));
    } else {
      if (child.visits === 0) {
        return child;
      }
      const exploitation = child.value / child.visits;
      score = exploitation + config.exploration * Math.sqrt(Math.log(node.visits) / child.visits);
    }
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  return best ?? node.children[0];
}

/**
 * How many children this node is allowed to have opened so far. Without widening the answer is
 * "all of them", which is what every pre-v10 version did: with ~36 root moves and a few hundred
 * iterations that leaves each child too few visits for its mean to mean anything.
 */
function allowedChildren(node: MCTSNode, config: ResolvedAlgoConfig): number {
  const widening = config.rootWidening;
  if (!widening || node.parent) {
    return Number.POSITIVE_INFINITY;
  }
  return widening.initial + widening.growth * Math.sqrt(node.visits);
}

/**
 * Rollouts must stay cheap: their value comes from volume, so this only ranks by the
 * arithmetic-only score and keeps a slice of randomness for exploration.
 */
function pickRolloutMove(state: GameState, moves: PlaceMove[], light: boolean): PlaceMove {
  if (moves.length === 1) {
    return moves[0];
  }
  if (random() < (light ? 0.2 : 0.3)) {
    return moves[randomInt(moves.length)];
  }
  const topN = Math.min(light ? 2 : 3, moves.length);
  const shortlist = capByQuickScore(state, moves, topN);
  return shortlist[randomInt(shortlist.length)];
}

/**
 * Rollouts are truncated long before the game ends, so the raw score gap is a biased
 * signal. Blending in the positional evaluation and squashing to [-1, 1] keeps the UCB
 * exploration term meaningful against the exploitation term.
 */
function rolloutValue(
  state: GameState,
  rootPlayer: PlayerColor,
  config: ResolvedAlgoConfig,
): number {
  const scores = calculateScores(state);
  const rootScore = scores.find((entry) => entry.color === rootPlayer)?.score ?? 0;
  const opponentMean =
    scores
      .filter((entry) => entry.color !== rootPlayer)
      .reduce((sum, entry) => sum + entry.score, 0) / 3;
  const material = Math.tanh((rootScore - opponentMean) / config.materialScale);
  if (state.finished) {
    return material;
  }
  const positional = Math.tanh(
    evaluateState(state, rootPlayer, true, config.id) / config.positionalScale,
  );
  return material * config.materialBlend + positional * (1 - config.materialBlend);
}

function rollout(
  state: GameState,
  rootPlayer: PlayerColor,
  deadline: number,
  light: boolean,
  config: ResolvedAlgoConfig,
): number {
  let current = state;
  let passes = 0;
  let steps = 0;
  const maxSteps = light ? config.rolloutStepsLight : config.rolloutSteps;
  const moveCap = light ? ROLLOUT_MOVE_CAP_LIGHT : ROLLOUT_MOVE_CAP;

  while (!current.finished && passes < PLAYER_COLORS.length && steps < maxSteps) {
    if (performance.now() >= deadline) {
      break;
    }
    const moves = generateLegalMoves(current, current.currentTurn, moveCap);
    if (moves.length === 0) {
      current = applyMove(current, { type: 'pass', color: current.currentTurn });
      passes += 1;
      steps += 1;
      continue;
    }

    passes = 0;
    current = applyMove(current, pickRolloutMove(current, moves, light));
    steps += 1;
  }

  return rolloutValue(current, rootPlayer, config);
}

/** Value of a freshly expanded leaf: a truncated playout, the static eval, or the mean of both. */
function leafValue(
  node: MCTSNode,
  rootPlayer: PlayerColor,
  deadline: number,
  light: boolean,
  config: ResolvedAlgoConfig,
): number {
  if (config.leafValue === 'eval') {
    return rolloutValue(node.state, rootPlayer, config);
  }
  const played = rollout(node.state, rootPlayer, deadline, light, config);
  if (config.leafValue === 'rollout') {
    return played;
  }
  return (played + rolloutValue(node.state, rootPlayer, config)) / 2;
}

function expand(node: MCTSNode, config: ResolvedAlgoConfig): MCTSNode {
  const move = node.untriedMoves.pop();
  const prior = node.untriedPriors.pop() ?? 0;
  if (!move) {
    return node;
  }
  const childState = applyMove(node.state, move);
  const child = createNode(childState, move, node, config, prior);
  node.children.push(child);
  return child;
}

function backpropagate(node: MCTSNode, value: number): void {
  let current: MCTSNode | null = node;
  while (current) {
    current.visits += 1;
    current.value += value;
    current = current.parent;
  }
}

function bestChildMove(root: MCTSNode, selectByVisits: boolean): PlaceMove | null {
  if (root.children.length === 0) {
    return null;
  }
  return (
    [...root.children].sort((a, b) => {
      if (selectByVisits && a.visits !== b.visits) {
        return b.visits - a.visits;
      }
      const av = a.visits > 0 ? a.value / a.visits : Number.NEGATIVE_INFINITY;
      const bv = b.visits > 0 ? b.value / b.visits : Number.NEGATIVE_INFINITY;
      return bv - av;
    })[0]?.move ?? null
  );
}

/** Re-rank a shortlist by Monte Carlo win rate so suggestions match the odds bar. */
function preferHigherWinRate(
  state: GameState,
  rankedMoves: RankedMove[],
  simulations: number,
): RankedMove[] {
  if (rankedMoves.length === 0) {
    return rankedMoves;
  }

  const shortlist = rankedMoves.slice(0, Math.min(4, rankedMoves.length)).map((entry) => ({
    ...entry,
    winRate: estimateMoveWinRate(state, entry.move, simulations),
  }));
  shortlist.sort((a, b) => b.winRate - a.winRate || b.value - a.value);

  const chosenKeys = new Set(shortlist.map((entry) => moveKey(entry.move)));
  const rest = rankedMoves.filter((entry) => !chosenKeys.has(moveKey(entry.move)));
  return [...shortlist, ...rest];
}

export async function rankMovesGreedy(
  state: GameState,
  rootPlayer: PlayerColor,
  onProgress?: ProgressCallback,
  timeLimitMs = 800,
  candidateMoves?: PlaceMove[],
  isCancelled?: () => boolean,
  version: AlgoVersionId = DEFAULT_ALGO_VERSION,
): Promise<SearchResult> {
  const startedAt = performance.now();
  // The v12 engine has its own evaluation; routing its configs through this ranker would measure
  // v11's evaluation under a v12 label, which is exactly the confound `--policy greedy` exists to
  // avoid.
  const greedyConfig = getAlgo(version);
  if (greedyConfig.engine === 'oracle' && greedyConfig.oracle) {
    return rankMovesGreedy(
      state,
      rootPlayer,
      onProgress,
      timeLimitMs,
      candidateMoves,
      isCancelled,
      greedyConfig.oracle.baseVersion,
    );
  }
  if (greedyConfig.engine === 'committee' && greedyConfig.committee) {
    return rankMovesGreedyCommittee(state, rootPlayer, greedyConfig.committee, candidateMoves);
  }
  if (greedyConfig.engine === 'bitboard') {
    return rankMovesGreedyV12(state, rootPlayer, bitboardParamsFor(greedyConfig));
  }
  await emit(onProgress, {
    phase: 'starting',
    percent: 1,
    iterations: 0,
    maxIterations: 1,
    timeLimitMs,
    candidates: 0,
    startedAt,
  });
  await emit(onProgress, {
    phase: 'generating',
    percent: 4,
    iterations: 0,
    maxIterations: 1,
    timeLimitMs,
    candidates: 0,
    startedAt,
  });

  const source =
    candidateMoves ??
    syncActiveLegalMoveCache(state, rootPlayer, GREEDY_MOVE_CAP * 3, version).moves;
  const legalMoves = capByQuickScore(state, source, GREEDY_MOVE_CAP);
  await emit(onProgress, {
    phase: 'generating',
    percent: 18,
    iterations: 0,
    maxIterations: 1,
    timeLimitMs,
    candidates: legalMoves.length,
    startedAt,
  });

  if (legalMoves.length === 0) {
    await emit(onProgress, {
      phase: 'done',
      percent: 100,
      iterations: 0,
      maxIterations: 0,
      timeLimitMs,
      candidates: 0,
      startedAt,
    });
    return { bestMove: null, rankedMoves: [], confidence: 0 };
  }

  const sample = capByQuickScore(state, legalMoves, GREEDY_SAMPLE);

  const rankedMoves: RankedMove[] = [];
  for (let i = 0; i < sample.length; i += 1) {
    if (isCancelled?.()) {
      break;
    }
    const move = sample[i];
    const prior = quickMoveScore(state, move);
    const value = evaluateMovePrior(state, move, true, version) + prior * 0.05;
    rankedMoves.push({ move, visits: 1, winRate: 0, value });

    if (i % 4 === 0 || i === sample.length - 1) {
      rankedMoves.sort((a, b) => b.value - a.value);
      await emit(onProgress, {
        phase: 'ranking',
        percent: 20 + ((i + 1) / sample.length) * 30,
        iterations: i + 1,
        maxIterations: sample.length,
        timeLimitMs,
        candidates: legalMoves.length,
        currentBestLabel: moveLabel(rankedMoves[0]?.move),
        startedAt,
      });
    }
  }

  rankedMoves.sort((a, b) => b.value - a.value);
  return resultFromRanked(rankedMoves);
}

export async function searchBestMove(
  state: GameState,
  rootPlayer: PlayerColor,
  timeLimitMs: number,
  onProgress?: ProgressCallback,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const lightRollouts = options.lightRollouts ?? false;
  const skipWinOdds = options.skipWinOddsRefinement ?? false;
  const version = options.version ?? DEFAULT_ALGO_VERSION;
  const config = getAlgo(version);
  if (config.engine === 'oracle' && config.oracle) {
    return searchBestMoveOracle(
      state,
      rootPlayer,
      timeLimitMs,
      config.oracle,
      options.oracle,
      onProgress,
      options,
      config.id,
    );
  }
  // v3.5 sits *above* an engine rather than beside one: it delegates the whole search to its
  // primary at that primary's full budget, then re-ranks only the root children the search left
  // tied. With `band: 0` no set is ever contested, so this returns the primary's result untouched.
  if (config.engine === 'committee' && config.committee) {
    return searchBestMoveCommittee(state, rootPlayer, timeLimitMs, config.committee, onProgress, {
      iterationBudget: options.iterationBudget,
    });
  }
  // The whole v12 engine hangs off this one branch: same signature, same SearchResult, different
  // board representation, evaluation, tree and endgame solver.
  if (config.engine === 'bitboard') {
    return searchBestMoveV12(
      state,
      rootPlayer,
      timeLimitMs,
      bitboardParamsFor(config),
      onProgress,
      { iterationBudget: options.iterationBudget, engineKey: config.id },
    );
  }
  const startedAt = performance.now();
  const cache = syncActiveLegalMoveCache(state, rootPlayer, undefined, version);

  let greedy: SearchResult;
  if (cache.rankedMoves.length > 0) {
    greedy = resultFromRanked(cache.rankedMoves);
    await emit(onProgress, {
      phase: 'starting',
      percent: 20,
      iterations: greedy.rankedMoves.length,
      maxIterations: greedy.rankedMoves.length,
      timeLimitMs,
      candidates: cache.moves.length,
      currentBestLabel: moveLabel(greedy.bestMove),
      startedAt,
    });
  } else {
    greedy = await rankMovesGreedy(
      state,
      rootPlayer,
      onProgress,
      timeLimitMs,
      cache.moves,
      undefined,
      version,
    );
    setActiveLegalMoveCache(storeRankedMoves(cache, greedy.rankedMoves, version));
  }

  if (!greedy.bestMove || timeLimitMs <= 900) {
    await emit(onProgress, {
      phase: 'done',
      percent: 100,
      iterations: greedy.rankedMoves.length,
      maxIterations: greedy.rankedMoves.length,
      timeLimitMs,
      candidates: greedy.rankedMoves.length,
      currentBestLabel: moveLabel(greedy.bestMove),
      startedAt,
    });
    return greedy;
  }

  const remainingMs = Math.max(200, timeLimitMs - (performance.now() - startedAt));
  const deadline = performance.now() + remainingMs;
  // Under an iteration budget nothing may be cut short by the clock, or the same budget would give
  // different answers on a busy machine. A generous safety net still stops a pathological run.
  const iterationBudget = options.iterationBudget;
  const workDeadline = iterationBudget === undefined ? deadline : performance.now() + 60_000;

  // A sealed region is not a game any more — pack it exactly instead of sampling it.
  if (config.endgame) {
    const plan = solveSealedEndgame(state, rootPlayer, config.endgame, workDeadline, cache.moves);
    if (plan && plan.moves.length > 0) {
      const chosen = plan.moves[0];
      const ranked = promoteMove(greedy.rankedMoves, chosen);
      await emit(onProgress, {
        phase: 'done',
        percent: 100,
        iterations: plan.nodes,
        maxIterations: config.endgame.nodeBudget,
        timeLimitMs,
        candidates: ranked.length,
        currentBestLabel: moveLabel(chosen),
        startedAt,
      });
      return { bestMove: chosen, rankedMoves: ranked, confidence: plan.proven ? 1 : 0.7 };
    }
  }

  const root = createNode(state, null, null, config, 1, cache.moves);
  let iterations = 0;
  // Generous ceiling: the deadline should be what stops the search, not this cap.
  // Equal-compute comparisons: a config whose iterations cost more runs proportionally fewer.
  const scaledBudget =
    options.iterationBudget === undefined
      ? undefined
      : Math.max(1, Math.round(options.iterationBudget * config.iterationScale));
  const maxIterations = scaledBudget ?? Math.max(400, Math.floor(remainingMs * 2));

  await emit(onProgress, {
    phase: 'searching',
    percent: 55,
    iterations: 0,
    maxIterations,
    timeLimitMs,
    candidates: root.untriedMoves.length,
    currentBestLabel: moveLabel(greedy.bestMove),
    startedAt,
  });

  // With an iteration budget the wall clock only acts as a safety net, so a run is reproducible
  // and comparable across machines and parallel workers.
  while (
    iterations < maxIterations &&
    (iterationBudget !== undefined || performance.now() < deadline)
  ) {
    iterations += 1;
    let node = root;
    for (;;) {
      if (node.untriedMoves.length > 0 && node.children.length < allowedChildren(node, config)) {
        node = expand(node, config);
        break;
      }
      if (node.children.length === 0) {
        break;
      }
      node = selectChild(node, config);
    }
    const value = leafValue(node, rootPlayer, workDeadline, lightRollouts, config);
    backpropagate(node, value);

    if (iterations === 1 || iterations % 20 === 0 || performance.now() >= deadline) {
      const timeRatio = (performance.now() - (deadline - remainingMs)) / remainingMs;
      await emit(onProgress, {
        phase: 'searching',
        percent: 55 + Math.min(44, timeRatio * 44),
        iterations,
        maxIterations,
        timeLimitMs,
        candidates: root.children.length + root.untriedMoves.length,
        currentBestLabel: moveLabel(bestChildMove(root, config.selectByVisits) ?? greedy.bestMove),
        startedAt,
      });
    }
  }

  const rankedMoves: RankedMove[] = root.children
    .map((child) => ({
      move: child.move!,
      visits: child.visits,
      winRate: child.visits > 0 ? child.value / child.visits : 0,
      value:
        child.visits > 0
          ? (child.value / child.visits) * config.materialScale
          : quickMoveScore(state, child.move!),
    }))
    .sort((a, b) => {
      if (config.selectByVisits && a.visits !== b.visits) {
        return b.visits - a.visits;
      }
      return b.value - a.value;
    });

  if (rankedMoves.length === 0) {
    await emit(onProgress, {
      phase: 'done',
      percent: 100,
      iterations,
      maxIterations,
      timeLimitMs,
      candidates: greedy.rankedMoves.length,
      currentBestLabel: moveLabel(greedy.bestMove),
      startedAt,
    });
    return greedy;
  }

  const remainingForOdds = deadline - performance.now();
  const refined =
    skipWinOdds || remainingForOdds <= 400
      ? rankedMoves
      : preferHigherWinRate(state, rankedMoves, remainingForOdds > 1200 ? 20 : 10);
  const best = refined[0];
  const second = refined[1];
  const confidence =
    second && best.visits + second.visits > 0
      ? Math.min(
          1,
          Math.abs(best.value - second.value) / 8 + best.visits / (best.visits + second.visits),
        )
      : 0.5;

  setActiveLegalMoveCache(
    storeRankedMoves(syncActiveLegalMoveCache(state, rootPlayer, undefined, version), refined, version),
  );

  await emit(onProgress, {
    phase: 'done',
    percent: 100,
    iterations,
    maxIterations,
    timeLimitMs,
    candidates: refined.length,
    currentBestLabel: moveLabel(best.move),
    startedAt,
  });

  return {
    bestMove: best.move,
    rankedMoves: refined,
    confidence,
  };
}

/** Greedy-rank the player's legal set even when it is not their turn. */
export async function ponderNextMove(
  state: GameState,
  rootPlayer: PlayerColor,
  timeLimitMs: number,
  onProgress?: ProgressCallback,
  isCancelled?: () => boolean,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const version = options.version ?? DEFAULT_ALGO_VERSION;
  const cache = syncActiveLegalMoveCache(state, rootPlayer, 400, version);
  const greedy = await rankMovesGreedy(
    state,
    rootPlayer,
    onProgress,
    Math.min(timeLimitMs, 900),
    cache.moves,
    isCancelled,
    version,
  );
  if (isCancelled?.()) {
    return greedy;
  }
  setActiveLegalMoveCache(
    storeRankedMoves(
      syncActiveLegalMoveCache(state, rootPlayer, undefined, version),
      greedy.rankedMoves,
      version,
    ),
  );
  return greedy;
}

export async function analyzeBeforeMove(
  state: GameState,
  rootPlayer: PlayerColor,
  timeLimitMs: number,
  onProgress?: ProgressCallback,
  options: SearchOptions = {},
): Promise<SearchResult> {
  if (state.currentTurn !== rootPlayer) {
    return { bestMove: null, rankedMoves: [], confidence: 0 };
  }
  return searchBestMove(state, rootPlayer, timeLimitMs, onProgress, options);
}

export function getMoveValue(rankedMoves: RankedMove[], move: PlaceMove): number {
  const key = moveKey(move);
  const found = rankedMoves.find((entry) => moveKey(entry.move) === key);
  return found?.value ?? Number.NEGATIVE_INFINITY;
}
