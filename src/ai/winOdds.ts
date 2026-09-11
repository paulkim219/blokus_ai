import { calculateScores, generateLegalMoves } from '../engine/game';
import { cloneBoard } from '../engine/board';
import { PIECES } from '../engine/pieces';
import { PLAYER_COLORS, TURN_ORDER } from '../engine/types';
import type { GameState, PlaceMove, PlayerColor } from '../engine/types';
import { random, randomInt } from './rng';

export type WinOdds = Record<PlayerColor, number>;

export const EMPTY_WIN_ODDS: WinOdds = {
  blue: 25,
  yellow: 25,
  purple: 25,
  green: 25,
};

const PLAYOUT_MOVE_CAP = 14;

function nextPlayer(color: PlayerColor): PlayerColor {
  const index = TURN_ORDER.indexOf(color);
  return TURN_ORDER[(index + 1) % TURN_ORDER.length];
}

function quickMoveScore(move: PlaceMove): number {
  const size = PIECES[move.pieceId].size;
  const center = 9.5;
  const avgDist =
    move.absoluteCells.reduce(
      (sum, cell) => sum + Math.abs(cell.x - center) + Math.abs(cell.y - center),
      0,
    ) / move.absoluteCells.length;
  return size * 4 - avgDist * 0.35;
}

/** Apply a move without history / full legality scans — fast enough for Monte Carlo playouts. */
function applyForPlayout(state: GameState, move: PlaceMove | { type: 'pass'; color: PlayerColor }): GameState {
  const next: GameState = {
    board: cloneBoard(state.board),
    remainingPieces: {
      blue: state.remainingPieces.blue,
      yellow: state.remainingPieces.yellow,
      purple: state.remainingPieces.purple,
      green: state.remainingPieces.green,
    },
    currentTurn: state.currentTurn,
    hasPlayed: { ...state.hasPlayed },
    consecutivePasses: state.consecutivePasses,
    moveHistory: state.moveHistory,
    lastPlacedPieceId: { ...state.lastPlacedPieceId },
    finished: false,
    openingMode: state.openingMode,
  };

  if (move.type === 'pass') {
    next.consecutivePasses += 1;
    if (next.consecutivePasses >= PLAYER_COLORS.length) {
      next.finished = true;
    } else {
      next.currentTurn = nextPlayer(move.color);
    }
    return next;
  }

  for (const cell of move.absoluteCells) {
    next.board[cell.y][cell.x] = move.color;
  }
  next.remainingPieces = {
    ...next.remainingPieces,
    [move.color]: next.remainingPieces[move.color].filter((id) => id !== move.pieceId),
  };
  next.hasPlayed[move.color] = true;
  next.lastPlacedPieceId[move.color] = move.pieceId;
  next.consecutivePasses = 0;
  next.currentTurn = nextPlayer(move.color);
  return next;
}

function pickMove(moves: PlaceMove[]): PlaceMove {
  if (moves.length === 1) {
    return moves[0];
  }

  const scored = moves
    .map((move) => ({ move, score: quickMoveScore(move) }))
    .sort((a, b) => b.score - a.score);

  // Mostly follow the same light policy MCTS uses; keep some randomness for exploration.
  if (random() < 0.7) {
    const topN = Math.min(3, scored.length);
    return scored[randomInt(topN)].move;
  }
  return scored[randomInt(scored.length)].move;
}

/** Play out a game with a light policy until terminal (or safety cap). */
function simulateToEnd(state: GameState): GameState {
  let current = state;
  let passes = 0;
  let steps = 0;

  while (!current.finished && passes < PLAYER_COLORS.length && steps < 160) {
    const moves = generateLegalMoves(current, current.currentTurn, PLAYOUT_MOVE_CAP);
    if (moves.length === 0) {
      current = applyForPlayout(current, { type: 'pass', color: current.currentTurn });
      passes += 1;
      steps += 1;
      continue;
    }
    passes = 0;
    current = applyForPlayout(current, pickMove(moves));
    steps += 1;
  }

  return current;
}

function winnersFromState(state: GameState): PlayerColor[] {
  const scores = calculateScores(state);
  const best = Math.max(...scores.map((entry) => entry.score));
  return scores.filter((entry) => entry.score === best).map((entry) => entry.color);
}

function toPercents(wins: Record<PlayerColor, number>, simulations: number): WinOdds {
  if (simulations <= 0) {
    return { ...EMPTY_WIN_ODDS };
  }
  const raw = PLAYER_COLORS.map((color) => ({
    color,
    value: (wins[color] / simulations) * 100,
  }));
  const rounded = raw.map((entry) => ({
    ...entry,
    value: Math.round(entry.value * 10) / 10,
  }));
  const sum = rounded.reduce((total, entry) => total + entry.value, 0);
  const drift = Math.round((100 - sum) * 10) / 10;
  if (rounded.length > 0) {
    const largest = rounded.reduce((best, entry) => (entry.value > best.value ? entry : best));
    largest.value = Math.round((largest.value + drift) * 10) / 10;
  }

  return Object.fromEntries(rounded.map((entry) => [entry.color, Math.max(0, entry.value)])) as WinOdds;
}

function accumulateWins(state: GameState, simulations: number): Record<PlayerColor, number> {
  const wins: Record<PlayerColor, number> = {
    blue: 0,
    yellow: 0,
    purple: 0,
    green: 0,
  };

  for (let i = 0; i < simulations; i += 1) {
    const winners = winnersFromState(simulateToEnd(state));
    const share = 1 / winners.length;
    for (const winner of winners) {
      wins[winner] += share;
    }
  }

  return wins;
}

/** Synchronous Monte Carlo win-rate estimate (no UI yields). */
export function estimateWinOddsSync(state: GameState, simulations = 96): WinOdds {
  if (state.finished) {
    const winners = winnersFromState(state);
    const odds = { blue: 0, yellow: 0, purple: 0, green: 0 } as WinOdds;
    const share = 100 / Math.max(winners.length, 1);
    for (const winner of winners) {
      odds[winner] = Math.round(share * 10) / 10;
    }
    return odds;
  }

  return toPercents(accumulateWins(state, simulations), simulations);
}

/**
 * Estimate root player's win rate after forcing `move` as the next action.
 * Used to align move suggestions with the win-odds bar.
 */
export function estimateMoveWinRate(
  state: GameState,
  move: PlaceMove,
  simulations = 36,
): number {
  const next = applyForPlayout(state, move);
  return estimateWinOddsSync(next, simulations)[move.color];
}

/** Blend prior odds with a new sample to reduce bar flicker. */
export function smoothWinOdds(previous: WinOdds, next: WinOdds, alpha = 0.55): WinOdds {
  const mixed = PLAYER_COLORS.map((color) => ({
    color,
    value: previous[color] * (1 - alpha) + next[color] * alpha,
  }));
  const sum = mixed.reduce((total, entry) => total + entry.value, 0) || 100;
  const normalized = mixed.map((entry) => ({
    color: entry.color,
    value: Math.round((entry.value / sum) * 1000) / 10,
  }));
  const drift =
    Math.round((100 - normalized.reduce((total, entry) => total + entry.value, 0)) * 10) / 10;
  normalized[0].value = Math.round((normalized[0].value + drift) * 10) / 10;
  return Object.fromEntries(normalized.map((entry) => [entry.color, Math.max(0, entry.value)])) as WinOdds;
}

/**
 * Monte Carlo win-rate estimate: many light playouts (MCTS-style rollouts),
 * counting how often each player finishes with the best score.
 */
export async function estimateWinOdds(
  state: GameState,
  simulations = 96,
  onProgress?: (done: number, total: number, odds: WinOdds) => void,
): Promise<WinOdds> {
  if (state.finished) {
    const odds = estimateWinOddsSync(state, simulations);
    onProgress?.(simulations, simulations, odds);
    return odds;
  }

  const wins: Record<PlayerColor, number> = {
    blue: 0,
    yellow: 0,
    purple: 0,
    green: 0,
  };
  const chunk = 8;

  for (let i = 0; i < simulations; i += 1) {
    const winners = winnersFromState(simulateToEnd(state));
    const share = 1 / winners.length;
    for (const winner of winners) {
      wins[winner] += share;
    }

    if (i === 0 || (i + 1) % chunk === 0 || i === simulations - 1) {
      const odds = toPercents(wins, i + 1);
      onProgress?.(i + 1, simulations, odds);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  return toPercents(wins, simulations);
}
