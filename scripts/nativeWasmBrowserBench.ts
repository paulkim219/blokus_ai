/**
 * Times the native-wasm versions in headless Chromium through the app's own built worker
 * (`dist/assets/ai.worker-*.js`, which fetches the bundled .wasm), on the positions
 * `nativeWasmCheck.ts` uses, alternating position by position with the native twin
 * (`blokee-wasm-probe`) so machine load hits both alike. Each browser request is a `suggestMove`
 * with the UI's base budget, exactly as the live game sends it; its time runs from posting the
 * request to the worker's answer, so it includes the request conversion and the move tip, not only
 * the search. One untimed search per version first loads the module and the engine. The browser
 * draws its own seed (as the app does); the native side uses the position's fixed seed.
 *
 *   npm run build && npx tsx scripts/nativeWasmBrowserBench.ts --moves tmp/d1/x1-l6a.moves.jsonl \
 *     --positions 20 --versions v5.2-nano,v5.2-lite,v5.2,v5.0-ultra,v5.2-pro [--out tmp/wasm-browser] \
 *     [--chromium <path to a Chromium or chrome-headless-shell binary>]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { applyMove, createInitialState, passTurn } from '../src/engine/game.ts';
import type { GameState } from '../src/engine/types.ts';
import { toPlaceMove } from '../src/ai/bitboard/adapter.ts';
import { samplePositions } from './lib/nativeWasmPositions.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const movesFile = arg('moves', 'tmp/d1/x1-l6a.moves.jsonl');
const count = Number(arg('positions', '20'));
const versions = arg('versions', 'v5.2-nano,v5.2-lite,v5.2,v5.0-ultra,v5.2-pro').split(',');
const minPly = Number(arg('min-ply', '16'));
const maxPly = Number(arg('max-ply', '60'));
const out = arg('out', join('tmp', 'wasm-browser'));
const dist = 'dist';
/** A Chromium other than the one this Playwright version expects, e.g. an older cached build. */
const executablePath = arg('chromium', '') || undefined;
const probe = arg('probe', join('engine-wasm', 'target', 'release', 'blokee-wasm-probe'));

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
};

/**
 * Runs in the page, so it is plain JS text: tsx would otherwise inject helpers (`__name`) into a
 * function passed to `page.evaluate`. Times one version's searches through the app's worker.
 */
const PAGE_SETUP = `(() => {
  let worker = null;
  let next = 0;
  window.benchStart = (workerUrl) => {
    if (worker) worker.terminate();
    worker = new Worker(workerUrl, { type: 'module' });
  };
  window.benchAsk = (version, state) => new Promise((resolve) => {
    next += 1;
    const id = 'r' + next;
    const started = performance.now();
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.id !== id || data.type === 'progress') return;
      resolve({ ms: performance.now() - started, error: data.type === 'error' ? data.message : undefined });
    };
    worker.postMessage({ id, type: 'suggestMove', state, player: state.currentTurn, timeLimitMs: 2200, version, iterationBudget: 300 });
  });
})()`;

function stateFor(moves: number[]): GameState {
  let state = createInitialState();
  for (const id of moves) {
    state = id < 0 ? passTurn(state) : applyMove(state, toPlaceMove(id, state.currentTurn));
  }
  return state;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const workerFile = readdirSync(join(dist, 'assets')).find((f) => f.startsWith('ai.worker-') && f.endsWith('.js'));
  if (!workerFile) throw new Error('no built worker in dist/assets: run npm run build first');
  const positions = samplePositions(movesFile, count, minPly, maxPly).map((p) => ({
    request: p,
    ply: p.moves.length,
    state: stateFor(p.moves),
  }));

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/bench.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>bench</title>');
      return;
    }
    try {
      const body = readFileSync(join(dist, path));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage();
  page.on('console', (message) => process.stderr.write(`[page] ${message.text()}\n`));
  await page.goto(`http://127.0.0.1:${port}/bench.html`);
  const userAgent = (await page.evaluate('navigator.userAgent')) as string;
  await page.evaluate(PAGE_SETUP);
  const ask = async (version: string, state: GameState) => {
    const answer = (await page.evaluate(`window.benchAsk(${JSON.stringify(version)}, ${JSON.stringify(state)})`)) as {
      ms: number;
      error?: string;
    };
    if (answer.error) throw new Error(`${version}: ${answer.error}`);
    return answer.ms;
  };

  const rows: string[] = [];
  const records: unknown[] = [];
  for (const version of versions) {
    const configPath = join('engine-rs', 'configs', `${version}.json`);
    const child = spawn('nice', ['-n', '20', probe, configPath, 'ml/v41-rollout-policy.json'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const native = async (request: unknown) => {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const reply = JSON.parse((await lines.next()).value as string) as { ms: number; error?: string };
      if (reply.error) throw new Error(`native ${version}: ${reply.error}`);
      return reply.ms;
    };
    await page.evaluate(`window.benchStart(${JSON.stringify(`/assets/${workerFile}`)})`);
    await native(positions[0].request);
    await ask(version, positions[0].state);
    const browserMs: number[] = [];
    const nativeMs: number[] = [];
    for (const position of positions) {
      nativeMs.push(await native(position.request));
      browserMs.push(await ask(version, position.state));
    }
    child.stdin.end();
    const ratio = median(browserMs.map((ms, i) => ms / nativeMs[i]));
    process.stderr.write(`${version}: browser median ${median(browserMs).toFixed(0)} ms, native ${median(nativeMs).toFixed(0)} ms\n`);
    records.push({ version, plies: positions.map((p) => p.ply), browserMs, nativeMs });
    rows.push(
      `| ${version} | ${positions.length} | ${median(nativeMs).toFixed(1)} | ${median(browserMs).toFixed(1)} | ${ratio.toFixed(2)} | ${Math.max(...nativeMs).toFixed(0)} | ${Math.max(...browserMs).toFixed(0)} |`,
    );
  }
  await browser.close();
  server.close();
  const table = [
    `Chromium (${userAgent}), app worker, suggestMove at base budget 300`,
    '',
    '| version | positions | native median ms | Chromium median ms | Chromium/native (median of per-position ratios) | native max ms | Chromium max ms |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
  writeFileSync(join(out, 'browser.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(join(out, 'browser.md'), `${table}\n`);
  console.log(table);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
