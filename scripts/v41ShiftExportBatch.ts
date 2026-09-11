import { closeSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const workers = 8;
const gamesPerShard = 32;
const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
mkdirSync('ml/data', { recursive: true });

const runs = Array.from({ length: workers }, (_, index) => {
  const suffix = String.fromCharCode('a'.charCodeAt(0) + index);
  const prefix = `ml/data/v41-shift-${suffix}`;
  const logPath = `${prefix}.log`;
  const log = openSync(logPath, 'w');
  const child = spawn(tsx, [
    'scripts/exportTraining.ts',
    '--teachers', 'v3.1-pro-max',
    '--games', String(gamesPerShard),
    '--iterations', '300',
    '--seed-base', String(10_100_000 + index * 10_000),
    '--top-k', '12',
    '--opening-random-plies', '10',
    '--out', prefix,
    '--policy-features',
  ], { stdio: ['ignore', log, log] });
  console.log(`started ${suffix}: ${prefix}, pid ${child.pid}`);
  return new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      closeSync(log);
      reject(error);
    });
    child.on('close', (code) => {
      closeSync(log);
      if (code === 0) {
        console.log(`completed ${suffix}`);
        resolve();
      } else {
        reject(new Error(`export shard ${suffix} exited with ${code}; see ${logPath}`));
      }
    });
  });
});

await Promise.all(runs);
console.log(`completed ${workers * gamesPerShard} v3.1-pro-max teacher games`);
