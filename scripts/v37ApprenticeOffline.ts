/**
 * Score the opening oracle corpus with an existing policy net — no training.
 *
 * Gate 0 found the already-trained v4.5 pooled net picks the deep oracle's opening move 41.4% of the
 * time against the deployed search's 10.3%, on 29 positions. If that holds on the full 800-position
 * corpus — and specifically on own moves 4-5, which W1 showed is the only band with both a settled
 * answer and enough regret to matter — then the apprentice may not need to be trained at all. An
 * artifact that already exists plus a confidence gate would be the whole mechanism.
 *
 * That is worth an hour of checking before spending a night on a training pipeline, and it is the
 * same "measure the gate cheaply" discipline that killed arm A for the price of two scripts.
 *
 *   node --import tsx scripts/v37ApprenticeOffline.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  bitboardParamsFor,
  getAlgo,
  isAlgoVersionId,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { seatOf, toPosition } from '../src/ai/bitboard/index.ts';
import { createEvalContext, detectPhase, refreshContext } from '../src/ai/bitboard/features.ts';
import { writeFeatures, FEATURE_COUNT } from '../src/ai/bitboard/netFeatures.ts';
import { writePolicyFeaturesV2, POLICY_V2_FEATURE_COUNT } from '../src/ai/bitboard/policyFeaturesV2.ts';
import {
  pooledPolicyNetFor,
  preparePooledPosition,
  scorePooledPlacement,
} from '../src/ai/bitboard/spatialNet.ts';
import { MoveOrderer, sortByScore } from '../src/ai/bitboard/ordering.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { newMoveBuffer } from '../src/ai/bitboard/position.ts';
import { preloadNets } from './lib/netPreload.ts';
import type { OpeningRow } from './exportV37OpeningOracle.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function majority(tops: number[]): { move: number; count: number } {
  const c = new Map<number, number>();
  for (const t of tops) c.set(t, (c.get(t) ?? 0) + 1);
  let best = tops[0];
  let cnt = 0;
  for (const [m, k] of c) if (k > cnt) { best = m; cnt = k; }
  return { move: best, count: cnt };
}

async function main(): Promise<void> {
  preloadNets();
  const corpusPath = arg('corpus', 'selfplay-results/v37-opening-oracle.json')!;
  const netVersion = arg('net-version', 'v4.5-spatial-ensemble-v32-pro')!;
  const outPath = arg('out', 'selfplay-results/v37-apprentice-offline.json')!;
  if (!isAlgoVersionId(netVersion)) throw new Error(`unknown version: ${netVersion}`);

  const params = bitboardParamsFor(getAlgo(netVersion as AlgoVersionId));
  const pooled = pooledPolicyNetFor(params.search.pooledNetPath);
  if (!pooled) throw new Error(`${netVersion} has no pooled policy net registered`);

  const payload = JSON.parse(readFileSync(corpusPath, 'utf8')) as { rows: OpeningRow[] };
  const rows = payload.rows.filter((r) => r.state);
  console.log(`scoring ${rows.length} corpus positions with ${netVersion} (no search, no training)\n`);

  const context = createEvalContext();
  const priorContext = createEvalContext();
  const parentFeatures = new Float32Array(FEATURE_COUNT);
  const netInput = new Float32Array(POLICY_V2_FEATURE_COUNT);

  const out: Array<{
    game: number; ownMove: number; stable: boolean; agreement: number;
    netTop1: boolean; netTop3: boolean; netRank: number; netMargin: number;
    searchTop1: boolean; regret: number | null;
  }> = [];

  for (const row of rows) {
    const state = row.state!;
    const position = toPosition(state);
    const seat = seatOf(row.seat);
    if (position.turn !== seat) position.forceTurn(seat);
    context.fractionalTies = params.fractionalTerritoryTies;
    refreshContext(context, position, true);
    const phase = detectPhase(position, context, params, seat);

    const buffer = newMoveBuffer();
    const legal = position.generateMoves(seat, buffer);
    if (legal === 0) continue;

    const ordering = params.ordering[phase];
    const tier0 = Array.from({ length: legal }, (_, k) => buffer[k]).sort(
      (a, b) =>
        PLACEMENTS.size[b] * ordering.pieceSize - PLACEMENTS.centreDistance[b] * ordering.centrePull -
        (PLACEMENTS.size[a] * ordering.pieceSize - PLACEMENTS.centreDistance[a] * ordering.centrePull),
    );
    const kept = Math.min(Math.max(params.search.rootShortlist * 2, 96), tier0.length);
    const moves = new Int32Array(kept);
    for (let k = 0; k < kept; k += 1) moves[k] = tier0[k];
    const scores = new Float64Array(kept);
    new MoveOrderer(params).scoreMoves(position, context, seat, moves, kept, scores, phase, {
      withSplit: true, splitBudget: 24,
    });
    sortByScore(moves, scores, kept);
    const shortlist = Math.min(params.search.rootShortlist, kept);

    writeFeatures(parentFeatures, 0, position, context, seat);
    preparePooledPosition(pooled, position, seat);
    const scored: Array<{ id: number; s: number }> = [];
    for (let k = 0; k < shortlist; k += 1) {
      const undo = position.apply(moves[k]);
      refreshContext(priorContext, position, false);
      writePolicyFeaturesV2(netInput, position, priorContext, seat, moves[k], parentFeatures);
      scored.push({ id: moves[k], s: scorePooledPlacement(pooled, moves[k], seat, netInput) });
      position.undo(undo);
    }
    scored.sort((a, b) => b.s - a.s);

    const m = majority(row.oracleTopPerRun);
    const rank = scored.findIndex((e) => e.id === m.move);
    out.push({
      game: row.game,
      ownMove: row.ownMove,
      stable: m.count >= 2,
      agreement: m.count,
      netTop1: scored[0]?.id === m.move,
      netTop3: rank >= 0 && rank < 3,
      netRank: rank,
      netMargin: (scored[0]?.s ?? 0) - (scored[1]?.s ?? 0),
      searchTop1: row.deployed === m.move,
      regret: row.deployedRegret,
    });
  }

  const show = (label: string, sel: typeof out) => {
    if (sel.length === 0) return;
    const p = (f: (x: (typeof out)[0]) => boolean) =>
      `${((100 * sel.filter(f).length) / sel.length).toFixed(1)}%`;
    console.log(
      `  ${label.padEnd(22)}n=${String(sel.length).padStart(4)}   ` +
        `net top1 ${p((x) => x.netTop1).padStart(6)}   net top3 ${p((x) => x.netTop3).padStart(6)}   ` +
        `search top1 ${p((x) => x.searchTop1).padStart(6)}`,
    );
  };

  const stable = out.filter((x) => x.stable);
  console.log('=== agreement with the majority oracle move ===\n');
  show('all positions', out);
  show('2-of-3 stable only', stable);
  console.log('');
  for (let k = 1; k <= 5; k += 1) show(`stable, own move ${k}`, stable.filter((x) => x.ownMove === k));
  console.log('');
  show('stable, moves 4-5', stable.filter((x) => x.ownMove >= 4));
  show('stable, moves 1-3', stable.filter((x) => x.ownMove <= 3));

  writeFileSync(outPath, `${JSON.stringify({ net: netVersion, rows: out }, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
