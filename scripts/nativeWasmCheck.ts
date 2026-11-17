/**
 * Identity and timing check of the WASM engine against the native one.
 *
 * For each config, the same requests (recorded positions, fixed seeds, base budget 300) go to the
 * native twin of the .wasm (`engine-wasm/target/release/blokee-wasm-probe`, the same request code
 * linked natively) and to the .wasm under node, alternating position by position so machine load
 * hits both alike. Every response is compared whole (source, iterations, every ranked move with
 * its visits and value to the last bit); the best move is also compared on its own.
 *
 *   npx tsx scripts/nativeWasmCheck.ts --moves tmp/d1/x1-l6a.moves.jsonl --positions 20 \
 *     --configs v5.2-nano,v5.2-lite,v5.2,v5.0-ultra [--min-ply 16 --max-ply 60] [--out tmp/wasm]
 *
 * Build first: `npm run wasm:build` and
 * `cargo build --release --manifest-path engine-wasm/Cargo.toml --bin blokee-wasm-probe`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NativeWasmModule } from '../src/ai/nativeWasm/module.ts';
import { samplePositions } from './lib/nativeWasmPositions.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const movesFile = arg('moves', 'tmp/d1/x1-l6a.moves.jsonl');
const positions = Number(arg('positions', '20'));
const configs = arg('configs', 'v5.2-nano,v5.2-lite,v5.2,v5.0-ultra').split(',');
const minPly = Number(arg('min-ply', '16'));
const maxPly = Number(arg('max-ply', '60'));
const budget = Number(arg('budget', '300'));
const out = arg('out', join('tmp', 'wasm-check'));
const probe = arg('probe', join('engine-wasm', 'target', 'release', 'blokee-wasm-probe'));
const wasmPath = arg('wasm', join('src', 'ai', 'nativeWasm', 'blokee_engine.wasm'));
const table = 'ml/v41-rollout-policy.json';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const requests = samplePositions(movesFile, positions, minPly, maxPly, budget);
  const wasmBytes = readFileSync(wasmPath);
  const tableText = readFileSync(table, 'utf8');
  const rows: string[] = [];
  const lines: string[] = [];
  for (const name of configs) {
    const configPath = join('engine-rs', 'configs', `${name}.json`);
    const configText = readFileSync(configPath, 'utf8');
    const child = spawn('nice', ['-n', '20', probe, configPath, table], { stdio: ['pipe', 'pipe', 'inherit'] });
    const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const module = await NativeWasmModule.instantiate(wasmBytes);
    const handle = module.createEngine(configText, tableText);
    let identical = 0;
    let sameBest = 0;
    let sameBestVisits = 0;
    const nativeMs: number[] = [];
    const wasmMs: number[] = [];
    let peak = 0;
    for (const [index, request] of requests.entries()) {
      const text = JSON.stringify(request);
      child.stdin.write(`${text}\n`);
      const reply = JSON.parse((await reader.next()).value as string) as {
        ms: number;
        response?: unknown;
        error?: string;
      };
      if (reply.error) throw new Error(`native: ${reply.error}`);
      const started = performance.now();
      const wasmText = module.searchJson(handle, text);
      wasmMs.push(performance.now() - started);
      nativeMs.push(reply.ms);
      peak = Math.max(peak, module.memoryBytes);
      const native = reply.response as { ranked: Array<{ mv: number; visits: number }> };
      const wasm = JSON.parse(wasmText) as typeof native;
      const same = JSON.stringify(native) === JSON.stringify(wasm);
      identical += same ? 1 : 0;
      sameBest += native.ranked[0]?.mv === wasm.ranked[0]?.mv ? 1 : 0;
      sameBestVisits +=
        native.ranked[0]?.mv === wasm.ranked[0]?.mv && native.ranked[0]?.visits === wasm.ranked[0]?.visits ? 1 : 0;
      lines.push(
        JSON.stringify({
          config: name,
          index,
          ply: request.moves.length,
          seed: request.seed,
          identical: same,
          nativeMs: reply.ms,
          wasmMs: Math.round(wasmMs[wasmMs.length - 1] * 1000) / 1000,
          memoryMB: Math.round(module.memoryBytes / 2 ** 20),
          native,
          wasm: same ? undefined : wasm,
        }),
      );
      process.stderr.write(
        `${name} ${index + 1}/${requests.length}: ${same ? 'identical' : 'DIFFERENT'}, native ${reply.ms.toFixed(0)} ms, wasm ${wasmMs[wasmMs.length - 1].toFixed(0)} ms\n`,
      );
    }
    child.stdin.end();
    const n = requests.length;
    const nMed = median(nativeMs);
    const wMed = median(wasmMs);
    rows.push(
      `| ${name} | ${n} | ${sameBest}/${n} | ${sameBestVisits}/${n} | ${identical}/${n} | ${nMed.toFixed(0)} | ${wMed.toFixed(0)} | ${(wMed / nMed).toFixed(2)} | ${Math.round(peak / 2 ** 20)} |`,
    );
  }
  writeFileSync(join(out, 'responses.jsonl'), `${lines.join('\n')}\n`);
  const table_ = [
    '| config | positions | same best move | same best move and visits | whole response identical | native median ms | wasm (node) median ms | ratio | wasm memory MB (max) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
  writeFileSync(join(out, 'summary.md'), `${table_}\n`);
  console.log(table_);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
