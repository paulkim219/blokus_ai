/**
 * Freeze test for the measured `v12`.
 *
 * `v12` scored +1.90 [−0.67, 4.31] against v4 on 2026-08-17
 * (`selfplay-results/match-2026-08-17T02-30-23-133Z-summary.txt`). Everything the postmortem added
 * afterwards is a *parameter with a default*, and a default that silently changes behaviour would
 * detach that number from any config that still exists — the failure mode the whole measurement
 * protocol is built to avoid.
 *
 * So: the defaults must reproduce the report as originally implemented, and each ablation must
 * differ from `v12` on exactly the axis it claims.
 */

import { describe, expect, it } from 'vitest';
import { getAlgo, bitboardParamsFor } from '../algoVersions';
import { DEFAULT_BITBOARD_PARAMS } from './config';

function paramsOf(version: string) {
  return bitboardParamsFor(getAlgo(version));
}

/** Dotted paths where `a` and `b` differ. */
function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (a === b) {
    return [];
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return [prefix];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const key of keys) {
    out.push(
      ...diffPaths(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  return out;
}

describe('v12 parameter freeze', () => {
  it('resolves v12 to exactly the defaults', () => {
    expect(paramsOf('v12')).toEqual(DEFAULT_BITBOARD_PARAMS);
  });

  it('keeps every post-measurement parameter at its report-reproducing value', () => {
    const { search, phases } = DEFAULT_BITBOARD_PARAMS;
    // A1: the report's implementation took the margin against the best opponent.
    expect(search.opponentAggregation).toBe('max');
    // A2: the report reads E_i at a truncated leaf and nothing else.
    expect(search.leafMaterialBlend).toBe(0);
    // The report's Voronoi tie-break is winner-take-all.
    expect(DEFAULT_BITBOARD_PARAMS.fractionalTerritoryTies).toBe(false);
    // B1: the aggression dial is a multiplier on the fitted λ, so 1 is "no dial".
    expect(DEFAULT_BITBOARD_PARAMS.aggressionScale).toBe(1);
    // The harness budget is used unchanged.
    expect(search.iterationScale).toBe(1);
    // The report used one search tree per move.
    expect(search.rootEnsembleTrees).toBe(1);
    expect(search.varianceTuned).toBe(false);
    expect(search.varianceTunedRootOnly).toBe(false);
    expect(search.rootPieceDiversity).toBe(false);
    expect(search.netPriorBlend).toBe(1);
    expect(search.netPriorPhase).toBe('all');
    expect(search.playoutMastWeight).toBe(0);
    expect(search.fpuReduction).toBe(0);
    // The playout draws from a single open corner per ply.
    expect(search.playoutCorners).toBe(1);
    // C1: §5's standing-based shift was on.
    expect(search.objectiveShift).toBe(true);
    // A6: Δsplit was root-only, with no funnel reserve.
    expect(search.splitAtInterior).toBe(false);
    expect(search.interiorSplitBudget).toBe(0);
    expect(search.funnelReserve).toBe(0);
    for (const phase of ['opening', 'midgame', 'endgame'] as const) {
      // A3: no opponent-material term. A4: the report's per-region sqrt.
      expect(phases[phase].oppSquares).toBe(0);
      expect(phases[phase].cornerExponent).toBe(0.5);
      // The two features §3.1 names and §3.2 drops; the report's E_i has neither.
      expect(phases[phase].mobility).toBe(0);
      expect(phases[phase].uniqueCorners).toBe(0);
    }
  });

  it('gives each ablation exactly the axis it claims', () => {
    const expected: Record<string, string[]> = {
      'v12-mean': ['search.opponentAggregation'],
      'v12-material': ['search.leafMaterialBlend'],
      'v12-margin': ['search.rankBlend', 'search.objectiveShift'],
      'v12-oppsquares': [
        'phases.opening.oppSquares',
        'phases.midgame.oppSquares',
        'phases.endgame.oppSquares',
      ],
      // The opening phase already weighs waste at 0, so only two phases actually move.
      'v12-nowaste': ['phases.midgame.waste', 'phases.endgame.waste'],
      'v12-cutaware': [
        'search.splitAtInterior',
        'search.interiorSplitBudget',
        'search.funnelReserve',
      ],
      'v12-maxn': ['search.opponentPolicy'],
      'v12-fracties': ['fractionalTerritoryTies'],
      'v12-corners4': ['search.playoutCorners'],
      'v12-deep': ['search.playoutCutoff'],
      'v12-wide': ['search.nodeShortlist'],
      'v12-nopack': ['endgame.maxRegionCells'],
    };

    const base = paramsOf('v12');
    for (const [version, paths] of Object.entries(expected)) {
      expect({ version, paths: diffPaths(base, paramsOf(version)).sort() }).toEqual({
        version,
        paths: [...paths].sort(),
      });
    }
  });

  it('rescales the corner weights when it linearises the transform', () => {
    // Otherwise the ablation confounds "linear vs concave" with "corners now dominate E".
    const base = paramsOf('v12');
    const linear = paramsOf('v12-lincorners');
    for (const phase of ['opening', 'midgame', 'endgame'] as const) {
      expect(linear.phases[phase].cornerExponent).toBe(1);
      // The term's magnitude at ten open corners in one region is preserved.
      const before = base.phases[phase].corners * Math.sqrt(10);
      const after = linear.phases[phase].corners * 10;
      expect(after).toBeCloseTo(before, 6);
    }
  });

  it('makes v13 the union of the structural corrections', () => {
    const v13 = paramsOf('v13');
    expect(v13.search.opponentAggregation).toBe('mean');
    expect(v13.search.leafMaterialBlend).toBe(0.6);
    expect(v13.search.rankBlend).toBe(0);
    expect(v13.search.objectiveShift).toBe(false);
    expect(v13.search.funnelReserve).toBeGreaterThan(0);
    expect(v13.search.splitAtInterior).toBe(true);
    for (const phase of ['opening', 'midgame', 'endgame'] as const) {
      expect(v13.phases[phase].waste).toBe(0);
      expect(v13.phases[phase].cornerExponent).toBe(1);
      expect(v13.phases[phase].oppSquares).toBeGreaterThan(0);
    }
  });

  it('moves the v3.5 aggression sweep on exactly one axis', () => {
    // The dial multiplies the fitted per-seat aggression rather than replacing it, so the sweep must
    // differ from its own tier on `aggressionScale` and nothing else — otherwise the frontier is
    // measuring two things and cannot be read.
    const base = paramsOf('v3.1-pro-max');
    for (const [version, scale] of [
      ['v3.5-a00', 0],
      ['v3.5-a05', 0.5],
      ['v3.5-a16', 1.6],
      ['v3.5-a25', 2.5],
    ] as const) {
      expect({ version, paths: diffPaths(base, paramsOf(version)) }).toEqual({
        version,
        paths: ['aggressionScale'],
      });
      expect(paramsOf(version).aggressionScale).toBe(scale);
    }
    // The in-family control differs on nothing at all.
    expect(diffPaths(base, paramsOf('v3.5-a10'))).toEqual([]);
  });

  it('gives the committee its primary’s parameters unchanged', () => {
    // The committee layer must not perturb the engine underneath it, or a band sweep would be
    // measuring the layer *and* a config drift.
    for (const id of ['v3.5-balanced', 'v3.5-arb05']) {
      expect(diffPaths(paramsOf('v3.1-pro-max'), paramsOf(id))).toEqual([]);
    }
    expect(diffPaths(paramsOf('v3.5-pro'), paramsOf('v3.6-phase-v2-pro'))).toEqual([]);
  });

  it('moves the v3.6 iteration shapes on exactly one axis', () => {
    // A shape that also perturbed anything else would make the allocation experiment unreadable:
    // the whole claim is that only *where* the iterations go has changed.
    const base = paramsOf('v3.2-pro');
    for (const id of [
      'v3.6-flat',
      'v3.6-boost-1-5',
      'v3.6-boost-6-10',
      'v3.6-boost-11-15',
      'v3.6-boost-16-21',
      'v3.6-legacy-shape-pro',
      'v3.5-pro',
    ]) {
      expect({ id, paths: diffPaths(base, paramsOf(id)) }).toEqual({
        id,
        paths: ['search.iterationShape'],
      });
      expect(paramsOf(id).search.iterationShape).toHaveLength(21);
    }
    // Absent on everything that has not opted in, so the flat budget stays the default.
    expect(base.search.iterationShape).toBeUndefined();

    const proMax = paramsOf('v3.2-pro-max');
    for (const id of ['v3.6-legacy-shape-pro-max', 'v3.5-pro-max']) {
      expect({ id, paths: diffPaths(proMax, paramsOf(id)) }).toEqual({
        id,
        paths: ['search.iterationShape'],
      });
      expect(paramsOf(id).search.iterationShape).toHaveLength(21);
    }
    expect(proMax.search.iterationShape).toBeUndefined();

    for (const [baseId, candidateId] of [
      ['v3.2-lite', 'v3.5-lite'],
      ['v3.2', 'v3.5'],
    ] as const) {
      expect(diffPaths(paramsOf(baseId), paramsOf(candidateId))).toEqual(['search.iterationShape']);
    }
  });

  it('lines the v3.6 boost blocks up with the moves they are named after', () => {
    // `ownMovesPlayed` is 0 before a seat's first move, so the shape is indexed 0-based while the
    // ids are named the way a player counts — 1-based. Off by one here would silently boost the
    // wrong band and the probe would answer a question nobody asked.
    const shapeOf = (id: string) => paramsOf(id).search.iterationShape!;

    // Own move 1 is index 0, so the opening probe boosts indices 0..4 and nothing else.
    expect(shapeOf('v3.6-boost-1-5').map((v) => v === 2)).toEqual(
      Array.from({ length: 21 }, (_, k) => k <= 4),
    );
    // Own move 21 is index 20, and the endgame probe must reach it.
    expect(shapeOf('v3.6-boost-16-21')[20]).toBe(2);
    expect(shapeOf('v3.6-boost-16-21')[14]).toBe(1);

    // The four blocks tile the game exactly once, with no gap and no overlap.
    const covered = Array.from({ length: 21 }, (_, k) =>
      ['v3.6-boost-1-5', 'v3.6-boost-6-10', 'v3.6-boost-11-15', 'v3.6-boost-16-21'].filter(
        (id) => shapeOf(id)[k] === 2,
      ).length,
    );
    expect(covered).toEqual(Array.from({ length: 21 }, () => 1));
  });

  it('makes v3.6-pro-max an effort level of v3.5-pro-max, not a design change', () => {
    // The promotion note says the generation number denotes a new budget, not a new architecture.
    // That claim is only worth making if it is enforced: a second axis appearing here would mean
    // the +0.84 [0.31, 1.37] block measured something other than what its name says.
    expect(diffPaths(paramsOf('v3.5-pro-max'), paramsOf('v3.6-pro-max'))).toEqual([
      'search.iterationScale',
    ]);
    expect(paramsOf('v3.6-pro-max').search.iterationScale).toBe(8.33);
    expect(paramsOf('v3.5-pro-max').search.iterationScale).toBe(8);
    // Same curve on both.
    expect(paramsOf('v3.6-pro-max').search.iterationShape).toEqual(
      paramsOf('v3.5-pro-max').search.iterationShape,
    );
  });

  it('leaves v3.5-pro-max meaning exactly what its two match blocks measured', () => {
    // Adding v3.6-pro-max must not change what v3.5-pro-max resolves to, or the +0.41 [-0.15, 0.98]
    // pooled figure would describe a config nobody can run.
    expect(diffPaths(paramsOf('v3.6-legacy-shape-pro-max'), paramsOf('v3.5-pro-max'))).toEqual([]);
  });

  it('makes v3.7-pro differ from v3.5-pro on the opening window alone', () => {
    // The promotion claim is that skipping the tree on own moves 1-3 is free-or-better. Any second
    // axis here would mean the +0.45 [0.11, 0.78] block measured something else as well.
    expect(diffPaths(paramsOf('v3.5-pro'), paramsOf('v3.7-pro'))).toEqual([
      'search.openingHeuristicMaxOwnMove',
    ]);
    expect(paramsOf('v3.7-pro').search.openingHeuristicMaxOwnMove).toBe(3);
    // No network: the policy-net version of this idea measured -0.76.
    expect(paramsOf('v3.7-pro').search.pooledNetPath).toBeUndefined();
    expect(paramsOf('v3.7-pro').search.netPrior).toBe(false);
  });

  it('keeps v3.7-pro identical to the id its blocks were measured under', () => {
    expect(diffPaths(paramsOf('v3.7-noopening3-pro'), paramsOf('v3.7-pro'))).toEqual([]);
    expect(diffPaths(paramsOf('v3.7-noopening3-pro-max'), paramsOf('v3.7-pro-max'))).toEqual([]);
  });

  it('makes v3.7-pro-max differ from v3.6-pro-max on the opening window alone', () => {
    expect(diffPaths(paramsOf('v3.6-pro-max'), paramsOf('v3.7-pro-max'))).toEqual([
      'search.openingHeuristicMaxOwnMove',
    ]);
    // It inherits Pro Max's larger budget, which is the whole reason its gain is twice Pro's.
    expect(paramsOf('v3.7-pro-max').search.iterationScale).toBe(8.33);
  });

  it('keeps the budget-neutral v3.6 shapes at exactly a flat per-game budget', () => {
    // The match statistic carries no compute discount, so a shape summing to more than 21 would be
    // measuring itself plus a slice of the compute ladder. Only the boost probes may do that, and
    // they do it deliberately and by a stated amount.
    const total = (id: string) =>
      (paramsOf(id).search.iterationShape ?? []).reduce((sum, value) => sum + value, 0);

    expect(total('v3.6-flat')).toBeCloseTo(21, 6);
    expect(total('v3.6-legacy-shape-pro')).toBeCloseTo(21, 3);
    expect(total('v3.6-legacy-shape-pro-max')).toBeCloseTo(21, 3);
    expect(total('v3.5-lite')).toBeCloseTo(21, 3);
    expect(total('v3.5')).toBeCloseTo(21, 3);
    expect(total('v3.5-pro')).toBeCloseTo(21, 3);
    expect(total('v3.5-pro-max')).toBeCloseTo(21, 3);

    // Each probe buys one doubling over its own block and nothing else.
    for (const [id, boosted] of [
      ['v3.6-boost-1-5', 5],
      ['v3.6-boost-6-10', 5],
      ['v3.6-boost-11-15', 5],
      ['v3.6-boost-16-21', 6],
    ] as const) {
      expect({ id, total: total(id) }).toEqual({ id, total: 21 + boosted });
    }
  });

  it('enables v3.6 banking on exactly one axis above v3.5-pro', () => {
    expect(diffPaths(paramsOf('v3.5-pro'), paramsOf('v3.6-banking-pro'))).toEqual([
      'search.iterationBanking',
    ]);
  });

  it('keeps each promoted v3.2 tier identical to v3.1 except for rollout epsilon', () => {
    for (const [baseline, promoted] of [
      ['v3.1', 'v3.2'],
      ['v3.1-pro', 'v3.2-pro'],
      ['v3.1-pro-max', 'v3.2-pro-max'],
    ] as const) {
      expect(diffPaths(paramsOf(baseline), paramsOf(promoted))).toEqual(['search.playoutEps']);
      expect(paramsOf(promoted).search.playoutEps).toBe(0.6);
    }
  });

  it('leaves the legacy engine untouched by any of this', () => {
    for (const version of ['v1', 'v10', 'v11']) {
      expect(getAlgo(version).engine).toBe('legacy');
    }
    expect(getAlgo('v12').engine).toBe('bitboard');
    expect(getAlgo('v13').engine).toBe('bitboard');
  });
});
