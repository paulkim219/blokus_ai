/**
 * W3a — turn a measured move-importance profile into a budget-neutral candidate config.
 *
 * `n_k` proportional to `c_k` is the optimum of `sum_k c_k*log(n_k)` under a fixed `sum_k n_k`, so
 * the fit is "normalise the slope profile" and the interesting decisions are all about noise.
 * Three of them, each exposed as a flag because each is a judgement rather than a derivation:
 *
 *   --bands      Fit on the seven three-move bands rather than on 21 single-move estimates. Each
 *                band pools roughly three times the positions. Per-move slopes at this corpus size
 *                are mostly noise, and a shape fitted to noise is an expensive way to measure the
 *                bootstrap.
 *   --shrink     `shape = 1 + lambda*(raw - 1)`. The profile is an estimate, and an unshrunk fit
 *                spends its full confidence on it. At lambda 0 this emits exactly the flat shape,
 *                which is the identity gate.
 *   --floor/--ceil  No move may be starved to nothing or handed the whole game. A shape entry of
 *                near-zero is not an allocation, it is a resignation, and the endgame packer means
 *                a low slope there reflects an already-solved position rather than a hopeless one.
 *
 * The output is a registerable `AlgoConfig`, so a fitted shape can be matched with
 * `--challenger-file` without editing `src/ai/versions/v3.ts` and without a fitted-on-noise shape
 * becoming a named version before it has beaten anything.
 *
 *   node --import tsx scripts/fitIterationShape.ts
 *   npm run match -- --challenger-file tuning/v36-shape-<id>.json --champion v3.2-pro --seeds 16
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAlgo, type AlgoConfig } from '../src/ai/algoVersions.ts';
import { OWN_MOVES, normaliseShape } from '../src/ai/bitboard/timeManager.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface Band {
  label: string;
  n: number;
  slope: number;
  slopeLow: number;
  slopeHigh: number;
}

interface Profile {
  deployed: string;
  bands: Band[];
  perMove: Band[];
}

/** One row of `selfplay-results/v36-shape-probe-results.json`. */
interface ProbeResult {
  label: string;
  advantage: number | null;
  low: number | null;
  high: number | null;
}

/**
 * Turn the W2 boost probes into the same band shape W1 emits.
 *
 * A probe that doubles `k` of the 21 own moves buys `k/21` of a whole-game doubling, so its
 * advantage divided by `k/21` is the local exchange rate at those moves — in match points, which is
 * the currency the promotion rule is written in. That is a different and better-grounded estimate
 * than W1's oracle-regret proxy, and where the two disagree the match is the one this project has
 * repeatedly found to be right.
 *
 * The levels are not trustworthy: the four arms' size-weighted mean rate runs well above the
 * measured whole-game ladder, which is what 40-seed intervals do. Only the ratios survive, and the
 * ratios are all the normalisation uses.
 */
function bandsFromProbes(rows: ProbeResult[]): Band[] {
  const blocks: Array<[string, string, number]> = [
    ['v36-boost-1-5', 'moves 1-5', 5],
    ['v36-boost-6-10', 'moves 6-10', 5],
    ['v36-boost-11-15', 'moves 11-15', 5],
    ['v36-boost-16-21', 'moves 16-21', 6],
  ];
  const bands: Band[] = [];
  for (const [label, bandLabel, width] of blocks) {
    const row = rows.find((entry) => entry.label === label);
    if (!row || row.advantage === null) {
      throw new Error(`probe results are missing ${label}; run npm run experiment:v3.6-shape first`);
    }
    const perDoubling = width / 21;
    bands.push({
      label: bandLabel,
      n: width,
      slope: row.advantage / perDoubling,
      slopeLow: (row.low ?? row.advantage) / perDoubling,
      slopeHigh: (row.high ?? row.advantage) / perDoubling,
    });
  }
  return bands;
}

/** `moves 4-6` / `move 7` -> the own-move indices it covers, 1-based. */
function movesOf(label: string): number[] {
  const range = label.match(/(\d+)-(\d+)/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const single = label.match(/(\d+)/);
  return single ? [Number(single[1])] : [];
}

function main(): void {
  // Either W1's oracle-regret profile or W2's match-measured probe results; the file shape says
  // which, so there is no flag to get wrong.
  const inPath = arg('in', 'selfplay-results/move-importance.json')!;
  const base = arg('base', 'v3.2-pro')!;
  const shrink = Number(arg('shrink', '1'));
  const floor = Number(arg('floor', '0.35'));
  const ceil = Number(arg('ceil', '2.5'));
  const usePerMove = flag('per-move');
  const id = arg('id', 'v3.6-shape-fitted')!;
  const outPath = arg('out', `tuning/${id}.json`)!;

  const parsed = JSON.parse(readFileSync(inPath, 'utf8')) as Profile | ProbeResult[];
  const profile: Profile = Array.isArray(parsed)
    ? { deployed: base, bands: bandsFromProbes(parsed), perMove: [] }
    : parsed;
  const source = usePerMove ? profile.perMove : profile.bands;
  if (source.length === 0) {
    throw new Error(`${inPath} has no ${usePerMove ? 'perMove' : 'bands'} entries`);
  }

  // Each move takes its band's slope. Slopes can come back negative — a doubling that changed the
  // move for the worse — and a negative weight is not an allocation, so the floor does the clamping
  // rather than the fit pretending the estimate was positive.
  const raw = new Array<number>(OWN_MOVES).fill(Number.NaN);
  for (const band of source) {
    for (const move of movesOf(band.label)) {
      if (move >= 1 && move <= OWN_MOVES) {
        raw[move - 1] = band.slope;
      }
    }
  }
  // Moves no band covered (too few positions to estimate) keep the mean rather than a guess.
  const measured = raw.filter((value) => Number.isFinite(value));
  const fallback = measured.reduce((sum, value) => sum + value, 0) / Math.max(1, measured.length);
  for (let k = 0; k < OWN_MOVES; k += 1) {
    if (!Number.isFinite(raw[k])) raw[k] = fallback;
  }

  // Scale to mean 1 before shrinking, so `shrink` interpolates between flat and the fitted profile
  // rather than between flat and whatever units the slope happened to be in.
  const rawMean = raw.reduce((sum, value) => sum + value, 0) / OWN_MOVES;
  const relative =
    rawMean > 0 ? raw.map((value) => value / rawMean) : raw.map(() => 1);
  const shaped = relative.map((value) =>
    Math.min(ceil, Math.max(floor, 1 + shrink * (value - 1))),
  );
  const shape = normaliseShape(shaped).map((value) => Number(value.toFixed(4)));

  const baseConfig = getAlgo(base) as unknown as AlgoConfig;
  const config: AlgoConfig = {
    ...baseConfig,
    id,
    summary:
      `${base} with the iteration budget redistributed across the 21 own-moves by the measured ` +
      `compute-sensitivity profile (shrink ${shrink}, ${usePerMove ? 'per-move' : 'banded'}), ` +
      'normalised to the same per-game total.',
    bitboard: {
      ...(baseConfig.bitboard ?? {}),
      search: { ...((baseConfig.bitboard ?? {}).search ?? {}), iterationShape: shape },
    },
  } as AlgoConfig;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);

  const total = shape.reduce((sum, value) => sum + value, 0);
  console.log(`Fitted from ${inPath} (${usePerMove ? 'per-move' : 'banded'}, shrink ${shrink})\n`);
  for (let k = 0; k < OWN_MOVES; k += 1) {
    const bar = '#'.repeat(Math.round(shape[k] * 20));
    console.log(`  move ${String(k + 1).padStart(2)}  ${shape[k].toFixed(3).padStart(6)}  ${bar}`);
  }
  console.log(
    [
      '',
      `sum = ${total.toFixed(4)} over ${OWN_MOVES} moves — budget-neutral against ${base}.`,
      `Wrote ${outPath}`,
      '',
      'This is a hypothesis fitted to an estimate, not a version. Gate it the usual way:',
      `  npm run match -- --challenger-file ${outPath} --champion ${base} --seeds 16  --seed-base <A>`,
      `  npm run match -- --challenger-file ${outPath} --champion ${base} --seeds 40  --seed-base <B>`,
      `  npm run match -- --challenger-file ${outPath} --champion ${base} --seeds 100 --seed-base <C>`,
      '',
      'Seed blocks must be disjoint and pre-registered, and none may be a multiple of 100,000 below',
      'the tuner\'s generation count — that lattice is not held out.',
    ].join('\n'),
  );
}

main();
