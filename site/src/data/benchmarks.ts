import type { ComparatorId, GenerationId, ModelId } from './models';
import { MODELS, MODEL_ORDER } from './models';
import payload from './greedyTrajectories.json' with { type: 'json' };
import predecessorPayload from './predecessorTrajectories.json' with { type: 'json' };
import v31Payload from './v31Trajectories.json' with { type: 'json' };
import v32ProPayload from './v32ProTrajectories.json' with { type: 'json' };

export const V31_BASELINE: ModelId = 'hanni-3-1';
/**
 * The stronger reference for the second Pareto chart.
 *
 * The vs-3.1 chart compresses at the top: Hanni 4.1 Pro Max and Ultra both land near +4.8 against
 * it while being 1.49 apart head-to-head, because an engine placing ~80 of 89 squares has little
 * margin left to win. Unlike 3.1, this baseline is *kept* in its own chart at exactly zero delta so
 * its cost is visible rather than inferred.
 */
export const V32_PRO_BASELINE: ModelId = 'hanni-3-2-pro';

export const CROP_FROM = 16;
export const CROP_TO = 21;
export const MIN_PUBLIC_GAMES = 400;

const GENERATION_RANK: Record<GenerationId, number> = {
  '1': 1,
  '2': 2,
  '3.1': 3,
  '3.2': 4,
  '3.5': 5,
  '3.6': 6,
  '3.7': 7,
  '4.1': 8,
  '4': 9,
};

export interface GreedyTrajectoryResult {
  id: ModelId;
  algoId: string;
  games: number;
  seeds: number;
  turns: number;
  delta: number[];
  deltaLow: number[];
  deltaHigh: number[];
  heroMsPerMove: number;
  finalDelta: number;
  finalCi: [number, number];
  finishedAt?: string;
}

interface FilePayload {
  protocol: string;
  seeds: number;
  games: number;
  iterations: number;
  cropFrom: number;
  results: GreedyTrajectoryResult[];
}

const file = payload as FilePayload;

export const GREEDY_TRAJECTORIES: GreedyTrajectoryResult[] = (file.results ?? []).filter(
  (row): row is GreedyTrajectoryResult =>
    typeof row.id === 'string' &&
    row.id in MODELS &&
    (row.games ?? 0) >= MIN_PUBLIC_GAMES &&
    Array.isArray(row.delta) &&
    row.delta.length >= CROP_TO + 1,
);

export function visibleModelIds(generation: GenerationId): ModelId[] {
  const cap = GENERATION_RANK[generation];
  return MODEL_ORDER.filter((id) => {
    const model = MODELS[id];
    return model.status !== 'coming-soon' && GENERATION_RANK[model.generation] <= cap;
  });
}

/** Distinct hues per model so an overlay of eleven lines stays readable. */
export const MODEL_COLOR: Record<ModelId, string> = {
  'hanni-1': '#d8d4cc',
  'hanni-2-lite': '#f0c35a',
  'hanni-2-pro': '#e3a318',
  'hanni-3-1-nano': '#8ec8f0',
  'hanni-3-1-lite': '#5aa8d4',
  'hanni-3-1': '#3d8fbe',
  'hanni-3-1-pro': '#2f79d7',
  'hanni-3-1-pro-max': '#1d5fbc',
  'hanni-3-2-lite': '#e6ccfa',
  'hanni-3-2': '#d4a8f5',
  'hanni-3-2-pro': '#c084fc',
  'hanni-3-2-pro-max': '#8b3fd1',
  'hanni-3-5-lite': '#8fd6a8',
  'hanni-3-5': '#5cc489',
  'hanni-3-5-pro': '#2fa568',
  'hanni-3-6-pro-max': '#17794a',
  'hanni-3-7-lite': '#f2a3a3',
  'hanni-3-7': '#e8736f',
  'hanni-3-7-pro': '#d94f45',
  'hanni-3-7-pro-max': '#a82c26',
  'hanni-4-1-lite': '#7dd3d8',
  'hanni-4-1': '#2cb5bc',
  'hanni-4-1-pro': '#0e8f96',
  'hanni-4-1-pro-max': '#0b6b71',
  'hanni-4-1-ultra': '#064a4f',
  'hanni-4': '#6b6560',
};

export const FAMILY_COLOR: Record<Exclude<GenerationId, '4'>, string> = {
  '1': '#d8d4cc',
  '2': '#e3a318',
  '3.1': '#3d9be0',
  '3.2': '#c084fc',
  '3.5': '#2fa568',
  '3.6': '#17794a',
  '3.7': '#d94f45',
  '4.1': '#0e8f96',
};

export const FAMILY_LABEL: Record<Exclude<GenerationId, '4'>, string> = {
  '1': 'Hanni 1',
  '2': 'Hanni 2',
  '3.1': 'Hanni 3.1',
  '3.2': 'Hanni 3.2',
  '3.5': 'Hanni 3.5',
  '3.6': 'Hanni 3.6',
  '3.7': 'Hanni 3.7',
  '4.1': 'Hanni 4.1',
};

export const PROTOCOL_CAPTION =
  'Score minus the mean of three one-ply greedy seats, seat-rotated, 400 games, 300-iteration base scaled by each configuration’s iteration budget.';

export const V31_PROTOCOL_CAPTION =
  'Score minus the mean of three Hanni 3.1 seats, seat-rotated, 400 games, 300-iteration base scaled by each configuration’s iteration budget. Hanni 3.1 itself is the floor, so it is not plotted.';

export const V32_PRO_PROTOCOL_CAPTION =
  'Score minus the mean of three Hanni 3.2 Pro seats, seat-rotated, 400 games, 300-iteration base scaled by each configuration\u2019s iteration budget. Hanni 3.2 Pro is plotted at exactly zero \u2014 a seat-rotated mirror match is zero by construction \u2014 so the reference\u2019s own cost is visible.';

export const CROP_CAPTION =
  'Own-turns 0–15 are omitted so the plot starts where the engines have diverged.';

export function trajectoryFor(id: ModelId): GreedyTrajectoryResult | undefined {
  return GREEDY_TRAJECTORIES.find((row) => row.id === id);
}

const v31File = v31Payload as FilePayload;

export const V31_TRAJECTORIES: GreedyTrajectoryResult[] = (v31File.results ?? []).filter(
  (row): row is GreedyTrajectoryResult =>
    typeof row.id === 'string' &&
    row.id in MODELS &&
    row.id !== V31_BASELINE &&
    (row.games ?? 0) >= MIN_PUBLIC_GAMES &&
    Array.isArray(row.delta) &&
    row.delta.length >= CROP_TO + 1,
);

export function v31TrajectoryFor(id: ModelId): GreedyTrajectoryResult | undefined {
  return V31_TRAJECTORIES.find((row) => row.id === id);
}

export function visibleVs31ModelIds(generation: GenerationId): ModelId[] {
  return visibleModelIds(generation).filter((id) => id !== V31_BASELINE);
}

const v32ProFile = v32ProPayload as unknown as FilePayload;

export const V32_PRO_TRAJECTORIES: GreedyTrajectoryResult[] = (v32ProFile.results ?? []).filter(
  (row): row is GreedyTrajectoryResult =>
    typeof row.id === 'string' &&
    row.id in MODELS &&
    (row.games ?? 0) >= MIN_PUBLIC_GAMES &&
    Array.isArray(row.delta) &&
    row.delta.length >= CROP_TO + 1,
);

export function v32ProTrajectoryFor(id: ModelId): GreedyTrajectoryResult | undefined {
  return V32_PRO_TRAJECTORIES.find((row) => row.id === id);
}

/** The reference stays in this chart, at zero, so readers can see what the baseline itself costs. */
export function visibleVs32ProModelIds(generation: GenerationId): ModelId[] {
  return visibleModelIds(generation);
}

export function croppedTurns(row: GreedyTrajectoryResult): number[] {
  return row.delta.slice(CROP_FROM, CROP_TO + 1).map((_, index) => CROP_FROM + index);
}

export function croppedDelta(row: GreedyTrajectoryResult): number[] {
  return row.delta.slice(CROP_FROM, CROP_TO + 1);
}

export function croppedLow(row: GreedyTrajectoryResult): number[] {
  return row.deltaLow.slice(CROP_FROM, CROP_TO + 1);
}

export function croppedHigh(row: GreedyTrajectoryResult): number[] {
  return row.deltaHigh.slice(CROP_FROM, CROP_TO + 1);
}

export function hasPublicTrajectories(ids: ModelId[]): boolean {
  return ids.some((id) => trajectoryFor(id) != null);
}

export interface PredecessorTrajectoryResult extends GreedyTrajectoryResult {
  challenger: ModelId;
  opponent: ModelId;
}

interface PredecessorFile {
  protocol: string;
  seeds: number;
  games: number;
  iterations: number;
  results: PredecessorTrajectoryResult[];
}

const predecessorFile = predecessorPayload as PredecessorFile;

export const PREDECESSOR_TRAJECTORIES: PredecessorTrajectoryResult[] = (
  predecessorFile.results ?? []
).filter(
  (row): row is PredecessorTrajectoryResult =>
    typeof row.challenger === 'string' &&
    row.challenger in MODELS &&
    typeof row.opponent === 'string' &&
    row.opponent in MODELS &&
    (row.games ?? 0) >= MIN_PUBLIC_GAMES &&
    Array.isArray(row.delta) &&
    row.delta.length >= CROP_TO + 1,
);

export function predecessorTrajectory(
  challenger: ModelId,
  opponent: ComparatorId,
): GreedyTrajectoryResult | undefined {
  if (opponent === 'greedy') {
    return trajectoryFor(challenger);
  }
  const row = PREDECESSOR_TRAJECTORIES.find(
    (entry) => entry.challenger === challenger && entry.opponent === opponent,
  );
  if (!row) return undefined;
  return { ...row, id: challenger };
}
