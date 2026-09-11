import { readFileSync } from 'node:fs';
import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState, PlayerColor } from '../src/engine/types.ts';
import { generateLegalMoves } from '../src/engine/game.ts';
import {
  getAlgo,
  isAlgoVersionId,
  registerAlgoConfig,
  bitboardParamsFor,
  weightsFor,
  type AlgoConfig,
  type AlgoVersionId,
} from '../src/ai/algoVersions.ts';
import { extractFeatures } from '../src/ai/heuristics.ts';
import { playSeatedGame, type PolicyId } from '../src/ai/selfplay.ts';
import { createRng } from '../src/ai/rng.ts';
import { resetV12, toPosition } from '../src/ai/bitboard/index.ts';
import { createEvalContext, detectPhase, evaluate, refreshContext } from '../src/ai/bitboard/features.ts';
import { DEFAULT_BITBOARD_PARAMS } from '../src/ai/bitboard/config.ts';
import { SEAT_OF_COLOR } from '../src/ai/bitboard/seats.ts';
import { CELL_COUNT, testBit } from '../src/ai/bitboard/bitboard.ts';

/**
 * Within-node variance decomposition.
 *
 * Play is decided by ranking *siblings* — the legal successors of one node — not by ranking
 * unrelated positions. A term of the evaluation that barely varies across siblings cannot affect a
 * decision no matter how large its weight, and its weight is unidentifiable to any play-based
 * tuner, which would explain a fitter that plateaus at the same value from every start.
 *
 * For each sampled node this scores every (sampled) legal child, then reports each component's
 * standard deviation across those children as a share of the total's. High share = the component is
 * doing the deciding. Near zero = the component is dead for play.
 *
 * Candidate features carry no weight yet, so they are reported as a coefficient of variation
 * (sibling SD / |mean|) — "could this term discriminate at all, if it were weighted".
 *
 *   npm run sibling-variance -- --games 40 --stride 4
 */

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

type PhaseName = 'opening' | 'midgame' | 'endgame';

const context = createEvalContext();
/** Overridden by `--config <file>` so the decomposition can be run on a tuned config. */
let params = DEFAULT_BITBOARD_PARAMS;

/** Cells of T_i with at most one empty orthogonal neighbour — the corridor / sliver proxy. */
function packabilityProxies(seat: number): { deadEnds: number; no2x2: number } {
  const owner = context.territory.owner;
  const reach = context.territory.reach[seat];
  let deadEnds = 0;
  let no2x2 = 0;

  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (owner[cell] !== seat) {
      continue;
    }
    const x = cell % 20;
    const y = (cell / 20) | 0;
    let openNeighbours = 0;
    if (x > 0 && testBit(reach, cell - 1)) openNeighbours += 1;
    if (x < 19 && testBit(reach, cell + 1)) openNeighbours += 1;
    if (y > 0 && testBit(reach, cell - 20)) openNeighbours += 1;
    if (y < 19 && testBit(reach, cell + 20)) openNeighbours += 1;
    if (openNeighbours <= 1) {
      deadEnds += 1;
    }

    // Is this cell inside any 2×2 block of cells this seat can still reach? A cell that is not
    // cannot take anything bigger than a domino laid along a one-wide corridor.
    let in2x2 = false;
    for (let dy = -1; dy <= 0 && !in2x2; dy += 1) {
      for (let dx = -1; dx <= 0 && !in2x2; dx += 1) {
        const bx = x + dx;
        const by = y + dy;
        if (bx < 0 || by < 0 || bx > 18 || by > 18) {
          continue;
        }
        const base = by * 20 + bx;
        if (
          testBit(reach, base) &&
          testBit(reach, base + 1) &&
          testBit(reach, base + 20) &&
          testBit(reach, base + 21)
        ) {
          in2x2 = true;
        }
      }
    }
    if (!in2x2) {
      no2x2 += 1;
    }
  }
  return { deadEnds, no2x2 };
}

/** Weighted components of v12's E_i for the mover, plus unweighted candidate features. */
function v12Components(
  state: GameState,
  color: PlayerColor,
  phase: PhaseName,
): Record<string, number> {
  const seat = SEAT_OF_COLOR[color];
  const position = toPosition(state);
  refreshContext(context, position, false);
  const w = params.phases[phase];
  const profile = params.seats[seat];
  const total = evaluate(context, position, params, phase);

  let othersMean = 0;
  for (let s = 0; s < 4; s += 1) {
    if (s !== seat) {
      othersMean += total[s];
    }
  }
  othersMean /= 3;
  const { deadEnds, no2x2 } = packabilityProxies(seat);

  return {
    'E (vs mean)': total[seat] - othersMean,
    'a·S (squares)': w.squares * position.placedSquares(seat),
    'b·f(C) corners': w.corners * profile.corners * context.cornerScore[seat],
    'c·|T| territory': w.territory * profile.territory * context.territory.territory[seat],
    'centre reach': w.centre * profile.centre * context.centreScore[seat],
    'd·waste': -w.waste * profile.waste * context.waste[seat],
    'frontier': -w.frontier * context.pressure[seat],
    'opponent terms': othersMean,
    // Unweighted candidates.
    '~ |T_i| raw': context.territory.territory[seat],
    '~ dead-end cells': deadEnds,
    '~ cells not in 2x2': no2x2,
  };
}

/** Weighted components of v11's evaluation for the mover. */
function v11Components(state: GameState, color: PlayerColor): Record<string, number> {
  const config = getAlgo('v11');
  const f = extractFeatures(state, color, true, 'v11');
  let placed = 0;
  for (const c of PLAYER_COLORS) {
    placed += extractFeatures(state, c, true, 'v11').placedSquares;
  }
  const progress = placed / (89 * 4);
  const w = weightsFor(config, color, progress);
  return {
    'placed+remaining': f.placedSquares * w.placedSquares + f.remainingPenalty * w.remainingPenalty,
    'cornerAccess': f.cornerAccess * w.cornerAccess,
    'mobility': f.mobility * w.mobility,
    'centerControl': f.centerControl * w.centerControl,
    'blocking': f.blocking * w.blocking,
    'uniqueLiberties': f.uniqueLiberties * w.uniqueLiberties,
    'voronoiTerritory': f.voronoiTerritory * w.voronoiTerritory,
    'reachableArea': f.reachableArea * w.reachableArea,
    'opponentMobility': f.opponentMobility * w.opponentMobility,
  };
}

function sd(values: number[]): number {
  const n = values.length;
  if (n < 2) {
    return 0;
  }
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1));
}

function meanOf(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

interface Accumulator {
  /** Per component: SD across siblings at each node. */
  shares: Map<string, number[]>;
  nodes: number;
}

function accumulate(acc: Accumulator, perSibling: Array<Record<string, number>>, totalKey: string): void {
  const names = Object.keys(perSibling[0]);
  const totals = perSibling.map((s) => s[totalKey] ?? 0);
  const totalSd = sd(totals);
  for (const name of names) {
    const values = perSibling.map((s) => s[name]);
    const componentSd = sd(values);
    const list = acc.shares.get(name) ?? [];
    if (name.startsWith('~')) {
      // Unweighted candidate: report coefficient of variation instead of a share of E.
      const m = Math.abs(meanOf(values));
      list.push(m === 0 ? 0 : componentSd / m);
    } else {
      list.push(totalSd === 0 ? 0 : componentSd / totalSd);
    }
    acc.shares.set(name, list);
  }
  acc.nodes += 1;
}

function report(title: string, acc: Map<PhaseName | 'all', Accumulator>, note: string): void {
  const phases: Array<PhaseName | 'all'> = ['all', 'opening', 'midgame', 'endgame'];
  const names = [...(acc.get('all')?.shares.keys() ?? [])];
  console.log(`\n=== ${title} ===`);
  console.log(note + '\n');
  const header = ['component'.padEnd(22), ...phases.map((p) => p.padStart(9))].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const name of names) {
    const cells = phases.map((p) => {
      const list = acc.get(p)?.shares.get(name);
      return !list || list.length < 5 ? '     —   ' : meanOf(list).toFixed(3).padStart(9);
    });
    console.log([name.padEnd(22), ...cells].join('  '));
  }
  console.log('nodes:'.padEnd(22) + phases.map((p) => String(acc.get(p)?.nodes ?? 0).padStart(9)).join('  '));
}

function phaseOf(state: GameState, color: PlayerColor): PhaseName {
  const played = 21 - state.remainingPieces[color].length;
  return played < 5 ? 'opening' : played < 15 ? 'midgame' : 'endgame';
}

async function main(): Promise<void> {
  const games = Math.max(1, Number(arg('games', '40')));
  const stride = Math.max(1, Number(arg('stride', '4')));
  const maxSiblings = Math.max(4, Number(arg('siblings', '32')));
  const seedBase = Number(arg('seed-base', '7300000'));
  const policy = (arg('policy', 'greedy') ?? 'greedy') as PolicyId;
  const generators = (arg('generators', 'v11,v12') ?? 'v11,v12')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is AlgoVersionId => isAlgoVersionId(v));

  const configPath = arg('config');
  if (configPath) {
    const loaded = JSON.parse(readFileSync(configPath, 'utf8')) as AlgoConfig;
    registerAlgoConfig(loaded);
    params = bitboardParamsFor(getAlgo(loaded.id));
    console.log(`Decomposing with parameters from ${configPath} (${loaded.id})`);
  }

  console.log(
    `Within-node variance — ${games} games from {${generators.join(', ')}}, every ${stride} plies, ` +
      `up to ${maxSiblings} siblings per node\n`,
  );

  const phases: Array<PhaseName | 'all'> = ['all', 'opening', 'midgame', 'endgame'];
  const v12Acc = new Map<PhaseName | 'all', Accumulator>();
  const v11Acc = new Map<PhaseName | 'all', Accumulator>();
  for (const p of phases) {
    v12Acc.set(p, { shares: new Map(), nodes: 0 });
    v11Acc.set(p, { shares: new Map(), nodes: 0 });
  }

  const rng = createRng(99);

  for (let g = 0; g < games; g += 1) {
    const generator = generators[g % generators.length];
    resetV12();
    const seatVersions = Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, generator]),
    ) as Record<PlayerColor, AlgoVersionId>;
    const seatPolicies = Object.fromEntries(
      PLAYER_COLORS.map((c) => [c, policy]),
    ) as Record<PlayerColor, PolicyId>;

    await playSeatedGame({
      hero: policy,
      opponents: policy,
      seatVersions,
      seatPolicies,
      seed: seedBase + g,
      openingRandomPlies: 8,
      openingTopK: 3,
      searchOptions: { skipWinOddsRefinement: true, lightRollouts: true },
      onPly: (state, ply) => {
        if (ply % stride !== 0) {
          return;
        }
        const color = state.currentTurn;
        const moves = generateLegalMoves(state, color);
        if (moves.length < 4) {
          return;
        }
        // Uniform sample of the legal set: variance across a sample estimates variance across all,
        // and scoring 500 children per node would cost more than the diagnostic is worth.
        const picked = moves.length <= maxSiblings
          ? moves
          : Array.from({ length: maxSiblings }, () => moves[Math.floor(rng() * moves.length)]);

        const phase = phaseOf(state, color);
        const seat = SEAT_OF_COLOR[color];
        const position = toPosition(state);
        refreshContext(context, position, false);
        const v12Phase = detectPhase(position, context, params, seat);

        const v12Rows: Array<Record<string, number>> = [];
        const v11Rows: Array<Record<string, number>> = [];
        for (const move of picked) {
          const next: GameState = {
            ...state,
            board: state.board.map((row) => [...row]),
            remainingPieces: {
              ...state.remainingPieces,
              [color]: state.remainingPieces[color].filter((id) => id !== move.pieceId),
            },
            hasPlayed: { ...state.hasPlayed, [color]: true },
          };
          for (const cell of move.absoluteCells) {
            next.board[cell.y][cell.x] = color;
          }
          v12Rows.push(v12Components(next, color, v12Phase));
          v11Rows.push(v11Components(next, color));
        }

        for (const p of ['all', phase] as Array<PhaseName | 'all'>) {
          accumulate(v12Acc.get(p)!, v12Rows, 'E (vs mean)');
          // v11 has no single total column here, so sum the weighted own-side components.
          const withTotal = v11Rows.map((row) => ({
            ...row,
            total: Object.values(row).reduce((s, v) => s + v, 0),
          }));
          accumulate(v11Acc.get(p)!, withTotal, 'total');
        }
      },
    });

    if ((g + 1) % 10 === 0) {
      console.log(`  ${g + 1}/${games} games`);
    }
  }

  report(
    'v12 E_i — share of sibling spread carried by each component',
    v12Acc,
    'Mean over nodes of SD(component across siblings) / SD(E across siblings).\n' +
      'Rows prefixed ~ are unweighted candidates, shown as sibling SD / |mean|.',
  );
  report(
    'v11 evaluation — share of sibling spread carried by each component',
    v11Acc,
    'Same, over v11’s weighted own-side features.',
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
