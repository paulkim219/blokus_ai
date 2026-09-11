import type { SearchProgress } from '../ai/progress';
import {
  runAnalyzePlayedMove,
  runBatchAnalyze,
  runPonderMove,
  runSuggestMove,
} from '../ai/runAnalysis';
import { estimateWinOdds, type WinOdds } from '../ai/winOdds';
import type { GameState } from '../engine/types';
import type { WorkerRequest, WorkerResponse } from './ai.worker';

type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (progress: SearchProgress) => void;
  onOddsProgress?: (done: number, total: number, odds: WinOdds) => void;
};

let searchWorker: Worker | null = null;
let oddsWorker: Worker | null = null;
let searchWorkerFailed = false;
let oddsWorkerFailed = false;
const pending = new Map<string, Pending>();

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function markWorkerFailed(kind: 'search' | 'odds', _reason: unknown): void {
  const worker = kind === 'search' ? searchWorker : oddsWorker;
  try {
    worker?.terminate();
  } catch {
    // ignore
  }
  if (kind === 'search') {
    searchWorkerFailed = true;
    searchWorker = null;
  } else {
    oddsWorkerFailed = true;
    oddsWorker = null;
  }
}

function attachWorkerHandlers(worker: Worker, kind: 'search' | 'odds'): void {
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) {
      return;
    }

    if (response.type === 'progress') {
      entry.onProgress?.(response.progress);
      return;
    }
    if (response.type === 'oddsProgress') {
      entry.onOddsProgress?.(response.done, response.total, response.odds);
      return;
    }

    pending.delete(response.id);
    if (response.type === 'error') {
      entry.reject(new Error(response.message));
      return;
    }
    entry.resolve(response);
  };

  worker.onerror = (error) => {
    markWorkerFailed(kind, error);
  };

  worker.onmessageerror = (error) => {
    markWorkerFailed(kind, error);
  };
}

function getSearchWorker(): Worker | null {
  if (searchWorkerFailed) {
    return null;
  }
  if (!searchWorker) {
    try {
      searchWorker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      markWorkerFailed('search', error);
      return null;
    }
    attachWorkerHandlers(searchWorker, 'search');
  }
  return searchWorker;
}

function getOddsWorker(): Worker | null {
  if (oddsWorkerFailed) {
    return null;
  }
  if (!oddsWorker) {
    try {
      oddsWorker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      markWorkerFailed('odds', error);
      return null;
    }
    attachWorkerHandlers(oddsWorker, 'odds');
  }
  return oddsWorker;
}

async function sendViaWorker<T extends Exclude<WorkerResponse['type'], 'progress' | 'error' | 'oddsProgress'>>(
  request: WorkerRequest,
  options?: {
    onProgress?: (progress: SearchProgress) => void;
    onOddsProgress?: (done: number, total: number, odds: WinOdds) => void;
    workerKind?: 'search' | 'odds';
  },
): Promise<Extract<WorkerResponse, { type: T }>> {
  const kind = options?.workerKind ?? 'search';
  const activeWorker = kind === 'odds' ? getOddsWorker() : getSearchWorker();
  if (!activeWorker) {
    throw new Error('AI worker unavailable');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      pending.delete(request.id);
      try {
        activeWorker.terminate();
      } catch {
        // ignore
      }
      if (kind === 'odds') {
        oddsWorker = null;
        oddsWorkerFailed = true;
      } else {
        searchWorker = null;
        searchWorkerFailed = true;
      }
      reject(new Error('AI worker timed out before first response'));
    }, 1500);

    pending.set(request.id, {
      resolve: (response) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        resolve(response as Extract<WorkerResponse, { type: T }>);
      },
      reject: (reason) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        reject(reason);
      },
      onProgress: (progress) => {
        window.clearTimeout(timeout);
        options?.onProgress?.(progress);
      },
      onOddsProgress: (done, total, odds) => {
        window.clearTimeout(timeout);
        options?.onOddsProgress?.(done, total, odds);
      },
    });

    try {
      activeWorker.postMessage(request);
    } catch (error) {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        pending.delete(request.id);
        markWorkerFailed(kind, error);
        reject(error instanceof Error ? error : new Error('Failed to post to AI worker'));
      }
    }
  });
}

async function runOnMainThread(
  request: WorkerRequest,
  onProgress?: (progress: SearchProgress) => void,
  onOddsProgress?: (done: number, total: number, odds: WinOdds) => void,
): Promise<WorkerResponse> {
  switch (request.type) {
    case 'suggestMove': {
      const result = await runSuggestMove({ ...request, onProgress });
      return { id: request.id, type: 'suggestMove', ...result };
    }
    case 'ponder': {
      const result = await runPonderMove({ ...request, onProgress });
      return { id: request.id, type: 'ponder', ...result };
    }
    case 'estimateWinOdds': {
      const odds = await estimateWinOdds(request.state, request.simulations, onOddsProgress);
      return { id: request.id, type: 'estimateWinOdds', odds };
    }
    case 'analyzePlayedMove': {
      const result = await runAnalyzePlayedMove({ ...request, onProgress });
      return {
        id: request.id,
        type: 'analyzePlayedMove',
        ...result,
        rankedMoves: [],
      };
    }
    case 'batchAnalyze': {
      const result = await runBatchAnalyze({ ...request, onProgress });
      return { id: request.id, type: 'batchAnalyze', ...result };
    }
    case 'analyzePosition': {
      const result = await runSuggestMove({ ...request, onProgress });
      return {
        id: request.id,
        type: 'analyzePosition',
        bestMove: result.bestMove,
        rankedMoves: [],
        confidence: result.confidence,
        tip: result.tip,
      };
    }
    default:
      throw new Error('Unknown analysis request');
  }
}

async function sendRequest<T extends Exclude<WorkerResponse['type'], 'progress' | 'error' | 'oddsProgress'>>(
  request: WorkerRequest,
  options?: {
    onProgress?: (progress: SearchProgress) => void;
    onOddsProgress?: (done: number, total: number, odds: WinOdds) => void;
    workerKind?: 'search' | 'odds';
  },
): Promise<Extract<WorkerResponse, { type: T }>> {
  const kind = options?.workerKind ?? 'search';
  const failed = kind === 'odds' ? oddsWorkerFailed : searchWorkerFailed;
  if (!failed) {
    try {
      return await sendViaWorker<T>(request, options);
    } catch {
      if (kind === 'odds') {
        oddsWorkerFailed = true;
      } else {
        searchWorkerFailed = true;
      }
    }
  }

  const response = await runOnMainThread(request, options?.onProgress, options?.onOddsProgress);
  return response as Extract<WorkerResponse, { type: T }>;
}

export async function requestSuggestion(
  request: Omit<Extract<WorkerRequest, { type: 'suggestMove' }>, 'id'>,
  onProgress?: (progress: SearchProgress) => void,
) {
  return sendRequest<'suggestMove'>({ ...request, id: createId() }, { onProgress });
}

export async function requestPonder(
  request: Omit<Extract<WorkerRequest, { type: 'ponder' }>, 'id'>,
  onProgress?: (progress: SearchProgress) => void,
) {
  return sendRequest<'ponder'>({ ...request, id: createId() }, { onProgress });
}

export async function requestWinOdds(
  state: GameState,
  simulations: number,
  onProgress?: (done: number, total: number, odds: WinOdds) => void,
) {
  return sendRequest<'estimateWinOdds'>(
    { id: createId(), type: 'estimateWinOdds', state, simulations },
    { onOddsProgress: onProgress, workerKind: 'odds' },
  );
}

export async function requestPlayedMoveAnalysis(
  request: Omit<Extract<WorkerRequest, { type: 'analyzePlayedMove' }>, 'id'>,
  onProgress?: (progress: SearchProgress) => void,
) {
  return sendRequest<'analyzePlayedMove'>({ ...request, id: createId() }, { onProgress });
}

export async function requestBatchAnalysis(
  request: Omit<Extract<WorkerRequest, { type: 'batchAnalyze' }>, 'id'>,
  onProgress?: (progress: SearchProgress) => void,
) {
  return sendRequest<'batchAnalyze'>({ ...request, id: createId() }, { onProgress });
}

export function terminateAiWorker(): void {
  searchWorker?.terminate();
  oddsWorker?.terminate();
  searchWorker = null;
  oddsWorker = null;
  pending.clear();
}
