/**
 * Multi-player MCTS with a max^n vector backup (§2.2, §6 Layer 2).
 *
 * Every node carries a four-component value vector and the seat to move selects on its own
 * component. That is the least-wrong model of three independent opponents; paranoid and BRS are
 * available as alternative *selection policies at opponent nodes*, switched by §5's rule (paranoid
 * when leading, because that is when opponents really do coalesce).
 *
 * Structure notes:
 *
 * - One working `Position` is walked down and undone on the way back up, so nodes hold statistics
 *   and move lists but never a board. A 400-bit board per node would dominate memory long before
 *   the tree ran out of useful depth.
 * - Nodes are looked up by Zobrist hash, so transpositions share statistics — the search graph is a
 *   DAG (Childs et al.; Saffidine et al.). The exploration term uses the *edge's* visit count while
 *   exploitation uses the shared node's mean, which is the UCD reading of the two.
 * - A seat with no legal move is settled out of the position when the node is first built, and the
 *   result is cached on the node, so re-entering costs O(1) instead of a regeneration.
 * - Move lists are funnelled: generate everything, rank cheaply, then spend the expensive ordering
 *   (created corners, denied corners, Δsplit) on the survivors only.
 */

import { newMoveBuffer, type Position, type Undo } from './position';
import { PIECE_COUNT, PLACEMENTS } from './placements';
import { WORDS, intersectsAt, newMask, orInto } from './bitboard';
import { SEAT_COUNT } from './seats';
import { forward, netFor, type Net } from './net';
import {
  pooledPolicyNetFor,
  preparePooledPosition,
  scorePooledPlacement,
  type PooledPolicyNet,
} from './spatialNet';
import { FEATURE_COUNT, writeFeatures } from './netFeatures';
import { LEAF_FEATURE_COUNT, writeLeafFeatures } from './leafNetFeatures';
import {
  POLICY_FEATURE_COUNT,
  writePolicyFeatures,
} from './policyFeatures';
import {
  POLICY_V2_FEATURE_COUNT,
  writePolicyFeaturesV2,
} from './policyFeaturesV2';
import {
  createEvalContext,
  detectPhase,
  evaluate,
  refreshContext,
  type EvalContext,
} from './features';
import {
  HistoryTable,
  MoveOrderer,
  softmaxPriors,
  sortByScore,
} from './ordering';
import { Playout, createOutcome, type PlayoutOutcome } from './playout';
import { candidatePieceFeasibility } from './pieceFeasibility';
import {
  marginValue,
  objectiveBlend,
  valueVector,
  valueVectorFromMeanMargins,
} from './backup';
import { isSealed } from './territory';
import { solveSealedRegion, type PackResult } from './packer';
import type { PhaseId, BitboardParams } from './config';
import { createRng, type Rng } from '../rng';

export interface SearchLimits {
  /** Exact iteration count. Reproducible; what tournaments and the tuner use. */
  iterations?: number;
  /** Wall-clock deadline in `performance.now()` units. Ignored when `iterations` is set. */
  deadline?: number;
  /** Called every `progressEvery` iterations with the current best move. */
  onProgress?: (iterations: number, bestMove: number) => void;
  progressEvery?: number;
  /**
   * Research-only observation of terminal rollouts at the actual expanded-leaf distribution.
   * Arrays are owned copies and may be retained by the caller. Absent in production, this adds no
   * feature extraction or allocation to the hot path.
   */
  onLeafSample?: (sample: LeafSample) => void;
}

export interface LeafSample {
  /** Leaf state before the rollout. An owned clone, provided only under instrumentation. */
  position: Position;
  features: Float32Array;
  scores: Float64Array;
  rootSeat: number;
  phase: PhaseId;
  terminal: boolean;
}

export interface RankedPlacement {
  move: number;
  visits: number;
  /** Root seat's mean value in [0, 1]. */
  value: number;
  prior: number;
}

export interface V12SearchResult {
  best: number;
  ranked: RankedPlacement[];
  iterations: number;
  /** Set when the root value came from the exact packer rather than from sampling. */
  proven: boolean;
  phase: PhaseId;
}

class Node {
  hashLo = 0;
  hashHi = 0;
  turn = 0;
  visits = 0;
  values = new Float64Array(SEAT_COUNT);
  valueSquares = new Float64Array(SEAT_COUNT);
  /** Separately backed-up static heuristic vector for implicit max^n guidance. */
  implicitValues = new Float64Array(SEAT_COUNT);
  implicitReady = false;

  moves: Int32Array | null = null;
  priors: Float64Array | null = null;
  /** Whether `priors` include a learned policy rather than only hand ordering. */
  learnedPrior = false;
  moveCount = 0;
  opened = 0;
  children: Array<Node | null> = [];
  childVisits: Int32Array | null = null;
  /** Piece-level all-moves-as-first statistics, allocated only for RAVE candidates. */
  amafVisits: Int32Array | null = null;
  amafValues: Float64Array | null = null;
  /** Spatial group per root move; populated only by the experimental hierarchical selector. */
  groups: Int8Array | null = null;
  /** Interior nodes use a narrower shortlist; a reused descendant must be promoted once. */
  initialisedAsRoot = false;

  /** Seats settled out when this node was built, and the seat that ends up on move. */
  settled = false;
  settledOutMask = 0;
  settledTurn = 0;

  terminal = false;
  /** Proven value vector, from the exact packer when every seat is sealed. */
  proven: Float64Array | null = null;
}

const scratchMoves = newMoveBuffer();
const scratchScores = new Float64Array(scratchMoves.length);

function normal(rng: Rng): number {
  // Box-Muller with a strict lower bound so log(0) is impossible.
  const u1 = Math.max(Number.EPSILON, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Membership stamps for the reserved funnel, so a move cannot be admitted twice. */
const inclusionStamp = new Int32Array(PLACEMENTS.count);
let inclusionGeneration = 0;

/** Placement centroid bucket on a 4×4 grid; related destinations share root evidence. */
function spatialGroup(move: number): number {
  let x = 0;
  let y = 0;
  const start = PLACEMENTS.cellStart[move];
  const end = PLACEMENTS.cellStart[move + 1];
  for (let i = start; i < end; i += 1) {
    const cell = PLACEMENTS.cellList[i];
    x += cell % 20;
    y += Math.floor(cell / 20);
  }
  const count = Math.max(1, end - start);
  return Math.min(3, Math.floor(x / count / 5)) + 4 * Math.min(3, Math.floor(y / count / 5));
}

/** Bounded top-k selection: n log k with no allocation, unlike sorting a 2,000-move list. */
function topK(
  moves: Int32Array,
  scores: Float64Array,
  count: number,
  k: number,
  outMoves: Int32Array,
  outScores: Float64Array,
): number {
  const kept = Math.min(k, count);
  for (let i = 0; i < kept; i += 1) {
    outMoves[i] = moves[i];
    outScores[i] = scores[i];
  }
  if (kept === count) {
    return kept;
  }
  let minIndex = 0;
  for (let i = 1; i < kept; i += 1) {
    if (outScores[i] < outScores[minIndex]) {
      minIndex = i;
    }
  }
  for (let i = kept; i < count; i += 1) {
    if (scores[i] <= outScores[minIndex]) {
      continue;
    }
    outMoves[minIndex] = moves[i];
    outScores[minIndex] = scores[i];
    minIndex = 0;
    for (let j = 1; j < kept; j += 1) {
      if (outScores[j] < outScores[minIndex]) {
        minIndex = j;
      }
    }
  }
  return kept;
}

export class V12Search {
  private table = new Map<number, Node[]>();
  private context: EvalContext = createEvalContext();
  private playoutContext: EvalContext = createEvalContext();
  private orderer: MoveOrderer;
  private playout: Playout;
  private history = new HistoryTable();
  private outcome: PlayoutOutcome = createOutcome();

  private leafValues = new Float64Array(SEAT_COUNT);
  private netValues = new Float64Array(SEAT_COUNT);
  private netVector = new Float64Array(SEAT_COUNT);
  private jointNoise = new Float64Array(SEAT_COUNT);
  private priorContext = createEvalContext();
  private netInput = new Float32Array(Math.max(POLICY_V2_FEATURE_COUNT, LEAF_FEATURE_COUNT));
  private netPriors = new Float64Array(64);
  private policyParentFeatures = new Float32Array(FEATURE_COUNT);
  private groupVisits = new Int32Array(PIECE_COUNT);
  private groupValues = new Float64Array(PIECE_COUNT);
  private groupPriors = new Float64Array(PIECE_COUNT);
  private feasibilityCounts = new Int32Array(PIECE_COUNT);
  private feasibilityScores = new Float64Array(64);
  private diversityMoves = new Int32Array(64);
  private diversityScores = new Float64Array(64);
  private amafSeen = new Uint8Array(PIECE_COUNT);
  private net: Net | null = null;
  private pooledNet: PooledPolicyNet | null = null;
  private leafScores = new Float64Array(SEAT_COUNT);
  private materialValues = new Float64Array(SEAT_COUNT);
  private sealedFlags = new Uint8Array(SEAT_COUNT);
  private sealedSquares = new Int32Array(SEAT_COUNT);
  private sealedScore = new Float64Array(SEAT_COUNT);

  private denyScratch = newMask();
  private pathNodes: Node[] = [];
  private pathEdges: number[] = [];
  private pathUndos: Undo[] = [];

  private root: Node | null = null;
  private iterations = 0;
  private rootSeat = 0;
  private phase: PhaseId = 'midgame';
  private paranoid = false;
  private rankBlend = 0;
  private lastPhase: PhaseId | null = null;
  private reusedVisits = 0;
  private reusedChildren = 0;
  private leafObserver: SearchLimits['onLeafSample'];

  private iterationBudget = Number.POSITIVE_INFINITY;
  private halvingActive: number[] | null = null;
  private halvingStageStart: Int32Array | null = null;
  private halvingQuota = 0;
  private halvingRoundsLeft = 0;

  private generateBuffers: Int32Array[] = [];
  private scoreBuffers: Float64Array[] = [];

  private params: BitboardParams;

  constructor(params: BitboardParams) {
    this.params = params;
    this.net = netFor(params.search.netPath);
    this.pooledNet = pooledPolicyNetFor(params.search.pooledNetPath);
    this.orderer = new MoveOrderer(params);
    this.playout = new Playout(params);
    this.context.fractionalTies = params.fractionalTerritoryTies;
    this.playoutContext.fractionalTies = params.fractionalTerritoryTies;
  }

  setParams(params: BitboardParams): void {
    this.params = params;
    this.net = netFor(params.search.netPath);
    this.pooledNet = pooledPolicyNetFor(params.search.pooledNetPath);
    // A config that asks for a learned evaluation and does not get one would quietly play the
    // hand-written one and report the result under the wrong version's name. That exact failure —
    // configs silently falling through to another engine after a rename — already invalidated a
    // day of measurements here, so it is a hard error rather than a warning.
    const needsNet =
      params.search.netPath &&
      (params.search.netBlend > 0 || params.search.netPrior || params.search.netTailPrefix > 0);
    if (needsNet && this.net === null) {
      throw new Error(
        `search asked for the learned evaluation at "${params.search.netPath}" but no weights are ` +
          'registered; run `npm run train-v4` or call preloadNets() before playing',
      );
    }
    if (params.search.pooledNetPath && params.search.netPrior && this.pooledNet === null) {
      throw new Error(
        `search asked for the pooled policy at "${params.search.pooledNetPath}" but no weights ` +
          'are registered; call preloadNets() before playing',
      );
    }
    this.orderer.setParams(params);
    this.playout.setParams(params);
    this.context.fractionalTies = params.fractionalTerritoryTies;
    this.playoutContext.fractionalTies = params.fractionalTerritoryTies;
  }

  /** Between moves the tree is discarded; the history table is not, by design. */
  reset(): void {
    this.table.clear();
  }

  clearHistory(): void {
    this.history.clear();
    this.playout.resetLearning();
  }

  /**
   * Sets the tree up for one move and returns the number of root candidates (0 means the seat has
   * nothing to play). Split from {@link advance} so the caller can yield to the event loop between
   * chunks — the browser worker has to report progress, and a single synchronous multi-second call
   * would freeze the UI thread's message pump.
   */
  prepare(position: Position, rootSeat: number): number {
    this.rootSeat = rootSeat;
    refreshContext(this.context, position, true);
    const nextPhase = detectPhase(position, this.context, this.params, rootSeat);
    const canReuse =
      this.params.search.treeReuse &&
      this.params.search.transpositions &&
      this.lastPhase === nextPhase;
    if (!canReuse) {
      this.table.clear();
    }
    // Progressive history is cleared per move rather than carried across the game. Carrying it
    // would make a search depend on which games ran before it in the same worker process, and the
    // measurement protocol in ALGORITHMS.md rests on a seed reproducing a game exactly.
    this.history.clear();
    if (this.params.search.playoutMastLifetime === 'root') {
      this.playout.resetLearning();
    }
    this.phase = nextPhase;
    this.lastPhase = nextPhase;

    // §5: the objective blend and the opponent model both key off how far ahead we are.
    position.scores(this.leafScores);
    let bestOther = -Infinity;
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      if (seat !== rootSeat && this.leafScores[seat] > bestOther) {
        bestOther = this.leafScores[seat];
      }
    }
    const lead = this.leafScores[rootSeat] - bestOther;
    this.rankBlend = objectiveBlend(
      this.params.search.rankBlend,
      lead,
      this.params.search.objectiveShift,
    );
    const policy = this.params.search.opponentPolicy;
    this.paranoid =
      policy === 'paranoid' || (policy === 'auto' && lead >= this.params.search.paranoidLead);

    const reused = canReuse ? this.findNode(position) : null;
    this.reusedVisits = reused?.visits ?? 0;
    this.reusedChildren = reused?.opened ?? 0;
    const root = reused ?? this.nodeFor(position);
    this.initialiseNode(root, position, true);
    this.root = root;
    this.iterations = 0;
    this.iterationBudget = Number.POSITIVE_INFINITY;
    this.halvingActive = null;
    this.halvingStageStart = null;
    this.halvingQuota = 0;
    this.halvingRoundsLeft = 0;
    return root.moveCount;
  }

  /**
   * Runs up to `chunk` iterations. Returns false once the search is finished — budget exhausted,
   * deadline passed, or the root decision can no longer change.
   */
  advance(position: Position, chunk: number, limits: SearchLimits): boolean {
    const root = this.root;
    if (!root || root.moveCount === 0) {
      return false;
    }
    const iterationBudget = limits.iterations ?? Number.POSITIVE_INFINITY;
    this.iterationBudget = iterationBudget;
    const deadline = limits.deadline ?? Number.POSITIVE_INFINITY;
    const useClock = limits.iterations === undefined;
    this.leafObserver = limits.onLeafSample;

    for (let step = 0; step < chunk; step += 1) {
      if (this.iterations >= iterationBudget) {
        return false;
      }
      if (useClock && performance.now() >= deadline) {
        return false;
      }
      this.iterate(root, position);
      this.iterations += 1;
    }

    if (
      this.params.search.rootPolicy === 'puct' &&
      this.params.time.earlyExit &&
      this.iterations >= this.params.time.minIterations &&
      this.decided(root, iterationBudget - this.iterations)
    ) {
      return false;
    }
    return true;
  }

  result(): V12SearchResult {
    const root = this.root;
    if (!root || root.moveCount === 0) {
      return { best: -1, ranked: [], iterations: this.iterations, proven: false, phase: this.phase };
    }
    return {
      best: this.bestMove(root),
      ranked: this.rankRoot(root),
      iterations: this.iterations,
      proven: root.proven !== null,
      phase: this.phase,
    };
  }

  /** Convenience wrapper for callers that do not need to yield (tests, scripts, self-play). */
  run(position: Position, rootSeat: number, limits: SearchLimits): V12SearchResult {
    if (this.prepare(position, rootSeat) === 0) {
      return this.result();
    }
    const chunk = limits.progressEvery ?? 64;
    while (this.advance(position, chunk, limits)) {
      limits.onProgress?.(this.iterations, this.bestMove(this.root!));
    }
    return this.result();
  }

  get iterationCount(): number {
    return this.iterations;
  }

  get currentBest(): number {
    return this.root ? this.bestMove(this.root) : -1;
  }

  get reusedRootVisits(): number {
    return this.reusedVisits;
  }

  get reusedRootChildren(): number {
    return this.reusedChildren;
  }

  /* --- Tree ------------------------------------------------------------------------------- */

  private nodeFor(position: Position): Node {
    if (!this.params.search.transpositions) {
      const fresh = new Node();
      fresh.hashLo = position.hashLo;
      fresh.hashHi = position.hashHi;
      fresh.turn = position.turn;
      return fresh;
    }
    const bucket = this.table.get(position.hashLo);
    if (bucket) {
      for (const node of bucket) {
        if (node.hashHi === position.hashHi) {
          return node;
        }
      }
      const created = new Node();
      created.hashLo = position.hashLo;
      created.hashHi = position.hashHi;
      created.turn = position.turn;
      bucket.push(created);
      return created;
    }
    const created = new Node();
    created.hashLo = position.hashLo;
    created.hashHi = position.hashHi;
    created.turn = position.turn;
    this.table.set(position.hashLo, [created]);
    return created;
  }

  private findNode(position: Position): Node | null {
    const bucket = this.table.get(position.hashLo);
    if (!bucket) return null;
    for (const node of bucket) {
      if (node.hashHi === position.hashHi) return node;
    }
    return null;
  }

  /**
   * Settles seats that cannot move out of the position, then builds and orders the move list. The
   * settle result is cached because re-entering this node from another path must reproduce it
   * exactly, and regenerating to discover "this seat is out" costs a full generation.
   */
  private initialiseNode(node: Node, position: Position, isRoot: boolean): void {
    this.enterNode(node, position);
    if (isRoot && node.moves !== null && !node.initialisedAsRoot && !node.terminal) {
      this.promoteToRoot(node, position);
      return;
    }
    if (node.moves !== null || node.terminal) {
      return;
    }

    const depth = this.pathNodes.length;
    const buffer = this.buffer(depth);
    const scores = this.scores(depth);
    const seat = position.turn;
    const count = position.generateMoves(seat, buffer);
    if (count === 0) {
      node.terminal = true;
      node.moves = new Int32Array(0);
      node.moveCount = 0;
      return;
    }

    // Tier 1: O(1) per move, just to cut the list down to something the real ordering can afford.
    const ordering = this.params.ordering[this.phase];
    for (let i = 0; i < count; i += 1) {
      const move = buffer[i];
      scores[i] =
        PLACEMENTS.size[move] * ordering.pieceSize -
        PLACEMENTS.centreDistance[move] * ordering.centrePull;
    }
    const funnel = isRoot
      ? Math.max(this.params.search.rootShortlist * 2, 96)
      : Math.max(this.params.search.nodeShortlist * 2, 48);

    const withSplit = isRoot || this.params.search.splitAtInterior;
    const reserve = this.params.search.funnelReserve;
    // One board pass, before the funnel: the reserve needs the articulation map to decide what the
    // cheap filter is not allowed to throw away.
    refreshContext(this.context, position, withSplit || reserve > 0);

    const kept =
      reserve > 0
        ? this.reservedTopK(buffer, scores, count, funnel, reserve, seat)
        : topK(buffer, scores, count, funnel, scratchMoves, scratchScores);

    // Tier 2: the real ordering heuristic, including Δsplit for moves that cut a region.
    this.orderer.scoreMoves(
      position,
      this.context,
      seat,
      scratchMoves,
      kept,
      scratchScores,
      this.phase,
      {
        withSplit,
        splitBudget: isRoot ? 24 : this.params.search.interiorSplitBudget,
      },
    );
    sortByScore(scratchMoves, scratchScores, kept);

    const shortlist = Math.min(
      kept,
      isRoot ? this.params.search.rootShortlist : this.params.search.nodeShortlist,
    );
    const feasibilityWeight = isRoot ? this.params.search.rootPieceFeasibilityWeight : 0;
    if (feasibilityWeight !== 0 && shortlist > 1) {
      const moves = this.buffer(depth + 1);
      let mean = 0;
      for (let index = 0; index < shortlist; index += 1) {
        const value = candidatePieceFeasibility(
          position,
          seat,
          scratchMoves[index],
          moves,
          this.feasibilityCounts,
        );
        this.feasibilityScores[index] = value;
        mean += value;
      }
      mean /= shortlist;
      let variance = 0;
      for (let index = 0; index < shortlist; index += 1) {
        const delta = this.feasibilityScores[index] - mean;
        variance += delta * delta;
      }
      const scale = Math.sqrt(variance / shortlist);
      if (scale > 1e-9) {
        for (let index = 0; index < shortlist; index += 1) {
          scratchScores[index] +=
            feasibilityWeight * (this.feasibilityScores[index] - mean) / scale;
        }
      }
    }
    if (isRoot && this.params.search.rootPieceDiversity && shortlist > 1) {
      this.interleavePieces(scratchMoves, scratchScores, shortlist);
    }
    node.moves = scratchMoves.slice(0, shortlist);
    node.moveCount = shortlist;
    node.priors = new Float64Array(shortlist);
    node.learnedPrior = false;
    softmaxPriors(
      scratchScores.slice(0, shortlist),
      shortlist,
      this.params.search.priorTemp,
      node.priors,
    );
    // The network's own training objective, applied where it belongs. Root-only: the shortlist is
    // ~48 moves and each costs one territory pass plus one forward pass, about 5 ms once per move —
    // whereas doing this at every interior node would cost more than the entire search budget.
    if (
      (this.net !== null || this.pooledNet !== null) &&
      this.params.search.netPrior &&
      isRoot &&
      (this.params.search.netPriorPhase === 'all' ||
        (this.params.search.netPriorPhase === 'endgame' && this.phase === 'endgame') ||
        (this.params.search.netPriorPhase === 'openingMidgame' && this.phase !== 'endgame'))
    ) {
      const priorScores = this.scores(depth);
      writeFeatures(this.policyParentFeatures, 0, position, this.context, seat);
      if (this.pooledNet !== null) preparePooledPosition(this.pooledNet, position, seat);
      for (let i = 0; i < shortlist; i += 1) {
        const undo = position.apply(node.moves[i]);
        refreshContext(this.priorContext, position, false);
        if (this.pooledNet !== null || this.net?.featureCount === POLICY_V2_FEATURE_COUNT) {
          writePolicyFeaturesV2(
            this.netInput,
            position,
            this.priorContext,
            seat,
            node.moves[i],
            this.policyParentFeatures,
          );
        } else if (this.net?.featureCount === POLICY_FEATURE_COUNT) {
          writePolicyFeatures(
            this.netInput,
            position,
            this.priorContext,
            seat,
            node.moves[i],
            this.policyParentFeatures,
          );
        } else if (this.net?.featureCount === FEATURE_COUNT) {
          writeFeatures(this.netInput, 0, position, this.priorContext, seat);
        } else {
          throw new Error(`unsupported policy network input width ${this.net?.featureCount}`);
        }
        priorScores[i] = this.pooledNet
          ? scorePooledPlacement(this.pooledNet, node.moves[i], seat, this.netInput)
          : forward(this.net!, this.netInput)[0];
        position.undo(undo);
      }
      softmaxPriors(priorScores, shortlist, this.params.search.netPriorTemp, this.netPriors);
      const blend = Math.min(1, Math.max(0, this.params.search.netPriorBlend));
      for (let i = 0; i < shortlist; i += 1) {
        node.priors[i] = (1 - blend) * node.priors[i] + blend * this.netPriors[i];
      }
      node.learnedPrior = true;
    }

    if (isRoot && this.params.search.rootGrouping !== 'none') {
      node.groups = new Int8Array(shortlist);
      for (let i = 0; i < shortlist; i += 1) {
        node.groups[i] = this.params.search.rootGrouping === 'piece'
          ? PLACEMENTS.pieceId[node.moves[i]]
          : spatialGroup(node.moves[i]);
      }
    }

    node.children = new Array(shortlist).fill(null);
    node.childVisits = new Int32Array(shortlist);
    if (this.params.search.raveEquivalence > 0) {
      node.amafVisits = new Int32Array(PIECE_COUNT);
      node.amafValues = new Float64Array(PIECE_COUNT * SEAT_COUNT);
    }
    node.opened = 0;
    node.initialisedAsRoot = isRoot;
  }

  /** Keep each move's prior score, but make progressive widening see piece families first. */
  private interleavePieces(moves: Int32Array, scores: Float64Array, count: number): void {
    const seen = new Uint8Array(PIECE_COUNT);
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      const piece = PLACEMENTS.pieceId[moves[index]];
      if (seen[piece] === 0) {
        seen[piece] = 1;
        this.diversityMoves[cursor] = moves[index];
        this.diversityScores[cursor] = scores[index];
        cursor += 1;
      }
    }
    for (let index = 0; index < count; index += 1) {
      const move = moves[index];
      let first = true;
      for (let before = 0; before < index; before += 1) {
        if (PLACEMENTS.pieceId[moves[before]] === PLACEMENTS.pieceId[move]) {
          first = false;
          break;
        }
      }
      if (!first) {
        this.diversityMoves[cursor] = move;
        this.diversityScores[cursor] = scores[index];
        cursor += 1;
      }
    }
    moves.set(this.diversityMoves.subarray(0, count), 0);
    scores.set(this.diversityScores.subarray(0, count), 0);
  }

  /** Rebuild an interior shortlist at root width while keeping statistics for surviving moves. */
  private promoteToRoot(node: Node, position: Position): void {
    const oldMoves = node.moves!;
    const oldChildren = node.children;
    const oldVisits = node.childVisits!;
    const oldOpened = node.opened;

    node.moves = null;
    node.priors = null;
    node.moveCount = 0;
    node.opened = 0;
    node.children = [];
    node.childVisits = null;
    node.groups = null;
    this.initialiseNode(node, position, true);

    const freshMoves = node.moves!;
    const freshPriors = node.priors!;
    const freshGroups = node.groups;
    const freshCount = node.moveCount;
    const used = new Uint8Array(freshCount);
    const order = new Int32Array(freshCount);
    const reusedOld = new Int32Array(freshCount).fill(-1);
    let cursor = 0;

    for (let oldIndex = 0; oldIndex < oldOpened; oldIndex += 1) {
      for (let freshIndex = 0; freshIndex < freshCount; freshIndex += 1) {
        if (used[freshIndex] === 0 && freshMoves[freshIndex] === oldMoves[oldIndex]) {
          used[freshIndex] = 1;
          order[cursor] = freshIndex;
          reusedOld[cursor] = oldIndex;
          cursor += 1;
          break;
        }
      }
    }
    const reused = cursor;
    for (let freshIndex = 0; freshIndex < freshCount; freshIndex += 1) {
      if (used[freshIndex] === 0) order[cursor++] = freshIndex;
    }

    const moves = new Int32Array(freshCount);
    const priors = new Float64Array(freshCount);
    const children: Array<Node | null> = new Array(freshCount).fill(null);
    const childVisits = new Int32Array(freshCount);
    const groups = freshGroups ? new Int8Array(freshCount) : null;
    for (let index = 0; index < freshCount; index += 1) {
      const source = order[index];
      moves[index] = freshMoves[source];
      priors[index] = freshPriors[source];
      if (groups && freshGroups) groups[index] = freshGroups[source];
      const oldIndex = reusedOld[index];
      if (oldIndex >= 0) {
        children[index] = oldChildren[oldIndex];
        childVisits[index] = oldVisits[oldIndex];
      }
    }
    node.moves = moves;
    node.priors = priors;
    node.children = children;
    node.childVisits = childVisits;
    node.groups = groups;
    node.opened = reused;
    node.initialisedAsRoot = true;
  }

  /**
   * `topK` by the cheap score, but with `reserve` slots held back for moves the cheap score would
   * delete and the real ordering exists to judge: those covering an articulation point, and those
   * covering an opponent's open corner.
   *
   * This is the fix for the report's blind spot. §3.1 says Δsplit "is what makes the search look at
   * cut moves at all when they otherwise place a small piece" — but a first-stage filter of
   * `piece size − centre distance` removes small-piece cut moves *before* Δsplit is ever computed,
   * so the heuristic only ever scores candidates that did not need it. Reserved moves are not
   * promoted; they are merely allowed to compete on the real ordering.
   */
  private reservedTopK(
    moves: Int32Array,
    scores: Float64Array,
    count: number,
    funnel: number,
    reserve: number,
    seat: number,
  ): number {
    const base = Math.max(1, funnel - reserve);
    let kept = topK(moves, scores, count, base, scratchMoves, scratchScores);

    // One combined mask, so testing "does this deny anybody" is a single early-exit intersection.
    const denyMask = this.denyScratch;
    denyMask.fill(0);
    for (let other = 0; other < SEAT_COUNT; other += 1) {
      if (other !== seat) {
        orInto(denyMask, this.context.territory.openCorners[other]);
      }
    }

    inclusionGeneration += 1;
    for (let i = 0; i < kept; i += 1) {
      inclusionStamp[scratchMoves[i]] = inclusionGeneration;
    }

    const articulation = this.context.articulation;
    const hasArticulation = this.context.hasArticulation;
    let added = 0;
    for (let i = 0; i < count && added < reserve; i += 1) {
      const move = moves[i];
      if (inclusionStamp[move] === inclusionGeneration) {
        continue;
      }
      let interesting = false;
      if (hasArticulation) {
        for (let c = PLACEMENTS.cellStart[move]; c < PLACEMENTS.cellStart[move + 1]; c += 1) {
          if (articulation[PLACEMENTS.cellList[c]] === 1) {
            interesting = true;
            break;
          }
        }
      }
      if (!interesting && intersectsAt(denyMask, PLACEMENTS.cells, move * WORDS)) {
        interesting = true;
      }
      if (!interesting) {
        continue;
      }
      inclusionStamp[move] = inclusionGeneration;
      scratchMoves[kept] = move;
      scratchScores[kept] = scores[i];
      kept += 1;
      added += 1;
    }

    return kept;
  }

  /** Applies (or replays) the settle step this node was built with. */
  private enterNode(node: Node, position: Position): void {
    if (node.settled) {
      position.setOutMask(node.settledOutMask);
      position.forceTurn(node.settledTurn);
      return;
    }
    let guard = 0;
    while (!position.finished && guard < SEAT_COUNT) {
      if (position.hasMove(position.turn)) {
        break;
      }
      position.markOut(position.turn);
      position.advanceTurn();
      guard += 1;
    }
    node.settled = true;
    node.settledOutMask = position.getOutMask();
    node.settledTurn = position.turn;
    node.turn = position.turn;
    if (position.finished) {
      node.terminal = true;
      node.moves = new Int32Array(0);
      node.moveCount = 0;
    }
  }

  private buffer(depth: number): Int32Array {
    while (this.generateBuffers.length <= depth) {
      this.generateBuffers.push(newMoveBuffer());
    }
    return this.generateBuffers[depth];
  }

  private scores(depth: number): Float64Array {
    while (this.scoreBuffers.length <= depth) {
      this.scoreBuffers.push(new Float64Array(scratchMoves.length));
    }
    return this.scoreBuffers[depth];
  }

  private allowedChildren(node: Node): number {
    const { wideningInit, wideningGrowth, wideningAllNodes } = this.params.search;
    if (!wideningAllNodes && node !== this.pathRoot) {
      return node.moveCount;
    }
    return Math.min(node.moveCount, Math.floor(wideningInit + wideningGrowth * Math.sqrt(node.visits)));
  }

  private pathRoot: Node | null = null;

  private iterate(root: Node, position: Position): void {
    this.pathNodes.length = 0;
    this.pathEdges.length = 0;
    this.pathUndos.length = 0;
    this.pathRoot = root;

    let node = root;
    let leaf = root;

    for (;;) {
      if (node.terminal || node.proven !== null) {
        leaf = node;
        break;
      }
      if (node.moves === null) {
        this.initialiseNode(node, position, node === root);
        if (node.terminal) {
          leaf = node;
          break;
        }
      }

      const index = this.select(node);
      if (index < 0) {
        leaf = node;
        break;
      }

      this.pathNodes.push(node);
      this.pathEdges.push(index);
      const move = node.moves![index];
      this.pathUndos.push(position.apply(move));
      if (this.brsSkip(position)) {
        // BRS-style turn skip: the immediate threat replies and the root player moves again.
        position.forceTurn(this.rootSeat);
      }

      const existing = node.children[index];
      if (existing === null) {
        const child = this.nodeFor(position);
        node.children[index] = child;
        this.enterNode(child, position);
        leaf = child;
        break;
      }
      node = existing;
    }

    this.seedImplicit(leaf, position);
    this.playout.clearTrace();
    const value = this.leafValue(leaf, position);
    if (leaf.proven !== null) {
      leaf.implicitValues.set(value);
      leaf.implicitReady = true;
    }
    this.backup(value);

    for (let i = this.pathUndos.length - 1; i >= 0; i -= 1) {
      position.undo(this.pathUndos[i]);
    }
  }

  /**
   * Best Reply Search, in the only form that keeps its point. Schadd & Winands take the single most
   * damaging move across *all* opponents; generating three opponents' move lists at every node
   * would cost more than the depth it buys, so this takes the immediate threat — the seat that
   * moves next — and returns the turn to the root player. The illegal-sequence artefact is the same
   * one the report calls mild for Blokus: skipping a turn does not violate the geometry.
   */
  private brsSkip(position: Position): boolean {
    return (
      this.params.search.opponentPolicy === 'brs' &&
      position.turn !== this.rootSeat &&
      !position.finished &&
      position.out[this.rootSeat] === 0
    );
  }

  private select(node: Node): number {
    if (node === this.pathRoot && this.params.search.rootPolicy === 'sequentialHalving') {
      return this.selectSequentialHalving(node);
    }
    if (node === this.pathRoot && this.params.search.rootGrouping !== 'none') {
      return this.selectGroupedRoot(node);
    }
    const allowed = this.allowedChildren(node);
    if (node.opened < allowed && node.opened < node.moveCount) {
      const index = node.opened;
      node.opened += 1;
      return index;
    }
    if (node.opened === 0) {
      return -1;
    }

    const seat = node.turn;
    const component = this.paranoid ? this.rootSeat : seat;
    const invert = this.paranoid && seat !== this.rootSeat;
    const { cPuct, historyWeight, implicitMaxnWeight } = this.params.search;
    const sqrtVisits = Math.sqrt(Math.max(1, node.visits));
    const parentMean = node.visits > 0 ? node.values[component] / node.visits : 0.5;

    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < node.opened; index += 1) {
      const child = node.children[index];
      const edgeVisits = node.childVisits![index];
      let q: number;
      if (child === null || child.visits === 0) {
        // First-play urgency: an unexplored sibling inherits the parent's own estimate.
        q = (invert ? 1 - parentMean : parentMean) - this.params.search.fpuReduction;
      } else {
        const mean = child.values[component] / child.visits;
        q = invert ? 1 - mean : mean;
      }
      if (implicitMaxnWeight > 0 && child?.implicitReady) {
        const implicit = invert
          ? 1 - child.implicitValues[component]
          : child.implicitValues[component];
        q = (1 - implicitMaxnWeight) * q + implicitMaxnWeight * implicit;
      }
      const raveEquivalence = this.params.search.raveEquivalence;
      if (raveEquivalence > 0 && node.amafVisits && node.amafValues) {
        const piece = PLACEMENTS.pieceId[node.moves![index]];
        const amafVisits = node.amafVisits[piece];
        if (amafVisits > 0) {
          const amafMean = node.amafValues[piece * SEAT_COUNT + component] / amafVisits;
          const amaf = invert ? 1 - amafMean : amafMean;
          const beta = raveEquivalence / (raveEquivalence + edgeVisits);
          q = (1 - beta) * q + beta * amaf;
        }
      }
      let uncertainty = 1;
      if (
        this.params.search.varianceTuned &&
        (!this.params.search.varianceTunedRootOnly || node === this.pathRoot) &&
        child &&
        child.visits > 1
      ) {
        const mean = child.values[component] / child.visits;
        const variance = Math.max(0, child.valueSquares[component] / child.visits - mean * mean);
        const tuned = Math.min(
          0.25,
          variance + Math.sqrt((2 * Math.log(Math.max(2, node.visits))) / child.visits),
        );
        uncertainty = Math.sqrt(tuned / 0.25);
      }
      const u = uncertainty * cPuct * node.priors![index] * (sqrtVisits / (1 + edgeVisits));
      const h =
        historyWeight === 0
          ? 0
          : (historyWeight * this.history.score(seat, node.moves![index])) / (1 + edgeVisits);
      const score = q + u + h;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  /** Two-stage PUCT: first select a spatial/piece family, then a placement inside it. */
  private selectGroupedRoot(root: Node): number {
    const allowed = this.allowedChildren(root);
    if (root.opened < allowed && root.opened < root.moveCount) {
      const index = root.opened;
      root.opened += 1;
      return index;
    }
    if (root.opened === 0 || !root.groups) {
      return -1;
    }

    const visits = this.groupVisits;
    const values = this.groupValues;
    const priors = this.groupPriors;
    visits.fill(0);
    values.fill(0);
    priors.fill(0);
    for (let index = 0; index < root.opened; index += 1) {
      const group = root.groups[index];
      const edgeVisits = root.childVisits![index];
      visits[group] += edgeVisits;
      priors[group] += root.priors![index];
      const child = root.children[index];
      if (child && child.visits > 0) {
        values[group] += edgeVisits * (child.values[this.rootSeat] / child.visits);
      }
    }

    const parentMean = root.visits > 0 ? root.values[this.rootSeat] / root.visits : 0.5;
    const sqrtRoot = Math.sqrt(Math.max(1, root.visits));
    const c = this.params.search.cPuct;
    let selectedGroup = -1;
    let groupScore = -Infinity;
    for (let group = 0; group < priors.length; group += 1) {
      if (priors[group] <= 0) continue;
      const q = visits[group] > 0 ? values[group] / visits[group] : parentMean;
      const score = q + c * priors[group] * (sqrtRoot / (1 + visits[group]));
      if (score > groupScore) {
        groupScore = score;
        selectedGroup = group;
      }
    }

    const sqrtGroup = Math.sqrt(Math.max(1, visits[selectedGroup]));
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < root.opened; index += 1) {
      if (root.groups[index] !== selectedGroup) continue;
      const child = root.children[index];
      const edgeVisits = root.childVisits![index];
      const q = child && child.visits > 0
        ? child.values[this.rootSeat] / child.visits
        : parentMean;
      const withinPrior = root.priors![index] / Math.max(1e-12, priors[selectedGroup]);
      const u = c * withinPrior * (sqrtGroup / (1 + edgeVisits));
      const score = q + u;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  /** Deterministic root Sequential Halving (Cazenave, 2020), with PUCT retained below root. */
  private selectSequentialHalving(root: Node): number {
    if (this.halvingActive === null) {
      this.halvingActive = Array.from({ length: root.moveCount }, (_, index) => index);
      this.halvingRoundsLeft = Math.max(1, Math.ceil(Math.log2(root.moveCount)));
      root.opened = root.moveCount;
      this.startHalvingStage(root);
    }

    for (;;) {
      const active: number[] | null = this.halvingActive;
      if (!active || active.length === 0) {
        return -1;
      }
      if (active.length === 1) {
        return active[0];
      }

      let selected = -1;
      let least = Number.POSITIVE_INFINITY;
      for (const index of active) {
        const spent = root.childVisits![index] - this.halvingStageStart![index];
        if (spent < this.halvingQuota && spent < least) {
          least = spent;
          selected = index;
        }
      }
      if (selected >= 0) {
        return selected;
      }

      active.sort((a, b) => {
        const childA = root.children[a];
        const childB = root.children[b];
        const valueA = childA && childA.visits > 0
          ? childA.values[this.rootSeat] / childA.visits
          : -Infinity;
        const valueB = childB && childB.visits > 0
          ? childB.values[this.rootSeat] / childB.visits
          : -Infinity;
        return valueB - valueA || root.priors![b] - root.priors![a] || a - b;
      });
      this.halvingActive = active.slice(0, Math.ceil(active.length / 2));
      this.halvingRoundsLeft = Math.max(1, this.halvingRoundsLeft - 1);
      this.startHalvingStage(root);
    }
  }

  private startHalvingStage(root: Node): void {
    const active = this.halvingActive!;
    const remaining = Number.isFinite(this.iterationBudget)
      ? Math.max(1, this.iterationBudget - this.iterations)
      : active.length;
    this.halvingQuota = Math.max(
      1,
      Math.floor(remaining / Math.max(1, this.halvingRoundsLeft * active.length)),
    );
    this.halvingStageStart = new Int32Array(root.moveCount);
    this.halvingStageStart.set(root.childVisits!);
  }

  /** Seed a node's implicit vector with the same static E used at truncated leaves. */
  private seedImplicit(node: Node, position: Position): void {
    if (this.params.search.implicitMaxnWeight <= 0 || node.implicitReady) {
      return;
    }
    refreshContext(this.context, position, false);
    const scores = evaluate(this.context, position, this.params, this.phase);
    valueVector(
      scores,
      this.params.search.evalScale,
      this.rankBlend,
      node.implicitValues,
      this.params.search.opponentAggregation,
    );
    node.implicitReady = true;
  }

  /* --- Leaf evaluation --------------------------------------------------------------------- */

  /**
   * §6: "at expansion, if the child state contains any region no opponent can enter (for any
   * player, not only the agent), do not run a playout for that region; call the exact solver, cache
   * the result, and back up its proven value as that player's component of the score vector."
   *
   * A truncated playout reports E_i, not squares, so a proven final score cannot simply be spliced
   * into the vector — the two are not in the same units. A sealed seat's future is fully determined,
   * so its component is instead written on the E scale as `squares · (final squares + bonuses)`,
   * which is exactly what E would report if the packing had already happened.
   */
  private leafValue(node: Node, position: Position): Float64Array {
    if (node.proven !== null) {
      return node.proven;
    }
    if (node.terminal || position.finished) {
      position.scores(this.leafScores);
      const value = valueVector(
        this.leafScores,
        this.params.search.sigmoidScale,
        this.rankBlend,
        this.leafValues,
      );
      node.proven = value.slice();
      return node.proven;
    }

    this.sealedFlags.fill(0);
    let sealedCount = 0;
    let activeSeats = 0;
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      if (position.out[seat] === 0) {
        activeSeats += 1;
      }
    }

    if (this.endgameGateOpen(position)) {
      refreshContext(this.context, position, false);
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        if (position.out[seat] === 1) {
          continue;
        }
        if (!isSealed(this.context.territory, seat)) {
          continue;
        }
        const pack: PackResult | null = solveSealedRegion(
          position,
          seat,
          this.context.territory,
          this.params.endgame,
        );
        if (!pack) {
          continue;
        }
        this.sealedFlags[seat] = 1;
        this.sealedSquares[seat] = pack.squares;
        this.sealedScore[seat] = pack.score;
        sealedCount += 1;
      }
    }

    if (sealedCount === activeSeats && activeSeats > 0) {
      // Nobody can affect anybody: the whole position is decided.
      position.scores(this.leafScores);
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        if (this.sealedFlags[seat] === 1) {
          this.leafScores[seat] = this.sealedScore[seat];
        }
      }
      const value = valueVector(
        this.leafScores,
        this.params.search.sigmoidScale,
        this.rankBlend,
        this.leafValues,
        this.params.search.opponentAggregation,
      );
      node.proven = value.slice();
      return node.proven;
    }

    // v4: the learned evaluation stands in for the playout entirely rather than for E_i at its
    // truncation point. A rollout is a high-variance sample of the same quantity the network
    // estimates directly, and the truncation sweep showed the estimate only becomes trustworthy
    // when the rollout is played out to the end — 84 plies at +5.71 against 12 plies at baseline.
    // Replacing it removes both the variance and the cost, which is the whole bet of this version.
    const netBlend = this.net === null ? 0 : this.params.search.netBlend;
    const tailConfigured = netBlend >= 1 && this.params.search.netTailPrefix > 0;
    if (this.leafObserver && netBlend === 0) {
      refreshContext(this.context, position, false);
      writeLeafFeatures(this.netInput, 0, position, this.context, this.rootSeat);
    }
    const leafRng = netBlend > 0 ? this.leafRng(position) : null;
    const retainRollout =
      leafRng !== null &&
      netBlend >= 1 &&
      this.params.search.netRolloutProbability > 0 &&
      leafRng() < this.params.search.netRolloutProbability;
    // A learned tail has not been trained on the temporary skip-seat state used by the exact
    // sealed-region splice. Preserve the incumbent rollout for those rare late leaves.
    const tailEnabled = tailConfigured && !retainRollout && sealedCount === 0;
    if (netBlend > 0 && this.net !== null && !retainRollout && !tailConfigured) {
      refreshContext(this.context, position, false);
      this.evaluateNet(position, this.context, leafRng!, 0, true);
      // At blend 1 the network stands in for the rollout outright and the rollout is never run.
      // Below 1 both are computed and averaged: the rollout is an unbiased but high-variance sample
      // of the final margin, the network a biased but low-variance estimate of the same thing, so
      // the average can beat either. This is the only reason to pay for both.
      if (netBlend >= 1) {
        this.leafValues.set(this.netVector);
        return this.leafValues;
      }
    }

    this.playout.run(
      position,
      this.playoutContext,
      this.phase,
      this.outcome,
      sealedCount > 0 ? this.sealedFlags : undefined,
      tailEnabled ? this.params.search.netTailPrefix : 0,
      tailEnabled
        ? (tailPosition, tailContext, _steps, out) => {
            const accepted = this.evaluateNet(
              tailPosition,
              tailContext,
              leafRng!,
              this.params.search.netTailMaxStd,
              false,
            );
            if (accepted) out.set(this.netVector);
            return accepted;
          }
        : undefined,
    );

    if (this.outcome.learnedTail) {
      this.leafValues.set(this.outcome.values);
      return this.leafValues;
    }

    if (this.outcome.terminal) {
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        if (this.sealedFlags[seat] === 1) {
          this.outcome.values[seat] = this.sealedScore[seat];
        }
      }
      this.leafObserver?.({
        position: position.clone(),
        features: this.netInput.slice(0, LEAF_FEATURE_COUNT),
        scores: this.outcome.values.slice(),
        rootSeat: this.rootSeat,
        phase: this.phase,
        terminal: true,
      });
      const terminal = valueVector(
        this.outcome.values,
        this.params.search.sigmoidScale,
        this.rankBlend,
        this.leafValues,
        this.params.search.opponentAggregation,
      );
      // This is the path a *full-length* rollout almost always takes, so the blend has to apply
      // here or `v4-hybrid` is v3.1 with extra arithmetic. A terminated playout is still one
      // sample of the final margin, not an exact value for the leaf — the exact cases (proven,
      // already-finished, fully sealed) returned long before this point.
      if (netBlend > 0 && netBlend < 1) {
        for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
          terminal[seat] = (1 - netBlend) * terminal[seat] + netBlend * this.netVector[seat];
        }
      }
      return terminal;
    }

    if (sealedCount > 0) {
      const squaresWeight = this.params.phases[this.phase].squares;
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        if (this.sealedFlags[seat] !== 1) {
          continue;
        }
        const finalSquares = position.placedSquares(seat) + this.sealedSquares[seat];
        const bonus = this.sealedScore[seat] > 0 ? this.sealedScore[seat] : 0;
        this.outcome.values[seat] = squaresWeight * (finalSquares + bonus);
      }
    }

    this.leafObserver?.({
      position: position.clone(),
      features: this.netInput.slice(0, LEAF_FEATURE_COUNT),
      scores: this.outcome.values.slice(),
      rootSeat: this.rootSeat,
      phase: this.phase,
      terminal: false,
    });

    const aggregation = this.params.search.opponentAggregation;
    const value = valueVector(
      this.outcome.values,
      this.params.search.evalScale,
      this.rankBlend,
      this.leafValues,
      aggregation,
    );

    // The report truncates the playout and reads E_i, with no term for the score itself. The
    // legacy engine keeps 60% of a truncated leaf on the actual score margin, and Blokus is scored
    // in squares, so this restores that anchor when asked for:
    //
    //   v = m·σ(score margin / sigmoidScale) + (1 − m)·[(1 − β)·σ(E margin / evalScale) + β·rank]
    const material = this.params.search.leafMaterialBlend;
    if (material > 0) {
      position.scores(this.leafScores);
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        if (this.sealedFlags[seat] === 1) {
          this.leafScores[seat] = this.sealedScore[seat];
        }
      }
      marginValue(
        this.leafScores,
        this.params.search.sigmoidScale,
        this.materialValues,
        aggregation,
      );
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        value[seat] = material * this.materialValues[seat] + (1 - material) * value[seat];
      }
    }

    if (netBlend > 0 && netBlend < 1) {
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        value[seat] = (1 - netBlend) * value[seat] + netBlend * this.netVector[seat];
      }
    }

    return value;
  }

  /** Evaluate the shared four-seat network at either the expanded leaf or a rollout-prefix state. */
  private evaluateNet(
    position: Position,
    context: EvalContext,
    rng: Rng,
    maxStd: number,
    applySealed: boolean,
  ): boolean {
    if (this.net === null) return false;
    // One pass, from the root seat's perspective, returns all four values. Four perspective passes
    // would erase most of the tail bootstrap's speed advantage.
    if (this.net.featureCount === LEAF_FEATURE_COUNT) {
      writeLeafFeatures(this.netInput, 0, position, context, this.rootSeat);
    } else {
      writeFeatures(this.netInput, 0, position, context, this.rootSeat);
    }
    const out = forward(this.net, this.netInput);
    const sampling = this.params.search.netValueSampling;
    const jointSampling = sampling === 'gaussianJoint';
    const distributionRequired = sampling !== 'mean' || maxStd > 0;
    const requiredOutputs = jointSampling ? SEAT_COUNT + 10 : 2 * SEAT_COUNT;
    if (distributionRequired && out.length < requiredOutputs) {
      throw new Error(
        `distributional leaf evaluation needs ${requiredOutputs} outputs, got ${out.length}`,
      );
    }
    if (maxStd > 0) {
      let largest = 0;
      if (jointSampling) {
        let at = SEAT_COUNT;
        for (let row = 0; row < SEAT_COUNT; row += 1) {
          let variance = 0;
          for (let column = 0; column <= row; column += 1) {
            const value = out[at++];
            variance += value * value;
          }
          largest = Math.max(largest, Math.sqrt(variance));
        }
      } else {
        for (let i = 0; i < SEAT_COUNT; i += 1) {
          const logVariance = Math.max(-8, Math.min(8, out[SEAT_COUNT + i]));
          largest = Math.max(largest, Math.exp(0.5 * logVariance));
        }
      }
      if (largest > maxStd) return false;
    }

    if (jointSampling) {
      for (let i = 0; i < SEAT_COUNT; i += 1) this.jointNoise[i] = normal(rng);
    }
    let choleskyAt = SEAT_COUNT;
    for (let i = 0; i < SEAT_COUNT; i += 1) {
      const seat = (this.rootSeat + i) % SEAT_COUNT;
      let prediction = out[i];
      if (jointSampling) {
        for (let column = 0; column <= i; column += 1) {
          prediction +=
            this.params.search.netSampleScale * out[choleskyAt++] * this.jointNoise[column];
        }
      } else if (sampling === 'gaussian') {
        const logVariance = Math.max(-8, Math.min(8, out[SEAT_COUNT + i]));
        prediction +=
          this.params.search.netSampleScale * Math.exp(0.5 * logVariance) * normal(rng);
      }
      this.netValues[seat] =
        applySealed && this.sealedFlags[seat] === 1 ? this.sealedScore[seat] : prediction;
    }
    if (this.params.search.netOutputKind === 'values') {
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        this.netVector[seat] = Math.max(0, Math.min(1, this.netValues[seat]));
      }
    } else if (this.params.search.netOutputKind === 'meanMargins') {
      valueVectorFromMeanMargins(
        this.netValues,
        this.params.search.netScale,
        this.rankBlend,
        this.netVector,
      );
    } else {
      valueVector(
        this.netValues,
        this.params.search.netScale,
        this.rankBlend,
        this.netVector,
        this.params.search.opponentAggregation,
      );
    }
    return true;
  }

  /** A local stream keeps learned-value sampling from perturbing the global paired-rollout stream. */
  private leafRng(position: Position): Rng {
    const seed = (
      position.hashLo ^
      Math.imul(position.hashHi, 0x9e3779b1) ^
      Math.imul(this.iterations + 1, 0x85ebca6b)
    ) >>> 0;
    return createRng(seed);
  }

  /**
   * The sealed check costs a territory pass at every leaf, which is not worth paying while the
   * board is still one connected fight. Total squares left in hand is an O(1) proxy for "late
   * enough that regions might have closed".
   */
  private endgameGateOpen(position: Position): boolean {
    if (this.params.endgame.maxRegionCells <= 0) {
      return false;
    }
    let total = 0;
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      total += position.handSquares[seat];
    }
    return total <= this.params.endgame.gateRemainingSquares;
  }

  private backup(value: Float64Array): void {
    for (let i = 0; i < this.pathNodes.length; i += 1) {
      const node = this.pathNodes[i];
      const index = this.pathEdges[i];
      node.visits += 1;
      node.childVisits![index] += 1;
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        node.values[seat] += value[seat];
        if (this.params.search.varianceTuned) {
          node.valueSquares[seat] += value[seat] * value[seat];
        }
      }
      if (this.params.search.historyWeight !== 0) {
        this.history.update(node.turn, node.moves![index], value[node.turn]);
      }
      if (this.params.search.raveEquivalence > 0 && node.amafVisits && node.amafValues) {
        this.updateAmaf(node, i, value);
      }
    }
    // The leaf itself: its own statistics matter when a transposition reaches it later.
    const leafParent = this.pathNodes[this.pathNodes.length - 1];
    const leafIndex = this.pathEdges[this.pathEdges.length - 1];
    const leaf = leafParent ? leafParent.children[leafIndex] : this.pathRoot;
    if (leaf) {
      leaf.visits += 1;
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        leaf.values[seat] += value[seat];
        if (this.params.search.varianceTuned) {
          leaf.valueSquares[seat] += value[seat] * value[seat];
        }
      }
    }

    if (this.params.search.implicitMaxnWeight > 0) {
      for (let i = this.pathNodes.length - 1; i >= 0; i -= 1) {
        this.recomputeImplicit(this.pathNodes[i]);
      }
    }
  }

  private updateAmaf(node: Node, pathIndex: number, value: Float64Array): void {
    const seen = this.amafSeen;
    seen.fill(0);
    const record = (mover: number, move: number): void => {
      if (mover !== node.turn) return;
      const piece = PLACEMENTS.pieceId[move];
      if (seen[piece] === 1) return;
      seen[piece] = 1;
      node.amafVisits![piece] += 1;
      const offset = piece * SEAT_COUNT;
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        node.amafValues![offset + seat] += value[seat];
      }
    };
    for (let index = pathIndex; index < this.pathNodes.length; index += 1) {
      record(this.pathNodes[index].turn, this.pathNodes[index].moves![this.pathEdges[index]]);
    }
    for (let index = 0; index < this.playout.lastTraceLength; index += 1) {
      record(this.playout.traceMover(index), this.playout.traceMove(index));
    }
  }

  /** Max^n backup: the mover chooses one child and the whole four-seat vector follows it. */
  private recomputeImplicit(node: Node): void {
    let best: Node | null = null;
    let bestValue = -Infinity;
    for (let index = 0; index < node.opened; index += 1) {
      const child = node.children[index];
      if (!child?.implicitReady) {
        continue;
      }
      const value = child.implicitValues[node.turn];
      if (value > bestValue) {
        bestValue = value;
        best = child;
      }
    }
    if (best) {
      node.implicitValues.set(best.implicitValues);
      node.implicitReady = true;
    }
  }

  /* --- Root readout ------------------------------------------------------------------------ */

  private decisionVisits(root: Node, index: number): number {
    return (
      root.childVisits![index] +
      (root.learnedPrior ? this.params.search.rootPriorPseudoVisits : 0) *
        (root.priors?.[index] ?? 0)
    );
  }

  private bestMove(root: Node): number {
    if (root.moveCount === 0) {
      return -1;
    }
    let best = -1;
    let bestVisits = -1;
    let bestValue = -Infinity;
    for (let index = 0; index < root.opened; index += 1) {
      const visits = this.decisionVisits(root, index);
      const child = root.children[index];
      const value = child && child.visits > 0 ? child.values[this.rootSeat] / child.visits : -1;
      if (visits > bestVisits || (visits === bestVisits && value > bestValue)) {
        best = index;
        bestVisits = visits;
        bestValue = value;
      }
    }
    return best >= 0 ? root.moves![best] : root.moves![0];
  }

  private rankRoot(root: Node): RankedPlacement[] {
    const ranked: Array<RankedPlacement & { decisionVisits: number }> = [];
    for (let index = 0; index < root.moveCount; index += 1) {
      const child = root.children[index];
      ranked.push({
        move: root.moves![index],
        visits: root.childVisits ? root.childVisits[index] : 0,
        value: child && child.visits > 0 ? child.values[this.rootSeat] / child.visits : 0,
        prior: root.priors ? root.priors[index] : 0,
        decisionVisits: this.decisionVisits(root, index),
      });
    }
    ranked.sort(
      (a, b) => b.decisionVisits - a.decisionVisits || b.value - a.value || a.move - b.move,
    );
    return ranked;
  }

  /** §6.1: stop once the runner-up cannot overtake the leader on visits in the budget that is left. */
  private decided(root: Node, remaining: number): boolean {
    if (!root.childVisits || root.opened < 2 || remaining === Number.POSITIVE_INFINITY) {
      return false;
    }
    let best = -1;
    let second = -1;
    for (let index = 0; index < root.opened; index += 1) {
      const visits = root.childVisits[index];
      if (visits > best) {
        second = best;
        best = visits;
      } else if (visits > second) {
        second = visits;
      }
    }
    return second + remaining < best;
  }
}
