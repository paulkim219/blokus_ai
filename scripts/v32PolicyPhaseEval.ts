import { readFileSync, writeFileSync } from 'node:fs';
import { forward, loadNet } from '../src/ai/bitboard/net.ts';

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const prefix = arg('--data', 'ml/data/v32-policy-d');
const weights = arg('--weights', 'ml/v32-policy-weights.json');
const tailFraction = Number(arg('--tail-frac', '0.12'));
const output = arg('--out', 'selfplay-results/v32-policy-phase-eval.json');
const meta = JSON.parse(readFileSync(`${prefix}.meta.json`, 'utf8')) as {
  featureCount: number;
  featureNames?: string[];
  rows: number;
  targetWidth: number;
  targets?: string[];
};
if (!(tailFraction > 0 && tailFraction <= 1)) {
  throw new Error('--tail-frac must be in (0, 1]');
}
const rawNet = JSON.parse(readFileSync(weights, 'utf8'));
const net = loadNet(rawNet);
const xBuffer = readFileSync(`${prefix}.x.f32`);
const yBuffer = readFileSync(`${prefix}.y.f32`);
const x = new Float32Array(xBuffer.buffer, xBuffer.byteOffset, xBuffer.byteLength / 4);
const y = new Float32Array(yBuffer.buffer, yBuffer.byteOffset, yBuffer.byteLength / 4);
const rows = Math.min(meta.rows, x.length / meta.featureCount, y.length / meta.targetWidth);
const firstValidationRow = Math.floor(rows * (1 - tailFraction));
const openingIndex = meta.featureNames?.indexOf('phaseOpening') ?? -1;
const midgameIndex = meta.featureNames?.indexOf('phaseMidgame') ?? -1;
const teacherIndex = meta.targets?.indexOf('teacher') ?? 2;
const visitsIndex = meta.targets?.indexOf('visits') ?? 3;
const policyIndex = meta.targets?.indexOf('policy') ?? -1;

interface Group {
  phase: 'opening' | 'midgame' | 'endgame';
  scores: number[];
  targets: number[];
  policyMass: number[];
  values: number[];
}
const groups = new Map<number, Group>();
for (let row = firstValidationRow; row < rows; row += 1) {
  const features = x.subarray(row * meta.featureCount, (row + 1) * meta.featureCount);
  const targetAt = row * meta.targetWidth;
  const groupId = y[targetAt];
  // Current policy features name the phase flags. Retain the old indices for legacy shards.
  const opening = openingIndex >= 0 ? features[openingIndex] : features[80];
  const midgame = midgameIndex >= 0 ? features[midgameIndex] : features[81];
  const phase = opening > 0.5 ? 'opening' : midgame > 0.5 ? 'midgame' : 'endgame';
  const group = groups.get(groupId) ?? {
    phase,
    scores: [],
    targets: [],
    policyMass: [],
    values: [],
  };
  group.scores.push(forward(net, features)[0]);
  const policy = policyIndex >= 0 ? y[targetAt + policyIndex] : Number.NaN;
  const visits = y[targetAt + visitsIndex];
  group.targets.push(Number.isFinite(policy) ? Math.log(Math.max(policy, 1e-8)) : Math.log1p(visits));
  group.policyMass.push(Number.isFinite(policy) ? policy : visits);
  group.values.push(y[targetAt + teacherIndex]);
  groups.set(groupId, group);
}

const phases = ['opening', 'midgame', 'endgame'] as const;
const summarize = (phase?: typeof phases[number]) => {
  let correct = 0;
  let pairs = 0;
  let top1 = 0;
  let roots = 0;
  let visitShareRegret = 0;
  let teacherChoiceValueRegret = 0;
  for (const group of groups.values()) {
    if ((phase && group.phase !== phase) || group.scores.length < 2) continue;
    roots += 1;
    const predicted = group.scores.reduce((best, value, index) =>
      value > group.scores[best] ? index : best, 0);
    const teacher = group.targets.reduce((best, value, index) =>
      value > group.targets[best] ? index : best, 0);
    if (predicted === teacher) top1 += 1;
    const policyTotal = group.policyMass.reduce((sum, value) => sum + value, 0);
    if (policyTotal > 0) {
      visitShareRegret +=
        (group.policyMass[teacher] - group.policyMass[predicted]) / policyTotal;
    }
    teacherChoiceValueRegret += group.values[teacher] - group.values[predicted];
    for (let i = 0; i < group.scores.length; i += 1) {
      for (let j = i + 1; j < group.scores.length; j += 1) {
        const modelDelta = group.scores[i] - group.scores[j];
        const targetDelta = group.targets[i] - group.targets[j];
        if (Math.abs(targetDelta) <= 1e-9) continue;
        correct += modelDelta * targetDelta > 0 ? 1 : 0;
        pairs += 1;
      }
    }
  }
  return {
    phase: phase ?? 'all',
    roots,
    pairs,
    pairAccuracy: correct / Math.max(pairs, 1),
    top1Accuracy: top1 / Math.max(roots, 1),
    meanPolicyMassRegret: visitShareRegret / Math.max(roots, 1),
    meanTeacherChoiceValueRegret: teacherChoiceValueRegret / Math.max(roots, 1),
  };
};
const results = [summarize(), ...phases.map((phase) => summarize(phase))];
const report = { prefix, weights, tailFraction, firstValidationRow, rows, results };
console.log(report);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
