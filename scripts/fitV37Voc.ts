/**
 * Workstream A, W2/W3 — fit a continue/stop controller and grade it against the ceiling.
 *
 * Gate 0 measured what *perfect foresight* is worth: +1.71 [1.24, 2.94] points over spending the same
 * compute uniformly, at a +25% cap, against a 200-seed MDE of 0.95. A fitted controller needs roughly
 * **55% of perfect** to stay measurable. This script says what fraction it actually gets.
 *
 * Deliberately a small monotone model, not a network. The v4 programme spent five generations
 * establishing that a better-fitted model does not help when the channel it feeds has no capacity;
 * here the channel has capacity (gate 0 says so) and the risk is the opposite one — overfitting 24
 * games of checkpoint features and reporting the fit rather than the effect. So:
 *
 * - **split by game, never by position** (positions in one game share a board and an outcome);
 * - score on the held-out games only;
 * - report the realised fraction of the ceiling with a game-level bootstrap, not a point estimate;
 * - compare against two null controllers, because a feature model that cannot beat "always continue"
 *   or "continue in the midgame" is not a controller, it is a decoration.
 *
 *   node --import tsx scripts/fitV37Voc.ts
 */

import { readFileSync } from 'node:fs';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Checkpoint {
  fraction: number;
  iterations: number;
  bestKey: string;
  leaderChanged: boolean;
  visitGap: number;
  visitShare: number;
  entropy: number;
  topValueGap: number;
  children: number;
  decidedAtNominal: boolean;
  regret: number | null;
}
interface Row {
  game: number;
  ownMove: number;
  phase: string;
  legal: number;
  oracleStable: boolean;
  checkpoints: Checkpoint[];
}

/** The decision the controller actually makes: at nominal budget, buy another tranche or stop. */
interface Decision {
  game: number;
  /** Regret removed by continuing from 1.0x to 2.0x. Negative means the extra search made it worse. */
  gain: number;
  features: number[];
  ownMove: number;
  midgame: boolean;
}

const FEATURE_NAMES = [
  'visitShare',
  'entropy',
  'normalisedVisitGap',
  'topValueGap',
  'leaderChurn',
  'decided',
];

function decisionsFrom(rows: Row[]): Decision[] {
  const out: Decision[] = [];
  for (const row of rows) {
    if (!row.oracleStable) continue;
    const at1 = row.checkpoints.find((c) => c.fraction === 1.0);
    const at2 = row.checkpoints.find((c) => c.fraction === 2.0);
    const atHalf = row.checkpoints.find((c) => c.fraction === 0.5);
    if (!at1 || !at2 || !atHalf || at1.regret === null || at2.regret === null) continue;
    const churn = [atHalf, at1].filter((c) => c.leaderChanged).length;
    out.push({
      game: row.game,
      gain: at1.regret - at2.regret,
      ownMove: row.ownMove,
      midgame: row.phase === 'midgame',
      features: [
        at1.visitShare,
        at1.entropy,
        at1.visitGap / Math.max(1, at1.iterations),
        at1.topValueGap,
        churn,
        at1.decidedAtNominal ? 1 : 0,
      ],
    });
  }
  return out;
}

/** Spend the cap on the highest-scoring decisions; report the regret actually removed. */
function realised(decisions: Decision[], score: (d: Decision) => number, cap: number): number {
  const k = Math.max(0, Math.round(cap * decisions.length));
  if (k === 0) return 0;
  return [...decisions]
    .sort((a, b) => score(b) - score(a))
    .slice(0, k)
    .reduce((sum, d) => sum + d.gain, 0);
}

function ceiling(decisions: Decision[], cap: number): number {
  return realised(decisions, (d) => d.gain, cap);
}

function uniform(decisions: Decision[], cap: number): number {
  const total = decisions.reduce((sum, d) => sum + d.gain, 0);
  return Math.log2(1 + cap) * total;
}

/**
 * Ridge-regularised least squares on standardised features. Six features and a few hundred rows is
 * exactly the regime where an unregularised fit reports its own noise.
 */
function fitRidge(rows: Decision[], lambda: number): { weights: number[]; mean: number[]; sd: number[] } {
  const n = rows.length;
  const d = FEATURE_NAMES.length;
  const mean = new Array(d).fill(0);
  const sd = new Array(d).fill(1);
  for (let j = 0; j < d; j += 1) {
    mean[j] = rows.reduce((s, r) => s + r.features[j], 0) / n;
    const v = rows.reduce((s, r) => s + (r.features[j] - mean[j]) ** 2, 0) / Math.max(1, n - 1);
    sd[j] = Math.sqrt(v) || 1;
  }
  const X = rows.map((r) => r.features.map((f, j) => (f - mean[j]) / sd[j]));
  const y = rows.map((r) => r.gain);
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < d; j += 1) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k += 1) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < d; j += 1) A[j][j] += lambda;
  // Gaussian elimination; d is 6.
  for (let c = 0; c < d; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < d; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < d; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < d; k += 1) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return { weights: b.map((v, j) => (Math.abs(A[j][j]) < 1e-12 ? 0 : v / A[j][j])), mean, sd };
}

function main(): void {
  const inPath = arg('in', 'selfplay-results/v37-voc-corpus.json')!;
  const cap = Number(arg('cap', '0.25'));
  const lambda = Number(arg('lambda', '10'));
  const file = JSON.parse(readFileSync(inPath, 'utf8')) as { rows: Row[] };
  const decisions = decisionsFrom(file.rows);
  const games = [...new Set(decisions.map((d) => d.game))].sort((a, b) => a - b);

  console.log(
    `${decisions.length} labelled decisions from ${games.length} games (oracle-stable only)\n`,
  );
  if (decisions.length < 40 || games.length < 6) {
    console.log('Too few to split by game and say anything. Collect a larger corpus.');
    return;
  }

  // Split by game. A random split would put siblings of one game on both sides.
  const cut = Math.floor(games.length * 0.6);
  const trainGames = new Set(games.slice(0, cut));
  const train = decisions.filter((d) => trainGames.has(d.game));
  const test = decisions.filter((d) => !trainGames.has(d.game));
  console.log(`train ${train.length} decisions / ${cut} games   holdout ${test.length} / ${games.length - cut} games\n`);

  const model = fitRidge(train, lambda);
  const predict = (d: Decision) =>
    d.features.reduce((s, f, j) => s + model.weights[j] * ((f - model.mean[j]) / model.sd[j]), 0);

  console.log('fitted weights (standardised):');
  FEATURE_NAMES.forEach((name, j) => console.log(`  ${name.padEnd(20)} ${model.weights[j].toFixed(4)}`));

  const ceil = ceiling(test, cap);
  const uni = uniform(test, cap);
  const arms: Array<[string, (d: Decision) => number]> = [
    ['fitted controller', predict],
    ['null: always continue', () => Math.random()],
    ['null: midgame only', (d) => (d.midgame ? 1 : 0)],
    ['null: not yet decided', (d) => (d.features[5] === 0 ? 1 : 0)],
    ['null: low visit share', (d) => -d.features[0]],
  ];

  console.log(`\nheld-out, cap +${(cap * 100).toFixed(0)}% (squares of oracle regret removed):\n`);
  console.log(`  ${'arm'.padEnd(24)}${'removed'.padStart(9)}${'vs uniform'.padStart(12)}${'% of ceiling'.padStart(14)}`);
  console.log(`  ${'perfect foresight'.padEnd(24)}${ceil.toFixed(2).padStart(9)}${(ceil - uni).toFixed(2).padStart(12)}${'100%'.padStart(14)}`);
  console.log(`  ${'uniform extra compute'.padEnd(24)}${uni.toFixed(2).padStart(9)}${'0.00'.padStart(12)}${'—'.padStart(14)}`);
  for (const [name, score] of arms) {
    const got = realised(test, score, cap);
    const frac = ceil > 0 ? (got - uni) / (ceil - uni) : 0;
    console.log(
      `  ${name.padEnd(24)}${got.toFixed(2).padStart(9)}${(got - uni).toFixed(2).padStart(12)}${`${(100 * frac).toFixed(0)}%`.padStart(14)}`,
    );
  }
  console.log(
    [
      '',
      'A controller needs roughly 55% of the ceiling to clear a 200-seed MDE of 0.95.',
      'It must also beat every null above: one that cannot outscore "continue where the search is not',
      'yet decided" is not learning anything the engine does not already know.',
    ].join('\n'),
  );
}

main();
