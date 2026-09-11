/**
 * A reusable corpus of sampled positions with the realized outcome of the game each came from, plus
 * the offline evaluator for a terminal-rollout policy.
 *
 * The corpus is the expensive part (it costs real self-play games) and the evaluation is nearly
 * free — a few hundred rollouts per position, no search — so the corpus is cached to disk and every
 * policy candidate is scored against the same positions with the same rollout seeds. That asymmetry
 * is the whole point: it turns the rollout-policy channel from something you search one 400-game
 * match at a time into something you can search thousands of candidates at a time.
 *
 * Positions are tagged with the game they came from so train/holdout splits can be made **by game**.
 * Positions inside one game share a board and an outcome; splitting by position would leak.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PLAYER_COLORS } from '../../src/engine/types.ts';
import type { GameState, PlayerColor } from '../../src/engine/types.ts';
import type { AlgoVersionId } from '../../src/ai/algoVersions.ts';
import { playSeatedGame, type PolicyId } from '../../src/ai/selfplay.ts';
import { setSeed } from '../../src/ai/rng.ts';
import { resetV12, seatOf, toPosition } from '../../src/ai/bitboard/index.ts';
import { withOverrides, type BitboardParams, type DeepPartial, type PhaseId } from '../../src/ai/bitboard/config.ts';
import { createEvalContext, detectPhase, refreshContext } from '../../src/ai/bitboard/features.ts';
import { Playout, createOutcome } from '../../src/ai/bitboard/playout.ts';
import { objectiveBlend, valueVector } from '../../src/ai/bitboard/backup.ts';
import { SEAT_COUNT } from '../../src/ai/bitboard/seats.ts';

export type PhaseName = 'opening' | 'midgame' | 'endgame';

export interface Sample {
  game: number;
  state: GameState;
  player: PlayerColor;
  phase: PhaseName;
  /** Realized final scores of the game this position came from, by seat index. */
  finalScores: number[];
}

export function phaseOf(state: GameState, color: PlayerColor): PhaseName {
  const played = 21 - state.remainingPieces[color].length;
  if (played < 5) return 'opening';
  return played < 15 ? 'midgame' : 'endgame';
}

export async function collectCorpus(
  games: number,
  seedBase: number,
  stride: number,
  generator: AlgoVersionId,
  policy: PolicyId,
  onGame?: (done: number, total: number, positions: number) => void,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let g = 0; g < games; g += 1) {
    resetV12();
    const pending: Sample[] = [];
    const seatVersions = Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, generator]),
    ) as Record<PlayerColor, AlgoVersionId>;
    const seatPolicies = Object.fromEntries(PLAYER_COLORS.map((c) => [c, policy])) as Record<
      PlayerColor,
      PolicyId
    >;
    const record = await playSeatedGame({
      hero: policy,
      opponents: policy,
      seatVersions,
      seatPolicies,
      seed: seedBase + g,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: { skipWinOddsRefinement: true, lightRollouts: true },
      onPly: (state, ply) => {
        if (ply % stride === 0 && !state.finished) {
          pending.push({
            game: g,
            state,
            player: state.currentTurn,
            phase: phaseOf(state, state.currentTurn),
            finalScores: [],
          });
        }
      },
    });
    const final = new Array<number>(SEAT_COUNT).fill(0);
    for (const color of PLAYER_COLORS) {
      final[seatOf(color)] = record.scores[color];
    }
    for (const sample of pending) {
      sample.finalScores = final;
    }
    samples.push(...pending);
    onGame?.(g + 1, games, samples.length);
  }
  return samples;
}

export function saveCorpus(path: string, samples: Sample[]): void {
  writeFileSync(path, `${JSON.stringify(samples)}\n`);
}

export function loadCorpus(path: string): Sample[] {
  return JSON.parse(readFileSync(path, 'utf8')) as Sample[];
}

/**
 * Resumable collection: saves after **every** game and continues from whatever is already on disk.
 *
 * Long jobs on this machine are routinely reaped, and a collector that only writes at the end loses
 * everything each time — which is exactly what happened twice while building this corpus. Game
 * indices are stable functions of `seedBase`, so a resumed run reproduces the same positions it
 * would have collected in one pass.
 */
export async function collectCorpusResumable(
  path: string,
  targetGames: number,
  seedBase: number,
  stride: number,
  generator: AlgoVersionId,
  policy: PolicyId,
  onGame?: (done: number, total: number, positions: number) => void,
): Promise<Sample[]> {
  const existing = existsSync(path) ? loadCorpus(path) : [];
  const done = new Set(existing.map((sample) => sample.game));
  const samples = [...existing];
  for (let g = 0; g < targetGames; g += 1) {
    if (done.has(g)) continue;
    const one = await collectCorpus(1, seedBase + g, stride, generator, policy);
    for (const sample of one) {
      sample.game = g;
    }
    samples.push(...one);
    saveCorpus(path, samples);
    onGame?.(g + 1, targetGames, samples.length);
  }
  return samples;
}

/** Squashed margin for one seat, using exactly the transform the search backs up. */
export function seatValue(
  scores: Float64Array,
  params: BitboardParams,
  seat: number,
  out: Float64Array,
): number {
  const rankBlend = objectiveBlend(params.search.rankBlend, 0, params.search.objectiveShift);
  valueVector(scores, params.search.netScale, rankBlend, out, params.search.opponentAggregation);
  return out[seat];
}

export interface PolicyScore {
  /** mean(rollout estimate − realized outcome); what simulation balancing drives to zero. */
  bias: number;
  /** mean squared error against the realized outcome — the regression objective. Lower is better. */
  mse: number;
  /** Spearman correlation with the realized outcome: discrimination, not calibration. */
  rho: number;
  n: number;
  byPhase: Record<PhaseName, { bias: number; mse: number; n: number }>;
}

/**
 * Scores one rollout policy on a fixed corpus.
 *
 * Every candidate gets the same per-position rollout seed, so two candidates are separated by their
 * policy and not by their draw — the same common-random-numbers discipline the tournament harness
 * uses, applied where it is a thousand times cheaper.
 */
export function evaluatePolicy(
  base: BitboardParams,
  overrides: DeepPartial<BitboardParams>,
  samples: Sample[],
  rollouts: number,
  seedBase: number,
): PolicyScore {
  const params = withOverrides(base, overrides);
  const playout = new Playout(params);
  const outcome = createOutcome();
  const context = createEvalContext();
  context.fractionalTies = params.fractionalTerritoryTies;
  const scratch = new Float64Array(SEAT_COUNT);
  const target = new Float64Array(SEAT_COUNT);

  const estimates: number[] = [];
  const targets: number[] = [];
  const phases: PhaseName[] = [];

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const seat = seatOf(sample.player);
    const position = toPosition(sample.state);
    if (position.turn !== seat) position.forceTurn(seat);
    refreshContext(context, position, false);
    const phase: PhaseId = detectPhase(position, context, params, seat);

    setSeed(seedBase + i * 7919);
    let total = 0;
    for (let r = 0; r < rollouts; r += 1) {
      playout.run(position, context, phase, outcome);
      total += seatValue(outcome.values, params, seat, scratch);
    }
    estimates.push(total / rollouts);
    target.set(sample.finalScores);
    targets.push(seatValue(target, params, seat, scratch));
    phases.push(sample.phase);
  }

  const n = Math.max(1, estimates.length);
  const errors = estimates.map((value, i) => value - targets[i]);
  const byPhase = {} as PolicyScore['byPhase'];
  for (const phase of ['opening', 'midgame', 'endgame'] as const) {
    const picked = errors.filter((_, i) => phases[i] === phase);
    byPhase[phase] = {
      bias: picked.length ? picked.reduce((s, v) => s + v, 0) / picked.length : 0,
      mse: picked.length ? picked.reduce((s, v) => s + v * v, 0) / picked.length : 0,
      n: picked.length,
    };
  }
  return {
    bias: errors.reduce((sum, value) => sum + value, 0) / n,
    mse: errors.reduce((sum, value) => sum + value * value, 0) / n,
    rho: spearman(estimates, targets),
    n: estimates.length,
    byPhase,
  };
}

export function spearman(a: number[], b: number[]): number {
  if (a.length < 2) return 0;
  const rank = (values: number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((x, y) => x.value - y.value);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1;
      const mean = (i + j) / 2;
      for (let k = i; k <= j; k += 1) ranks[order[k].index] = mean;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / n;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Splits by game, never by position: positions inside a game share a board and an outcome. */
export function splitByGame(samples: Sample[], holdoutFraction: number): {
  train: Sample[];
  holdout: Sample[];
} {
  const games = [...new Set(samples.map((sample) => sample.game))].sort((a, b) => a - b);
  const holdoutCount = Math.max(1, Math.round(games.length * holdoutFraction));
  const holdoutGames = new Set(games.slice(games.length - holdoutCount));
  return {
    train: samples.filter((sample) => !holdoutGames.has(sample.game)),
    holdout: samples.filter((sample) => holdoutGames.has(sample.game)),
  };
}
