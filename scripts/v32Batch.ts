import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface MatchSpec {
  candidate: string;
  baseline: string;
  seeds: number;
  seedBase: number;
  label: string;
}

interface MatchResult extends MatchSpec {
  advantage: number | null;
  low: number | null;
  high: number | null;
  output: string;
}

const specs: MatchSpec[] = [
  // Candidate 2: implicit max^n. Alpha 0.10 is the primary candidate; 0.20 is a pro-tier bracket.
  { candidate: 'v3.2-implicit10', baseline: 'v3.1', seeds: 40, seedBase: 920000, label: 'v32-c2-implicit10-tier-standard' },
  { candidate: 'v3.2-implicit10-pro', baseline: 'v3.1-pro', seeds: 100, seedBase: 921000, label: 'v32-c2-implicit10-tier-pro' },
  { candidate: 'v3.2-implicit20-pro', baseline: 'v3.1-pro', seeds: 40, seedBase: 922000, label: 'v32-c2-implicit20-bracket-pro' },
  { candidate: 'v3.2-implicit10-pro-max', baseline: 'v3.1-pro-max', seeds: 100, seedBase: 923000, label: 'v32-c2-implicit10-tier-pro-max' },

  // Candidate 3: one-axis tree-parameter screen at the pro tier.
  { candidate: 'v3.2-cpuct08-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930000, label: 'v32-c3-cpuct08-screen' },
  { candidate: 'v3.2-cpuct12-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930100, label: 'v32-c3-cpuct12-screen' },
  { candidate: 'v3.2-cpuct20-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930200, label: 'v32-c3-cpuct20-screen' },
  { candidate: 'v3.2-prior3-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930300, label: 'v32-c3-prior3-screen' },
  { candidate: 'v3.2-prior9-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930400, label: 'v32-c3-prior9-screen' },
  { candidate: 'v3.2-widen04-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930500, label: 'v32-c3-widen04-screen' },
  { candidate: 'v3.2-widen12-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930600, label: 'v32-c3-widen12-screen' },
  { candidate: 'v3.2-history0-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930700, label: 'v32-c3-history0-screen' },
  { candidate: 'v3.2-history03-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930800, label: 'v32-c3-history03-screen' },
  { candidate: 'v3.2-history09-pro', baseline: 'v3.1-pro', seeds: 12, seedBase: 930900, label: 'v32-c3-history09-screen' },

  // Candidate 4: transposition ablation at all three compute tiers.
  { candidate: 'v3.2-notrans', baseline: 'v3.1', seeds: 40, seedBase: 940000, label: 'v32-c4-notrans-tier-standard' },
  { candidate: 'v3.2-notrans-pro', baseline: 'v3.1-pro', seeds: 100, seedBase: 941000, label: 'v32-c4-notrans-tier-pro' },
  { candidate: 'v3.2-notrans-pro-max', baseline: 'v3.1-pro-max', seeds: 100, seedBase: 942000, label: 'v32-c4-notrans-tier-pro-max' },
];

function run(spec: MatchSpec): Promise<MatchResult> {
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const args = [
    join(process.cwd(), 'scripts', 'tournament.ts'),
    '--challenger', spec.candidate,
    '--champion', spec.baseline,
    '--iterations', '300',
    '--seeds', String(spec.seeds),
    '--seed-base', String(spec.seedBase),
    '--workers', '8',
    '--label', spec.label,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${spec.label} exited with ${code}`));
        return;
      }
      const match = output.match(/Advantage .*?: (-?\d+\.\d+) \[95% CI (-?\d+\.\d+), (-?\d+\.\d+)\]/);
      resolve({
        ...spec,
        advantage: match ? Number(match[1]) : null,
        low: match ? Number(match[2]) : null,
        high: match ? Number(match[3]) : null,
        output,
      });
    });
  });
}

async function main(): Promise<void> {
  const results: MatchResult[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    console.log(`\n######## v3.2 batch ${index + 1}/${specs.length}: ${spec.label} ########\n`);
    results.push(await run(spec));
    const path = join(process.cwd(), 'selfplay-results', 'v32-batch-results.json');
    writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
