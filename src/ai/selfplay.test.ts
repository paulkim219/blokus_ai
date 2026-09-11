import { describe, expect, it, beforeEach } from 'vitest';
import { playGame, runLadder } from './selfplay';
import { clearLegalMoveCache } from './legalMoveCache';

describe('self-play', () => {
  beforeEach(() => {
    clearLegalMoveCache();
  });
  it(
    'plays a short greedy vs greedy game',
    async () => {
      const result = await playGame({
        hero: 'greedy',
        opponents: 'greedy',
        heroColor: 'blue',
        maxPlies: 8,
      });
      expect(result.plies).toBe(8);
      expect(result.heroColor).toBe('blue');
      expect(result.scores.blue).toBeTypeOf('number');
    },
    30_000,
  );

  it(
    'runs a one-game ladder without throwing',
    async () => {
      const ladder = await runLadder({
        hero: 'greedy',
        opponents: 'greedy',
        games: 1,
        maxPlies: 8,
      });
      expect(ladder.games).toBe(1);
      expect(ladder.results[0].plies).toBeGreaterThan(0);
    },
    30_000,
  );
});
