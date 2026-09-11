import { closeSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';

const workers = 8;
const gamesPerShard = 8;
mkdirSync('ml/data', { recursive: true });

const runs = Array.from({ length: workers }, (_, index) => {
  const suffix = String.fromCharCode('a'.charCodeAt(0) + index);
  const prefix = `ml/data/v44-spatial-${suffix}`;
  const logPath = `${prefix}.log`;
  const log = openSync(logPath, 'w');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/exportTraining.ts',
      '--teachers',
      'v3.2-pro-max',
      '--games',
      String(gamesPerShard),
      '--iterations',
      '300',
      '--search-repeats',
      '3',
      '--seed-base',
      String(12_500_000 + index * 10_000),
      '--top-k',
      '12',
      '--opening-random-plies',
      '10',
      '--out',
      prefix,
      '--policy-features-v2',
      '--action-planes',
    ],
    { stdio: ['ignore', log, log] },
  );
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
        reject(new Error(`spatial shard ${suffix} exited with ${code}; see ${logPath}`));
      }
    });
  });
});

await Promise.all(runs);
console.log(`completed ${workers * gamesPerShard} action-plane consensus games`);
