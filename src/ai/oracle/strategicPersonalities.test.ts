import { describe, expect, it } from 'vitest';
import { createInitialState, generateLegalMoves } from '../../engine/game';
import { PIECES } from '../../engine/pieces';
import { createOracleInteractionState } from './interaction';
import {
  STRATEGIC_PERSONALITIES,
  STRATEGIC_PERSONALITY_FAMILIES,
  activeStrategicPersonality,
  rerankStrategicMoves,
  scoreStrategicObjective,
} from './strategicPersonalities';
import type { OracleMoveFeatures } from './types';

function features(overrides: Partial<OracleMoveFeatures> = {}): OracleMoveFeatures {
  return {
    source: 0,
    targetPressure: [0, 0, 0, 0],
    deniedCorners: [0, 0, 0, 0],
    edgeContacts: [0, 0, 0, 0],
    diagonalContacts: [0, 0, 0, 0],
    primaryTarget: -1,
    retaliation: 0,
    persistence: 0,
    pieceSize: 0,
    centerAffinity: 0,
    edgeAffinity: 0,
    outwardProgress: 0,
    frontierGain: 0,
    totalDenial: 0,
    totalContact: 0,
    ...overrides,
  };
}

describe('strategic personality league', () => {
  it('contains five disjoint variants of every objective family', () => {
    expect(STRATEGIC_PERSONALITIES).toHaveLength(40);
    for (const family of STRATEGIC_PERSONALITY_FAMILIES) {
      const profiles = STRATEGIC_PERSONALITIES.filter((entry) => entry.family === family);
      expect(profiles.map((entry) => entry.variant)).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(profiles[0].strength).toBeLessThan(profiles[1].strength);
      expect(profiles[1].strength).toBeLessThan(profiles[2].strength);
      expect(profiles[3].baseWeight).toBeGreaterThan(profiles[2].baseWeight);
      expect(profiles[3].secondaryWeight).toBeGreaterThan(0);
      // Variant e is fixed before its holdout is generated. Keep it inside the development
      // envelope while changing all three mixture parameters from the prior d holdout.
      expect(profiles[4]).toMatchObject({
        variant: 'e',
        strength: 1.25,
        baseWeight: 0.62,
        secondaryWeight: 0.1,
      });
    }
  });

  it('distinguishes retaliation, persistence, and directed targeting objectives', () => {
    const state = createInitialState();
    expect(
      scoreStrategicObjective(state, features({ retaliation: 2 }), 'retaliator'),
    ).toBeGreaterThan(scoreStrategicObjective(state, features(), 'retaliator'));
    expect(
      scoreStrategicObjective(state, features({ persistence: 2 }), 'persistent'),
    ).toBeGreaterThan(scoreStrategicObjective(state, features(), 'persistent'));
    expect(
      scoreStrategicObjective(
        state,
        features({ targetPressure: [0, 2, 0, 0] }),
        'next-hunter',
      ),
    ).toBeGreaterThan(
      scoreStrategicObjective(
        state,
        features({ targetPressure: [0, 0, 2, 0] }),
        'next-hunter',
      ),
    );
  });

  it('reranks legal moves without mutating real interaction history', () => {
    const state = createInitialState();
    const moves = generateLegalMoves(state, 'blue');
    const ranked = moves.map((move, index) => ({
      move,
      visits: 1,
      winRate: 0,
      value: moves.length - index,
    }));
    const interaction = createOracleInteractionState();
    const before = structuredClone(interaction);
    const reranked = rerankStrategicMoves(
      state,
      ranked,
      'oracle-personality-tempo-c',
      interaction,
    );
    expect(reranked).toHaveLength(ranked.length);
    expect(PIECES[reranked[0].move.pieceId].size).toBe(5);
    expect(interaction).toEqual(before);
  });
});

describe('activeStrategicPersonality', () => {
  const schedule = {
    initial: 'oracle-personality-blocker-a',
    switchTo: 'oracle-personality-center-a',
    afterOwnMoves: 6,
  } as const;

  it('keeps the initial objective until the seat has made enough moves', () => {
    for (let moves = 0; moves < 6; moves += 1) {
      expect(activeStrategicPersonality(schedule, moves)).toBe('oracle-personality-blocker-a');
    }
  });

  it('switches on the seat’s own move count, not the global ply', () => {
    expect(activeStrategicPersonality(schedule, 6)).toBe('oracle-personality-center-a');
    expect(activeStrategicPersonality(schedule, 20)).toBe('oracle-personality-center-a');
  });

  it('reranks differently on either side of the switch', () => {
    const state = createInitialState('corner');
    const moves = generateLegalMoves(state, 'blue').slice(0, 40);
    const ranked = moves.map((move, index) => ({ move, value: -index, visits: 0, winRate: 0 }));
    const interaction = createOracleInteractionState();
    const before = rerankStrategicMoves(
      state,
      ranked,
      activeStrategicPersonality(schedule, 0),
      interaction,
    );
    const after = rerankStrategicMoves(
      state,
      ranked,
      activeStrategicPersonality(schedule, 6),
      interaction,
    );
    expect(before[0]?.move).not.toEqual(after[0]?.move);
  });
});
