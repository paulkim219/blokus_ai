export type SearchPhase = 'starting' | 'generating' | 'ranking' | 'searching' | 'done';

export interface SearchProgress {
  phase: SearchPhase;
  percent: number;
  iterations: number;
  maxIterations: number;
  elapsedMs: number;
  timeLimitMs: number;
  candidates: number;
  currentBestLabel?: string;
}

export type ProgressCallback = (progress: SearchProgress) => void | Promise<void>;

export function formatProgressLabel(progress: SearchProgress): string {
  switch (progress.phase) {
    case 'starting':
      return 'Starting search…';
    case 'generating':
      return `Gathering legal moves… (${progress.candidates} found)`;
    case 'ranking':
      return `Scoring candidates… ${progress.iterations}/${Math.max(progress.maxIterations, 1)}`;
    case 'searching':
      return `MCTS search… ${progress.iterations} sims (${Math.round(progress.percent)}%)`;
    case 'done':
      return 'Search complete';
    default:
      return 'Analyzing…';
  }
}
