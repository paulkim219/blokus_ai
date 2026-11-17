import type { AlgoConfig, AlgoVersionId } from '../algoVersions';
import type { NativeEngineConfig } from '../nativeWasm/types';
import v50Ultra from '../../../engine-rs/configs/v5.0-ultra.json' with { type: 'json' };
import v52Nano from '../../../engine-rs/configs/v5.2-nano.json' with { type: 'json' };
import v52Lite from '../../../engine-rs/configs/v5.2-lite.json' with { type: 'json' };
import v52 from '../../../engine-rs/configs/v5.2.json' with { type: 'json' };
import v52Turbo from '../../../engine-rs/configs/v5.2-turbo.json' with { type: 'json' };
import v52Pro from '../../../engine-rs/configs/v5.2-pro.json' with { type: 'json' };
import v53Nano from '../../../engine-rs/configs/v5.3-nano.json' with { type: 'json' };
import v53Lite from '../../../engine-rs/configs/v5.3-lite.json' with { type: 'json' };
import v53 from '../../../engine-rs/configs/v5.3.json' with { type: 'json' };
import v53Turbo from '../../../engine-rs/configs/v5.3-turbo.json' with { type: 'json' };
import { V4_WEIGHTS } from './v1';

/**
 * The v5 line: the native engine's own models (`engine-rs/configs/`), played in the browser by the
 * same engine compiled to WebAssembly (`engine-wasm/`, `src/ai/nativeWasm/`).
 *
 * Their configs carry a `native` block (RAVE, interior expansion, the fitted feature prior, rank
 * reward, last-good-reply, priorLog selection) that the TS engine cannot play, so they are
 * `engine: 'native-wasm'` and never `bitboard`: a bitboard entry would silently run them on the TS
 * engine without any of it. These ids are unrelated to the `v5-*` "v5 Oracle" experiments in
 * `./v5.ts`.
 *
 * `iterationScale` stays unset here (1): the native engine applies the config's own scale to the
 * UI's base budget of 300, exactly as `blokee-match --budget 300` does. The tiers are matched to
 * Pentobi's time per move on native (`docs/V5_TRACKER.md`); in the browser each takes longer.
 *
 * `v5.2-ultra` is not registered: it peaks around 10 GB natively, beyond wasm32's 4 GB.
 */
function nativeVersion(
  id: AlgoVersionId,
  configName: string,
  config: NativeEngineConfig,
  summary: string,
): AlgoConfig {
  return {
    id,
    summary,
    // Legacy fields: unread by this engine, present because every config carries them.
    weights: V4_WEIGHTS,
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: true,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    engine: 'native-wasm',
    native: { configName, config },
  };
}

export const V5_NATIVE_VERSIONS: Record<AlgoVersionId, AlgoConfig> = {
  'v5.0-ultra': nativeVersion(
    'v5.0-ultra',
    'v5.0-ultra',
    v50Ultra as NativeEngineConfig,
    'Start of the v5 line (named 2026-11-14): the Pentobi-port package — interior expansion, RAVE, ' +
      'priorLog selection, rank reward, last-good-reply, fitted root and interior prior — at ' +
      'iterationScale 13.528. Native engine in WebAssembly.',
  ),
  'v5.2-nano': nativeVersion(
    'v5.2-nano',
    'v5.2-nano',
    v52Nano as NativeEngineConfig,
    'v5.2 nano tier: v5.1-ultra settings at Pentobi level 1 time per move (iterationScale 0.383). ' +
      'Benchmark score 2.84. Native engine in WebAssembly.',
  ),
  'v5.2-lite': nativeVersion(
    'v5.2-lite',
    'v5.2-lite',
    v52Lite as NativeEngineConfig,
    'v5.2 lite tier: Pentobi level 3 time per move (iterationScale 0.647). Benchmark score 3.41. ' +
      'Native engine in WebAssembly.',
  ),
  'v5.2': nativeVersion(
    'v5.2',
    'v5.2',
    v52 as NativeEngineConfig,
    'v5.2 base tier: Pentobi level 5 time per move (iterationScale 3.545). Benchmark score 5.06. ' +
      'Native engine in WebAssembly.',
  ),
  'v5.2-turbo': nativeVersion(
    'v5.2-turbo',
    'v5.2-turbo',
    v52Turbo as NativeEngineConfig,
    'v5.2 turbo tier: the base model at Pentobi level 6 time per move (iterationScale 23.222; named ' +
      'turbo 2026-11-16). Benchmark score 6.07. Native engine in WebAssembly.',
  ),
  'v5.2-pro': nativeVersion(
    'v5.2-pro',
    'v5.2-pro',
    v52Pro as NativeEngineConfig,
    'v5.2 pro tier: Pentobi level 7 time per move (iterationScale 224.487, about 67,000 iterations ' +
      'a move). Benchmark score 6.67. Native engine in WebAssembly; several seconds a move in a browser.',
  ),
  'v5.3-nano': nativeVersion(
    'v5.3-nano',
    'v5.3-nano',
    v53Nano as NativeEngineConfig,
    'v5.3 nano tier (named 2026-11-17): v5.2-nano plus the narrow interior cap (floor(2 + 0.5 sqrt(visits)) ' +
      'children per interior node), at Pentobi level 1 time per move (iterationScale 0.363). +0.94 over ' +
      'v5.2-nano; benchmark score 3.01. Native engine in WebAssembly.',
  ),
  'v5.3-lite': nativeVersion(
    'v5.3-lite',
    'v5.3-lite',
    v53Lite as NativeEngineConfig,
    'v5.3 lite tier (named 2026-11-17): v5.2-lite plus the narrow interior cap (floor(2 + 0.5 sqrt(visits))), ' +
      'at Pentobi level 3 time per move (iterationScale 0.647). +1.10 over v5.2-lite; benchmark score 3.53. ' +
      'Native engine in WebAssembly.',
  ),
  'v5.3': nativeVersion(
    'v5.3',
    'v5.3',
    v53 as NativeEngineConfig,
    'v5.3 base tier (named 2026-11-16): v5.2 plus the interior cap (each interior node considers its ' +
      'floor(4 + sqrt(visits)) best children), at Pentobi level 5 time per move (iterationScale 3.776). ' +
      '+0.71 over v5.2; benchmark score 5.16. Native engine in WebAssembly.',
  ),
  'v5.3-turbo': nativeVersion(
    'v5.3-turbo',
    'v5.3-turbo',
    v53Turbo as NativeEngineConfig,
    'v5.3 turbo tier: v5.3 at Pentobi level 6 time per move (iterationScale 25.091). +0.71 over ' +
      'v5.2-turbo; benchmark score 6.15. Native engine in WebAssembly.',
  ),
};
