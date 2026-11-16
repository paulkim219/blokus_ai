/**
 * Fixed positions for the native-vs-WASM checks: decisions (the mover had a move) from recorded
 * games (`blokee-pentobi --moves-out` JSONL), minPly <= ply <= maxPly, evenly spaced. Each carries
 * a fixed seed derived from the game seed and ply, as `examples/s4_identity.rs` derives it.
 */
import { readFileSync } from 'node:fs';
import type { NativeSearchRequest } from '../../src/ai/nativeWasm/module.ts';

export function samplePositions(
  movesFile: string,
  count: number,
  minPly: number,
  maxPly: number,
  budget = 300,
): Array<NativeSearchRequest & { moves: number[]; seed: number }> {
  const games = readFileSync(movesFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { seed: number; moves: number[] });
  const candidates: Array<{ seed: number; prefix: number[] }> = [];
  for (const game of games) {
    for (let ply = minPly; ply <= Math.min(maxPly, game.moves.length - 1); ply += 1) {
      if (game.moves[ply] >= 0) candidates.push({ seed: game.seed, prefix: game.moves.slice(0, ply) });
    }
  }
  const step = Math.max(1, Math.floor(candidates.length / count));
  return candidates
    .filter((_, i) => i % step === 0)
    .slice(0, count)
    .map(({ seed, prefix }) => ({
      moves: prefix,
      budget,
      seed: (seed ^ Math.imul(prefix.length, 0x9e3779b9)) >>> 0,
    }));
}
