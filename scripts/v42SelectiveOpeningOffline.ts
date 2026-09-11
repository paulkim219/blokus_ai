/**
 * v4.2 — cross-fitted selective-action screen for own moves 4-5.
 *
 * Every prediction is out-of-game: five folds are assigned by game id, and a fold is scored only by
 * a ridge model fitted on the other four. See the preregistration before changing targets/features.
 *
 *   node --import tsx scripts/v42SelectiveOpeningOffline.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  bitboardParamsFor,
  getAlgo,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { FEATURE_COUNT, writeFeatures } from '../src/ai/bitboard/netFeatures.ts';
import { POLICY_V2_FEATURE_COUNT, writePolicyFeaturesV2 } from '../src/ai/bitboard/policyFeaturesV2.ts';
import {
  pooledPolicyNetFor,
  preparePooledPosition,
  scorePooledPlacementMembers,
} from '../src/ai/bitboard/spatialNet.ts';
import { MoveOrderer, sortByScore } from '../src/ai/bitboard/ordering.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { newMoveBuffer } from '../src/ai/bitboard/position.ts';
import { preloadNets } from './lib/netPreload.ts';
import type { OpeningRow } from './exportV37OpeningOracle.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FEATURE_NAMES = [
  'move5', 'logLegal', 'margin12', 'margin13', 'entropy', 'voteShare',
  'chosenMemberSd', 'memberMarginMean', 'memberMarginSd', 'heuristicAgree',
  'heuristicRank', 'pieceSize', 'centreDistance',
];

interface ScoredRow {
  game: number;
  ownMove: number;
  stable: boolean;
  features: number[];
  proxyGain: number;
  exactGain: number | null;
  top1Delta: number;
  rawMargin: number;
  ensembleConfidence: number;
  heuristicAgree: number;
  prediction?: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function majority(xs: number[]): { move: number; count: number } {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].map(([move, count]) => ({ move, count })).sort((a, b) => b.count - a.count)[0];
}

interface Ridge {
  mean: number[];
  scale: number[];
  weights: number[];
  intercept: number;
}

function fitRidge(rows: ScoredRow[], lambda = 10): Ridge {
  const d = FEATURE_NAMES.length;
  const means = Array.from({ length: d }, (_, j) => mean(rows.map((r) => r.features[j])));
  const scales = Array.from({ length: d }, (_, j) => sd(rows.map((r) => r.features[j])) || 1);
  const intercept = mean(rows.map((r) => r.proxyGain));
  const a = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (const row of rows) {
    const x = row.features.map((v, j) => (v - means[j]) / scales[j]);
    const y = row.proxyGain - intercept;
    for (let j = 0; j < d; j += 1) {
      b[j] += x[j] * y;
      for (let k = 0; k < d; k += 1) a[j][k] += x[j] * x[k];
    }
  }
  for (let j = 0; j < d; j += 1) a[j][j] += lambda;
  for (let c = 0; c < d; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < d; r += 1) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    const div = a[c][c];
    if (Math.abs(div) < 1e-12) continue;
    for (let r = 0; r < d; r += 1) {
      if (r === c) continue;
      const f = a[r][c] / div;
      for (let k = c; k < d; k += 1) a[r][k] -= f * a[c][k];
      b[r] -= f * b[c];
    }
  }
  return { mean: means, scale: scales, weights: b.map((v, j) => v / a[j][j]), intercept };
}

function predict(model: Ridge, row: ScoredRow): number {
  return model.intercept + row.features.reduce(
    (s, v, j) => s + model.weights[j] * ((v - model.mean[j]) / model.scale[j]), 0,
  );
}

function bootstrapByGame(rows: ScoredRow[], key: 'proxyGain' | 'top1Delta', draws = 4000): [number, number] {
  const groups = [...new Set(rows.map((r) => r.game))].map((game) => rows.filter((r) => r.game === game));
  const values: number[] = [];
  let state = 0x42c0ffee;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let draw = 0; draw < draws; draw += 1) {
    const sample: ScoredRow[] = [];
    for (let i = 0; i < groups.length; i += 1) sample.push(...groups[Math.floor(random() * groups.length)]);
    values.push(mean(sample.map((r) => r[key])));
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(0.025 * draws)], values[Math.floor(0.975 * draws)]];
}

function summarize(rows: ScoredRow[], score: (r: ScoredRow) => number, coverage: number) {
  const n = Math.max(1, Math.round(rows.length * coverage));
  const selected = [...rows].sort((a, b) => score(b) - score(a)).slice(0, n);
  const exact = selected.filter((r) => r.exactGain !== null);
  return {
    coverage: selected.length / rows.length,
    selected: selected.length,
    games: new Set(selected.map((r) => r.game)).size,
    proxyGain: mean(selected.map((r) => r.proxyGain)),
    proxyCi: bootstrapByGame(selected, 'proxyGain'),
    exactResolved: exact.length,
    exactGain: mean(exact.map((r) => r.exactGain!)),
    top1Delta: mean(selected.map((r) => r.top1Delta)),
    top1Ci: bootstrapByGame(selected, 'top1Delta'),
    threshold: Math.min(...selected.map(score)),
  };
}

async function main(): Promise<void> {
  preloadNets();
  const corpus = arg('corpus', 'selfplay-results/v37-opening-oracle.json');
  const outPath = arg('out', 'selfplay-results/v42-selective-opening-offline.json');
  const version = arg('net-version', 'v4.5-spatial-ensemble-v32-pro') as AlgoVersionId;
  const payload = JSON.parse(readFileSync(corpus, 'utf8')) as { rows: OpeningRow[] };
  const params = bitboardParamsFor(getAlgo(version));
  const net = pooledPolicyNetFor(params.search.pooledNetPath);
  if (!net) throw new Error(`${version} has no registered pooled policy network`);

  const context = createEvalContext();
  const childContext = createEvalContext();
  const parentFeatures = new Float32Array(FEATURE_COUNT);
  const input = new Float32Array(POLICY_V2_FEATURE_COUNT);
  const rows: ScoredRow[] = [];

  for (const row of payload.rows.filter((r) => r.state && r.ownMove >= 4 && r.ownMove <= 5)) {
    const position = toPosition(row.state!);
    const seat = seatOf(row.seat);
    if (position.turn !== seat) position.forceTurn(seat);
    context.fractionalTies = params.fractionalTerritoryTies;
    refreshContext(context, position, true);
    const phase = detectPhase(position, context, params, seat);
    const buffer = newMoveBuffer();
    const legal = position.generateMoves(seat, buffer);
    if (legal === 0) continue;

    const ordering = params.ordering[phase];
    const tier0 = Array.from({ length: legal }, (_, i) => buffer[i]).sort(
      (a, b) => PLACEMENTS.size[b] * ordering.pieceSize - PLACEMENTS.centreDistance[b] * ordering.centrePull
        - (PLACEMENTS.size[a] * ordering.pieceSize - PLACEMENTS.centreDistance[a] * ordering.centrePull),
    );
    const kept = Math.min(Math.max(params.search.rootShortlist * 2, 96), tier0.length);
    const moves = new Int32Array(kept);
    for (let i = 0; i < kept; i += 1) moves[i] = tier0[i];
    const heuristicScores = new Float64Array(kept);
    new MoveOrderer(params).scoreMoves(position, context, seat, moves, kept, heuristicScores, phase, {
      withSplit: true,
      splitBudget: params.search.interiorSplitBudget > 0 ? params.search.interiorSplitBudget : 24,
    });
    sortByScore(moves, heuristicScores, kept);
    const shortlist = Math.min(params.search.rootShortlist, kept);

    writeFeatures(parentFeatures, 0, position, context, seat);
    preparePooledPosition(net, position, seat);
    const scored: Array<{ move: number; scores: number[]; mean: number }> = [];
    for (let i = 0; i < shortlist; i += 1) {
      const undo = position.apply(moves[i]);
      refreshContext(childContext, position, false);
      writePolicyFeaturesV2(input, position, childContext, seat, moves[i], parentFeatures);
      const memberScores = scorePooledPlacementMembers(net, moves[i], seat, input);
      scored.push({ move: moves[i], scores: memberScores, mean: mean(memberScores) });
      position.undo(undo);
    }
    scored.sort((a, b) => b.mean - a.mean);
    if (scored.length < 3) continue;
    const chosen = scored[0];
    const margins = chosen.scores.map((s, member) => {
      const runner = Math.max(...scored.slice(1).map((candidate) => candidate.scores[member]));
      return s - runner;
    });
    const votes = chosen.scores.map((_, member) => {
      const best = [...scored].sort((a, b) => b.scores[member] - a.scores[member])[0];
      return best.move === chosen.move ? 1 : 0;
    });
    const logits = scored.map((x) => x.mean);
    const maxLogit = Math.max(...logits);
    const exps = logits.map((x) => Math.exp(x - maxLogit));
    const probs = exps.map((x) => x / exps.reduce((a, b) => a + b, 0));
    const entropy = -probs.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0) / Math.log(probs.length);
    const heuristicRank = Array.from(moves.slice(0, shortlist)).indexOf(chosen.move);
    const oracle = majority(row.oracleTopPerRun);
    const byMove = new Map(row.head.map((x) => [x.placement, x.value] as const));
    const headValues = row.head.map((x) => x.value);
    const top = Math.max(...headValues);
    const bottom = Math.min(...headValues);
    const tail = bottom - Math.max(0.05, 0.25 * (top - bottom));
    const netValue = byMove.get(chosen.move);
    const deployedValue = byMove.get(row.deployed);
    const proxyGain = (netValue ?? tail) - (deployedValue ?? tail);
    const rawMargin = chosen.mean - scored[1].mean;
    const voteShare = mean(votes);
    const chosenSd = sd(chosen.scores);
    const marginMean = mean(margins);
    const marginSd = sd(margins);
    const hAgree = chosen.move === moves[0] ? 1 : 0;
    rows.push({
      game: row.game,
      ownMove: row.ownMove,
      stable: oracle.count >= 2,
      features: [
        row.ownMove === 5 ? 1 : 0,
        Math.log1p(legal),
        rawMargin,
        chosen.mean - scored[2].mean,
        entropy,
        voteShare,
        chosenSd,
        marginMean,
        marginSd,
        hAgree,
        heuristicRank / Math.max(1, shortlist - 1),
        PLACEMENTS.size[chosen.move] / 5,
        PLACEMENTS.centreDistance[chosen.move] / 20,
      ],
      proxyGain,
      exactGain: netValue !== undefined && deployedValue !== undefined ? netValue - deployedValue : null,
      top1Delta: Number(chosen.move === oracle.move) - Number(row.deployed === oracle.move),
      rawMargin,
      ensembleConfidence: voteShare - chosenSd,
      heuristicAgree: hAgree,
    });
  }

  const stable = rows.filter((r) => r.stable);
  for (let fold = 0; fold < 5; fold += 1) {
    const train = stable.filter((r) => r.game % 5 !== fold);
    const test = stable.filter((r) => r.game % 5 === fold);
    const model = fitRidge(train, 10);
    for (const row of test) row.prediction = predict(model, row);
  }
  const fullModel = fitRidge(stable, 10);
  const coverages = [0.1, 0.2, 0.3, 0.5, 1];
  const arms: Array<[string, (r: ScoredRow) => number]> = [
    ['cross-fitted ridge', (r) => r.prediction ?? Number.NEGATIVE_INFINITY],
    ['raw policy margin', (r) => r.rawMargin],
    ['ensemble confidence', (r) => r.ensembleConfidence],
    ['heuristic agreement', (r) => r.heuristicAgree],
    ['move 5 only', (r) => Number(r.ownMove === 5)],
  ];
  const summaries = arms.flatMap(([arm, score]) => coverages.map((coverage) => ({
    arm,
    ...summarize(stable, score, coverage),
  })));

  console.log(`scored ${rows.length} positions from ${new Set(rows.map((r) => r.game)).size} games`);
  console.log(`primary stable set: ${stable.length} positions; exact pair resolved: ${stable.filter((r) => r.exactGain !== null).length}\n`);
  console.log(`${'arm'.padEnd(24)} ${'cover'.padStart(6)} ${'n'.padStart(4)} ${'proxy gain'.padStart(12)} ${'exact gain'.padStart(12)} ${'top1 Δ'.padStart(9)}`);
  for (const row of summaries) {
    console.log(`${row.arm.padEnd(24)} ${(100 * row.coverage).toFixed(0).padStart(5)}% ${String(row.selected).padStart(4)} ${row.proxyGain.toFixed(3).padStart(12)} ${row.exactGain.toFixed(3).padStart(12)} ${(100 * row.top1Delta).toFixed(1).padStart(8)}pp`);
  }
  console.log('\nfull-data ridge coefficients (standardised):');
  FEATURE_NAMES.forEach((name, i) => console.log(`  ${name.padEnd(20)} ${fullModel.weights[i].toFixed(4)}`));

  const primary = summaries.find((x) => x.arm === 'cross-fitted ridge' && Math.abs(x.coverage - 0.2) < 0.01)!;
  const deployment30 = summarize(stable, (row) => predict(fullModel, row), 0.3);
  const passed = primary.proxyGain > 0 && primary.exactGain >= 0 && primary.top1Delta >= 0;
  console.log(`\nPRIMARY 20% RIDGE GATE: ${passed ? 'PASS' : 'FAIL'}`);
  console.log(`proxy 95% game bootstrap [${primary.proxyCi.map((x) => x.toFixed(3)).join(', ')}]`);
  console.log(`top1 Δ 95% game bootstrap [${primary.top1Ci.map((x) => (100 * x).toFixed(1)).join(', ')}] pp`);

  writeFileSync(outPath, `${JSON.stringify({
    corpus,
    version,
    rows: rows.length,
    games: new Set(rows.map((r) => r.game)).size,
    stableRows: stable.length,
    features: FEATURE_NAMES,
    fullModel,
    deployment30,
    summaries,
    primaryGate: { passed, ...primary },
  }, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
