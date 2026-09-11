/**
 * ε-greedy truncated playouts (§2.2, §6).
 *
 * "Random playouts in Blokus are informative because the scoring rule is simple, and they can be
 * truncated after a fixed number of plies with a heuristic evaluation (early playout termination),
 * which is far cheaper than a well-tuned static evaluator deep enough for minimax."
 *
 * Two details matter for speed and for bias:
 *
 * 1. A playout ply does *not* generate the full legal set. At the peak the branching factor runs
 *    into four figures, and a full generation twelve times per simulation would cost more than the
 *    simulation is worth. Instead it samples open corners in random order and enumerates only the
 *    placements covering one of them, which is both cheap and spatially unbiased — capping a full
 *    generation instead would bias every playout toward whichever corner happens to sort first.
 * 2. The policy is deliberately blunt: piece size and centre pull. §7 warns against varying ε by
 *    node uncertainty, and the report's own recommendation is to tune ε once per phase and leave
 *    it alone.
 *
 * All randomness comes from `src/ai/rng`, so a seeded match replays exactly.
 */

import { WORDS, toIndices, type Mask, newMask } from "./bitboard";
import { PLACEMENTS, PIECE_COUNT } from "./placements";
import type { Position } from "./position";
import { SEAT_COUNT, BOARD_CENTRE } from "./seats";
import { evaluate, refreshContext, type EvalContext } from "./features";
import type { PhaseId, BitboardParams } from "./config";
import { random, randomInt } from "../rng";
import {
  rolloutPolicyFor,
  scoreRolloutPolicy,
  type RolloutPolicy,
} from './rolloutPolicy';

export interface PlayoutOutcome {
  /** Per-seat values: final Blokus scores when terminal, E_i when truncated. */
  values: Float64Array;
  terminal: boolean;
  /** True when `values` were supplied directly in backed-value space by a learned tail. */
  learnedTail: boolean;
}

export type PlayoutTailEvaluator = (
  position: Position,
  context: EvalContext,
  steps: number,
  out: Float64Array,
) => boolean;

const cornerMask: Mask = newMask();
const cornerCells = new Int32Array(400);

/**
 * Dedup stamps for `sampleMoves`. One placement can cover two of the mover's open corners, and the
 * candidate pool must not double-weight it. The check was a linear scan of everything accepted so
 * far — quadratic in the pool, inside the hottest loop in the engine. `Position.generateFromCorners`
 * solves the identical problem with a generation stamp; this is the same trick.
 */
const sampleStamp = new Int32Array(PLACEMENTS.count);
let sampleGeneration = 0;

/**
 * Direct references to the placement table's arrays.
 *
 * `sampleMoves` is ~66% of engine self time and reads these tens of thousands of times per MCTS
 * iteration. Each `PLACEMENTS.cells[...]` is a property load on a twenty-field object before the
 * indexed read; binding them once removes that load from the innermost loop. The table is built once
 * at module load and never reassigned, so these alias the same buffers for the process lifetime.
 */
const P_CELLS = PLACEMENTS.cells;
const P_EDGE_HALO = PLACEMENTS.edgeHalo;
const P_COVER_LIST = PLACEMENTS.coverList;
const P_COVER_PIECE_START = PLACEMENTS.coverPieceStart;
const P_MASK_LO = PLACEMENTS.maskLo;
const P_MASK_HI = PLACEMENTS.maskHi;
const candidateBuffer = new Int32Array(512);

/**
 * Legal placements covering a randomly chosen open corner of `seat`, up to `limit`. Returns 0 only
 * when the seat genuinely has no legal move anywhere, so the caller can mark it out with certainty.
 */
export function sampleMoves(
  position: Position,
  seat: number,
  out: Int32Array,
  limit: number,
  maxCorners = 1,
): number {
  if (position.hand[seat] === 0) {
    return 0;
  }
  if (position.played[seat] === 0) {
    return position.generateMoves(seat, out, limit);
  }

  position.openCornersInto(cornerMask, seat);
  const corners = toIndices(cornerMask, cornerCells);
  if (corners === 0) {
    return 0;
  }

  // Fisher–Yates over the corner list, drawn lazily: the first corner with a legal placement
  // usually ends the loop, and the shuffle is what keeps the sample spatially unbiased.
  const hand = position.hand[seat];
  const occ = position.occ;
  const own = position.own[seat];
  let count = 0;
  let cornersUsed = 0;
  sampleGeneration += 1;
  const generation = sampleGeneration;

  for (
    let remaining = corners;
    remaining > 0 && count < limit;
    remaining -= 1
  ) {
    const pick = randomInt(remaining);
    const cell = cornerCells[pick];
    cornerCells[pick] = cornerCells[remaining - 1];
    cornerCells[remaining - 1] = cell;

    let found = false;
    // Iterate only the pieces still in hand. `coverList` is grouped by piece and ascending within a
    // piece, so this visits exactly the same ids in exactly the same order as a full scan with a
    // per-candidate hand test — it just stops paying for the pieces that are already down.
    const pieceBase = cell * (PIECE_COUNT + 1);
    for (let piece = 0; piece < PIECE_COUNT && count < limit; piece += 1) {
      if ((hand & (1 << piece)) === 0) {
        continue;
      }
      const runStart = P_COVER_PIECE_START[pieceBase + piece];
      const runEnd = P_COVER_PIECE_START[pieceBase + piece + 1];
      for (let i = runStart; i < runEnd && count < limit; i += 1) {
        const id = P_COVER_LIST[i];
        const offset = id * 13;
        // Only the words this placement actually touches. A piece spans at most five adjacent squares,
        // so `lo..hi` is one to three words of the thirteen; the rest are zero and `x & 0` is zero, so
        // skipping them is exactly equivalent. This loop is the hottest code in the engine.
        const lo = P_MASK_LO[id];
        const hi = P_MASK_HI[id];
        // Both rejection tests in one pass. They had separate loops with separate early exits, but
        // either one firing leads to the same `continue`, so OR-ing them per word decides exactly the
        // same candidates and walks the words once instead of twice. Which word triggers can differ;
        // the outcome cannot.
        let rejected = false;
        for (let w = lo; w < hi; w += 1) {
          const o = offset + w;
          if (((occ[w] & P_CELLS[o]) | (own[w] & P_EDGE_HALO[o])) !== 0) {
            rejected = true;
            break;
          }
        }
        if (rejected) {
          continue;
        }
        // A placement can cover two of this seat's corners; the pool must not double-weight it.
        if (sampleStamp[id] === generation) {
          continue;
        }
        sampleStamp[id] = generation;
        out[count] = id;
        count += 1;
        found = true;
      }
    }

    if (found) {
      cornersUsed += 1;
      // Keep drawing corners until `maxCorners` of them have contributed, so the policy can compare
      // a move at one corner against a move at another. With `maxCorners = 1` this is the original
      // behaviour: the first corner that yields anything ends the draw.
      if (cornersUsed >= maxCorners) {
        return count;
      }
    }
  }
  return count;
}

/** Blunt simulation policy: spend big pieces, lean toward the centre. */
function playoutScore(
  move: number,
  sizeWeight: number,
  centreWeight: number,
): number {
  return (
    PLACEMENTS.size[move] * sizeWeight -
    PLACEMENTS.centreDistance[move] * centreWeight
  );
}

/**
 * Static halo popcounts, built once. `cornerHalo` counts the diagonal cells a placement would offer
 * as future corners; `edgeHalo` counts the orthogonal cells it forbids to its own colour. Both are
 * properties of the placement alone, so they cost one array read inside the rollout — which is the
 * only price a rollout policy can afford (see `playoutPolicy` in config.ts).
 */
const HALO_COUNTS = (() => {
  const corner = new Float32Array(PLACEMENTS.count);
  const edge = new Float32Array(PLACEMENTS.count);
  for (let move = 0; move < PLACEMENTS.count; move += 1) {
    const offset = move * WORDS;
    let cornerBits = 0;
    let edgeBits = 0;
    for (let w = 0; w < WORDS; w += 1) {
      cornerBits += popcount32(PLACEMENTS.cornerHalo[offset + w]);
      edgeBits += popcount32(PLACEMENTS.edgeHalo[offset + w]);
    }
    corner[move] = cornerBits;
    edge[move] = edgeBits;
  }
  return { corner, edge };
})();

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** Fitted simulation policy: the legacy two terms plus the two static halo counts. */
function linearScore(
  move: number,
  sizeWeight: number,
  centreWeight: number,
  cornerWeight: number,
  edgeWeight: number,
): number {
  return (
    PLACEMENTS.size[move] * sizeWeight -
    PLACEMENTS.centreDistance[move] * centreWeight +
    HALO_COUNTS.corner[move] * cornerWeight -
    HALO_COUNTS.edge[move] * edgeWeight
  );
}

interface PassRecord {
  seat: number;
  turn: number;
}

interface MoveRecord {
  mover: number;
  move: number;
  record: ReturnType<Position["apply"]>;
}

export class Playout {
  private scores = new Float64Array(SEAT_COUNT);
  private mastSums = new Float64Array(SEAT_COUNT * 21);
  private mastCounts = new Int32Array(SEAT_COUNT * 21);
  private mastStride = 21;
  private traceMovers = new Int8Array(96);
  private traceMoves = new Int32Array(96);
  private traceLength = 0;
  private policyScores = new Float64Array(512);
  private params: BitboardParams;
  private tablePolicy: RolloutPolicy | null = null;

  constructor(params: BitboardParams) {
    this.params = params;
    this.refreshTablePolicy();
    this.ensureMastStorage();
  }

  setParams(params: BitboardParams): void {
    this.params = params;
    this.refreshTablePolicy();
    this.ensureMastStorage();
  }

  private refreshTablePolicy(): void {
    this.tablePolicy = rolloutPolicyFor(this.params.search.playoutTablePath);
    if (this.params.search.playoutPolicy === 'table' && this.tablePolicy === null) {
      throw new Error(
        `playout asked for table policy at "${this.params.search.playoutTablePath ?? ''}" but ` +
          'no artifact is registered; call preloadNets() before play',
      );
    }
  }

  resetLearning(): void {
    this.mastSums.fill(0);
    this.mastCounts.fill(0);
  }

  clearTrace(): void {
    this.traceLength = 0;
  }

  get lastTraceLength(): number {
    return this.traceLength;
  }

  traceMover(index: number): number {
    return this.traceMovers[index];
  }

  traceMove(index: number): number {
    return this.traceMoves[index];
  }

  /**
   * Plays from `position` for at most `cutoff` plies and reports the outcome. The position is
   * restored before returning, so callers can run thousands of playouts from one tree node without
   * cloning it.
   *
   * `skip` marks seats to leave out of the simulation entirely — the report's "once a player is
   * entirely sealed off, drop them from playouts altogether, since nothing they do can affect
   * anyone else".
   */
  run(
    position: Position,
    context: EvalContext,
    phase: PhaseId,
    outcome: PlayoutOutcome,
    skip?: Uint8Array,
    tailPrefix = 0,
    tailEvaluator?: PlayoutTailEvaluator,
  ): PlayoutOutcome {
    this.traceLength = 0;
    const undos: Array<MoveRecord | PassRecord> = [];
    const skipped: number[] = [];
    if (skip) {
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        if (skip[seat] === 1 && position.out[seat] === 0) {
          position.markOut(seat);
          skipped.push(seat);
        }
      }
      if (position.out[position.turn] === 1) {
        position.advanceTurn();
      }
    }

    const {
      playoutEps,
      playoutEpsByPhase,
      playoutCutoff,
      playoutMoveCap,
      playoutCorners,
      playoutMastWeight,
    } = this.params.search;
    const epsilon = playoutEpsByPhase?.[phase] ?? playoutEps;
    const ordering = this.params.ordering[phase];
    const linear = this.params.search.playoutPolicy === "linear";
    const table = this.params.search.playoutPolicy === 'table';
    let steps = 0;
    let learnedTail = false;
    let pendingTail = tailPrefix > 0 ? tailEvaluator : undefined;

    while (steps < playoutCutoff && !position.finished) {
      const seat = position.turn;
      const count = sampleMoves(
        position,
        seat,
        candidateBuffer,
        playoutMoveCap,
        playoutCorners,
      );
      if (count === 0) {
        const turn = position.turn;
        position.markOut(seat);
        position.advanceTurn();
        undos.push({ seat, turn });
        steps += 1;
        if (pendingTail && steps >= tailPrefix && !position.finished) {
          refreshContext(context, position, false);
          learnedTail = pendingTail(position, context, steps, outcome.values);
          pendingTail = undefined;
          if (learnedTail) break;
        }
        continue;
      }

      let chosen: number;
      if (count === 1 || random() < epsilon) {
        chosen = candidateBuffer[randomInt(count)];
      } else if (table) {
        chosen = this.sampleTable(
          candidateBuffer,
          count,
          position,
          seat,
          phase,
          ordering,
          playoutMastWeight,
        );
      } else if (linear) {
        chosen = this.sampleLinear(
          candidateBuffer,
          count,
          seat,
          ordering,
          playoutMastWeight,
        );
      } else {
        let best = -Infinity;
        chosen = candidateBuffer[0];
        for (let i = 0; i < count; i += 1) {
          const score =
            playoutScore(
              candidateBuffer[i],
              ordering.pieceSize,
              ordering.centrePull,
            ) + this.mastScore(seat, candidateBuffer[i], playoutMastWeight);
          if (score > best) {
            best = score;
            chosen = candidateBuffer[i];
          }
        }
      }

      undos.push({ mover: seat, move: chosen, record: position.apply(chosen) });
      if (this.traceLength < this.traceMoves.length) {
        this.traceMovers[this.traceLength] = seat;
        this.traceMoves[this.traceLength] = chosen;
        this.traceLength += 1;
      }
      steps += 1;
      if (pendingTail && steps >= tailPrefix && !position.finished) {
        refreshContext(context, position, false);
        learnedTail = pendingTail(position, context, steps, outcome.values);
        pendingTail = undefined;
        if (learnedTail) break;
      }
    }

    const terminal = position.finished;
    if (learnedTail) {
      // The evaluator wrote values in the exact space consumed by MCTS backup.
    } else if (terminal) {
      position.scores(this.scores);
      outcome.values.set(this.scores);
    } else {
      refreshContext(context, position, false);
      outcome.values.set(evaluate(context, position, this.params, phase));
    }
    outcome.terminal = terminal;
    outcome.learnedTail = learnedTail;

    if (playoutMastWeight !== 0 && !learnedTail) {
      this.updateMast(undos, outcome.values, terminal ? 12 : 28);
    }

    for (let i = undos.length - 1; i >= 0; i -= 1) {
      const entry = undos[i];
      if ("record" in entry) {
        position.undo(entry.record);
      } else {
        position.out[entry.seat] = 0;
        position.forceTurn(entry.turn);
      }
    }
    for (const seat of skipped) {
      position.out[seat] = 0;
    }

    return outcome;
  }

  /**
   * Fitted policy: score the pool with the four static terms, then either take the argmax
   * (`playoutTemp === 0`, exactly the legacy rule with extra terms) or sample from the softmax.
   *
   * Scores are shifted by their maximum before exponentiating, so the temperature is scale-free and
   * a large weight vector cannot overflow.
   */
  private sampleLinear(
    candidates: Int32Array,
    count: number,
    seat: number,
    ordering: { pieceSize: number; centrePull: number },
    mastWeight: number,
  ): number {
    const { playoutCornerWeight, playoutEdgeWeight, playoutTemp } =
      this.params.search;
    let best = -Infinity;
    let bestMove = candidates[0];
    for (let i = 0; i < count; i += 1) {
      const score =
        linearScore(
          candidates[i],
          ordering.pieceSize,
          ordering.centrePull,
          playoutCornerWeight,
          playoutEdgeWeight,
        ) + this.mastScore(seat, candidates[i], mastWeight);
      this.policyScores[i] = score;
      if (score > best) {
        best = score;
        bestMove = candidates[i];
      }
    }
    if (playoutTemp <= 0) {
      return bestMove;
    }
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      const weight = Math.exp((this.policyScores[i] - best) / playoutTemp);
      this.policyScores[i] = weight;
      total += weight;
    }
    let draw = random() * total;
    for (let i = 0; i < count; i += 1) {
      draw -= this.policyScores[i];
      if (draw <= 0) {
        return candidates[i];
      }
    }
    return bestMove;
  }

  /** Learned guided branch with an exact blend-zero identity to the incumbent score. */
  private sampleTable(
    candidates: Int32Array,
    count: number,
    position: Position,
    seat: number,
    phase: PhaseId,
    ordering: { pieceSize: number; centrePull: number },
    mastWeight: number,
  ): number {
    const policy = this.tablePolicy!;
    const blend = this.params.search.playoutTableBlend ?? policy.blend;
    const temperature = this.params.search.playoutTemp;
    let best = -Infinity;
    let bestMove = candidates[0];
    for (let i = 0; i < count; i += 1) {
      const move = candidates[i];
      const incumbent = playoutScore(move, ordering.pieceSize, ordering.centrePull);
      const learned = scoreRolloutPolicy(
        policy,
        phase,
        seat,
        move,
        position.handSquares[seat],
        position.hand[seat],
      );
      const score =
        incumbent * (1 - blend) +
        learned * blend +
        this.mastScore(seat, move, mastWeight);
      this.policyScores[i] = score;
      if (score > best) {
        best = score;
        bestMove = move;
      }
    }
    if (temperature <= 0) return bestMove;
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      const weight = Math.exp((this.policyScores[i] - best) / temperature);
      this.policyScores[i] = weight;
      total += weight;
    }
    let draw = random() * total;
    for (let i = 0; i < count; i += 1) {
      draw -= this.policyScores[i];
      if (draw <= 0) return candidates[i];
    }
    return bestMove;
  }

  private mastScore(seat: number, move: number, weight: number): number {
    if (weight === 0) return 0;
    const key = this.mastKey(seat, move);
    return this.mastCounts[key] > 0
      ? (weight * this.mastSums[key]) / this.mastCounts[key]
      : 0;
  }

  private ensureMastStorage(): void {
    const stride =
      this.params.search.playoutMastGranularity === "placement"
        ? PLACEMENTS.size.length
        : 21;
    if (stride === this.mastStride) return;
    this.mastStride = stride;
    this.mastSums = new Float64Array(SEAT_COUNT * stride);
    this.mastCounts = new Int32Array(SEAT_COUNT * stride);
  }

  private mastKey(seat: number, move: number): number {
    const action =
      this.params.search.playoutMastGranularity === "placement"
        ? move
        : PLACEMENTS.pieceId[move];
    return seat * this.mastStride + action;
  }

  private updateMast(
    undos: Array<MoveRecord | PassRecord>,
    values: Float64Array,
    scale: number,
  ): void {
    for (const entry of undos) {
      if (!("record" in entry)) continue;
      let others = 0;
      for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
        if (seat !== entry.mover) others += values[seat];
      }
      const reward = Math.tanh(
        (values[entry.mover] - others / (SEAT_COUNT - 1)) / scale,
      );
      const key = this.mastKey(entry.mover, entry.move);
      this.mastSums[key] += reward;
      this.mastCounts[key] += 1;
    }
  }
}

export function createOutcome(): PlayoutOutcome {
  return { values: new Float64Array(SEAT_COUNT), terminal: false, learnedTail: false };
}

export { BOARD_CENTRE };
