/**
 * A resolved native config (`engine-rs/configs/*.json`): a full `BitboardParams` plus the
 * native-only `native` block (RAVE, interior expansion, fitted prior, rank reward, ...) that the TS
 * engine cannot play. Only the fields the app reads are typed; the rest goes to the engine as is.
 */
export interface NativeEngineConfig {
  search: {
    /** Applied by the native engine itself to the UI's base budget (300): never apply it twice. */
    iterationScale: number;
    sigmoidScale: number;
    playoutPolicy: string;
    playoutTablePath?: string | null;
  };
  native?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** `AlgoConfig.native`: what an `engine: 'native-wasm'` version runs. */
export interface NativeWasmSpec {
  /** The config's file name in `engine-rs/configs/` (without `.json`), for messages and provenance. */
  configName: string;
  /** That file's contents, imported as JSON. */
  config: NativeEngineConfig;
}
