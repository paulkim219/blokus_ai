import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { cpus } from 'node:os';
import type { PolicyId } from '../../src/ai/selfplay.ts';
import type { AlgoConfig, AlgoVersionId } from '../../src/ai/algoVersions.ts';
import type { FeatureVector } from '../../src/ai/heuristics.ts';
import type { OracleProbeOptions, OracleProbeResult } from '../../src/ai/oracle/probe.ts';
import type { OracleTrajectoryResult } from '../../src/ai/oracle/trajectory.ts';
import type { OracleSearchDiagnostics } from '../../src/ai/oracle/oneLap.ts';
import type { StrategicPersonalityId, StrategicPersonalitySchedule } from '../../src/ai/oracle/strategicPersonalities.ts';
import type { OpeningMode, PlayerColor } from '../../src/engine/types.ts';

/**
 * Pool of self-play worker processes.
 *
 * Separate processes rather than worker threads: the engine keeps module-level caches (the active
 * legal-move cache, the memoised board stats, the algo registry) and a process boundary keeps one
 * game's state from leaking into the next. It also means a crashed game cannot take the run down.
 */
export interface GameAssignment {
  id: string;
  seatVersions: Record<PlayerColor, AlgoVersionId>;
  seatPolicies: Record<PlayerColor, PolicyId>;
  seatPersonalities?: Partial<Record<PlayerColor, StrategicPersonalityId>>;
  seatPersonalitySchedules?: Partial<Record<PlayerColor, StrategicPersonalitySchedule>>;
  seed: number;
  openingMode?: OpeningMode;
  iterationBudget?: number;
  maxPlies?: number;
  openingRandomPlies?: number;
  openingTopK?: number;
  /** Generated configs to register before playing — how the tuner ships candidates to workers. */
  configs?: AlgoConfig[];
  /** Echoed back on the outcome so a caller can log per-ply features from the same run. */
  logFeatures?: boolean;
  /**
   * When set, the worker samples that seat's score (and the mean of the other three) each time it
   * is on move, plus wall-clock for those moves. Used by the public vs-greedy trajectory charts.
   */
  traceSeat?: PlayerColor;
  /** Prediction-only opponent-model audit. It never changes the selected move. */
  oracleProbe?: OracleProbeOptions;
  /** Return exact legal-set features for learned opponent-policy training. */
  oracleTrajectory?: boolean | 'contextual';
  /** Return per-game response-layer activation and timing counters. */
  oracleDiagnostics?: boolean;
}

/** One training row: the position as seen by the side to move, before it moved. */
export interface FeatureSample {
  seat: PlayerColor;
  ply: number;
  progress: number;
  features: FeatureVector;
}

/** Per-own-turn scores for `traceSeat`, sampled when that seat is on move. Variable length. */
export interface ScoreTrace {
  hero: number[];
  opponents: number[];
  heroMs: number;
  heroMoves: number;
}

export interface GameOutcome {
  id: string;
  scores: Record<PlayerColor, number>;
  winner: PlayerColor[];
  plies: number;
  finished: boolean;
  durationMs: number;
  samples?: FeatureSample[];
  scoreTrace?: ScoreTrace;
  oracleProbe?: OracleProbeResult;
  oracleTrajectory?: OracleTrajectoryResult;
  oracleSearch?: OracleSearchDiagnostics;
  error?: string;
}

export function defaultWorkerCount(): number {
  return Math.max(1, Math.min(8, cpus().length - 2));
}

/** stderr is inherited so worker crashes surface in the run's own output. */
type WorkerProcess = ChildProcessByStdio<Writable, Readable, null>;

interface Worker {
  child: WorkerProcess;
  busy: boolean;
}

export class GamePool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<string, (outcome: GameOutcome) => void>();

  constructor(size: number = defaultWorkerCount()) {
    const script = join(process.cwd(), 'scripts', 'tournamentWorker.ts');
    // Use Node's loader instead of the tsx CLI. The CLI creates an IPC socket for its optional
    // process-control layer, which restricted runners reject; the loader executes the same
    // TypeScript without a wrapper or socket, so closing this child still closes the real worker.
    for (let i = 0; i < size; i += 1) {
      const child: WorkerProcess = spawn(process.execPath, ['--import', 'tsx', script], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const worker: Worker = { child, busy: false };
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith('{')) {
          return;
        }
        const outcome = JSON.parse(line) as GameOutcome;
        worker.busy = false;
        this.pending.get(outcome.id)?.(outcome);
        this.pending.delete(outcome.id);
      });
      this.workers.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Runs every assignment, keeping all workers fed. `onResult` fires as each game lands. */
  async run(
    assignments: GameAssignment[],
    onResult?: (outcome: GameOutcome, done: number, total: number) => void,
  ): Promise<GameOutcome[]> {
    const queue = [...assignments];
    const outcomes: GameOutcome[] = [];
    let done = 0;

    return new Promise((resolve) => {
      if (queue.length === 0) {
        resolve(outcomes);
        return;
      }

      const dispatch = (): void => {
        for (const worker of this.workers) {
          if (worker.busy || queue.length === 0) {
            continue;
          }
          const assignment = queue.shift()!;
          worker.busy = true;
          this.pending.set(assignment.id, (outcome) => {
            outcomes.push(outcome);
            done += 1;
            onResult?.(outcome, done, assignments.length);
            if (done === assignments.length) {
              resolve(outcomes);
            } else {
              dispatch();
            }
          });
          worker.child.stdin.write(`${JSON.stringify(assignment)}\n`);
        }
      };

      dispatch();
    });
  }

  /** Ending stdin lets a worker exit cleanly; the kill is the backstop for one that hangs. */
  close(): void {
    for (const worker of this.workers) {
      worker.child.stdin.end();
      worker.child.kill('SIGTERM');
    }
  }
}
