import { analyzeBeforeMove, ponderNextMove } from '../ai/mcts';
import { preloadUiArtifacts } from '../ai/preloadUiArtifacts';
import { classifyMoveQuality } from '../ai/quality';
import { explainMoveChoice, suggestionTip } from '../ai/explain';
import { getStateAtMoveIndex } from '../engine/game';
import type { SearchProgress } from '../ai/progress';
import { estimateWinOdds, type WinOdds } from '../ai/winOdds';
import type { GameState, MoveAnalysis, PlaceMove, PlayerColor } from '../engine/types';
import type { AlgoVersionId } from '../ai/algoVersions';
import type { SearchOptions } from '../ai/searchTypes';

preloadUiArtifacts();

interface VersionedSearch {
  version?: AlgoVersionId;
  iterationBudget?: number;
}

function searchOptionsFrom(request: VersionedSearch): SearchOptions {
  return {
    version: request.version,
    iterationBudget: request.iterationBudget,
  };
}

export type WorkerRequest =
  | {
      id: string;
      type: 'analyzePosition';
      state: GameState;
      player: PlayerColor;
      timeLimitMs: number;
      version?: AlgoVersionId;
      iterationBudget?: number;
    }
  | {
      id: string;
      type: 'analyzePlayedMove';
      stateBefore: GameState;
      played: PlaceMove;
      player: PlayerColor;
      timeLimitMs: number;
      version?: AlgoVersionId;
      iterationBudget?: number;
    }
  | {
      id: string;
      type: 'suggestMove';
      state: GameState;
      player: PlayerColor;
      timeLimitMs: number;
      version?: AlgoVersionId;
      iterationBudget?: number;
    }
  | {
      id: string;
      type: 'ponder';
      state: GameState;
      player: PlayerColor;
      timeLimitMs: number;
      version?: AlgoVersionId;
      iterationBudget?: number;
    }
  | {
      id: string;
      type: 'estimateWinOdds';
      state: GameState;
      simulations: number;
    }
  | {
      id: string;
      type: 'batchAnalyze';
      state: GameState;
      player: PlayerColor;
      moveIndices: number[];
      timeLimitMs: number;
      version?: AlgoVersionId;
      iterationBudget?: number;
    };

export type WorkerResponse =
  | {
      id: string;
      type: 'progress';
      progress: SearchProgress;
    }
  | {
      id: string;
      type: 'oddsProgress';
      done: number;
      total: number;
      odds: WinOdds;
    }
  | {
      id: string;
      type: 'analyzePosition';
      bestMove: PlaceMove | null;
      rankedMoves: Awaited<ReturnType<typeof analyzeBeforeMove>>['rankedMoves'];
      confidence: number;
      tip?: string;
    }
  | {
      id: string;
      type: 'analyzePlayedMove';
      bestMove: PlaceMove | null;
      quality: ReturnType<typeof classifyMoveQuality>['quality'];
      delta: number;
      reasons: string[];
      rankedMoves: Awaited<ReturnType<typeof analyzeBeforeMove>>['rankedMoves'];
    }
  | {
      id: string;
      type: 'suggestMove';
      bestMove: PlaceMove | null;
      tip: string;
      confidence: number;
    }
  | {
      id: string;
      type: 'ponder';
      bestMove: PlaceMove | null;
      tip: string;
      confidence: number;
    }
  | {
      id: string;
      type: 'estimateWinOdds';
      odds: WinOdds;
    }
  | {
      id: string;
      type: 'batchAnalyze';
      analyses: MoveAnalysis[];
    }
  | {
      id: string;
      type: 'error';
      message: string;
    };

let activeJob = 0;
let lastProgressYield = 0;

function isCancelled(job: number): boolean {
  return job !== activeJob;
}

/** Post progress and yield occasionally so the UI thread can paint updates. */
async function reportProgress(id: string, progress: SearchProgress, job: number): Promise<void> {
  if (isCancelled(job)) {
    return;
  }
  const response: WorkerResponse = { id, type: 'progress', progress };
  self.postMessage(response);
  const force = progress.phase === 'done' || progress.phase === 'starting';
  const now = performance.now();
  if (!force && now - lastProgressYield < 150) {
    return;
  }
  lastProgressYield = now;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const job = ++activeJob;
  void (async () => {
    try {
      switch (request.type) {
        case 'analyzePosition': {
          const result = await analyzeBeforeMove(
            request.state,
            request.player,
            request.timeLimitMs,
            (progress) => reportProgress(request.id, progress, job),
            searchOptionsFrom(request),
          );
          if (isCancelled(job)) {
            return;
          }
          const response: WorkerResponse = {
            id: request.id,
            type: 'analyzePosition',
            bestMove: result.bestMove,
            rankedMoves: result.rankedMoves,
            confidence: result.confidence,
            tip: result.bestMove ? suggestionTip(request.state, result.bestMove) : undefined,
          };
          self.postMessage(response);
          break;
        }
        case 'suggestMove': {
          const result = await analyzeBeforeMove(
            request.state,
            request.player,
            request.timeLimitMs,
            (progress) => reportProgress(request.id, progress, job),
            searchOptionsFrom(request),
          );
          if (isCancelled(job)) {
            return;
          }
          const response: WorkerResponse = {
            id: request.id,
            type: 'suggestMove',
            bestMove: result.bestMove,
            tip: result.bestMove
              ? suggestionTip(request.state, result.bestMove)
              : 'No legal moves available.',
            confidence: result.confidence,
          };
          self.postMessage(response);
          break;
        }
        case 'ponder': {
          const result = await ponderNextMove(
            request.state,
            request.player,
            request.timeLimitMs,
            (progress) => reportProgress(request.id, progress, job),
            () => isCancelled(job),
            searchOptionsFrom(request),
          );
          if (isCancelled(job)) {
            return;
          }
          const response: WorkerResponse = {
            id: request.id,
            type: 'ponder',
            bestMove: result.bestMove,
            tip: result.bestMove
              ? suggestionTip(request.state, result.bestMove)
              : 'No legal moves available.',
            confidence: result.confidence,
          };
          self.postMessage(response);
          break;
        }
        case 'estimateWinOdds': {
          const odds = await estimateWinOdds(request.state, request.simulations, (done, total, current) => {
            if (isCancelled(job)) {
              return;
            }
            const response: WorkerResponse = {
              id: request.id,
              type: 'oddsProgress',
              done,
              total,
              odds: current,
            };
            self.postMessage(response);
          });
          if (isCancelled(job)) {
            return;
          }
          const response: WorkerResponse = {
            id: request.id,
            type: 'estimateWinOdds',
            odds,
          };
          self.postMessage(response);
          break;
        }
        case 'analyzePlayedMove': {
          const result = await analyzeBeforeMove(
            request.stateBefore,
            request.player,
            request.timeLimitMs,
            (progress) => reportProgress(request.id, progress, job),
            searchOptionsFrom(request),
          );
          if (isCancelled(job)) {
            return;
          }
          const { quality, delta } = classifyMoveQuality(result.rankedMoves, request.played);
          const response: WorkerResponse = {
            id: request.id,
            type: 'analyzePlayedMove',
            bestMove: result.bestMove,
            quality,
            delta,
            reasons: explainMoveChoice(request.stateBefore, request.played, result.bestMove),
            rankedMoves: result.rankedMoves,
          };
          self.postMessage(response);
          break;
        }
        case 'batchAnalyze': {
          const analyses: MoveAnalysis[] = [];
          const total = request.moveIndices.length || 1;
          for (let i = 0; i < request.moveIndices.length; i += 1) {
            if (isCancelled(job)) {
              return;
            }
            const moveIndex = request.moveIndices[i];
            await reportProgress(
              request.id,
              {
                phase: 'searching',
                percent: ((i + 1) / total) * 100,
                iterations: i + 1,
                maxIterations: total,
                elapsedMs: 0,
                timeLimitMs: request.timeLimitMs * total,
                candidates: total,
                currentBestLabel: `Reviewing move #${moveIndex + 1}`,
              },
              job,
            );
            const stateBefore = getStateAtMoveIndex(request.state, moveIndex);
            const move = request.state.moveHistory[moveIndex];
            if (!move || move.type !== 'place' || move.color !== request.player) {
              continue;
            }
            const result = await analyzeBeforeMove(
              stateBefore,
              request.player,
              request.timeLimitMs,
              undefined,
              searchOptionsFrom(request),
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
          if (isCancelled(job)) {
            return;
          }
          const response: WorkerResponse = {
            id: request.id,
            type: 'batchAnalyze',
            analyses,
          };
          self.postMessage(response);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      if (isCancelled(job)) {
        return;
      }
      const response: WorkerResponse = {
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown worker error',
      };
      self.postMessage(response);
    }
  })();
};

export {};
