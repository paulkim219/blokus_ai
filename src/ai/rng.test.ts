import { describe, expect, it } from 'vitest';
import { createRng, getSeed, random, setSeed, withSeed } from './rng';
import { playSeatedGame } from './selfplay';
import { clearLegalMoveCache } from './legalMoveCache';

describe('seeded rng', () => {
  it('replays the same stream for the same seed', () => {
    setSeed(42);
    const first = Array.from({ length: 8 }, () => random());
    setSeed(42);
    const second = Array.from({ length: 8 }, () => random());
    expect(second).toEqual(first);
  });

  it('produces different streams for different seeds', () => {
    setSeed(1);
    const a = Array.from({ length: 8 }, () => random());
    setSeed(2);
    const b = Array.from({ length: 8 }, () => random());
    expect(b).not.toEqual(a);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('restores the previous stream after withSeed', () => {
    setSeed(99);
    const before = random();
    withSeed(5, () => random());
    expect(getSeed()).toBe(99);
    setSeed(99);
    expect(random()).toBe(before);
  });
});

describe('game-level determinism', () => {
  it(
    'replays an identical game from the same seed',
    async () => {
      const options = {
        hero: 'mcts-bench' as const,
        opponents: 'mcts-bench' as const,
        seed: 1234,
        maxPlies: 8,
        searchOptions: { skipWinOddsRefinement: true, lightRollouts: true, iterationBudget: 25 },
      };

      clearLegalMoveCache();
      const first = await playSeatedGame(options);
      clearLegalMoveCache();
      const second = await playSeatedGame(options);

      // The whole tournament design rests on this: identical seed ⇒ identical game, so two
      // configs can be compared on the same rollout luck instead of on independent noise.
      expect(second.scores).toEqual(first.scores);
      expect(second.plies).toBe(first.plies);
    },
    60_000,
  );
});
