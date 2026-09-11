import type { MoveQuality, PlaceMove } from '../engine/types';
import type { RankedMove } from './mcts';
import { getMoveValue } from './mcts';

const EPSILON = 0.15;
const GOOD_THRESHOLD = 0.8;
const INACCURACY_THRESHOLD = 2.5;

export function classifyMoveQuality(
  rankedMoves: RankedMove[],
  playedMove: PlaceMove,
): { quality: MoveQuality; delta: number } {
  if (rankedMoves.length === 0) {
    return { quality: 'good', delta: 0 };
  }

  const bestValue = rankedMoves[0].value;
  const playedValue = getMoveValue(rankedMoves, playedMove);
  const delta = bestValue - playedValue;

  if (delta <= EPSILON) {
    return { quality: 'best', delta };
  }
  if (delta <= GOOD_THRESHOLD) {
    return { quality: 'good', delta };
  }
  if (delta <= INACCURACY_THRESHOLD) {
    return { quality: 'inaccuracy', delta };
  }
  return { quality: 'blunder', delta };
}

export function visibleQuality(quality: MoveQuality): 'best' | 'blunder' | null {
  if (quality === 'best') {
    return 'best';
  }
  if (quality === 'blunder') {
    return 'blunder';
  }
  return null;
}
