import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { GameState } from '../src/engine/types.ts';
import { applyMove, createInitialState, generateLegalMoves, passTurn } from '../src/engine/game.ts';
import type { AlgoVersionId } from '../src/ai/algoVersions.ts';
import { searchBestMove } from '../src/ai/mcts.ts';
import { setSeed, randomInt } from '../src/ai/rng.ts';
import { resetV12 } from '../src/ai/bitboard/index.ts';

/**
 * How much of the teacher's sibling ordering is signal?
 *
 * Every distillation result is bounded by how consistent the target is. If a 300-iteration search
 * ranks one node's children differently each time it is asked, then no model can score better
 * against it than the search scores against itself, and a learned evaluation that plateaus at 0.56
 * pairwise accuracy may be at the ceiling rather than short of it.
 *
 * This searches the same position twice with different RNG seeds and measures how often the two
 * runs order the same pair of moves the same way — the self-agreement of the target. It also
 * reports agreement restricted to pairs the *first* run separated clearly, since near-ties are
 * where disagreement is expected and harmless.
 *
 *   npm run teacher-noise -- --version v3.1 --games 6 --iterations 300
 */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const key = (m: { pieceId: number; anchor: { x: number; y: number }; orientationIndex: number }) =>
  `${m.pieceId}:${m.anchor.x}:${m.anchor.y}:${m.orientationIndex}`;

async function main(): Promise<void> {
  const version = (arg('version', 'v3.1') ?? 'v3.1') as AlgoVersionId;
  const games = Number(arg('games', '6'));
  const iterations = Number(arg('iterations', '300'));
  const seedBase = Number(arg('seed-base', '9100000'));
  const stride = Number(arg('stride', '3'));
  const topK = Number(arg('top-k', '12'));

  console.log(
    `Teacher self-agreement — ${version} at ${iterations} iterations, ${games} games, ` +
      `every ${stride} plies, top ${topK} moves\n`,
  );

  let valuePairs = 0;
  let valueAgree = 0;
  let clearValuePairs = 0;
  let clearValueAgree = 0;
  let visitPairs = 0;
  let visitAgree = 0;
  let clearVisitPairs = 0;
  let clearVisitAgree = 0;
  let bestMoveSame = 0;
  let positions = 0;

  for (let g = 0; g < games; g += 1) {
    setSeed(seedBase + g);
    resetV12();
    let state: GameState = createInitialState('corner');
    let ply = 0;

    while (!state.finished && ply < 200) {
      const mover = state.currentTurn;
      if (generateLegalMoves(state, mover, 1).length === 0) {
        state = passTurn(state);
        ply += 1;
        continue;
      }

      const runs: Array<Map<string, { value: number; visits: number }>> = [];
      const selected: string[] = [];
      let first: Awaited<ReturnType<typeof searchBestMove>> | null = null;
      if (ply % stride === 0) {
        for (let r = 0; r < 2; r += 1) {
          resetV12();
          setSeed(seedBase * 13 + g * 977 + ply * 31 + r * 100_003);
          const result = await searchBestMove(state, mover, 600_000, undefined, {
            version,
            iterationBudget: iterations,
            skipWinOddsRefinement: true,
          });
          if (r === 0) {
            first = result;
          }
          runs.push(
            new Map(
              result.rankedMoves
                .slice(0, topK)
                .map((m) => [key(m.move), { value: m.value, visits: m.visits }]),
            ),
          );
          selected.push(result.bestMove ? key(result.bestMove) : '');
        }

        const [a, b] = runs;
        const shared = [...a.keys()].filter((k) => b.has(k));
        if (shared.length > 1) {
          positions += 1;
          // `bestMove` is the most-visited child in both engines. The old diagnostic compared that
          // choice from run A with the highest mean-Q child from run B, mixing two decision rules
          // and making its headline self-agreement number invalid.
          if (first?.bestMove && selected[0] !== '' && selected[0] === selected[1]) {
            bestMoveSame += 1;
          }
          for (let i = 0; i < shared.length; i += 1) {
            for (let j = i + 1; j < shared.length; j += 1) {
              const ai = a.get(shared[i])!;
              const aj = a.get(shared[j])!;
              const bi = b.get(shared[i])!;
              const bj = b.get(shared[j])!;
              const valueA = ai.value - aj.value;
              const valueB = bi.value - bj.value;
              if (Math.abs(valueA) >= 1e-9 && Math.abs(valueB) >= 1e-9) {
                valuePairs += 1;
                if (valueA * valueB > 0) {
                  valueAgree += 1;
                }
                if (Math.abs(valueA) > 1) {
                  clearValuePairs += 1;
                  if (valueA * valueB > 0) {
                    clearValueAgree += 1;
                  }
                }
              }

              const visitsA = ai.visits - aj.visits;
              const visitsB = bi.visits - bj.visits;
              if (visitsA !== 0 && visitsB !== 0) {
                visitPairs += 1;
                if (visitsA * visitsB > 0) {
                  visitAgree += 1;
                }
                // A two-visit gap is the smallest non-trivial separation at this budget: a
                // one-visit lead can be caused solely by which child received the final playout.
                if (Math.abs(visitsA) > 1) {
                  clearVisitPairs += 1;
                  if (visitsA * visitsB > 0) {
                    clearVisitAgree += 1;
                  }
                }
              }
            }
          }
        }
      }

      resetV12();
      setSeed(seedBase + g * 7919 + ply);
      const play = await searchBestMove(state, mover, 600_000, undefined, {
        version,
        iterationBudget: iterations,
        skipWinOddsRefinement: true,
      });
      if (!play.bestMove) {
        state = passTurn(state);
      } else {
        const pick =
          ply < 10
            ? play.rankedMoves[randomInt(Math.min(3, play.rankedMoves.length))].move
            : play.bestMove;
        state = applyMove(state, pick);
      }
      ply += 1;
    }
    console.log(
      `game ${g + 1}/${games} — ${positions} positions, ` +
        `${visitPairs} visit pairs / ${valuePairs} value pairs so far`,
    );
  }

  void PLAYER_COLORS;
  console.log(
    `\n=== Teacher self-agreement (${version}, ${iterations} iterations) ===\n` +
      `Positions compared: ${positions}\n` +
      `Same best move in both runs: ${((bestMoveSame / Math.max(positions, 1)) * 100).toFixed(1)}%\n` +
      `Visit pairs ordered the same way: ` +
      `${((visitAgree / Math.max(visitPairs, 1)) * 100).toFixed(1)}%  (n=${visitPairs})\n` +
      `  ...when run A separated them by >1 visit: ` +
      `${((clearVisitAgree / Math.max(clearVisitPairs, 1)) * 100).toFixed(1)}%  ` +
      `(n=${clearVisitPairs})\n` +
      `Value pairs ordered the same way: ` +
      `${((valueAgree / Math.max(valuePairs, 1)) * 100).toFixed(1)}%  (n=${valuePairs})\n` +
      `  ...when run A separated them by >1 point: ` +
      `${((clearValueAgree / Math.max(clearValuePairs, 1)) * 100).toFixed(1)}%  ` +
      `(n=${clearValuePairs})\n\n` +
      `Best-move and visit-pair agreement measure the target used by the current trainer. Value-pair\n` +
      `agreement measures the older searched-Q target. Both are ceilings only for a single noisy run;\n` +
      `averaging repeated searches can produce a cleaner consensus target.`,
  );
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
