import { describe, expect, it } from 'vitest';
import { applyMove, generateLegalMoves } from '../../engine/game';
import { placementFor, toPosition } from './adapter';
import { createEvalContext, refreshContext } from './features';
import { FEATURE_COUNT, writeFeatures } from './netFeatures';
import {
  POLICY_FEATURE_COUNT,
  POLICY_FEATURE_NAMES,
  writePolicyFeatures,
} from './policyFeatures';
import {
  POLICY_V2_FEATURE_COUNT,
  POLICY_V2_FEATURE_NAMES,
  writePolicyFeaturesV2,
} from './policyFeaturesV2';
import { playRandomGame } from './testUtil';

describe('policy feature contract', () => {
  it('adds explicit action identity and parent-to-child deltas', () => {
    const state = playRandomGame(320, 12, 12).final;
    const move = generateLegalMoves(state, state.currentTurn)[0];
    const seat = toPosition(state).turn;
    const parent = toPosition(state);
    const child = toPosition(applyMove(state, move));
    const parentContext = createEvalContext();
    const childContext = createEvalContext();
    refreshContext(parentContext, parent, false);
    refreshContext(childContext, child, false);

    const parentFeatures = new Float32Array(FEATURE_COUNT);
    const policyFeatures = new Float32Array(POLICY_FEATURE_COUNT);
    writeFeatures(parentFeatures, 0, parent, parentContext, seat);
    writePolicyFeatures(
      policyFeatures,
      child,
      childContext,
      seat,
      placementFor(move),
      parentFeatures,
    );

    expect(POLICY_FEATURE_NAMES).toHaveLength(POLICY_FEATURE_COUNT);
    expect([...policyFeatures].every(Number.isFinite)).toBe(true);
    const pieceStart = FEATURE_COUNT;
    expect(policyFeatures.slice(pieceStart, pieceStart + 21).reduce((a, b) => a + b, 0)).toBe(1);
    const deltaStart = FEATURE_COUNT + 21 + 8 + 6;
    expect([...policyFeatures.slice(deltaStart)].some((value) => value !== 0)).toBe(true);
  });

  it('adds home-relative geometry and local action contacts without changing the old prefix', () => {
    const state = playRandomGame(321, 12, 12).final;
    const move = generateLegalMoves(state, state.currentTurn)[0];
    const seat = toPosition(state).turn;
    const parent = toPosition(state);
    const child = toPosition(applyMove(state, move));
    const parentContext = createEvalContext();
    const childContext = createEvalContext();
    refreshContext(parentContext, parent, false);
    refreshContext(childContext, child, false);

    const parentFeatures = new Float32Array(FEATURE_COUNT);
    const oldFeatures = new Float32Array(POLICY_FEATURE_COUNT);
    const richerFeatures = new Float32Array(POLICY_V2_FEATURE_COUNT);
    writeFeatures(parentFeatures, 0, parent, parentContext, seat);
    writePolicyFeatures(oldFeatures, child, childContext, seat, placementFor(move), parentFeatures);
    writePolicyFeaturesV2(
      richerFeatures,
      child,
      childContext,
      seat,
      placementFor(move),
      parentFeatures,
    );

    expect(POLICY_V2_FEATURE_NAMES).toHaveLength(POLICY_V2_FEATURE_COUNT);
    expect(POLICY_V2_FEATURE_COUNT).toBe(256);
    expect([...richerFeatures.slice(0, POLICY_FEATURE_COUNT)]).toEqual([...oldFeatures]);
    expect([...richerFeatures].every(Number.isFinite)).toBe(true);
    expect([...richerFeatures.slice(POLICY_FEATURE_COUNT)].some((value) => value !== 0)).toBe(true);
  });
});
