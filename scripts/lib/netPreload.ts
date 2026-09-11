import { existsSync, readFileSync } from 'node:fs';
import { isNetRegistered, loadNet, registerNet } from '../../src/ai/bitboard/net.ts';
import {
  isPooledPolicyNetRegistered,
  loadPooledPolicyNet,
  registerPooledPolicyNet,
  type RawPooledPolicyNet,
} from '../../src/ai/bitboard/spatialNet.ts';
import { isBookRegistered, registerBook, type BookFile } from '../../src/ai/bitboard/book.ts';
import {
  isRolloutPolicyRegistered,
  loadRolloutPolicy,
  registerRolloutPolicy,
  type RawRolloutPolicy,
} from '../../src/ai/bitboard/rolloutPolicy.ts';
import { ALGO_VERSIONS, bitboardParamsFor, type AlgoConfig } from '../../src/ai/algoVersions.ts';

/**
 * Node-side loader for learned evaluations.
 *
 * The engine itself never reads a file — it has to stay importable by the browser build — so every
 * Node entry point that might play a net-backed version calls this once at startup. Worker
 * processes call it too, after registering any generated configs, because a config that names
 * weights nobody loaded would otherwise fall back to the hand-written evaluation *silently* and
 * report a number for the wrong engine. That failure mode already cost this project once, when 23
 * configs declaring `engine: "v12"` after a rename quietly ran on the legacy engine.
 */
export function preloadNets(extra: AlgoConfig[] = []): void {
  const paths = new Set<string>();
  const pooledPaths = new Set<string>();
  const bookPaths = new Set<string>();
  const rolloutPolicyPaths = new Set<string>();
  const configs: AlgoConfig[] = [...Object.values(ALGO_VERSIONS), ...extra];
  for (const config of configs) {
    if (config.engine !== 'bitboard') {
      continue;
    }
    const path = bitboardParamsFor(config).search.netPath;
    if (path) {
      paths.add(path);
    }
    const pooledPath = bitboardParamsFor(config).search.pooledNetPath;
    if (pooledPath) pooledPaths.add(pooledPath);
    const bookPath = bitboardParamsFor(config).search.bookPath;
    if (bookPath) bookPaths.add(bookPath);
    const rolloutPolicyPath = bitboardParamsFor(config).search.playoutTablePath;
    if (rolloutPolicyPath) rolloutPolicyPaths.add(rolloutPolicyPath);
  }
  for (const path of bookPaths) {
    if (isBookRegistered(path)) continue;
    // A missing book is loud but not fatal: the engine plays on without one, and the search it
    // would have skipped simply runs. That is a strength difference, not a wrong-engine bug, so it
    // does not warrant the hard throw a missing net gets.
    if (!existsSync(path)) {
      console.warn(`[preload] opening book not found: ${path} — configs naming it will search instead`);
      continue;
    }
    const file = JSON.parse(readFileSync(path, 'utf8')) as BookFile;
    registerBook(path, file);
    console.log(`[preload] opening book ${path}: ${file.entries.length} entries`);
  }
  for (const path of paths) {
    if (isNetRegistered(path)) {
      continue;
    }
    if (!existsSync(path)) {
      // Not fatal here, because every run loads *every* registered version's weights and a missing
      // v4 file must not stop a v1-vs-v2 match. The engine refuses to play a net-backed version
      // without its net, so the failure still surfaces — at the version that actually needs it.
      console.warn(`[net] ${path} not found; versions that need it will refuse to play`);
      continue;
    }
    registerNet(path, loadNet(JSON.parse(readFileSync(path, 'utf8'))));
  }
  for (const path of pooledPaths) {
    if (isPooledPolicyNetRegistered(path)) continue;
    if (!existsSync(path)) {
      console.warn(`[net] ${path} not found; versions that need it will refuse to play`);
      continue;
    }
    registerPooledPolicyNet(
      path,
      loadPooledPolicyNet(JSON.parse(readFileSync(path, 'utf8')) as RawPooledPolicyNet),
    );
  }
  for (const path of rolloutPolicyPaths) {
    if (isRolloutPolicyRegistered(path)) continue;
    if (!existsSync(path)) {
      console.warn(`[net] ${path} not found; versions that need it will refuse to play`);
      continue;
    }
    registerRolloutPolicy(
      path,
      loadRolloutPolicy(JSON.parse(readFileSync(path, 'utf8')) as RawRolloutPolicy),
    );
  }
}
