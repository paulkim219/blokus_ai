import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import { applyMove, calculateScores, createInitialState, generateLegalMoves, passTurn } from '../src/engine/game.ts';
import { isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed, randomInt } from '../src/ai/rng.ts';
import { placementFor, resetV12, toPosition } from '../src/ai/bitboard/index.ts';
import { createEvalContext, refreshContext } from '../src/ai/bitboard/features.ts';
import { SEAT_COLORS, SEAT_OF_COLOR } from '../src/ai/bitboard/seats.ts';
import { FEATURE_COUNT, FEATURE_NAMES, writeFeatures } from '../src/ai/bitboard/netFeatures.ts';
import {
  POLICY_FEATURE_COUNT,
  POLICY_FEATURE_NAMES,
  writePolicyFeatures,
} from '../src/ai/bitboard/policyFeatures.ts';
import {
  POLICY_V2_FEATURE_COUNT,
  POLICY_V2_FEATURE_NAMES,
  writePolicyFeaturesV2,
} from '../src/ai/bitboard/policyFeaturesV2.ts';
import { CELL_COUNT, testBit } from '../src/ai/bitboard/bitboard.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';

/**
 * Distillation dataset: what an expensive search knows, written down as (position → value) rows.
 *
 * The teacher searches once per ply exactly as it would in ordinary self-play, and we keep the
 * ranking it produced anyway. That makes the data free relative to just playing the games — the
 * alternative, re-searching each candidate child, costs a factor of K for information the parent
 * search already computed.
 *
 * Two targets come out of one pass, and they answer different questions:
 *
 *   `teacher`  — the searched value of every candidate child. Defined for all K siblings, so it is
 *                the only one that can train *discrimination between siblings*, which is where the
 *                v12 investigation localised the deficit (v12's evaluation was the better global
 *                predictor at 0.494 vs 0.444 and still lost the match).
 *   `outcome`  — the final seat margin, valid only for the child actually played. Marked `onPath`
 *                so the trainer can restrict the regression head to rows where it means something.
 *                Labelling unplayed siblings with the game's result is the classic leak here.
 *
 *   npm run export-training -- --teachers v2-pro,v3.1 --games 200 --iterations 300
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const SINGLE_TARGETS = ['group', 'onPath', 'teacher', 'visits', 'm0', 'm1', 'm2', 'm3'];
const CONSENSUS_TARGETS = [
  'group',
  'onPath',
  'teacher',
  'visits',
  'policy',
  'confidence',
  'm0',
  'm1',
  'm2',
  'm3',
];

const context = createEvalContext();
const scratch = new Float32Array(POLICY_V2_FEATURE_COUNT);
const parentScratch = new Float32Array(FEATURE_COUNT);

interface PendingRow {
  group: number;
  onPath: boolean;
  teacher: number;
  visits: number;
  policy: number;
  confidence: number;
  seat: PlayerColor;
  features: Float32Array;
  planes?: Uint8Array;
}

async function main(): Promise<void> {
  const teachers = (arg('teachers', 'v2-pro,v3.1') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is AlgoVersionId => isAlgoVersionId(v));
  const games = Math.max(1, Number(arg('games', '100')));
  const iterations = Number(arg('iterations', '300'));
  const seedBase = Number(arg('seed-base', '8100000'));
  const topK = Math.max(2, Number(arg('top-k', '10')));
  const openingRandomPlies = Number(arg('opening-random-plies', '10'));
  const searchRepeats = Math.max(1, Number(arg('search-repeats', '1')));
  const outPrefix = arg('out', 'ml/data/train') ?? 'ml/data/train';
  // Optional raw board planes alongside the feature vector, for testing whether the ranking ceiling
  // is a property of the task or of the hand-picked features. One byte per cell: 0 empty, 1 the
  // perspective seat's own squares, 2-4 the other three seats in seat-relative order.
  const actionPlanes = process.argv.includes('--action-planes');
  const withPlanes = actionPlanes || process.argv.includes('--planes');
  const policyFeaturesV2 = process.argv.includes('--policy-features-v2');
  const policyFeatures = policyFeaturesV2 || process.argv.includes('--policy-features');
  const featureCount = policyFeaturesV2
    ? POLICY_V2_FEATURE_COUNT
    : policyFeatures
      ? POLICY_FEATURE_COUNT
      : FEATURE_COUNT;
  const featureNames = policyFeaturesV2
    ? POLICY_V2_FEATURE_NAMES
    : policyFeatures
      ? POLICY_FEATURE_NAMES
      : FEATURE_NAMES;
  // Spatial rows also record the absolute mover seat. Feature vectors and ownership channels are
  // seat-relative, but the 20x20 lattice must be reflected so every mover's home maps to (0, 0).
  // Keeping the seat in y avoids trying to infer that transform from a sparse early-game board.
  const targetNames = [
    ...(searchRepeats > 1 ? CONSENSUS_TARGETS : SINGLE_TARGETS),
    ...(withPlanes ? ['seat'] : []),
  ];
  const targetWidth = targetNames.length;

  mkdirSync(dirname(join(process.cwd(), outPrefix)), { recursive: true });
  // Synchronous appends, deliberately, and batched one write per game.
  //
  // `createWriteStream` opens the file *asynchronously*, and this loop hands the event loop almost
  // nothing: a teacher search at 300 iterations is a long synchronous block. The open callback
  // never ran, so no file was ever created and every row accumulated in the stream's memory buffer
  // while the log cheerfully reported progress. Anything that must be on disk while this process is
  // still running has to be written synchronously.
  writeFileSync(`${outPrefix}.x.f32`, Buffer.alloc(0));
  writeFileSync(`${outPrefix}.y.f32`, Buffer.alloc(0));
  if (withPlanes) {
    writeFileSync(`${outPrefix}.p.u8`, Buffer.alloc(0));
  }

  console.log(
    `Distillation export — teachers {${teachers.join(', ')}}, ${games} games, ` +
      `${iterations} iterations/move, top ${topK} siblings per ply\n` +
    `Features: ${featureCount}${policyFeatures ? ' (action-conditioned policy)' : ''}\n` +
      `Independent searches/position: ${searchRepeats}\n` +
      `Output: ${outPrefix}.{x,y}.f32\n`,
  );

  let group = 0;
  let rows = 0;
  const started = Date.now();

  // Rewritten after every game: a long export is routinely stopped part-way on this machine, and a
  // dataset without its header is unreadable. Row counts always describe what is actually on disk.
  const writeMeta = (rowCount: number, groupCount: number, played: number): void => {
    writeFileSync(
      `${outPrefix}.meta.json`,
      `${JSON.stringify(
        {
          featureCount,
          featureNames,
          rows: rowCount,
          groups: groupCount,
          teachers,
          gamesRequested: games,
          gamesPlayed: played,
          iterations,
          seedBase,
          topK,
          searchRepeats,
          /** Column order of the `.y.f32` companion file. */
          targets: targetNames,
          targetWidth,
          planes: withPlanes
            ? {
                cells: CELL_COUNT,
                encoding: actionPlanes
                  ? '0 empty, 1 own, 2..4 opponent owner, 5 candidate placement'
                  : '0 empty, 1..4 seat-relative owner',
              }
            : null,
        },
        null,
        2,
      )}\n`,
    );
  };

  for (let g = 0; g < games; g += 1) {
    const teacher = teachers[g % teachers.length];
    const seed = seedBase + g;
    setSeed(seed);
    resetV12();

    let state: GameState = createInitialState('corner');
    const pending: PendingRow[] = [];
    let ply = 0;

    while (!state.finished && ply < 200) {
      const mover = state.currentTurn;
      if (generateLegalMoves(state, mover, 1).length === 0) {
        state = passTurn(state);
        ply += 1;
        continue;
      }
      const results: Array<Awaited<ReturnType<typeof searchBestMove>>> = [];
      for (let repeat = 0; repeat < searchRepeats; repeat += 1) {
        if (searchRepeats > 1) {
          resetV12();
          setSeed(seed + ply * 1_009 + repeat * 100_003);
        }
        results.push(
          await searchBestMove(state, mover, 600_000, undefined, {
            version: teacher,
            iterationBudget: iterations,
            skipWinOddsRefinement: true,
            lightRollouts: false,
          }),
        );
      }
      const first = results[0];
      if (!first.bestMove || first.rankedMoves.length === 0) {
        state = passTurn(state);
        ply += 1;
        continue;
      }

      type Ranked = (typeof first.rankedMoves)[number];
      type Aggregate = {
        candidate: Ranked;
        valueSum: number;
        visitsSum: number;
        singleVisits: number;
        policySum: number;
        present: number;
      };
      const aggregate = new Map<string, Aggregate>();
      const topCounts = new Map<string, number>();
      for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
        const result = results[resultIndex];
        if (result.bestMove) {
          const bestKey = `${result.bestMove.pieceId}:${result.bestMove.anchor.x}:${result.bestMove.anchor.y}:${result.bestMove.orientationIndex}`;
          topCounts.set(bestKey, (topCounts.get(bestKey) ?? 0) + 1);
        }
        const visitTotal = result.rankedMoves.reduce((sum, candidate) => sum + candidate.visits, 0);
        for (const candidate of result.rankedMoves.slice(0, topK)) {
          const candidateKey = `${candidate.move.pieceId}:${candidate.move.anchor.x}:${candidate.move.anchor.y}:${candidate.move.orientationIndex}`;
          const item = aggregate.get(candidateKey) ?? {
            candidate,
            valueSum: 0,
            visitsSum: 0,
            singleVisits: 0,
            policySum: 0,
            present: 0,
          };
          item.valueSum += candidate.value;
          item.visitsSum += candidate.visits;
          if (resultIndex === 0) {
            item.singleVisits = candidate.visits;
          }
          item.policySum += candidate.visits / Math.max(visitTotal, 1);
          item.present += 1;
          aggregate.set(candidateKey, item);
        }
      }
      const confidence = Math.max(...topCounts.values()) / searchRepeats;
      const candidates = [...aggregate.values()]
        .map((item) => ({
          ...item.candidate,
          value: item.valueSum / item.present,
          // Preserve an actual one-search target for the controlled target ablation. The consensus
          // distribution lives separately in `policy`; candidates absent from run zero get zero.
          visits: searchRepeats > 1 ? item.singleVisits : item.visitsSum,
          policy: item.policySum / searchRepeats,
        }))
        .sort((a, b) => b.policy - a.policy || b.visits - a.visits || b.value - a.value)
        .slice(0, topK);

      // Diverse openings, or every seed replays one line and the dataset is a hundred copies of the
      // same game. After the opening the teacher plays its best move, so the state distribution the
      // network sees is the one it will be asked to evaluate.
      const chosen =
        ply < openingRandomPlies
          ? candidates[randomInt(Math.min(3, candidates.length))]
          : candidates[0];

      const chosenKey = `${chosen.move.pieceId}:${chosen.move.anchor.x}:${chosen.move.anchor.y}:${chosen.move.orientationIndex}`;
      const seat = SEAT_OF_COLOR[mover];
      if (policyFeatures) {
        const parent = toPosition(state);
        refreshContext(context, parent, false);
        writeFeatures(parentScratch, 0, parent, context, seat);
      }
      let wrote = 0;

      for (const candidate of candidates) {
        const child = applyMove(state, candidate.move);
        const position = toPosition(child);
        refreshContext(context, position, false);
        if (policyFeaturesV2) {
          writePolicyFeaturesV2(
            scratch,
            position,
            context,
            seat,
            placementFor(candidate.move),
            parentScratch,
          );
        } else if (policyFeatures) {
          writePolicyFeatures(
            scratch,
            position,
            context,
            seat,
            placementFor(candidate.move),
            parentScratch,
          );
        } else {
          writeFeatures(scratch, 0, position, context, seat);
        }
        const key = `${candidate.move.pieceId}:${candidate.move.anchor.x}:${candidate.move.anchor.y}:${candidate.move.orientationIndex}`;
        let planes: Uint8Array | undefined;
        if (withPlanes) {
          planes = new Uint8Array(CELL_COUNT);
          for (let s2 = 0; s2 < 4; s2 += 1) {
            const owner = position.own[(seat + s2) % 4];
            for (let cell = 0; cell < CELL_COUNT; cell += 1) {
              if (testBit(owner, cell)) {
                planes[cell] = s2 + 1;
              }
            }
          }
          if (actionPlanes) {
            const placement = placementFor(candidate.move);
            const actionStart = PLACEMENTS.cellStart[placement];
            const actionEnd = PLACEMENTS.cellStart[placement + 1];
            for (let i = actionStart; i < actionEnd; i += 1) {
              planes[PLACEMENTS.cellList[i]] = 5;
            }
          }
        }
        pending.push({
          group,
          onPath: key === chosenKey,
          teacher: candidate.value,
          visits: candidate.visits,
          policy: candidate.policy,
          confidence,
          seat: mover,
          features: scratch.slice(),
          planes,
        });
        wrote += 1;
      }
      if (wrote > 0) {
        group += 1;
      }

      state = applyMove(state, chosen.move);
      ply += 1;
    }

    // score − mean(other three): the same statistic the tournament promotes on, so the regression
    // head is fitted to the quantity that decides whether a version is better.
    const table = calculateScores(state);
    const finalScores = Object.fromEntries(
      table.map((entry) => [entry.color, entry.score]),
    ) as Record<PlayerColor, number>;
    const margin: Record<PlayerColor, number> = {} as Record<PlayerColor, number>;
    for (const color of PLAYER_COLORS) {
      let others = 0;
      for (const other of PLAYER_COLORS) {
        if (other !== color) {
          others += finalScores[other];
        }
      }
      margin[color] = finalScores[color] - others / 3;
    }

    const xChunk = Buffer.alloc(pending.length * featureCount * 4);
    const yChunk = Buffer.alloc(pending.length * targetWidth * 4);
    let xAt = 0;
    let yAt = 0;
    for (const row of pending) {
      Buffer.from(row.features.buffer, row.features.byteOffset, featureCount * 4).copy(xChunk, xAt);
      xAt += featureCount * 4;
      // All four margins, rotated so index 0 is the seat that moved — the same seat-relative order
      // `writeFeatures` uses. One forward pass then predicts the whole value vector, instead of one
      // pass per seat, which is what makes the network affordable at every MCTS leaf.
      const base = SEAT_OF_COLOR[row.seat];
      const outcome = [
        margin[SEAT_COLORS[base]],
        margin[SEAT_COLORS[(base + 1) % 4]],
        margin[SEAT_COLORS[(base + 2) % 4]],
        margin[SEAT_COLORS[(base + 3) % 4]],
      ];
      const y = new Float32Array([
        row.group,
        row.onPath ? 1 : 0,
        row.teacher,
        row.visits,
        ...(searchRepeats > 1 ? [row.policy, row.confidence] : []),
        ...outcome,
        ...(withPlanes ? [base] : []),
      ]);
      Buffer.from(y.buffer).copy(yChunk, yAt);
      yAt += targetWidth * 4;
      rows += 1;
    }
    appendFileSync(`${outPrefix}.x.f32`, xChunk);
    appendFileSync(`${outPrefix}.y.f32`, yChunk);
    if (withPlanes) {
      const pChunk = Buffer.alloc(pending.length * CELL_COUNT);
      let pAt = 0;
      for (const row of pending) {
        if (row.planes) {
          Buffer.from(row.planes.buffer, row.planes.byteOffset, CELL_COUNT).copy(pChunk, pAt);
        }
        pAt += CELL_COUNT;
      }
      appendFileSync(`${outPrefix}.p.u8`, pChunk);
    }

    writeMeta(rows, group, g + 1);
    const rate = (g + 1) / ((Date.now() - started) / 60_000);
    console.log(
      `game ${g + 1}/${games} (${teacher}) — ${pending.length} rows, ${rows} total, ` +
        `${rate.toFixed(1)} games/min, ETA ${((games - g - 1) / rate).toFixed(0)} min`,
    );
  }

  writeMeta(rows, group, games);
  console.log(`\n${rows} rows in ${group} sibling groups → ${outPrefix}.*`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
