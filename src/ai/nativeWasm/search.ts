/**
 * `engine: 'native-wasm'` versions: the native engine (`engine-rs`), compiled to WebAssembly by
 * `npm run wasm:build`, searching in the AI worker.
 *
 * The request carries exactly what `toPosition(state)` gives the TS engine (cell owners, hands,
 * last pieces, side to move) plus the game's last three placements, which the native fitted prior's
 * local-response features read. The budget passed is the UI's *base* budget (300): the engine
 * multiplies it by the native config's own `iterationScale`, as `blokee-match --budget 300` does,
 * so the registry entry must leave `AlgoConfig.iterationScale` at its default and this code must
 * not scale it again.
 *
 * A search is one synchronous call into the module, so it must never run on the page's main
 * thread; `searchBestMoveNativeWasm` refuses to.
 */
import raw from '../../../ml/v41-rollout-policy.json' with { type: 'json' };
import { PIECES } from '../../engine/pieces';
import { BOARD_SIZE } from '../../engine/types';
import type { GameState, PlaceMove, PlayerColor } from '../../engine/types';
import { placementFor, toPlaceMove } from '../bitboard/adapter';
import { SEAT_OF_COLOR } from '../bitboard/seats';
import type { ProgressCallback, SearchProgress } from '../progress';
import { random } from '../rng';
import type { RankedMove, SearchResult } from '../searchTypes';
import { NativeWasmModule, type NativeSearchRequest, type NativeSearchResponse } from './module';
import type { NativeWasmSpec } from './types';

/** The only rollout table a native config may name today (`playoutTablePath`). */
const ROLLOUT_TABLES: Record<string, unknown> = { 'ml/v41-rollout-policy.json': raw };

let modulePromise: Promise<NativeWasmModule> | null = null;
/** One live engine at a time: every engine's tree lives in the same linear memory, which never shrinks. */
let live: { key: string; configJson: string; handle: number } | null = null;

interface FsLike {
  readFile(path: URL): Promise<Uint8Array>;
}

async function wasmBytes(): Promise<ArrayBuffer> {
  const url = new URL('./blokee_engine.wasm', import.meta.url);
  if (url.protocol === 'file:') {
    // Node (vitest, tsx scripts). Kept out of the browser bundle by the computed specifier.
    const specifier = 'node:fs/promises';
    const fs = (await import(/* @vite-ignore */ specifier)) as FsLike;
    const bytes = await fs.readFile(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not load the native engine (${response.status} ${url.pathname})`);
  }
  return response.arrayBuffer();
}

/** A fresh, separate instance of the module (tests and diagnostics; searches use a shared one). */
export async function instantiateNativeWasm(): Promise<NativeWasmModule> {
  return NativeWasmModule.instantiate(await wasmBytes());
}

async function loadModule(): Promise<NativeWasmModule> {
  if (modulePromise) {
    const existing = await modulePromise;
    if (!existing.isBroken) {
      return existing;
    }
    // A trap leaves the module unusable; start over with a fresh one.
    modulePromise = null;
    live = null;
  }
  modulePromise = wasmBytes().then((bytes) => NativeWasmModule.instantiate(bytes));
  try {
    return await modulePromise;
  } catch (error) {
    modulePromise = null;
    throw error;
  }
}

async function engineFor(key: string, spec: NativeWasmSpec): Promise<{ module: NativeWasmModule; handle: number }> {
  const module = await loadModule();
  const configJson = JSON.stringify(spec.config);
  if (live && live.key === key && live.configJson === configJson) {
    return { module, handle: live.handle };
  }
  if (live) {
    module.freeEngine(live.handle);
    live = null;
  }
  const tablePath = spec.config.search.playoutPolicy === 'table' ? spec.config.search.playoutTablePath : null;
  let tableJson = '';
  if (tablePath) {
    const table = ROLLOUT_TABLES[tablePath];
    if (!table) {
      throw new Error(`${spec.configName}: rollout table ${tablePath} is not bundled with the app`);
    }
    // JSON.parse/stringify round-trips every double exactly, and the engine parses with
    // serde_json's float_roundtrip, so the engine sees the same numbers as from the file.
    tableJson = JSON.stringify(table);
  }
  const handle = module.createEngine(configJson, tableJson);
  live = { key, configJson, handle };
  return { module, handle };
}

function onPageMainThread(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** The request for `player`'s decision at `state`, built as `toPosition` builds the TS engine's. */
export function nativeRequestFor(state: GameState, player: PlayerColor): NativeSearchRequest {
  const cells = new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(-1);
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const owner = state.board[y][x];
      if (owner) {
        cells[y * BOARD_SIZE + x] = SEAT_OF_COLOR[owner];
      }
    }
  }
  const hand = [0, 0, 0, 0];
  const lastPiece = [-1, -1, -1, -1];
  for (const color of Object.keys(SEAT_OF_COLOR) as PlayerColor[]) {
    const seat = SEAT_OF_COLOR[color];
    for (const pieceId of state.remainingPieces[color]) {
      hand[seat] |= 1 << pieceId;
    }
    lastPiece[seat] = state.lastPlacedPieceId[color] ?? -1;
  }
  const recent: Array<[number, number]> = [];
  for (let i = state.moveHistory.length - 1; i >= 0 && recent.length < 3; i -= 1) {
    const move = state.moveHistory[i];
    if (move.type === 'place') {
      const id = placementFor(move);
      if (id >= 0) {
        recent.unshift([SEAT_OF_COLOR[move.color], id]);
      }
    }
  }
  return {
    cells,
    hand,
    lastPiece,
    turn: SEAT_OF_COLOR[state.currentTurn],
    openingAnywhere: state.openingMode === 'anywhere',
    recent,
    seat: SEAT_OF_COLOR[player],
  };
}

function moveLabel(move: PlaceMove | null): string | undefined {
  return move ? `${PIECES[move.pieceId].name} @ (${move.anchor.x},${move.anchor.y})` : undefined;
}

function toRanked(response: NativeSearchResponse, player: PlayerColor, sigmoidScale: number): RankedMove[] {
  return response.ranked.map((entry) => ({
    move: toPlaceMove(entry.mv, player),
    visits: entry.visits,
    // `value` is logit(mean) * sigmoidScale for a searched move; invert it for the win rate.
    winRate:
      response.source === 'search' && entry.visits > 0 ? 1 / (1 + Math.exp(-entry.value / sigmoidScale)) : 0,
    value: entry.value,
  }));
}

function confidenceOf(response: NativeSearchResponse, ranked: RankedMove[]): number {
  if (response.source === 'heuristic') return 0.75;
  if (response.source === 'packer') return 0.9;
  const [best, second] = ranked;
  return best && second && best.visits + second.visits > 0
    ? Math.min(1, Math.abs(best.value - second.value) / 8 + best.visits / (best.visits + second.visits))
    : 0.5;
}

async function emit(onProgress: ProgressCallback | undefined, progress: SearchProgress): Promise<void> {
  if (onProgress) {
    await onProgress(progress);
  }
}

export interface NativeWasmOptions {
  /** Base iterations (the UI passes `UI_SEARCH_ITERATIONS`); the engine applies `iterationScale`. */
  iterationBudget?: number;
  /** The version id; one engine is kept per id. */
  engineKey: string;
  /** Fixed seed for reproducible runs; by default drawn from the engine RNG stream (`rng.ts`). */
  seed?: number;
}

export async function searchBestMoveNativeWasm(
  state: GameState,
  rootPlayer: PlayerColor,
  timeLimitMs: number,
  spec: NativeWasmSpec,
  onProgress: ProgressCallback | undefined,
  options: NativeWasmOptions,
): Promise<SearchResult> {
  if (onPageMainThread()) {
    throw new Error(`${options.engineKey} runs only in the AI worker; it would block the page`);
  }
  const startedAt = performance.now();
  const budget = options.iterationBudget ?? 300;
  const maxIterations = Math.max(1, Math.round(budget * spec.config.search.iterationScale));
  const progress = (phase: SearchProgress['phase'], percent: number, extra: Partial<SearchProgress> = {}) =>
    emit(onProgress, {
      phase,
      percent,
      iterations: 0,
      maxIterations,
      elapsedMs: Math.round(performance.now() - startedAt),
      timeLimitMs,
      candidates: 0,
      ...extra,
    });

  // Before anything slow: the client gives the worker 1.5 s to say something.
  await progress('starting', 2);
  const { module, handle } = await engineFor(options.engineKey, spec);
  await progress('searching', 10);
  const request: NativeSearchRequest = {
    ...nativeRequestFor(state, rootPlayer),
    budget,
    seed: options.seed ?? Math.floor(random() * 0x100000000) >>> 0,
  };
  const response = module.search(handle, request);
  const rankedMoves = toRanked(response, rootPlayer, spec.config.search.sigmoidScale);
  const best = rankedMoves[0] ?? null;
  await progress('done', 100, {
    iterations: response.iterations,
    maxIterations: response.source === 'search' ? maxIterations : 0,
    candidates: rankedMoves.length,
    currentBestLabel: moveLabel(best?.move ?? null),
  });
  return { bestMove: best?.move ?? null, rankedMoves, confidence: confidenceOf(response, rankedMoves) };
}

/** `rankMovesGreedyV12` on the native engine (`Engine::rank_greedy`): the ponder preview. */
export async function rankMovesGreedyNativeWasm(
  state: GameState,
  rootPlayer: PlayerColor,
  spec: NativeWasmSpec,
  engineKey: string,
): Promise<SearchResult> {
  if (onPageMainThread()) {
    throw new Error(`${engineKey} runs only in the AI worker; it would block the page`);
  }
  const { module, handle } = await engineFor(engineKey, spec);
  const response = module.search(handle, { ...nativeRequestFor(state, rootPlayer), mode: 'greedy' });
  const rankedMoves = response.ranked.map((entry) => ({
    move: toPlaceMove(entry.mv, rootPlayer),
    visits: 1,
    winRate: 0,
    value: entry.value,
  }));
  if (rankedMoves.length === 0) {
    return { bestMove: null, rankedMoves, confidence: 0 };
  }
  const gap = rankedMoves.length > 1 ? Math.abs(rankedMoves[0].value - rankedMoves[1].value) : 0;
  return { bestMove: rankedMoves[0].move, rankedMoves, confidence: Math.min(0.85, 0.35 + gap / 20) };
}

/** Linear memory of the loaded module in bytes (0 before the first search). Diagnostics only. */
export async function nativeWasmMemoryBytes(): Promise<number> {
  return modulePromise ? (await modulePromise).memoryBytes : 0;
}
