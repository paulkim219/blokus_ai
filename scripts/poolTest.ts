import { PLAYER_COLORS } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { ALGO_VERSIONS } from '../src/ai/algoVersions.ts';
import { SPACES, readParams, buildCandidate } from './lib/paramSpace.ts';
import { GamePool, type GameAssignment } from './lib/pool.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';

/** Does one tuner-shaped assignment actually play a full-strength game? */
async function main(): Promise<void> {
  const base = ALGO_VERSIONS['v3.1'];
  const specs = SPACES['v31-tier'];
  const values = readParams(base, specs);
  values[0] = 3.2; // cPuct, well away from the base 1.6
  const cand = buildCandidate(base, specs, values, 'cand-test');

  const seatPolicies = Object.fromEntries(
    PLAYER_COLORS.map((c) => [c, 'mcts-bench' as PolicyId]),
  ) as Record<PlayerColor, PolicyId>;
  const seatVersions = Object.fromEntries(
    PLAYER_COLORS.map((c, i) => [c, i === 0 ? 'cand-test' : 'v3.1']),
  ) as Record<PlayerColor, string>;

  const assignment: GameAssignment = {
    id: 'probe',
    seatVersions,
    seatPolicies,
    seed: 12345,
    iterationBudget: 300,
    openingRandomPlies: 8,
    openingTopK: 3,
    configs: [cand],
  };

  const pool = new GamePool(1);
  const t = Date.now();
  const [out] = await pool.run([assignment]);
  pool.close();
  console.log(`duration ${Date.now() - t} ms (worker reported ${out.durationMs} ms)`);
  console.log('plies', out.plies, 'finished', out.finished);
  console.log('error:', out.error ?? '(none)');
  console.log('scores', JSON.stringify(out.scores));
}
void main();
