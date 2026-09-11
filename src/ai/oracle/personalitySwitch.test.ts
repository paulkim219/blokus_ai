import { describe, expect, it } from 'vitest';
import { moveKey } from '../../engine/game';
import type { PlaceMove } from '../../engine/types';
import { playSeatedGame } from '../selfplay';
import type { StrategicPersonalityId } from './strategicPersonalities';

const SEED = 56_000_001;
const MAX_PLIES = 44;
const SWITCH_AFTER = 6;

async function blueMoves(
  schedule: boolean,
): Promise<{ keys: string[]; personalities: (string | undefined)[] }> {
  const keys: string[] = [];
  const personalities: (string | undefined)[] = [];
  await playSeatedGame({
    hero: 'greedy',
    opponents: 'greedy',
    seatVersions: {
      blue: 'v4.1-lite',
      yellow: 'v4.1-lite',
      purple: 'v4.1-lite',
      green: 'v4.1-lite',
    },
    seatPolicies: { blue: 'greedy', yellow: 'greedy', purple: 'greedy', green: 'greedy' },
    seatPersonalities: schedule
      ? undefined
      : { blue: 'oracle-personality-blocker-a' as StrategicPersonalityId },
    seatPersonalitySchedules: schedule
      ? {
          blue: {
            initial: 'oracle-personality-blocker-a' as StrategicPersonalityId,
            switchTo: 'oracle-personality-tempo-a' as StrategicPersonalityId,
            afterOwnMoves: SWITCH_AFTER,
          },
        }
      : undefined,
    seed: SEED,
    maxPlies: MAX_PLIES,
    openingRandomPlies: 0,
    onMove: (state, move: PlaceMove | null, _ply, personality) => {
      if (state.currentTurn !== 'blue' || !move) return;
      keys.push(moveKey(move));
      personalities.push(personality);
    },
  });
  return { keys, personalities };
}

describe('mid-game personality switching', () => {
  it('plays the initial objective, then a different one, in a single continuous game', async () => {
    const fixed = await blueMoves(false);
    const switched = await blueMoves(true);

    expect(fixed.keys.length).toBeGreaterThan(SWITCH_AFTER);
    expect(switched.keys.length).toBe(fixed.keys.length);

    // The schedule is inert before the change point, so the two games must be identical there.
    expect(switched.keys.slice(0, SWITCH_AFTER)).toEqual(fixed.keys.slice(0, SWITCH_AFTER));
    // And the objective must actually change the moves afterwards, not merely the label.
    expect(switched.keys.slice(SWITCH_AFTER)).not.toEqual(fixed.keys.slice(SWITCH_AFTER));

    expect(switched.personalities.slice(0, SWITCH_AFTER)).toEqual(
      Array(SWITCH_AFTER).fill('oracle-personality-blocker-a'),
    );
    expect(new Set(switched.personalities.slice(SWITCH_AFTER))).toEqual(
      new Set(['oracle-personality-tempo-a']),
    );
  }, 60_000);
});
