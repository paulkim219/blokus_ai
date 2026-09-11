import { COLOR_LABELS } from '../engine/types';
import type { PlaceMove, PlayerColor } from '../engine/types';
import { PIECES } from '../engine/pieces';
import { applyMove } from '../engine/game';
import type { GameState } from '../engine/types';
import { extractFeatures, featureDelta, scoreFeatures } from './heuristics';
import type { FeatureVector } from './heuristics';

const FEATURE_MESSAGES: Record<string, (delta: number, opponent?: PlayerColor) => string> = {
  placedSquares: (delta) =>
    delta > 0
      ? `Places ${delta} more square${delta === 1 ? '' : 's'} on the board.`
      : `Leaves ${Math.abs(delta)} fewer square${Math.abs(delta) === 1 ? '' : 's'} placed.`,
  cornerAccess: (delta) =>
    delta > 0
      ? `Keeps ${delta} more corner outlet${delta === 1 ? '' : 's'} for future moves.`
      : `Closes ${Math.abs(delta)} corner outlet${Math.abs(delta) === 1 ? '' : 's'}.`,
  mobility: (delta) =>
    delta > 0
      ? `Maintains ${delta} more legal follow-up option${delta === 1 ? '' : 's'}.`
      : `Reduces your follow-up options by ${Math.abs(delta)}.`,
  opponentMobility: (delta) =>
    delta < 0
      ? `Restricts opponents by about ${Math.abs(delta).toFixed(0)} future move options.`
      : `Allows opponents more room to expand.`,
  centerControl: (delta) =>
    delta > 0 ? 'Claims stronger influence toward the center.' : 'Cedes central influence.',
  territory: (delta) =>
    delta > 0
      ? `Expands your territory by roughly ${delta} square${delta === 1 ? '' : 's'}.`
      : `Gives up roughly ${Math.abs(delta)} square${Math.abs(delta) === 1 ? '' : 's'} of territory.`,
  blocking: (delta) =>
    delta > 0 ? 'Applies more pressure on opponent corners.' : 'Applies less corner pressure.',
  remainingPenalty: (delta) =>
    delta < 0
      ? 'Uses a larger piece earlier, reducing endgame penalty risk.'
      : 'Leaves heavier pieces unused for now.',
};

function simulateMove(state: GameState, move: PlaceMove): GameState {
  return applyMove(state, move);
}

export function explainMoveChoice(
  state: GameState,
  played: PlaceMove,
  best: PlaceMove | null,
): string[] {
  if (!best) {
    return ['No alternative legal move was found in this position.'];
  }

  const before = extractFeatures(state, played.color);
  const playedAfter = extractFeatures(simulateMove(state, played), played.color);
  const bestAfter = extractFeatures(simulateMove(state, best), played.color);
  const playedDelta = featureDelta(before, playedAfter);
  const bestDelta = featureDelta(before, bestAfter);

  const reasons: string[] = [];
  const bestPiece = PIECES[best.pieceId].name;
  const playedPiece = PIECES[played.pieceId].name;

  reasons.push(
    `Best was ${bestPiece} at (${best.anchor.x}, ${best.anchor.y}); you played ${playedPiece} at (${played.anchor.x}, ${played.anchor.y}).`,
  );

  const keys: Array<keyof FeatureVector> = [
    'placedSquares',
    'cornerAccess',
    'mobility',
    'opponentMobility',
    'centerControl',
    'territory',
    'blocking',
    'remainingPenalty',
  ];
  const ranked = keys
    .map((key) => {
      const improvement = (bestDelta[key] ?? 0) - (playedDelta[key] ?? 0);
      return { key, improvement };
    })
    .sort((a, b) => b.improvement - a.improvement)
    .slice(0, 3);

  for (const entry of ranked) {
    const delta = (bestDelta[entry.key] ?? 0) - (playedDelta[entry.key] ?? 0);
    if (Math.abs(delta) < 0.5) {
      continue;
    }
    const opponent = findMostThreatenedOpponent(played.color);
    reasons.push(FEATURE_MESSAGES[entry.key](delta, opponent));
  }

  const bestScore = scoreFeatures(bestAfter);
  const playedScore = scoreFeatures(playedAfter);
  reasons.push(
    `Position score for ${COLOR_LABELS[played.color]} improves from ${playedScore.toFixed(1)} to ${bestScore.toFixed(1)} with the recommended move.`,
  );

  return reasons.slice(0, 4);
}

function findMostThreatenedOpponent(color: PlayerColor): PlayerColor {
  const opponents = (['blue', 'yellow', 'purple', 'green'] as PlayerColor[]).filter(
    (entry) => entry !== color,
  );
  return opponents[0];
}

export function suggestionTip(state: GameState, move: PlaceMove): string {
  const before = extractFeatures(state, move.color);
  const after = extractFeatures(simulateMove(state, move), move.color);
  const delta = featureDelta(before, after);
  if ((delta.cornerAccess ?? 0) > 1) {
    return 'Opens multiple corner routes for your next turns.';
  }
  if ((delta.opponentMobility ?? 0) < -2) {
    return 'Limits opponent expansion while keeping your options open.';
  }
  if ((delta.territory ?? 0) > 2) {
    return 'Claims useful territory toward the middle of the board.';
  }
  return `Strong placement with ${PIECES[move.pieceId].name} from (${move.anchor.x}, ${move.anchor.y}).`;
}
