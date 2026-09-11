import { analyzeBeforeMove, ponderNextMove } from './mcts';
import { preloadUiArtifacts } from './preloadUiArtifacts';
import { classifyMoveQuality } from './quality';
import { explainMoveChoice, suggestionTip } from './explain';
import { getStateAtMoveIndex } from '../engine/game';
import type { SearchProgress } from './progress';
import type { SearchOptions } from './searchTypes';
import type { GameState, MoveAnalysis, PlaceMove, PlayerColor } from '../engine/types';
import type { AlgoVersionId } from './algoVersions';

preloadUiArtifacts();

async function yieldProgress(
  onProgress: ((progress: SearchProgress) => void) | undefined,
  progress: SearchProgress,
): Promise<void> {
  onProgress?.(progress);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function searchOptions(version?: AlgoVersionId, iterationBudget?: number): SearchOptions {
  return { version, iterationBudget };
}

export async function runPonderMove(options: {
  state: GameState;
  player: PlayerColor;
  timeLimitMs: number;
  version?: AlgoVersionId;
  iterationBudget?: number;
  onProgress?: (progress: SearchProgress) => void;
}): Promise<{ bestMove: PlaceMove | null; tip: string; confidence: number }> {
  const result = await ponderNextMove(
    options.state,
    options.player,
    options.timeLimitMs,
    (progress) => yieldProgress(options.onProgress, progress),
    undefined,
    searchOptions(options.version, options.iterationBudget),
  );
  return {
    bestMove: result.bestMove,
    tip: result.bestMove
      ? suggestionTip(options.state, result.bestMove)
      : 'No legal moves available.',
    confidence: result.confidence,
  };
}

export async function runSuggestMove(options: {
  state: GameState;
  player: PlayerColor;
  timeLimitMs: number;
  version?: AlgoVersionId;
  iterationBudget?: number;
  onProgress?: (progress: SearchProgress) => void;
}): Promise<{ bestMove: PlaceMove | null; tip: string; confidence: number }> {
  const result = await analyzeBeforeMove(
    options.state,
    options.player,
    options.timeLimitMs,
    (progress) => yieldProgress(options.onProgress, progress),
    searchOptions(options.version, options.iterationBudget),
  );
  return {
    bestMove: result.bestMove,
    tip: result.bestMove
      ? suggestionTip(options.state, result.bestMove)
      : 'No legal moves available.',
    confidence: result.confidence,
  };
}

export async function runAnalyzePlayedMove(options: {
  stateBefore: GameState;
  played: PlaceMove;
  player: PlayerColor;
  timeLimitMs: number;
  version?: AlgoVersionId;
  iterationBudget?: number;
  onProgress?: (progress: SearchProgress) => void;
}): Promise<{
  bestMove: PlaceMove | null;
  quality: ReturnType<typeof classifyMoveQuality>['quality'];
  delta: number;
  reasons: string[];
}> {
  const result = await analyzeBeforeMove(
    options.stateBefore,
    options.player,
    options.timeLimitMs,
    (progress) => yieldProgress(options.onProgress, progress),
    searchOptions(options.version, options.iterationBudget),
  );
  const { quality, delta } = classifyMoveQuality(result.rankedMoves, options.played);
  return {
    bestMove: result.bestMove,
    quality,
    delta,
    reasons: explainMoveChoice(options.stateBefore, options.played, result.bestMove),
  };
}

export async function runBatchAnalyze(options: {
  state: GameState;
  player: PlayerColor;
  moveIndices: number[];
  timeLimitMs: number;
  version?: AlgoVersionId;
  iterationBudget?: number;
  onProgress?: (progress: SearchProgress) => void;
}): Promise<{ analyses: MoveAnalysis[] }> {
  const analyses: MoveAnalysis[] = [];
  const total = options.moveIndices.length || 1;
  const opts = searchOptions(options.version, options.iterationBudget);
  for (let i = 0; i < options.moveIndices.length; i += 1) {
    const moveIndex = options.moveIndices[i];
    await yieldProgress(options.onProgress, {
      phase: 'searching',
      percent: ((i + 1) / total) * 100,
      iterations: i + 1,
      maxIterations: total,
      elapsedMs: 0,
      timeLimitMs: options.timeLimitMs * total,
      candidates: total,
      currentBestLabel: `Reviewing move #${moveIndex + 1}`,
    });
    const stateBefore = getStateAtMoveIndex(options.state, moveIndex);
    const move = options.state.moveHistory[moveIndex];
    if (!move || move.type !== 'place' || move.color !== options.player) {
      continue;
    }
    const result = await analyzeBeforeMove(
      stateBefore,
      options.player,
      options.timeLimitMs,
      undefined,
      opts,
    );
    const { quality, delta } = classifyMoveQuality(result.rankedMoves, move);
    analyses.push({
      moveIndex,
      played: move,
      best: result.bestMove,
      quality,
      delta,
      reasons: explainMoveChoice(stateBefore, move, result.bestMove),
    });
  }
  return { analyses };
}
