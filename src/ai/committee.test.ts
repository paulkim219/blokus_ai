/**
 * Freeze and behaviour tests for the v3.5 committee.
 *
 * The load-bearing one is `is inert at band 0`. The whole design rests on the layer shipping
 * switched off, so that `v3.5-balanced` vs `v3.1-pro-max` is a mirror match that prints exactly 0.00
 * and every band above zero is a single axis away from a measured configuration.
 */

import { describe, expect, it } from 'vitest';
import { createInitialState, generateLegalMoves } from '../engine/game';
import type { PlaceMove } from '../engine/types';
import { getAlgo } from './algoVersions';
import {
  DEFAULT_COMMITTEE,
  arbitrate,
  combineRanks,
  committeeActiveAtOwnMove,
  contestedSet,
  type CommitteeParams,
} from './committee';
import { scoreMovesV12 } from './bitboard';
import { DEFAULT_BITBOARD_PARAMS } from './bitboard/config';
import type { RankedMove, SearchResult } from './searchTypes';

function ranked(visits: number[]): RankedMove[] {
  return visits.map((count, i) => ({
    move: { type: 'place', color: 'blue', pieceId: i, orientationIndex: 0, anchor: { x: i, y: 0 } },
    visits: count,
    winRate: 0,
    value: 0,
  })) as RankedMove[];
}

const params = (over: Partial<CommitteeParams> = {}): CommitteeParams => ({
  ...DEFAULT_COMMITTEE,
  ...over,
});

describe('contestedSet', () => {
  it('is empty at band 0, whatever the visit spread', () => {
    expect(contestedSet(ranked([412, 411, 410]), params({ band: 0 }))).toEqual([]);
  });

  it('takes children within the band of the leader’s share of total visits', () => {
    // Shares over the 961 total: 0.4287, 0.4141, 0.1571. The first gap is 0.0146.
    const entries = ranked([412, 398, 151]);
    expect(contestedSet(entries, params({ band: 0.02 }))).toEqual([0, 1]);
    expect(contestedSet(entries, params({ band: 0.01 }))).toEqual([]);
  });

  it('stops at the first child outside the band rather than scanning past it', () => {
    // 500 / 480 / 10 / 10: the third child is far outside, so the trailing pair never joins.
    expect(contestedSet(ranked([500, 480, 10, 10]), params({ band: 0.05 }))).toEqual([0, 1]);
  });

  it('honours maxArbitrated so the arbiters’ cost stays bounded', () => {
    const entries = ranked([100, 100, 100, 100, 100, 100]);
    expect(contestedSet(entries, params({ band: 1, maxArbitrated: 3 }))).toEqual([0, 1, 2]);
  });

  it('returns nothing when only the leader qualifies — a decided root is not contested', () => {
    expect(contestedSet(ranked([900, 50, 50]), params({ band: 0.05 }))).toEqual([]);
  });
});

describe('phase-gated arbitration', () => {
  it('activates only in the preregistered opening and endgame bands', () => {
    const gated = params({ ownMoveRanges: [[0, 4], [15, 20]] });
    expect(committeeActiveAtOwnMove(gated, 0)).toBe(true);
    expect(committeeActiveAtOwnMove(gated, 4)).toBe(true);
    expect(committeeActiveAtOwnMove(gated, 5)).toBe(false);
    expect(committeeActiveAtOwnMove(gated, 14)).toBe(false);
    expect(committeeActiveAtOwnMove(gated, 15)).toBe(true);
    expect(committeeActiveAtOwnMove(gated, 20)).toBe(true);
  });
});

describe('combineRanks', () => {
  it('breaks ties toward the primary, which votes first', () => {
    // One member each way, equal weight: the sums are equal and index 0 must win.
    expect(combineRanks([[0, 1], [1, 0]], [1, 1], 'borda')).toBe(0);
  });

  it('lets a weighted majority overturn the primary', () => {
    // Primary prefers 0; two unit-weight arbiters prefer 1.
    expect(combineRanks([[0, 1], [1, 0], [1, 0]], [1, 1, 1], 'borda')).toBe(1);
  });

  it('respects member weights', () => {
    expect(combineRanks([[1, 0], [0, 1]], [1, 2], 'borda')).toBe(0);
    expect(combineRanks([[1, 0], [0, 1]], [2, 1], 'borda')).toBe(1);
  });

  it('punishes a single last-place opinion harder under geomMean than under borda', () => {
    // Candidate 0 is ranked first twice and last once; candidate 1 is second everywhere.
    const ranks = [
      [0, 1, 2],
      [0, 1, 2],
      [2, 0, 1],
    ];
    expect(combineRanks(ranks, [1, 1, 1], 'borda')).toBe(0);
    expect(combineRanks(ranks, [1, 1, 1], 'geomMean')).toBe(1);
  });
});

describe('arbitrate', () => {
  const state = createInitialState();

  it('returns the primary’s result untouched at band 0', () => {
    const result: SearchResult = {
      bestMove: ranked([412, 398])[0].move,
      rankedMoves: ranked([412, 398]),
      confidence: 0.8,
    };
    expect(arbitrate(state, 'blue', result, params({ band: 0 }))).toBe(result);
  });

  it('returns the primary’s result untouched when no arbiter carries weight', () => {
    const result: SearchResult = {
      bestMove: ranked([412, 398])[0].move,
      rankedMoves: ranked([412, 398]),
      confidence: 0.8,
    };
    const out = arbitrate(
      state,
      'blue',
      result,
      params({ band: 0.5, arbiters: [{ version: 'v2-pro', weight: 0 }] }),
    );
    expect(out).toBe(result);
  });

  it('can promote a contested child, and keeps the rest of the ranking', () => {
    const legal: PlaceMove[] = generateLegalMoves(state, 'blue');
    // Two real moves, so the arbiters have something they can actually score.
    const entries: RankedMove[] = [
      { move: legal[0], visits: 100, winRate: 0, value: 0 },
      { move: legal[1], visits: 99, winRate: 0, value: 0 },
      { move: legal[2], visits: 1, winRate: 0, value: 0 },
    ];
    const result: SearchResult = { bestMove: legal[0], rankedMoves: entries, confidence: 0.5 };

    // A single arbiter with a large weight decides the contested pair outright, so the expected
    // move is whichever of the two that arbiter's own one-ply evaluation prefers.
    const scores = scoreMovesV12(state, 'blue', DEFAULT_BITBOARD_PARAMS, [legal[0], legal[1]]);
    const expected = scores[1] > scores[0] ? legal[1] : legal[0];

    const out = arbitrate(
      state,
      'blue',
      result,
      params({ band: 0.02, arbiters: [{ version: 'v12', weight: 10 }], primaryWeight: 1 }),
    );
    expect(out.bestMove).toBe(expected);
    expect(out.rankedMoves).toHaveLength(3);
    // The uncontested tail keeps its place whatever the arbiters decided.
    expect(out.rankedMoves[2].move).toBe(legal[2]);
  });

  it('leaves the reported values alone — they are contractually in squares', () => {
    const legal: PlaceMove[] = generateLegalMoves(state, 'blue');
    const entries: RankedMove[] = [
      { move: legal[0], visits: 100, winRate: 0, value: 7 },
      { move: legal[1], visits: 99, winRate: 0, value: 3 },
    ];
    const out = arbitrate(
      state,
      'blue',
      { bestMove: legal[0], rankedMoves: entries, confidence: 0.5 },
      params({ band: 0.5, arbiters: [{ version: 'v12', weight: 10 }] }),
    );
    expect(out.rankedMoves.map((entry) => entry.value).sort()).toEqual([3, 7]);
  });
});

describe('v3.5 version wiring', () => {
  it('ships the committee layer inert on the balanced control', () => {
    const config = getAlgo('v3.5-balanced');
    expect(config.engine).toBe('committee');
    expect(config.committee?.band).toBe(0);
    expect(config.committee?.primary).toBe('v3.1-pro-max');
  });

  it('gives every band candidate the same primary, so the band is the only axis', () => {
    for (const id of ['v3.5-arb02', 'v3.5-arb05', 'v3.5-arb10']) {
      const committee = getAlgo(id).committee!;
      expect(committee.primary).toBe('v3.1-pro-max');
      expect(committee.maxArbitrated).toBe(DEFAULT_COMMITTEE.maxArbitrated);
      expect(committee.combine).toBe('borda');
    }
  });

  it('keeps the learned network present but switched off', () => {
    const net = getAlgo('v3.5-arb05').committee!.arbiters.find((m) => m.version === 'v4');
    expect(net?.weight).toBe(0);
  });
});

describe('v3.6 phase evaluator wiring', () => {
  it('keeps v3.5-pro as the only search and gives selection to v2-pro in the gated phases', () => {
    const committee = getAlgo('v3.6-phase-v2-pro').committee!;
    expect(committee.primary).toBe('v3.5-pro');
    expect(committee.arbiters).toEqual([{ version: 'v2-pro', weight: 1 }]);
    expect(committee.primaryWeight).toBe(0);
    expect(committee.ownMoveRanges).toEqual([[0, 4], [15, 20]]);
  });
});
