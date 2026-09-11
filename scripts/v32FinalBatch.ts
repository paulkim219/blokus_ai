import { spawn } from 'node:child_process';
import { join } from 'node:path';

const matches = [
  ['v3.2-cpuct12-pro', 'v3.1-pro', '100', '950000', 'v32-c3-cpuct12-heldout'],
  ['v3.2-cpuct12-notrans-pro', 'v3.1-pro', '100', '951000', 'v32-combo-cpuct12-notrans-heldout'],
  ['v3.2-cpuct12-notrans-implicit10-pro', 'v3.1-pro', '40', '952000', 'v32-combo-threeway-screen'],
] as const;

async function run(args: readonly string[]): Promise<void> {
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const tournament = join(process.cwd(), 'scripts', 'tournament.ts');
  const [challenger, champion, seeds, seedBase, label] = args;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      tsx,
      [tournament, '--challenger', challenger, '--champion', champion, '--iterations', '300', '--seeds', seeds, '--seed-base', seedBase, '--workers', '8', '--label', label],
      { stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`)));
  });
}

for (const match of matches) {
  await run(match);
}
