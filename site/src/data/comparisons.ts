import { MODELS, type ComparatorId, type ModelId } from './models';
import publicMatchResults from './publicMatchResults.json' with { type: 'json' };

export type Protocol = 'post-2026-08-17' | 'pre-protocol';
export type ComparisonStatus = 'measured' | 'unmeasured';
export type Prominence = 'primary' | 'secondary';

export interface Comparison {
  challenger: ModelId;
  opponent: ComparatorId;
  status: ComparisonStatus;
  prominence: Prominence;
  protocol: Protocol;
  advantage?: number;
  ci?: [number, number];
  games?: number;
  seeds?: number;
  firstPlace?: number;
  note?: string;
}

const COMPARISON_BASE: Comparison[] = [
  {
    challenger: 'hanni-1',
    opponent: 'greedy',
    status: 'measured',
    prominence: 'secondary',
    protocol: 'pre-protocol',
    firstPlace: 90.9,
    games: 44,
    note: 'Historical: 90.9% sole wins, mean margin +18.14, from a different statistic. Not plotted with post-protocol advantage.',
  },
  {
    challenger: 'hanni-2-lite',
    opponent: 'greedy',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-2-lite',
    opponent: 'hanni-1',
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: 5.77,
    ci: [5.29, 6.24],
    note: 'Held-out seeds, post-protocol.',
  },
  {
    challenger: 'hanni-2-pro',
    opponent: 'hanni-1',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-2-pro',
    opponent: 'hanni-2-lite',
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: 5.89,
    ci: [4.72, 7.08],
    seeds: 100,
    games: 400,
    firstPlace: 48.8,
  },
  {
    challenger: 'hanni-3-1-nano',
    opponent: 'greedy',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1-nano',
    opponent: 'hanni-1',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1-nano',
    opponent: 'hanni-2-lite',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1-lite',
    opponent: 'greedy',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1-lite',
    opponent: 'hanni-2-lite',
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: -0.55,
    ci: [-1.32, 0.2],
    games: 800,
    firstPlace: 30.8,
    note: 'Parity, not a promotion. Interval spans zero.',
  },
  {
    challenger: 'hanni-3-1-lite',
    opponent: 'hanni-3-1-nano',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1',
    opponent: 'hanni-2-lite',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1',
    opponent: 'hanni-3-1-lite',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1-pro',
    opponent: 'hanni-3-1',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1-pro',
    opponent: 'hanni-2-pro',
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: 2.01,
    ci: [1.0, 3.02],
    games: 400,
    firstPlace: 41.5,
    note: 'About 360 ms/move against about 1,498 ms/move.',
  },
  {
    challenger: 'hanni-3-1-pro-max',
    opponent: 'hanni-2-pro',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-1-pro-max',
    opponent: 'hanni-3-1-pro',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-2',
    opponent: 'hanni-2-lite',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-2',
    opponent: 'hanni-3-1',
    status: 'measured',
    prominence: 'secondary',
    protocol: 'post-2026-08-17',
    advantage: 0.77,
    seeds: 40,
    games: 160,
    note: 'Transfer block only. Too small for a primary public number until a 400-game re-run.',
  },
  {
    challenger: 'hanni-3-2-pro',
    opponent: 'hanni-2-pro',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-2-pro',
    opponent: 'hanni-3-1-pro',
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: 0.7,
    ci: [0.1, 1.31],
    seeds: 156,
    games: 624,
  },
  {
    challenger: 'hanni-3-2-pro-max',
    opponent: 'hanni-2-pro',
    status: 'unmeasured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
  },
  {
    challenger: 'hanni-3-2-pro-max',
    opponent: 'hanni-3-1-pro-max',
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: 0.88,
    ci: [0.25, 1.54],
    seeds: 140,
    games: 560,
    firstPlace: 30.9,
  },
  {
    challenger: 'hanni-4-1-lite',
    opponent: 'hanni-3-1-lite',
    status: 'measured',
    prominence: 'secondary',
    protocol: 'post-2026-08-17',
    advantage: 0.18,
    ci: [-1.25, 1.59],
    seeds: 40,
    games: 160,
    firstPlace: 32.5,
    note: 'Transfer screen. Interval spans zero.',
  },
  {
    challenger: 'hanni-4-1',
    opponent: 'hanni-3-1',
    status: 'measured',
    prominence: 'secondary',
    protocol: 'post-2026-08-17',
    advantage: 0.59,
    ci: [-0.58, 1.82],
    seeds: 40,
    games: 160,
    firstPlace: 32.5,
    note: 'Positive point estimate; interval spans zero.',
  },
  {
    challenger: 'hanni-4-1-pro',
    opponent: 'hanni-3-1-pro',
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: 1.13,
    ci: [0.51, 1.74],
    seeds: 140,
    games: 560,
    note: 'Two independent blocks, both positive and both clearing zero. Pooled 140 seeds.',
  },
  {
    challenger: 'hanni-4-1-pro-max',
    opponent: 'hanni-3-1-pro-max',
    status: 'measured',
    prominence: 'secondary',
    protocol: 'post-2026-08-17',
    advantage: 0.5,
    ci: [-0.76, 1.69],
    seeds: 40,
    games: 160,
    firstPlace: 35.6,
    note: 'Transfer screen, not a promotion requirement. Interval spans zero.',
  },
];

type PublicHit = {
  challenger: string;
  opponent: string;
  advantage: number;
  ci: [number, number];
  games: number;
  seeds: number;
  firstPlace?: number;
  note?: string;
};

export const COMPARISONS: Comparison[] = COMPARISON_BASE.map((row) => {
  const hit = (publicMatchResults as PublicHit[]).find(
    (result) => result.challenger === row.challenger && result.opponent === row.opponent,
  );
  if (!hit) {
    return row;
  }
  return {
    ...row,
    status: 'measured',
    prominence: 'primary',
    protocol: 'post-2026-08-17',
    advantage: hit.advantage,
    ci: hit.ci,
    games: hit.games,
    seeds: hit.seeds,
    firstPlace: hit.firstPlace ?? row.firstPlace,
    note: hit.note ?? row.note,
  };
});

/** Shared-opponent ladder for the homepage: advantage versus Hanni 2 Pro. */
export const VS_HANNI_2_PRO: Array<{
  id: ModelId;
  advantage: number;
  ci?: [number, number];
  ms: number;
}> = [
  { id: 'hanni-2-lite', advantage: -5.89, ci: [-7.08, -4.72], ms: 271 },
  { id: 'hanni-3-1-lite', advantage: -2.87, ci: [-4.88, -0.7], ms: 85 },
  { id: 'hanni-3-1', advantage: -1.48, ci: [-2.5, -0.52], ms: 214 },
  { id: 'hanni-3-1-pro', advantage: 2.01, ci: [1.0, 3.02], ms: 360 },
  { id: 'hanni-3-1-pro-max', advantage: 2.13, ci: [1.15, 3.11], ms: 700 },
  { id: 'hanni-3-2-pro', advantage: 2.16, ci: [1.19, 3.13], ms: 367 },
  { id: 'hanni-3-2-pro-max', advantage: 3.59, ci: [2.62, 4.59], ms: 700 },
  { id: 'hanni-2-pro', advantage: 0, ms: 1498 },
];

export const TRUNCATION_SWEEP = [
  { plies: 12, advantage: 0, firstPlace: 25 },
  { plies: 18, advantage: 1.29, firstPlace: 34.3 },
  { plies: 24, advantage: 3.57, firstPlace: 45 },
  { plies: 36, advantage: 5.13, firstPlace: 50 },
  { plies: 48, advantage: 4.89, firstPlace: 46.9 },
  { plies: 84, advantage: 5.71, firstPlace: 52.1 },
];

export function comparisonsFor(id: ModelId): Comparison[] {
  const wanted = MODELS[id].comparators;
  return COMPARISONS.filter(
    (row) => row.challenger === id && wanted.includes(row.opponent),
  );
}

export function formatAdvantage(value: number): string {
  const abs = Math.abs(value).toFixed(2);
  return value > 0 ? `+${abs}` : value < 0 ? `−${abs}` : '0.00';
}

export function formatCi(ci: [number, number]): string {
  return `[${formatAdvantage(ci[0])}, ${formatAdvantage(ci[1])}]`;
}
