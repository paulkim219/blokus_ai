import { PLAYER_COLORS } from '../../src/engine/types.ts';
import type { PlayerColor } from '../../src/engine/types.ts';
import type { AlgoVersionId } from '../../src/ai/algoVersions.ts';

/**
 * A seat-rotated match: for one seed, version A occupies each of the four seats in turn while B
 * fills the rest. Rotating removes the seat advantage from the comparison — every past cycle in
 * this repo measured the challenger in the blue seat only, which conflates "stronger" with
 * "sitting first".
 */
export interface RotationGame {
  seed: number;
  /** Seat that version A occupied in this game. */
  seat: PlayerColor;
  scores: Record<PlayerColor, number>;
  winner: PlayerColor[];
}

/**
 * A's score minus the mean of the three B seats, averaged over the four rotations of one seed.
 *
 * The null is exactly zero: if A and B are the same config, all four rotations replay the same
 * game (same seed, identical players), and the four advantages sum to zero by construction. That
 * is why this replaces `hero − max(opponents)`, whose null is negative and was never calibrated.
 */
export function rotationAdvantage(games: RotationGame[]): number {
  if (games.length === 0) {
    return 0;
  }
  let total = 0;
  for (const game of games) {
    const own = game.scores[game.seat];
    const others = PLAYER_COLORS.filter((color) => color !== game.seat);
    const opponentMean =
      others.reduce((sum, color) => sum + game.scores[color], 0) / others.length;
    total += own - opponentMean;
  }
  return total / games.length;
}

/**
 * Squares this seat actually placed, recovered from its final score.
 *
 * `calculateScores` sets `score = −remainingSquares`, and adds the +15 / +20 completion bonuses only
 * when nothing remains — so a positive score means everything was placed and a non-positive one
 * gives the count directly. That makes the efficiency axis readable off every match log ever
 * written, including the 116 that predate the aggression work, with no schema change.
 */
export function squaresPlaced(score: number): number {
  return score > 0 ? TOTAL_SQUARES : TOTAL_SQUARES + score;
}

/** The 21 free polyominoes of size one to five. */
const TOTAL_SQUARES = 89;

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export interface Interval {
  mean: number;
  low: number;
  high: number;
  /** True when the whole interval sits above zero (A better) or below it (A worse). */
  significant: boolean;
}

/**
 * Below this, an advantage is floating-point noise rather than a result — a mirror match sums to
 * zero mathematically but lands on ~1e-16 in doubles.
 */
const ZERO_TOLERANCE = 1e-6;

/** Percentile bootstrap over the per-seed samples. Deterministic given `seed`. */
export function bootstrapCI(samples: number[], iterations = 4000, seed = 12345): Interval {
  const point = mean(samples);
  if (samples.length < 2) {
    return { mean: point, low: point, high: point, significant: false };
  }

  let state = seed >>> 0;
  const nextRandom = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    for (let j = 0; j < samples.length; j += 1) {
      total += samples[Math.floor(nextRandom() * samples.length)];
    }
    means.push(total / samples.length);
  }
  means.sort((a, b) => a - b);

  const low = means[Math.floor(iterations * 0.025)];
  const high = means[Math.floor(iterations * 0.975)];
  return {
    mean: point,
    low,
    high,
    significant: low > ZERO_TOLERANCE || high < -ZERO_TOLERANCE,
  };
}

export interface MatchSummary {
  challenger: AlgoVersionId;
  champion: AlgoVersionId;
  seeds: number;
  games: number;
  advantage: Interval;
  /** Share of games the challenger took outright first place in. Par for one seat of four is 25%. */
  firstPlaceRate: number;
  soleWinRate: number;
  meanChallengerScore: number;
  /**
   * The other half of the aggression frontier.
   *
   * `advantage` is `own − mean(others)`, so it cannot tell "I scored more" apart from "they scored
   * less" — and that difference is exactly what the aggression dial trades. A dial setting is read
   * on these three together: advantage says whether it costs strength, the two mean scores say what
   * it actually changed.
   */
  meanOpponentScore: number;
  /** Squares the challenger placed, the efficiency axis in its own units. */
  meanChallengerPlaced: number;
  perSeatAdvantage: Record<PlayerColor, number>;
}

export function summarizeMatch(
  challenger: AlgoVersionId,
  champion: AlgoVersionId,
  gamesBySeed: Map<number, RotationGame[]>,
): MatchSummary {
  const perSeed: number[] = [];
  const all: RotationGame[] = [];
  for (const games of gamesBySeed.values()) {
    perSeed.push(rotationAdvantage(games));
    all.push(...games);
  }

  const perSeatAdvantage = Object.fromEntries(
    PLAYER_COLORS.map((seat) => {
      const seatGames = all.filter((game) => game.seat === seat);
      return [seat, rotationAdvantage(seatGames)];
    }),
  ) as Record<PlayerColor, number>;

  const firstPlace = all.filter((game) => game.winner.includes(game.seat)).length;
  const soleWins = all.filter(
    (game) => game.winner.length === 1 && game.winner[0] === game.seat,
  ).length;

  return {
    challenger,
    champion,
    seeds: perSeed.length,
    games: all.length,
    advantage: bootstrapCI(perSeed),
    firstPlaceRate: all.length > 0 ? firstPlace / all.length : 0,
    soleWinRate: all.length > 0 ? soleWins / all.length : 0,
    meanChallengerScore: mean(all.map((game) => game.scores[game.seat])),
    meanOpponentScore: mean(
      all.flatMap((game) =>
        PLAYER_COLORS.filter((color) => color !== game.seat).map((color) => game.scores[color]),
      ),
    ),
    meanChallengerPlaced: mean(all.map((game) => squaresPlaced(game.scores[game.seat]))),
    perSeatAdvantage,
  };
}

export function formatMatchSummary(summary: MatchSummary): string {
  const { advantage } = summary;
  const verdict = !advantage.significant
    ? 'not significant'
    : advantage.low > 0
      ? `SIGNIFICANTLY BETTER than ${summary.champion}`
      : `SIGNIFICANTLY WORSE than ${summary.champion}`;
  const seats = PLAYER_COLORS.map(
    (seat) => `${seat} ${summary.perSeatAdvantage[seat].toFixed(2)}`,
  ).join('  ');

  return [
    `${summary.challenger} vs ${summary.champion} — ${summary.games} games over ${summary.seeds} seeds`,
    `Advantage (score − mean of the three ${summary.champion} seats): ${advantage.mean.toFixed(2)} ` +
      `[95% CI ${advantage.low.toFixed(2)}, ${advantage.high.toFixed(2)}] → ${verdict}`,
    `First place: ${(summary.firstPlaceRate * 100).toFixed(1)}% (par 25%), sole wins ${(summary.soleWinRate * 100).toFixed(1)}%`,
    `Mean score: ${summary.meanChallengerScore.toFixed(2)} ` +
      `(opponents ${summary.meanOpponentScore.toFixed(2)}), ` +
      `squares placed ${summary.meanChallengerPlaced.toFixed(2)} / 89`,
    `Per-seat advantage: ${seats}`,
  ].join('\n');
}
