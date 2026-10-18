/**
 * Resolve every bitboard version to its full `BitboardParams` and write one JSON per version to
 * `engine-rs/configs/`, for the native CLI tools (`blokee-selfplay`). The TS registry stays the
 * only place a version id is defined; this is a snapshot of it, regenerated whenever it changes.
 *
 *   npx tsx scripts/exportResolvedConfigs.ts [--out engine-rs/configs]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALGO_VERSIONS, bitboardParamsFor, getAlgo } from '../src/ai/algoVersions.ts';

const index = process.argv.indexOf('--out');
const out = index >= 0 ? process.argv[index + 1] : join('engine-rs', 'configs');
mkdirSync(out, { recursive: true });
let written = 0;
for (const id of Object.keys(ALGO_VERSIONS)) {
  const config = getAlgo(id as never);
  if (config.engine !== 'bitboard') continue;
  writeFileSync(join(out, `${id}.json`), `${JSON.stringify(bitboardParamsFor(config), null, 1)}\n`);
  written += 1;
}
console.log(`wrote ${written} bitboard configs to ${out}`);
