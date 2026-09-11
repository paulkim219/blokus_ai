import { readFileSync, writeFileSync } from 'node:fs';
import { placementFor, toPosition } from '../src/ai/bitboard/index.ts';
import { createEvalContext, refreshContext } from '../src/ai/bitboard/features.ts';
import { FEATURE_COUNT, writeFeatures } from '../src/ai/bitboard/netFeatures.ts';
import { POLICY_V2_FEATURE_COUNT, writePolicyFeaturesV2 } from '../src/ai/bitboard/policyFeaturesV2.ts';
import { PLACEMENTS } from '../src/ai/bitboard/placements.ts';
import { SEAT_OF_COLOR } from '../src/ai/bitboard/seats.ts';
import {
  loadPooledPolicyNet,
  preparePooledPosition,
  scorePooledPlacement,
  type RawPooledPolicyNet,
} from '../src/ai/bitboard/spatialNet.ts';
import { applyMove, createInitialState, generateLegalMoves } from '../src/engine/game.ts';

let state = createInitialState('corner');
for (let ply = 0; ply < 20; ply += 1) {
  const moves = generateLegalMoves(state, state.currentTurn);
  state = applyMove(state, moves[Math.floor(moves.length / 3)]);
}
const seat = SEAT_OF_COLOR[state.currentTurn];
const position = toPosition(state);
const net = loadPooledPolicyNet(
  JSON.parse(readFileSync('ml/v45-pooled-seed4501.json', 'utf8')) as RawPooledPolicyNet,
);
preparePooledPosition(net, position, seat);

const context = createEvalContext();
refreshContext(context, position, false);
const parent = new Float32Array(FEATURE_COUNT);
writeFeatures(parent, 0, position, context, seat);
const features = new Float32Array(POLICY_V2_FEATURE_COUNT);
const candidates = generateLegalMoves(state, state.currentTurn).slice(0, 8).map((move) => {
  const placement = placementFor(move);
  const undo = position.apply(placement);
  refreshContext(context, position, false);
  writePolicyFeaturesV2(features, position, context, seat, placement, parent);
  const score = scorePooledPlacement(net, placement, seat, features);
  position.undo(undo);
  const mask = new Array<number>(400).fill(0);
  // Python only needs the exact canonical action mask; use the same home reflection as deployment.
  for (let at = PLACEMENTS.cellStart[placement]; at < PLACEMENTS.cellStart[placement + 1]; at += 1) {
    const cell = PLACEMENTS.cellList[at];
    const x = cell % 20;
    const y = Math.floor(cell / 20);
    const cx = seat === 2 || seat === 3 ? 19 - x : x;
    const cy = seat === 1 || seat === 2 ? 19 - y : y;
    mask[cy * 20 + cx] = 1;
  }
  return { features: [...features], mask, score };
});

const planes = [...net.members[0].boardInput];
writeFileSync(
  'selfplay-results/v45-spatial-parity-input.json',
  `${JSON.stringify({ planes, candidates })}\n`,
);
console.log(candidates.map(({ score }) => score));
