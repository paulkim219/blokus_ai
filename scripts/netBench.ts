import { preloadNets } from './lib/netPreload.ts';
import { forward, netFor } from '../src/ai/bitboard/net.ts';
import { FEATURE_COUNT, writeFeatures } from '../src/ai/bitboard/netFeatures.ts';
import { createEvalContext, refreshContext } from '../src/ai/bitboard/features.ts';
import { toPosition } from '../src/ai/bitboard/index.ts';
import { createInitialState, applyMove, generateLegalMoves } from '../src/engine/game.ts';

/** Where does the learned evaluation actually spend its time? */
function main(): void {
  preloadNets();
  const net = netFor('ml/v4-weights.json');
  if (!net) {
    throw new Error('no net');
  }
  let state = createInitialState('corner');
  for (let i = 0; i < 12; i += 1) {
    state = applyMove(state, generateLegalMoves(state, state.currentTurn, 1)[0]);
  }
  const position = toPosition(state);
  const context = createEvalContext();
  const input = new Float32Array(FEATURE_COUNT);

  const N = 20_000;
  let t = performance.now();
  for (let i = 0; i < N; i += 1) {
    refreshContext(context, position, false);
  }
  const refresh = (performance.now() - t) / N;

  refreshContext(context, position, false);
  t = performance.now();
  for (let i = 0; i < N; i += 1) {
    writeFeatures(input, 0, position, context, 0);
  }
  const extract = (performance.now() - t) / N;

  t = performance.now();
  let sink = 0;
  for (let i = 0; i < N; i += 1) {
    sink += forward(net, input)[0];
  }
  const fwd = (performance.now() - t) / N;

  console.log(`refreshContext ${(refresh * 1000).toFixed(1)} µs`);
  console.log(`writeFeatures  ${(extract * 1000).toFixed(1)} µs`);
  console.log(`forward        ${(fwd * 1000).toFixed(1)} µs   (sink ${sink.toFixed(0)})`);
  console.log(`total/leaf     ${((refresh + extract + fwd) * 1000).toFixed(1)} µs`);
  console.log(`→ at 300 leaves ${((refresh + extract + fwd) * 300).toFixed(0)} ms/move`);
}
main();
