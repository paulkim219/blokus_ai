import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../engine/game';
import type { PlaceMove } from '../../engine/types';
import {
  advanceOracleInteraction,
  createOracleInteractionState,
  describeOracleInteraction,
  oracleSeat,
} from './interaction';

describe('Oracle interaction state', () => {
  it('records directed corner denial and retaliation without mutating the input', () => {
    const state = createInitialState();
    state.board[5][5] = 'blue';
    state.hasPlayed.blue = true;
    state.currentTurn = 'green';
    const interaction = createOracleInteractionState();
    const blue = oracleSeat('blue');
    const green = oracleSeat('green');
    interaction.pressure[blue][green] = 3;
    const before = structuredClone(interaction);
    const move: PlaceMove = {
      type: 'place',
      color: 'green',
      pieceId: 0,
      orientationIndex: 0,
      anchor: { x: 6, y: 6 },
      absoluteCells: [{ x: 6, y: 6 }],
    };

    const described = describeOracleInteraction(state, move, interaction);

    expect(described.deniedCorners[blue]).toBe(1);
    expect(described.primaryTarget).toBe(blue);
    expect(described.retaliation).toBeGreaterThan(0);
    expect(interaction).toEqual(before);

    const advanced = advanceOracleInteraction(interaction, described);
    expect(advanced.pressure[green][blue]).toBeGreaterThan(0);
    expect(advanced.pressure[blue][green]).toBeCloseTo(2.7);
    expect(advanced.lastAggressor[blue]).toBe(green);
    expect(advanced.lastVictim[green]).toBe(blue);
    expect(interaction).toEqual(before);
  });

  it('decays all directed pressure on a pass', () => {
    const interaction = createOracleInteractionState();
    interaction.pressure[0][2] = 5;
    const advanced = advanceOracleInteraction(interaction, null);
    expect(advanced.ply).toBe(1);
    expect(advanced.pressure[0][2]).toBeCloseTo(4.5);
    expect(interaction.pressure[0][2]).toBe(5);
  });
});

