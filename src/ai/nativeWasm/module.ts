/**
 * The native engine (`engine-rs`) compiled to WebAssembly (`engine-wasm/`), behind a small
 * JSON-in/JSON-out wrapper. Platform-neutral: the caller supplies the module bytes, so the worker
 * (fetch), vitest and node scripts (file read) share this code.
 *
 * The module imports nothing and exports `memory` plus the `blokee_*` functions documented in
 * `engine-wasm/src/lib.rs`.
 */

interface Exports {
  memory: WebAssembly.Memory;
  blokee_alloc(len: number): number;
  blokee_free(ptr: number, len: number): void;
  blokee_engine_new(configPtr: number, configLen: number, tablePtr: number, tableLen: number): number;
  blokee_engine_free(handle: number): void;
  blokee_search(handle: number, requestPtr: number, requestLen: number): number;
  blokee_result_ptr(): number;
  blokee_result_len(): number;
}

/** A request as `engine-wasm` reads it (`SearchRequest`). Seats: 0 blue, 1 green, 2 purple, 3 yellow. */
export interface NativeSearchRequest {
  mode?: 'search' | 'greedy';
  seat?: number;
  /** Base iterations (the UI's 300); the engine applies the config's own `iterationScale`. */
  budget?: number;
  seed?: number;
  limit?: number;
  /** A game record of placement ids (-1 = pass), replayed from the empty board. */
  moves?: number[];
  openingAnywhere?: boolean;
  /** Or the board itself: 400 owners (seat or -1), row-major. */
  cells?: number[];
  hand?: number[];
  lastPiece?: number[];
  turn?: number;
  /** The game's placements so far as [seat, placement], oldest first. */
  recent?: Array<[number, number]>;
}

export interface NativeRanked {
  mv: number;
  visits: number;
  /** `logit(mean) * sigmoidScale` for a searched move, as `searchBestMoveV12` reports `value`. */
  value: number;
}

export interface NativeSearchResponse {
  source: 'search' | 'heuristic' | 'packer' | 'greedy';
  iterations: number;
  ranked: NativeRanked[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One instantiated module. A trap (out of memory, a panic) leaves Rust's state undefined, so after
 * one every call throws and the owner must instantiate a fresh module.
 */
export class NativeWasmModule {
  private readonly exports: Exports;
  private broken: string | null = null;

  private constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as Exports;
  }

  static async instantiate(source: BufferSource | WebAssembly.Module): Promise<NativeWasmModule> {
    const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const instance = await WebAssembly.instantiate(module, {});
    return new NativeWasmModule(instance);
  }

  /** Linear memory now, in bytes. It only grows, so after a search this is that search's peak or more. */
  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }

  get isBroken(): boolean {
    return this.broken !== null;
  }

  /** Creates an engine from a native config's JSON text and its rollout table's (or ''). */
  createEngine(configJson: string, tableJson: string): number {
    return this.call((e) => {
      const config = this.write(configJson);
      const table = this.write(tableJson);
      try {
        const handle = e.blokee_engine_new(config.ptr, config.len, table.ptr, table.len);
        if (handle === 0) {
          throw new Error(`native engine refused the config: ${this.result()}`);
        }
        return handle;
      } finally {
        e.blokee_free(config.ptr, config.len);
        e.blokee_free(table.ptr, table.len);
      }
    });
  }

  freeEngine(handle: number): void {
    if (!this.broken) {
      this.exports.blokee_engine_free(handle);
    }
  }

  /** Runs one request synchronously and returns the raw response JSON. */
  searchJson(handle: number, request: NativeSearchRequest | string): string {
    const text = typeof request === 'string' ? request : JSON.stringify(request);
    return this.call((e) => {
      const buffer = this.write(text);
      try {
        const ok = e.blokee_search(handle, buffer.ptr, buffer.len);
        const result = this.result();
        if (ok !== 1) {
          throw new Error(`native search failed: ${result}`);
        }
        return result;
      } finally {
        e.blokee_free(buffer.ptr, buffer.len);
      }
    });
  }

  search(handle: number, request: NativeSearchRequest): NativeSearchResponse {
    return JSON.parse(this.searchJson(handle, request)) as NativeSearchResponse;
  }

  private call<T>(fn: (e: Exports) => T): T {
    if (this.broken) {
      throw new Error(`native engine module is unusable after an earlier trap (${this.broken})`);
    }
    try {
      return fn(this.exports);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        this.broken = error.message;
        throw new Error(
          `native engine trapped (${error.message}); linear memory was ${Math.round(this.memoryBytes / 2 ** 20)} MB`,
        );
      }
      throw error;
    }
  }

  private write(text: string): { ptr: number; len: number } {
    const bytes = encoder.encode(text);
    const ptr = this.exports.blokee_alloc(bytes.length);
    // Re-read `buffer` after the allocation: growing memory detaches the old one.
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  private result(): string {
    const ptr = this.exports.blokee_result_ptr();
    const len = this.exports.blokee_result_len();
    return decoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
  }
}
