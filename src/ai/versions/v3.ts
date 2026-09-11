/**
 * Generation 3 — the research-report engine (`src/ai/bitboard`).
 *
 * `v3` is the report exactly as first implemented and is frozen; every `v12-*` ablation below was
 * measured against it, and those ids are deliberately not renamed so the measurement record stays
 * attached to the configs it describes. `v3.1` is v3 iterated — fitted evaluation, fractional
 * Voronoi ties, full-length rollouts — with `v3.1-lite` the truncated variant.
 */

import type { AlgoConfig, AlgoVersionId } from '../algoVersions';
import type { DeepPartial, PhaseId, BitboardParams } from '../bitboard/config';
import { DEFAULT_BITBOARD_PARAMS } from '../bitboard/config';
import { DEFAULT_COMMITTEE, type CommitteeMember, type CommitteeParams } from '../committee';
import { V4_WEIGHTS } from './v1';

/**
 * The v12 family. Every field except `v12` is inert for this engine — it is present only because
 * `AlgoConfig` was shaped for the legacy one — so declaring them once here keeps the deltas visible.
 */
function v12Variant(
  id: AlgoVersionId,
  summary: string,
  overrides: DeepPartial<BitboardParams> | null,
): AlgoConfig {
  return {
    id,
    summary,
    weights: V4_WEIGHTS,
    exploration: 1.41,
    materialScale: 20,
    positionalScale: 60,
    materialBlend: 0.6,
    selectByVisits: true,
    adjacentOpponentWeight: 2 / 3,
    phaseBonusEarly: 0.25,
    phaseBonusLate: 0.1,
    engine: 'bitboard',
    bitboard: overrides,
  };
}

/**
 * Linearising f(C) multiplies the term by √|C| ≈ 3.16 at a typical ten open corners, so the corner
 * weights are divided by that. Without the rescale the ablation would confound "linear vs concave"
 * with "corners now dominate E", and stop being single-axis.
 */
const LINEAR_CORNER_RESCALE = 1 / Math.sqrt(10);

/**
 * Opponent material, weighted so that the *aggregate* pressure across the three opponents matches
 * the agent's own squares term: Σ_j λ_j ≈ 1.85 in the mid-game, so oppSquares ≈ squares / 1.85.
 * That is roughly what v11 does, whose opponent term is the opponent's whole evaluation.
 */
const OPP_SQUARES: Record<PhaseId, number> = { opening: 0.3, midgame: 0.75, endgame: 1.4 };

const CUT_AWARE_SEARCH = {
  funnelReserve: 24,
  splitAtInterior: true,
  interiorSplitBudget: 8,
} as const;


export const V3_TUNED: DeepPartial<BitboardParams> = {
    "phases": {
      "opening": {
        "squares": 0.7073943491787182,
        "corners": 3.236208243006147,
        "territory": 0.07869436657222152,
        "waste": 0.019340335125757536,
        "centre": 2.0751516480799825,
        "frontier": 0.19140497965605197,
        "oppTerritory": 0.123209337202243,
        "oppCorners": 0.2637393827654344,
        "oppSquares": 0.08957550081323215,
        "mobility": 0.17633374795435142,
        "uniqueCorners": 0.00014916084411385755,
        "cornerExponent": 0.5392766252710198
      },
      "midgame": {
        "squares": 2.14009336506333,
        "corners": 1.63555702411341,
        "territory": 0.4618259311789069,
        "waste": 0.44027256604352194,
        "centre": 0.30558293224891686,
        "frontier": 0.19148373778170136,
        "oppTerritory": 0.4493517939204217,
        "oppCorners": 0.33240981667469927,
        "oppSquares": 0.06939506768930884,
        "mobility": -0.40598936157341664,
        "uniqueCorners": 0.12977957695067222,
        "cornerExponent": 0.41430604449335706
      },
      "endgame": {
        "squares": 2.439759753226241,
        "corners": 1.485841278511595,
        "territory": 0.5151829972226134,
        "waste": 0.835242401245712,
        "centre": 0.09068757113632515,
        "frontier": 0,
        "oppTerritory": 0.22893918622663953,
        "oppCorners": 0.18730612025648047,
        "oppSquares": 0.04775752466192881,
        "mobility": 0.05354090731220601,
        "uniqueCorners": 0.12195186120727289,
        "cornerExponent": 0.4697523606526842
      }
    },
    "lambda": {
      "opening": {
        "next": 0.2662788703416361,
        "prev": 0.2034751255979761,
        "diag": 0.09263200847574488,
        "leaderBoost": 0.25942335808900846
      },
      "midgame": {
        "next": 0.8107331953257476,
        "prev": 0.41391178353978364,
        "diag": 0.3275790711723966,
        "leaderBoost": 0.234598573207065
      },
      "endgame": {
        "next": 0.4298727832569056,
        "prev": 0.41399781997360585,
        "diag": 0.1774918522212113,
        "leaderBoost": 0.1792541306555348
      }
    },
    "ordering": {
      "opening": {
        "pieceSize": 1.6,
        "split": 0.15,
        "newCorners": 1.2,
        "denyCorners": 0.4,
        "centrePull": 0.55
      },
      "midgame": {
        "pieceSize": 0.9,
        "split": 0.65,
        "newCorners": 0.9,
        "denyCorners": 1.1,
        "centrePull": 0.15
      },
      "endgame": {
        "pieceSize": 1.3,
        "split": 0.35,
        "newCorners": 0.5,
        "denyCorners": 0.5,
        "centrePull": 0
      }
    },
    "seats": [
      {
        "centre": 1.15,
        "corners": 1.05,
        "territory": 1,
        "waste": 0.9,
        "aggression": 0.8
      },
      {
        "centre": 1.05,
        "corners": 1,
        "territory": 1.02,
        "waste": 0.97,
        "aggression": 0.95
      },
      {
        "centre": 1,
        "corners": 1,
        "territory": 1.05,
        "waste": 1.03,
        "aggression": 1.1
      },
      {
        "centre": 0.9,
        "corners": 0.98,
        "territory": 1.1,
        "waste": 1.15,
        "aggression": 1.25
      }
    ],
    "search": {
      "cPuct": 1.6,
      "priorTemp": 6,
      "wideningInit": 8,
      "wideningGrowth": 0.8,
      "wideningAllNodes": true,
      "playoutEps": 0.15,
      "playoutCutoff": 84,
      "playoutMoveCap": 12,
      "sigmoidScale": 12,
      "evalScale": 28,
      "rankBlend": 0.35,
      "opponentAggregation": "max",
      "leafMaterialBlend": 0,
      "objectiveShift": true,
      "historyWeight": 0.6,
      "opponentPolicy": "auto",
      "paranoidLead": 8,
      "transpositions": true,
      "virtualLoss": 0,
      "rootShortlist": 40,
      "nodeShortlist": 24,
      "splitAtInterior": false,
      "interiorSplitBudget": 0,
      "funnelReserve": 0,
      "playoutCorners": 1
    },
    "endgame": {
      "maxRegionCells": 44,
      "maxOwnMoves": 80,
      "nodeBudget": 30000,
      "memoLimit": 40000,
      "nearSealed": true,
      "gateRemainingSquares": 160
    },
    "time": {
      "probeFraction": 0.2,
      "minIterations": 64,
      "spreadFactor": 1.5,
      "earlyExit": true
    },
    "detection": {
      "openingMoves": 5,
      "midgameMoves": 15,
      "contestedFloor": 0.08
    },
    "fractionalTerritoryTies": true
  } as DeepPartial<BitboardParams>;

const V12_FAMILY: Record<AlgoVersionId, AlgoConfig> = {
  /**
   * The research report as an engine (`src/ai/bitboard`). **Frozen**: this is the config that measured
   * +1.90 [−0.67, 4.31] vs v4 (100 games, 300 iterations, 2026-08-17). Every parameter added since
   * defaults to reproducing it, and `config.test.ts` fails if that stops being true — so the number
   * above stays attached to a config that still exists.
   */
  v3: v12Variant(
    'v3',
    'Research-report engine: bitboards, multi-player MCTS with max^n vector backup and sigmoid-margin values, Voronoi territory with tempo tie-break, articulation-point Δsplit ordering, waste-aware evaluation, phase × seat weights, exact sealed-region packer, DAG transpositions.',
    // Materialised rather than left null so the CEM tuner reads real starting values off it:
    // `readParams` treats a missing dotted path as 0, which would start every generation from an
    // all-zero mean.
    DEFAULT_BITBOARD_PARAMS,
  ),

  // --- Ablations for the report's own claims -------------------------------------------------

  'v12-maxn': v12Variant(
    'v12-maxn',
    'v12 with the opponent model pinned to max^n instead of switching to paranoid when leading (§5).',
    { search: { opponentPolicy: 'maxn' } },
  ),

  'v12-nopack': v12Variant(
    'v12-nopack',
    'v12 with the sealed-region packer disabled (region cap 0), so leaves always sample (§4.3).',
    { endgame: { maxRegionCells: 0 } },
  ),

  'v12-nosplit': v12Variant(
    'v12-nosplit',
    'v12 with the Δsplit ordering term zeroed in every phase (§3.1).',
    { ordering: { opening: { split: 0 }, midgame: { split: 0 }, endgame: { split: 0 } } },
  ),

  'v12-onephase': v12Variant(
    'v12-onephase',
    'v12 with the opening and endgame weight vectors replaced by the mid-game one (§4).',
    {
      phases: {
        opening: DEFAULT_BITBOARD_PARAMS.phases.midgame,
        endgame: DEFAULT_BITBOARD_PARAMS.phases.midgame,
      },
      lambda: {
        opening: DEFAULT_BITBOARD_PARAMS.lambda.midgame,
        endgame: DEFAULT_BITBOARD_PARAMS.lambda.midgame,
      },
    },
  ),

  'v12-noseat': v12Variant(
    'v12-noseat',
    'v12 with all four seat profiles set to 1.0 — the null for the seat-asymmetry claim (§5).',
    {
      seats: [
        { centre: 1, corners: 1, territory: 1, waste: 1, aggression: 1 },
        { centre: 1, corners: 1, territory: 1, waste: 1, aggression: 1 },
        { centre: 1, corners: 1, territory: 1, waste: 1, aggression: 1 },
        { centre: 1, corners: 1, territory: 1, waste: 1, aggression: 1 },
      ],
    },
  ),

  // --- Ablations for the postmortem's structural findings -------------------------------------
  // These exist because the parameters they move were hard-coded when the report was implemented,
  // so no amount of tuning could have reached them. Search-level only where noted: the greedy
  // policy has no tree, so a change to the backup is invisible to it.

  /** A1. Search-level only. */
  'v12-mean': v12Variant(
    'v12-mean',
    'v12 backing up the margin against the MEAN of the other three seats instead of the best of them — matching the statistic the tournament promotes on.',
    { search: { opponentAggregation: 'mean' } },
  ),

  /** A2. Search-level only. */
  'v12-material': v12Variant(
    'v12-material',
    'v12 with 60% of a truncated leaf anchored on the actual score margin, matching the legacy engine, instead of reading E_i alone.',
    { search: { leafMaterialBlend: 0.6 } },
  ),

  /** A1/C1. Search-level only. */
  'v12-margin': v12Variant(
    'v12-margin',
    'v12 optimising margin only: rank blend 0 and the standing-based objective shift off (which a rank blend of 0 does not otherwise achieve).',
    { search: { rankBlend: 0, objectiveShift: false } },
  ),

  /** A3. Visible at eval level. */
  'v12-oppsquares': v12Variant(
    'v12-oppsquares',
    'v12 with opponent material in E_i, weighted so aggregate opponent pressure matches the own-squares term. The report weighs opponents by space alone.',
    {
      phases: {
        opening: { oppSquares: OPP_SQUARES.opening },
        midgame: { oppSquares: OPP_SQUARES.midgame },
        endgame: { oppSquares: OPP_SQUARES.endgame },
      },
    },
  ),

  /** A4. Visible at eval level. */
  'v12-lincorners': v12Variant(
    'v12-lincorners',
    'v12 with a linear open-corner count instead of the report’s per-region sqrt, corner weights rescaled by 1/√10 so the term keeps its magnitude and the axis stays single.',
    {
      phases: {
        opening: {
          cornerExponent: 1,
          corners: 3.0 * LINEAR_CORNER_RESCALE,
          oppCorners: 0.3 * LINEAR_CORNER_RESCALE,
        },
        midgame: {
          cornerExponent: 1,
          corners: 2.0 * LINEAR_CORNER_RESCALE,
          oppCorners: 0.9 * LINEAR_CORNER_RESCALE,
        },
        endgame: {
          cornerExponent: 1,
          corners: 1.0 * LINEAR_CORNER_RESCALE,
          oppCorners: 0.2 * LINEAR_CORNER_RESCALE,
        },
      },
    },
  ),

  /** A5. Visible at eval level. */
  'v12-nowaste': v12Variant(
    'v12-nowaste',
    'v12 with the waste term off. With the monomino held it degenerates to |T_i ∩ own edge halo| — own frontier length — which fights the corner term.',
    { phases: { opening: { waste: 0 }, midgame: { waste: 0 }, endgame: { waste: 0 } } },
  ),

  /** A6. Search-level only. */
  'v12-cutaware': v12Variant(
    'v12-cutaware',
    'v12 with a funnel that reserves 24 slots for articulation-point and corner-denying moves, and Δsplit computed at interior nodes — so the term the report calls its headline actually reaches the tree.',
    { search: CUT_AWARE_SEARCH },
  ),

  /**
   * Tree-level ablations. The evaluation reached parity with v11 while the search gave back ~3
   * points, so these three test *what the search computes* rather than what its terms are worth —
   * the distinction that separated the eleven failed reweightings from the one recomputation that
   * worked. All are invisible at the greedy policy, which has no tree.
   */
  'v12-corners4': v12Variant(
    'v12-corners4',
    'v12 with playouts pooling candidates from 4 distinct open corners per ply instead of 1, so the simulation policy can compare across corners.',
    { search: { playoutCorners: 4 } },
  ),

  'v12-deep': v12Variant(
    'v12-deep',
    'v12 with playouts truncated at 24 plies instead of 12 — six moves per seat rather than three, before E_i is read.',
    { search: { playoutCutoff: 24 } },
  ),

  'v12-wide': v12Variant(
    'v12-wide',
    'v12 with interior nodes shortlisting 48 moves instead of 24 (and the cheap pre-filter funnel widening with it).',
    { search: { nodeShortlist: 48 } },
  ),

  /**
   * Fractional Voronoi tie-break: a cell several seats reach in the same number of steps is split
   * 1/k between them instead of going whole to whoever moves soonest. Winner-take-all makes |T_i|
   * jump by whole regions between siblings that differ by one placement, and those jumps are noise
   * with respect to the outcome — this smooths the same statistic without changing what it means.
   */
  'v12-fracties': v12Variant(
    'v12-fracties',
    'v12 with tied Voronoi cells split 1/k between the seats that tie, rather than awarded whole to the earliest mover.',
    { fractionalTerritoryTies: true },
  ),

  /**
   * The two features §3.1 of the report names and §3.2's E_i formula omits — legal move count and
   * unique corners. Starting weights are v11's fitted values scaled by ~0.65, the approximate ratio
   * of the two evaluations' material terms; the tuner is expected to move them. v11 fits mobility
   * negative in the late game, and that sign is preserved here.
   *
   * This is the last structural candidate for the ~1-point residual: after tuning, v12 matches v11's
   * piece-size schedule almost exactly and still leaves ~1 more square in hand, which is a
   * shape-compatibility failure rather than a piece-selection one.
   */
  'v12-libs': v12Variant(
    'v12-libs',
    'v12 plus the two features §3.1 names and §3.2 drops: mobility (|C| + 2·pieces, v11’s |A_i| proxy) and unique corners (corners no opponent also holds).',
    {
      phases: {
        opening: { mobility: 0.65, uniqueCorners: 0.55 },
        midgame: { mobility: 0.65, uniqueCorners: 0.55 },
        endgame: { mobility: -0.57, uniqueCorners: 0.35 },
      },
    },
  ),


  /**
   * v3-lite / v3-pro — the tuned research-report engine. They differ only in rollout length, the
   * same axis that separates v2-lite from v2-pro.
   *
   * `v3.1` is v3 iterated: CEM-fitted evaluation, the fractional Voronoi tie-break, and full-length
   * rollouts. The strongest configuration of this engine measured — −0.55 [−1.32, 0.20] against
   * v2-lite over 800 held-out games — and still **below v2-pro**, which beats it by −4.45
   * [−5.89, −2.97]. `v3.1-lite` is the same evaluation with rollouts truncated at 12 plies.
   */
  'v3.1-nano': v12Variant(
    'v3.1-nano',
    'Tuned research-report evaluation + fractional Voronoi ties, rollouts truncated at 12 plies. ~43 ms/move.',
    { ...V3_TUNED, search: { ...(V3_TUNED.search ?? {}), playoutCutoff: 12 } },
  ),

  'v3.1-lite': v12Variant(
    'v3.1-lite',
    'Tuned research-report evaluation + fractional Voronoi ties + full-length rollouts, 300 iterations. ~87 ms/move.',
    V3_TUNED,
  ),

  /**
   * Every structural correction at once. An upper-bound probe on how much of the gap to v11 the
   * findings recover — deliberately not single-axis, and not a promotion candidate until it has
   * been through the tuner the way v10 was to become v11.
   */
  v13: v12Variant(
    'v13',
    'v12 plus every structural correction from the postmortem: mean-aggregated margin, 60% material anchor at truncated leaves, no rank blend, opponent material in E_i, linear corner count, no waste term, cut-aware funnel with interior Δsplit.',
    {
      search: {
        opponentAggregation: 'mean',
        leafMaterialBlend: 0.6,
        rankBlend: 0,
        objectiveShift: false,
        ...CUT_AWARE_SEARCH,
      },
      phases: {
        opening: {
          oppSquares: OPP_SQUARES.opening,
          waste: 0,
          cornerExponent: 1,
          corners: 3.0 * LINEAR_CORNER_RESCALE,
          oppCorners: 0.3 * LINEAR_CORNER_RESCALE,
        },
        midgame: {
          oppSquares: OPP_SQUARES.midgame,
          waste: 0,
          cornerExponent: 1,
          corners: 2.0 * LINEAR_CORNER_RESCALE,
          oppCorners: 0.9 * LINEAR_CORNER_RESCALE,
        },
        endgame: {
          oppSquares: OPP_SQUARES.endgame,
          waste: 0,
          cornerExponent: 1,
          corners: 1.0 * LINEAR_CORNER_RESCALE,
          oppCorners: 0.2 * LINEAR_CORNER_RESCALE,
        },
      },
    },
  ),
};


/**
 * v3.1-pro — the same engine given a *time* budget instead of an iteration budget.
 *
 * Every v3.1-vs-v2-pro comparison so far has been iteration-matched, and that is not a fair fight in
 * the direction people assume: at 300 iterations v3.1 costs 87 ms/move and v2-pro costs 1439 ms, so
 * the "loss" of −2.87 [−4.88, −0.70] was recorded while the champion spent **16× the compute**.
 * These configs spend ~200 ms — still a quarter to a seventh of v2-pro — and use `iterationScale`
 * so a single match can give each side its own budget.
 *
 * Two ways to spend the extra 3.5×, deliberately separated so the answer is attributable:
 *
 *   depth — more iterations, rollouts untouched.
 *   width — more candidates per rollout ply, iterations barely raised.
 *
 * Width is the interesting one. v3.1's "full-length" rollout samples ONE open corner and at most 12
 * placements, 15% of them uniformly at random; it reaches the end of the game nearly blind. The
 * tell is the cost of going from truncated to full-length rollouts in each engine: 2.70× in the
 * legacy engine (271 → 732 ms) against 1.30× here (43 → 56 ms). Two engines doing the same amount
 * of simulation work would not differ by that much. The truncation sweep already showed rollout
 * *length* is worth +5.71; rollout *width* is the untested twin.
 */
function v31tier(
  id: AlgoVersionId,
  summary: string,
  search: Record<string, unknown>,
): AlgoConfig {
  const base = V12_FAMILY['v3.1-lite'];
  return {
    ...base,
    id,
    summary,
    bitboard: {
      ...(base.bitboard ?? {}),
      search: { ...((base.bitboard ?? {}).search ?? {}), ...search },
    },
  } as AlgoConfig;
}

const V31_TIERS: Record<AlgoVersionId, AlgoConfig> = {
  /**
   * v3.2 changes only the terminal-rollout mixture: 60% of rollout moves are sampled uniformly
   * rather than 15%. Two independent v3.1-pro-max blocks (140 seeds / 560 games pooled) measured
   * +0.88 [0.25, 1.54] points at identical iteration budgets, with both blocks positive.
   */
  'v3.2-lite': v31tier(
    'v3.2-lite',
    'v3.1-lite compute tier with 60% uniform-random terminal-rollout moves.',
    { iterationScale: 1, playoutEps: 0.6 },
  ),
  'v3.2': v31tier(
    'v3.2',
    'v3.1 compute tier with 60% uniform-random terminal-rollout moves.',
    { iterationScale: 2.33, playoutEps: 0.6 },
  ),
  'v3.2-pro': v31tier(
    'v3.2-pro',
    'v3.1-pro compute tier with 60% uniform-random terminal-rollout moves.',
    { iterationScale: 4.59, playoutEps: 0.6 },
  ),
  'v3.2-pro-max': v31tier(
    'v3.2-pro-max',
    'v3.1-pro-max compute tier with 60% uniform-random terminal-rollout moves.',
    { iterationScale: 8, playoutEps: 0.6 },
  ),

  /**
   * v4.6 learned-leaf candidates. The 32×16 residual MLP predicts the incumbent rollout-return
   * distribution. Its direct linear head is ridge-initialised; the nonlinear branch may only
   * replace that checkpoint when game-disjoint validation improves. At 300 iterations the pure
   * network arms measure 4.5× faster than terminal rollouts, while retaining 25% real rollouts
   * measures 2.33× faster. `iterationScale` spends those savings on additional search at the
   * standard v3.2 wall-clock tier.
   */
  'v4.6-leaf-mean': v31tier(
    'v4.6-leaf-mean',
    'v3.2 with terminal rollouts replaced by the deterministic mean of the calibrated v4.6 residual MLP.',
    {
      iterationScale: 10.5,
      playoutEps: 0.6,
      netPath: 'ml/v46-search-leaf-distribution.json',
      netBlend: 1,
      netOutputKind: 'meanMargins',
      netValueSampling: 'mean',
      netRolloutProbability: 0,
    },
  ),
  'v4.6-leaf-sampled': v31tier(
    'v4.6-leaf-sampled',
    'v3.2 with each terminal rollout replaced by a reproducible draw from the calibrated learned return distribution.',
    {
      iterationScale: 10.5,
      playoutEps: 0.6,
      netPath: 'ml/v46-search-leaf-distribution.json',
      netBlend: 1,
      netOutputKind: 'meanMargins',
      netValueSampling: 'gaussian',
      netSampleScale: 1,
      netRolloutProbability: 0,
    },
  ),
  'v4.6-leaf-sampled-real25': v31tier(
    'v4.6-leaf-sampled-real25',
    'v4.6 sampled leaf distribution with a real incumbent rollout retained on 25% of expanded leaves.',
    {
      iterationScale: 5.43,
      playoutEps: 0.6,
      netPath: 'ml/v46-search-leaf-distribution.json',
      netBlend: 1,
      netOutputKind: 'meanMargins',
      netValueSampling: 'gaussian',
      netSampleScale: 1,
      netRolloutProbability: 0.25,
    },
  ),
  'v4.6b-leaf-mean': v31tier(
    'v4.6b-leaf-mean',
    'v3.2 with rollouts replaced by an MLP trained directly on the nonlinear backed-up value vector.',
    {
      iterationScale: 10.5,
      playoutEps: 0.6,
      netPath: 'ml/v46b-search-leaf-values.json',
      netBlend: 1,
      netOutputKind: 'values',
      netValueSampling: 'mean',
      netRolloutProbability: 0,
    },
  ),
  'v4.6b-leaf-sampled': v31tier(
    'v4.6b-leaf-sampled',
    'v4.6b with a reproducible draw from the learned backed-value distribution at every leaf.',
    {
      iterationScale: 10.5,
      playoutEps: 0.6,
      netPath: 'ml/v46b-search-leaf-values.json',
      netBlend: 1,
      netOutputKind: 'values',
      netValueSampling: 'gaussian',
      netSampleScale: 1,
      netRolloutProbability: 0,
    },
  ),
  'v4.6b-leaf-sampled05': v31tier(
    'v4.6b-leaf-sampled05',
    'v4.6b backed-value distribution sampled at half its learned conditional standard deviation.',
    {
      iterationScale: 10.5,
      playoutEps: 0.6,
      netPath: 'ml/v46b-search-leaf-values.json',
      netBlend: 1,
      netOutputKind: 'values',
      netValueSampling: 'gaussian',
      netSampleScale: 0.5,
      netRolloutProbability: 0,
    },
  ),
  'v4.6b-leaf-sampled-real25': v31tier(
    'v4.6b-leaf-sampled-real25',
    'v4.6b backed-value distribution with real incumbent rollouts retained on 25% of leaves.',
    {
      iterationScale: 5.43,
      playoutEps: 0.6,
      netPath: 'ml/v46b-search-leaf-values.json',
      netBlend: 1,
      netOutputKind: 'values',
      netValueSampling: 'gaussian',
      netSampleScale: 1,
      netRolloutProbability: 0.25,
    },
  ),
  'v4.6d-pooled-leaf-sampled05': v31tier(
    'v4.6d-pooled-leaf-sampled05',
    'v3.2 with a compact 4x4 pooled spatial MLP sampled at half learned backed-value variance.',
    {
      iterationScale: 7.56,
      playoutEps: 0.6,
      netPath: 'ml/v46d-pooled-leaf-values.json',
      netBlend: 1,
      netOutputKind: 'values',
      netValueSampling: 'gaussian',
      netSampleScale: 0.5,
      netRolloutProbability: 0,
    },
  ),
  'v4.6d-pooled-leaf-sampled05-real25': v31tier(
    'v4.6d-pooled-leaf-sampled05-real25',
    'v4.6d half-noise pooled spatial value with real incumbent rollouts retained on 25% of leaves.',
    {
      iterationScale: 4.85,
      playoutEps: 0.6,
      netPath: 'ml/v46d-pooled-leaf-values.json',
      netBlend: 1,
      netOutputKind: 'values',
      netValueSampling: 'gaussian',
      netSampleScale: 0.5,
      netRolloutProbability: 0.25,
    },
  ),
  'v4.6d-pooled-leaf-blend25': v31tier(
    'v4.6d-pooled-leaf-blend25',
    'v3.2 with every real rollout retained and its backed value blended 25% with the pooled spatial MLP mean.',
    {
      iterationScale: 1.81,
      playoutEps: 0.6,
      netPath: 'ml/v46d-pooled-leaf-values.json',
      netBlend: 0.25,
      netOutputKind: 'values',
      netValueSampling: 'mean',
      netRolloutProbability: 0,
    },
  ),
  'v4.6e-canonical-pooled-blend25': v31tier(
    'v4.6e-canonical-pooled-blend25',
    'v4.6d 25% value blend with every spatial plane rotated into the root seat’s canonical home-corner orientation.',
    {
      iterationScale: 1.81,
      playoutEps: 0.6,
      netPath: 'ml/v46e-canonical-pooled-values.json',
      netBlend: 0.25,
      netOutputKind: 'values',
      netValueSampling: 'mean',
      netRolloutProbability: 0,
    },
  ),

  /**
   * v4.2 blend sweep on the best-performing learned leaf value.
   *
   * Every v4.6 arm is monotone in how much real rollout it keeps: full replacement −13.88, sampled
   * −12.50, sampled with 25% real rollouts −7.04, 25% blend −0.81. A monotone λ-curve with no
   * interior optimum is the signature of a biased leaf estimate (AlphaGo's own λ sweep found an
   * interior optimum at 0.5 with an unbiased one). Nobody has looked below 0.25, which is where an
   * interior optimum would have to be if one exists at all.
   *
   * These are screened on the v4.2 leaf-channel metric before any match; that metric correctly
   * flagged all three v4.7 tail failures and every v4.6 arm above.
   */
  'v4.2-leaf-blend05': v31tier(
    'v4.2-leaf-blend05',
    'v4.6e canonical pooled leaf value at a 5% blend with the real rollout.',
    {
      iterationScale: 1.81,
      playoutEps: 0.6,
      netPath: 'ml/v46e-canonical-pooled-values.json',
      netBlend: 0.05,
      netOutputKind: 'values',
      netValueSampling: 'mean',
      netRolloutProbability: 0,
    },
  ),
  'v4.2-leaf-blend10': v31tier(
    'v4.2-leaf-blend10',
    'v4.6e canonical pooled leaf value at a 10% blend with the real rollout.',
    {
      iterationScale: 1.81,
      playoutEps: 0.6,
      netPath: 'ml/v46e-canonical-pooled-values.json',
      netBlend: 0.1,
      netOutputKind: 'values',
      netValueSampling: 'mean',
      netRolloutProbability: 0,
    },
  ),
  'v4.2-leaf-blend15': v31tier(
    'v4.2-leaf-blend15',
    'v4.6e canonical pooled leaf value at a 15% blend with the real rollout.',
    {
      iterationScale: 1.81,
      playoutEps: 0.6,
      netPath: 'ml/v46e-canonical-pooled-values.json',
      netBlend: 0.15,
      netOutputKind: 'values',
      netValueSampling: 'mean',
      netRolloutProbability: 0,
    },
  ),
  /** Blend zero at the same iteration scale: the compute-matched control for the sweep above. */
  'v4.2-leaf-blend00': v31tier(
    'v4.2-leaf-blend00',
    'The v4.2 blend sweep control: identical iteration scale, no learned leaf value at all.',
    { iterationScale: 1.81, playoutEps: 0.6 },
  ),

  /**
   * The tier the whole v3 line should have been compared at. ~190 ms/move, spent entirely on
   * iterations (`iterationScale` 2.33, ≈700) with the rollout policy left alone.
   *
   * Measured −1.48 [−2.50, −0.52] against `v2-pro` over 400 held-out games, at roughly a seventh of
   * v2-pro's 1439 ms/move — against −2.87 [−4.88, −0.70] for the 87 ms `v3.1-lite`. Half the gap
   * closed by spending compute the engine was never given.
   */
  'v3.1': v31tier(
    'v3.1',
    'Full-length rollouts, 12 placements over 1 corner, ~700 iterations. ~190 ms/move.',
    { iterationScale: 2.33 },
  ),

  /**
   * ~390 ms/move, again spent entirely on iterations (≈1380).
   *
   * A 100-game bake-off at 200 ms had put a 24x2 rollout mix ahead of depth-only, and the tiers were
   * built on that. A four-point single-axis sweep at 400 games each then reversed it: against three
   * `v3.1`, narrow-and-deep scored +1.86 [1.06, 2.69], 32x3 +1.10 [0.28, 1.94], 24x2 +0.89
   * [0.13, 1.68] and 48x4 +0.17 [−0.57, 1.00]. Monotone in width, the wrong way. The earlier
   * ordering was selection noise across overlapping intervals — the same mistake, twice, and the
   * reason single-axis sweeps at full power are the only protocol that has ever worked here.
   */
  'v3.1-pro': v31tier(
    'v3.1-pro',
    'Full-length rollouts, 12 placements over 1 corner, ~1380 iterations. ~390 ms/move.',
    { iterationScale: 4.59 },
  ),

  /**
   * The 400 ms depth/width sweep. Every entry costs ~390 ms; they differ only in how that budget is
   * split between rollout width and iteration count. CEM over the whole search space is not
   * affordable at this tier — resolving a one-point effect needs 180 seeds per candidate, so a
   * 12x12 population search would be ~104,000 games — but a four-point single-axis sweep at full
   * power is, and it answers the question the 200 ms bake-off raised without being able to settle.
   */
  'v3.1-pro-w12': v31tier(
    'v3.1-pro-w12',
    '400 ms: narrow rollouts (12 placements over 1 corner) at ~1380 iterations.',
    { playoutMoveCap: 12, playoutCorners: 1, iterationScale: 4.59 },
  ),
  'v3.1-pro-w32': v31tier(
    'v3.1-pro-w32',
    '400 ms: 32 placements over 3 corners at ~780 iterations.',
    { playoutMoveCap: 32, playoutCorners: 3, iterationScale: 2.8 },
  ),
  'v3.1-pro-w48': v31tier(
    'v3.1-pro-w48',
    '400 ms: 48 placements over 4 corners at ~560 iterations.',
    { playoutMoveCap: 48, playoutCorners: 4, iterationScale: 2.2 },
  ),

  /**
   * ~600 ms/move. Extends the compute ladder a further 1.66x on the axis the 400 ms sweep picked:
   * all of it into iterations (~2290), rollout policy untouched.
   *
   * `v3.1-pro-max-w6` narrows the rollout further still. The 400 ms sweep was monotone in width with
   * *narrower* better across 48 → 32 → 24 → 12, and 12 is where the tier stopped only because that
   * was the base's value, not because anything showed it to be the floor. If 6 continues the trend
   * the rollout policy is worth much less than the iterations it displaces; if it reverses, 12 is
   * near optimal and the ladder should stop widening the question.
   */
  'v3.1-pro-max': v31tier(
    'v3.1-pro-max',
    'v3.1-pro at max effort: the same config at ~2400 iterations. ~600-800 ms/move.',
    { iterationScale: 8.0 },
  ),
  'v3.1-pro-max-w6': v31tier(
    'v3.1-pro-max-w6',
    'v3.1-pro at max effort with rollouts narrowed to 6 placements over 1 corner — does narrowing keep helping?',
    { playoutMoveCap: 6, playoutCorners: 1, iterationScale: 8.2 },
  ),

  /**
   * Fills the gap in the compute ladder. `v3.1` (~700 iterations) is −1.03 [−1.90, −0.15] against
   * `v2-pro` and `v3.1-pro` (~1380) is +2.01 [1.00, 3.02] — a 3.04-point jump for 1.7x the compute,
   * where the step below it bought only 1.84 for 2.5x. Returns that *grow* with budget are the
   * wrong shape, so this measures the midpoint: if the curve is smooth it should land near +0.5.
   */
  'v3.1-pro-mid': v31tier(
    'v3.1-pro-mid',
    'Between v3.1 and v3.1-pro: ~1000 iterations, ~280 ms/move. A curve-shape check, not a tier.',
    { iterationScale: 3.33 },
  ),

  // Single-axis probes behind the 200 ms tier, kept because they are what attributes its gain.
  'v3.1-depth-only': v31tier(
    'v3.1-depth-only',
    'v3.1-lite rollouts (12x1) at ~700 iterations — depth without width, ~190 ms/move.',
    { iterationScale: 2.33 },
  ),
  'v3.1-wide-only': v31tier(
    'v3.1-wide-only',
    'Rollouts sampling 32 placements over 3 corners at ~400 iterations — width without depth, ~200 ms/move.',
    { playoutMoveCap: 32, playoutCorners: 3, iterationScale: 1.33 },
  ),
};

/** Frozen v3.2 research candidates. They stay out of the UI until a held-out match promotes one. */
const V32_CANDIDATES: Record<AlgoVersionId, AlgoConfig> = {
  'v3.2-sh': v31tier(
    'v3.2-sh',
    'v3.1 compute tier with deterministic Sequential Halving at the root.',
    { iterationScale: 2.33, rootPolicy: 'sequentialHalving' },
  ),
  'v3.2-sh-pro': v31tier(
    'v3.2-sh-pro',
    'v3.1-pro compute tier with deterministic Sequential Halving at the root.',
    { iterationScale: 4.59, rootPolicy: 'sequentialHalving' },
  ),
  'v3.2-sh-pro-max': v31tier(
    'v3.2-sh-pro-max',
    'v3.1-pro-max compute tier with deterministic Sequential Halving at the root.',
    { iterationScale: 8, rootPolicy: 'sequentialHalving' },
  ),

  'v3.2-implicit10': v31tier(
    'v3.2-implicit10',
    'v3.1 compute tier with a 10% implicit max^n heuristic blend.',
    { iterationScale: 1.5, implicitMaxnWeight: 0.1 },
  ),
  'v3.2-implicit10-pro': v31tier(
    'v3.2-implicit10-pro',
    'v3.1-pro compute tier with a 10% implicit max^n heuristic blend.',
    { iterationScale: 3.0, implicitMaxnWeight: 0.1 },
  ),
  'v3.2-implicit10-pro-max': v31tier(
    'v3.2-implicit10-pro-max',
    'v3.1-pro-max compute tier with a 10% implicit max^n heuristic blend.',
    { iterationScale: 5.2, implicitMaxnWeight: 0.1 },
  ),
  'v3.2-implicit20-pro': v31tier(
    'v3.2-implicit20-pro',
    'v3.1-pro compute tier with a 20% implicit max^n heuristic blend.',
    { iterationScale: 3.0, implicitMaxnWeight: 0.2 },
  ),

  'v3.2-notrans': v31tier(
    'v3.2-notrans',
    'v3.1 compute tier with transposition sharing disabled.',
    { iterationScale: 2.33, transpositions: false },
  ),
  'v3.2-notrans-pro': v31tier(
    'v3.2-notrans-pro',
    'v3.1-pro compute tier with transposition sharing disabled.',
    { iterationScale: 4.59, transpositions: false },
  ),
  'v3.2-notrans-pro-max': v31tier(
    'v3.2-notrans-pro-max',
    'v3.1-pro-max compute tier with transposition sharing disabled.',
    { iterationScale: 8, transpositions: false },
  ),

  'v3.2-cpuct08-pro': v31tier('v3.2-cpuct08-pro', 'v3.1-pro with cPuct 0.8.', {
    iterationScale: 4.59,
    cPuct: 0.8,
  }),
  'v3.2-cpuct12-pro': v31tier('v3.2-cpuct12-pro', 'v3.1-pro with cPuct 1.2.', {
    iterationScale: 4.59,
    cPuct: 1.2,
  }),
  'v3.2-cpuct20-pro': v31tier('v3.2-cpuct20-pro', 'v3.1-pro with cPuct 2.0.', {
    iterationScale: 4.59,
    cPuct: 2,
  }),
  'v3.2-prior3-pro': v31tier('v3.2-prior3-pro', 'v3.1-pro with prior temperature 3.', {
    iterationScale: 4.59,
    priorTemp: 3,
  }),
  'v3.2-prior9-pro': v31tier('v3.2-prior9-pro', 'v3.1-pro with prior temperature 9.', {
    iterationScale: 4.59,
    priorTemp: 9,
  }),
  'v3.2-widen04-pro': v31tier('v3.2-widen04-pro', 'v3.1-pro with widening growth 0.4.', {
    iterationScale: 4.59,
    wideningGrowth: 0.4,
  }),
  'v3.2-widen12-pro': v31tier('v3.2-widen12-pro', 'v3.1-pro with widening growth 1.2.', {
    iterationScale: 4.59,
    wideningGrowth: 1.2,
  }),
  'v3.2-history0-pro': v31tier('v3.2-history0-pro', 'v3.1-pro with history disabled.', {
    iterationScale: 4.59,
    historyWeight: 0,
  }),
  'v3.2-history03-pro': v31tier('v3.2-history03-pro', 'v3.1-pro with history weight 0.3.', {
    iterationScale: 4.59,
    historyWeight: 0.3,
  }),
  'v3.2-history09-pro': v31tier('v3.2-history09-pro', 'v3.1-pro with history weight 0.9.', {
    iterationScale: 4.59,
    historyWeight: 0.9,
  }),
  'v3.2-cpuct12-notrans-pro': v31tier(
    'v3.2-cpuct12-notrans-pro',
    'Held-out v3.2 combination: cPuct 1.2 with transposition sharing disabled.',
    { iterationScale: 4.59, cPuct: 1.2, transpositions: false },
  ),
  'v3.2-cpuct12-notrans-implicit10-pro': v31tier(
    'v3.2-cpuct12-notrans-implicit10-pro',
    'Three-way v3.2 combination: cPuct 1.2, no transpositions, and 10% implicit max^n.',
    { iterationScale: 3, cPuct: 1.2, transpositions: false, implicitMaxnWeight: 0.1 },
  ),

  'v3.2-policy-audit-pro': v31tier(
    'v3.2-policy-audit-pro',
    'Action-conditioned visit policy plus a paired terminal-rollout audit of the top four root moves.',
    {
      iterationScale: 4.2,
      netPath: 'ml/v32-policy-weights.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 4,
      rootAudit: 'paired',
      rootAuditTopK: 4,
      rootAuditRollouts: 64,
      rootAuditBlend: 0.35,
    },
  ),
  'v3.2-policy-pro': v31tier(
    'v3.2-policy-pro',
    'Action-conditioned learned visit policy as the root prior, with no other search change.',
    {
      iterationScale: 4.35,
      netPath: 'ml/v32-policy-weights.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 4,
    },
  ),
  'v3.2-policy25-pro': v31tier(
    'v3.2-policy25-pro',
    '25% action-conditioned learned root prior blended with 75% v3.1 hand prior.',
    {
      iterationScale: 4.35,
      netPath: 'ml/v32-policy-weights.json',
      netBlend: 0,
      netPrior: true,
      netPriorBlend: 0.25,
      netPriorTemp: 4,
    },
  ),
  'v3.2-policy50-pro': v31tier(
    'v3.2-policy50-pro',
    'Equal blend of action-conditioned learned and v3.1 hand root priors.',
    {
      iterationScale: 4.35,
      netPath: 'ml/v32-policy-weights.json',
      netBlend: 0,
      netPrior: true,
      netPriorBlend: 0.5,
      netPriorTemp: 4,
    },
  ),
  'v3.2-policy-end-pro': v31tier(
    'v3.2-policy-end-pro',
    'Action-conditioned learned root prior only in the endgame, where held-out ranking is strongest.',
    {
      iterationScale: 4.5,
      netPath: 'ml/v32-policy-weights.json',
      netBlend: 0,
      netPrior: true,
      netPriorPhase: 'endgame',
      netPriorTemp: 4,
    },
  ),
  'v4.1-policy-v32-pro': v31tier(
    'v4.1-policy-v32-pro',
    'v3.2-pro with the larger policy-only v4.1 visit model as its root prior.',
    {
      iterationScale: 4.35,
      playoutEps: 0.6,
      netPath: 'ml/v41-shift-policy-alpha0.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 4,
    },
  ),
  'v4.3-policy-v32-pro': v31tier(
    'v4.3-policy-v32-pro',
    'v3.2-pro with the 256-feature local-interaction policy as its root prior.',
    {
      iterationScale: 4.35,
      playoutEps: 0.6,
      netPath: 'ml/v43-feature-256.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 4,
    },
  ),
  'v4.5-spatial-single-v32-pro': v31tier(
    'v4.5-spatial-single-v32-pro',
    'v3.2-pro with one canonical shared-board/action-mask policy member as its root prior.',
    {
      iterationScale: 4.46,
      playoutEps: 0.6,
      pooledNetPath: 'ml/v45-pooled-seed4501.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 1,
    },
  ),
  'v4.5-spatial-ensemble-v32-pro': v31tier(
    'v4.5-spatial-ensemble-v32-pro',
    'v3.2-pro with a three-seed shared-board/action-mask logit ensemble as its root prior.',
    {
      iterationScale: 4.19,
      playoutEps: 0.6,
      pooledNetPath: 'ml/v45-pooled-ensemble.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 1,
    },
  ),
  'v4.5-spatial-pv128-v32-pro': v31tier(
    'v4.5-spatial-pv128-v32-pro',
    'Three-seed spatial ensemble with 128 calibrated policy pseudo-visits in root readout.',
    {
      iterationScale: 4.19,
      playoutEps: 0.6,
      pooledNetPath: 'ml/v45-pooled-ensemble.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 1,
      rootPriorPseudoVisits: 128,
    },
  ),
  'v4.5-spatial-pv256-v32-pro': v31tier(
    'v4.5-spatial-pv256-v32-pro',
    'Three-seed spatial ensemble with 256 calibrated policy pseudo-visits in root readout.',
    {
      iterationScale: 4.19,
      playoutEps: 0.6,
      pooledNetPath: 'ml/v45-pooled-ensemble.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 1,
      rootPriorPseudoVisits: 256,
    },
  ),
  'v4.5-spatial-pv512-v32-pro': v31tier(
    'v4.5-spatial-pv512-v32-pro',
    'Three-seed spatial ensemble with 512 calibrated policy pseudo-visits in root readout.',
    {
      iterationScale: 4.19,
      playoutEps: 0.6,
      pooledNetPath: 'ml/v45-pooled-ensemble.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 1,
      rootPriorPseudoVisits: 512,
    },
  ),
  'v4.5-spatial-earlymid-v32-pro': v31tier(
    'v4.5-spatial-earlymid-v32-pro',
    'Three-seed spatial ensemble used only in opening and midgame, where it generalizes.',
    {
      iterationScale: 4.19,
      playoutEps: 0.6,
      pooledNetPath: 'ml/v45-pooled-ensemble.json',
      netBlend: 0,
      netPrior: true,
      netPriorPhase: 'openingMidgame',
      netPriorTemp: 1,
    },
  ),
  'v4.5-spatial-earlymid-pv128-v32-pro': v31tier(
    'v4.5-spatial-earlymid-pv128-v32-pro',
    'Opening/midgame spatial ensemble plus 128 learned-policy pseudo-visits at root readout.',
    {
      iterationScale: 4.19,
      playoutEps: 0.6,
      pooledNetPath: 'ml/v45-pooled-ensemble.json',
      netBlend: 0,
      netPrior: true,
      netPriorPhase: 'openingMidgame',
      netPriorTemp: 1,
      rootPriorPseudoVisits: 128,
    },
  ),
  /**
   * E1 — the prior-ablation ladder. Diagnostics, never shipped.
   *
   * Four generations of learned root priors have measured null and nobody has measured what the
   * root-prior channel is worth at all. `softmaxPriors` divides scores by `priorTemp`, so raising it
   * flattens the PUCT prior toward uniform at exactly zero compute cost. The spread between `v3.2-pro`
   * and `v3.2-pro-uniform` is the total value of the prior *weights* — an upper bound on what any
   * reranking model, learned or not, can earn there.
   *
   * Note what this does *not* flatten: progressive widening still opens children in shortlist order,
   * which the same heuristic set. That is a separate channel and needs its own arm.
   */
  /**
   * Calibration anchor, not a release. `v3.2-pro` with terminal rollouts truncated at 12 plies.
   *
   * The truncation ladder supplies the widest-range points in the metric-calibration set (+1.29 to
   * +5.13 depending on depth), but those numbers were measured on the v4-era design engine under a
   * different configuration and are the oldest measurements in the repository. Anchoring an offline
   * metric on a stale number would silently miscalibrate everything built on it, so the largest rung
   * is re-measured on the engine that actually ships.
   */
  'v3.2-pro-cutoff12': v31tier(
    'v3.2-pro-cutoff12',
    'Calibration anchor: v3.2-pro with 12-ply truncated rollouts instead of terminal ones.',
    { iterationScale: 4.59, playoutEps: 0.6, playoutCutoff: 12 },
  ),
  /**
   * The incumbent control for the v4.2 compute ladder.
   *
   * `v4.2-pro-s56` is `v4.1-pro` given 21.8% more iterations. To know whether that gain is *better*
   * than what compute alone buys, the same increment has to be given to the incumbent and measured
   * the same way. The project's 1.27-points-per-doubling figure comes from a pro→pro-max comparison
   * at a different operating point and should not be extrapolated to this one.
   */
  'v3.1-pro-s56': v31tier(
    'v3.1-pro-s56',
    'Compute control: v3.1-pro given the same 21.8% iteration increment as the v4.2 ladder.',
    { iterationScale: 5.59 },
  ),
  /** Held-out leaf-channel arm for the v4.2 preregistered metric confirmation. */
  'v3.2-pro-cutoff24': v31tier(
    'v3.2-pro-cutoff24',
    'Calibration arm: v3.2-pro with 24-ply truncated rollouts.',
    { iterationScale: 4.59, playoutEps: 0.6, playoutCutoff: 24 },
  ),
  /** Calibration arm: the ten-arm tree screen's significantly-harmful prior temperature. */
  'v3.2-pro-priortemp3': v31tier(
    'v3.2-pro-priortemp3',
    'Calibration arm: v3.2-pro with the sharper priorTemp 3 that measured -2.93.',
    { iterationScale: 4.59, playoutEps: 0.6, priorTemp: 3 },
  ),
  /** Calibration arm: v3.1's rollout mixture inside v3.2's tier, i.e. the ε promotion reversed. */
  'v3.2-pro-eps15': v31tier(
    'v3.2-pro-eps15',
    'Calibration arm: v3.2-pro with the pre-promotion 15% rollout exploration.',
    { iterationScale: 4.59, playoutEps: 0.15 },
  ),
  'v3.2-pro-flat24': v31tier(
    'v3.2-pro-flat24',
    'E1 diagnostic: v3.2-pro with the root prior flattened (priorTemp 24).',
    { iterationScale: 4.59, playoutEps: 0.6, priorTemp: 24 },
  ),
  'v3.2-pro-uniform': v31tier(
    'v3.2-pro-uniform',
    'E1 diagnostic: v3.2-pro with an effectively uniform PUCT prior (priorTemp 1e6).',
    { iterationScale: 4.59, playoutEps: 0.6, priorTemp: 1e6 },
  ),
  'v3.2-audit-race-pro': v31tier(
    'v3.2-audit-race-pro',
    'Paired terminal root audit with variance-adaptive incumbent/challenger racing.',
    {
      iterationScale: 4.35,
      rootAudit: 'variance',
      rootAuditTopK: 4,
      rootAuditRollouts: 64,
      rootAuditBlend: 0.35,
    },
  ),
  'v3.2-policy-groups-pro': v31tier(
    'v3.2-policy-groups-pro',
    'Action-conditioned visit policy with two-level PUCT over 5×5 spatial destination groups.',
    {
      iterationScale: 4.15,
      netPath: 'ml/v32-policy-weights.json',
      netBlend: 0,
      netPrior: true,
      netPriorTemp: 4,
      rootGrouping: 'spatial',
    },
  ),
  'v3.2-reuse-pro': v31tier(
    'v3.2-reuse-pro',
    'v3.1-pro with per-seat persistent subtree reuse across the three intervening opponent moves.',
    { iterationScale: 4.59, treeReuse: true },
  ),
  'v3.2-ensemble2-pro': v31tier(
    'v3.2-ensemble2-pro',
    'Two independent v3.1-pro trees pooling root visits at the same total iteration budget.',
    { iterationScale: 4.0, rootEnsembleTrees: 2 },
  ),
  'v3.2-piecegroups-pro': v31tier(
    'v3.2-piecegroups-pro',
    'Two-level root PUCT over piece identity, then placement, at the v3.1-pro compute tier.',
    { iterationScale: 4.4, rootGrouping: 'piece' },
  ),
  'v3.2-varucb-pro': v31tier(
    'v3.2-varucb-pro',
    'v3.1-pro with UCB1-Tuned variance scaling on the PUCT exploration term.',
    { iterationScale: 4.59, varianceTuned: true },
  ),
  'v3.2-varucb': v31tier(
    'v3.2-varucb',
    'v3.1 compute tier with UCB1-Tuned variance scaling on the PUCT exploration term.',
    { iterationScale: 2.33, varianceTuned: true },
  ),
  'v3.2-varucb-pro-max': v31tier(
    'v3.2-varucb-pro-max',
    'v3.1-pro-max compute tier with UCB1-Tuned variance scaling on PUCT exploration.',
    { iterationScale: 8, varianceTuned: true },
  ),
  'v3.2-varroot-pro': v31tier(
    'v3.2-varroot-pro',
    'UCB1-Tuned variance scaling at the root only; interior PUCT remains v3.1-pro.',
    { iterationScale: 4.59, varianceTuned: true, varianceTunedRootOnly: true },
  ),
  'v3.2-var-eps30-pro': v31tier(
    'v3.2-var-eps30-pro',
    'All-node UCB1-Tuned exploration combined with the 30% random terminal-playout policy.',
    { iterationScale: 4.59, varianceTuned: true, playoutEps: 0.3 },
  ),
  'v3.2-piecediverse-pro': v31tier(
    'v3.2-piecediverse-pro',
    'Progressive widening opens the best placement of every piece before duplicate-piece moves.',
    { iterationScale: 4.59, rootPieceDiversity: true },
  ),
  'v3.2-eps05-pro': v31tier(
    'v3.2-eps05-pro',
    'v3.1-pro with a more deterministic 5% random playout policy.',
    { iterationScale: 4.59, playoutEps: 0.05 },
  ),
  'v3.2-eps30-pro': v31tier(
    'v3.2-eps30-pro',
    'v3.1-pro with a more exploratory 30% random playout policy.',
    { iterationScale: 4.59, playoutEps: 0.3 },
  ),
  'v3.2-eps45-pro': v31tier(
    'v3.2-eps45-pro',
    'v3.1-pro with a 45% uniform-random branch in terminal playouts.',
    { iterationScale: 4.59, playoutEps: 0.45 },
  ),
  'v3.2-eps60-pro': v31tier(
    'v3.2-eps60-pro',
    'v3.1-pro with a 60% uniform-random branch in terminal playouts.',
    { iterationScale: 4.59, playoutEps: 0.6 },
  ),
  'v3.2-eps60': v31tier(
    'v3.2-eps60',
    'v3.1 compute tier with a 60% uniform-random branch in terminal playouts.',
    { iterationScale: 2.33, playoutEps: 0.6 },
  ),
  'v3.2-eps60-pro-max': v31tier(
    'v3.2-eps60-pro-max',
    'v3.1-pro-max compute tier with a 60% uniform-random branch in terminal playouts.',
    { iterationScale: 8, playoutEps: 0.6 },
  ),
  'v3.2-eps100-pro': v31tier(
    'v3.2-eps100-pro',
    'v3.1-pro with uniformly random choices inside terminal playouts.',
    { iterationScale: 4.59, playoutEps: 1 },
  ),
  'v3.2-eps60-mid-pro': v31tier(
    'v3.2-eps60-mid-pro',
    '60% random terminal playouts only for midgame searches; 15% in opening and endgame.',
    { iterationScale: 4.59, playoutEpsByPhase: { opening: 0.15, midgame: 0.6, endgame: 0.15 } },
  ),
  'v3.2-eps60-early-pro': v31tier(
    'v3.2-eps60-early-pro',
    '60% random terminal playouts in opening and midgame searches; 15% in endgame.',
    { iterationScale: 4.59, playoutEpsByPhase: { opening: 0.6, midgame: 0.6, endgame: 0.15 } },
  ),
  'v3.2-eps60-late-pro': v31tier(
    'v3.2-eps60-late-pro',
    '15% random terminal playouts in opening; 60% in midgame and endgame searches.',
    { iterationScale: 4.59, playoutEpsByPhase: { opening: 0.15, midgame: 0.6, endgame: 0.6 } },
  ),
  'v3.2-eps30': v31tier(
    'v3.2-eps30',
    'v3.1 compute tier with a 30% random terminal-playout policy.',
    { iterationScale: 2.33, playoutEps: 0.3 },
  ),
  'v3.2-eps30-pro-max': v31tier(
    'v3.2-eps30-pro-max',
    'v3.1-pro-max compute tier with a 30% random terminal-playout policy.',
    { iterationScale: 8, playoutEps: 0.3 },
  ),
  'v3.2-eps30-mid-pro': v31tier(
    'v3.2-eps30-mid-pro',
    '30% random terminal playouts only for midgame searches; 15% in opening and endgame.',
    { iterationScale: 4.59, playoutEpsByPhase: { opening: 0.15, midgame: 0.3, endgame: 0.15 } },
  ),
  'v3.2-eps30-early-pro': v31tier(
    'v3.2-eps30-early-pro',
    '30% random terminal playouts in opening and midgame searches; 15% in endgame.',
    { iterationScale: 4.59, playoutEpsByPhase: { opening: 0.3, midgame: 0.3, endgame: 0.15 } },
  ),
  'v3.2-eps30-late-pro': v31tier(
    'v3.2-eps30-late-pro',
    '15% random terminal playouts in opening; 30% in midgame and endgame searches.',
    { iterationScale: 4.59, playoutEpsByPhase: { opening: 0.15, midgame: 0.3, endgame: 0.3 } },
  ),
  'v3.2-fpu05-pro': v31tier(
    'v3.2-fpu05-pro',
    'v3.1-pro with a 0.05 first-play-urgency reduction for unvisited children.',
    { iterationScale: 4.59, fpuReduction: 0.05 },
  ),
  'v3.2-fpu10-pro': v31tier(
    'v3.2-fpu10-pro',
    'v3.1-pro with a 0.10 first-play-urgency reduction for unvisited children.',
    { iterationScale: 4.59, fpuReduction: 0.1 },
  ),
  'v3.2-mast05-pro': v31tier(
    'v3.2-mast05-pro',
    'Piece-level Move-Average Sampling with weight 0.5 inside terminal playouts.',
    { iterationScale: 4.59, playoutMastWeight: 0.5 },
  ),
  'v3.2-mast10-pro': v31tier(
    'v3.2-mast10-pro',
    'Piece-level Move-Average Sampling with weight 1.0 inside terminal playouts.',
    { iterationScale: 4.59, playoutMastWeight: 1 },
  ),
  'v3.2-mast-placement-pro': v31tier(
    'v3.2-mast-placement-pro',
    'Exact-placement Move-Average Sampling rather than sharing outcomes by piece identity.',
    { iterationScale: 4.59, playoutMastWeight: 0.5, playoutMastGranularity: 'placement' },
  ),
  'v3.2-mast-game-pro': v31tier(
    'v3.2-mast-game-pro',
    'Piece-level MAST retained across moves within one game and reset between tournament games.',
    { iterationScale: 4.59, playoutMastWeight: 0.5, playoutMastLifetime: 'game' },
  ),
  'v3.2-var-mast05-pro': v31tier(
    'v3.2-var-mast05-pro',
    'Piece-level MAST playout learning combined with all-node variance-tuned PUCT.',
    { iterationScale: 4.59, playoutMastWeight: 0.5, varianceTuned: true },
  ),
  'v3.2-rave10-pro': v31tier(
    'v3.2-rave10-pro',
    'Piece-level RAVE blended into child values with ten equivalent direct visits.',
    { iterationScale: 4.3, raveEquivalence: 10 },
  ),
  'v3.2-rave50-pro': v31tier(
    'v3.2-rave50-pro',
    'Piece-level RAVE blended into child values with fifty equivalent direct visits.',
    { iterationScale: 4.3, raveEquivalence: 50 },
  ),
  'v3.2-feas2-pro': v31tier(
    'v3.2-feas2-pro',
    'v3.1-pro with a two-point standardised prior bias for remaining-piece feasibility.',
    { iterationScale: 4.0, rootPieceFeasibilityWeight: 2 },
  ),
  'v3.2-feas4-pro': v31tier(
    'v3.2-feas4-pro',
    'v3.1-pro with a four-point standardised prior bias for remaining-piece feasibility.',
    { iterationScale: 4.0, rootPieceFeasibilityWeight: 4 },
  ),
};

/* --- v3.5 ------------------------------------------------------------------------------------
 *
 * Two independent lines, deliberately not bundled: a committee at the root (a strength claim) and a
 * global aggression dial (a behaviour claim). They are measured against different statistics and
 * must never be promoted together — `v13` is the standing reminder of what bundling costs.
 */

/** `v3.1-pro-max` plus a top-level bitboard override. The dial lives outside `search`. */
function v35tier(
  id: AlgoVersionId,
  summary: string,
  overrides: DeepPartial<BitboardParams>,
): AlgoConfig {
  const base = V31_TIERS['v3.1-pro-max'];
  return {
    ...base,
    id,
    summary,
    bitboard: { ...(base.bitboard ?? {}), ...overrides },
  } as AlgoConfig;
}

/**
 * The aggression sweep, at the pro-max tier.
 *
 * `aggressionScale` multiplies every seat's fitted `aggression`, and so every opponent-directed term
 * the engine has. `a10` is the shipping value and must play identically to `v3.1-pro-max`; it exists
 * so the sweep has an in-family control rather than one that differs by config identity.
 *
 * `a00` does double duty: it is the product's EFFICIENT pole *and* the λ = 0 ablation report §5
 * records as never run ("The λ machinery has never been ablated. Set λ = 0 and measure.").
 *
 * Expect this sweep to move behaviour more than strength, and read it on the frontier rather than on
 * the promote statistic: that statistic *is* `score − mean(others)`, so scale 1 is aligned with it by
 * construction and every other point is handicapped on it by definition.
 */
const V35_AGGRESSION: Record<AlgoVersionId, AlgoConfig> = {
  'v3.5-a00': v35tier(
    'v3.5-a00',
    'v3.1-pro-max with λ scaled to 0 — a purely self-directed engine. The EFFICIENT pole, and §5’s never-run λ ablation.',
    { aggressionScale: 0 },
  ),
  'v3.5-a05': v35tier('v3.5-a05', 'v3.1-pro-max with λ scaled to 0.5.', { aggressionScale: 0.5 }),
  'v3.5-a10': v35tier(
    'v3.5-a10',
    'v3.1-pro-max with λ scaled to 1 — the shipping value, as the sweep’s in-family control.',
    { aggressionScale: 1 },
  ),
  'v3.5-a16': v35tier('v3.5-a16', 'v3.1-pro-max with λ scaled to 1.6.', { aggressionScale: 1.6 }),
  'v3.5-a25': v35tier(
    'v3.5-a25',
    'v3.1-pro-max with λ scaled to 2.5 — the GREEDY pole, ~3x the fitted opponent pressure.',
    { aggressionScale: 2.5 },
  ),

  /**
   * The same sweep at the one-ply policy, where the dial is *fully* load-bearing.
   *
   * With `playoutCutoff: 84` almost every leaf is terminal and its value is σ(score margin), which is
   * margin-maximising whatever λ is set to — so at pro-max the dial shapes what the search explores,
   * not what it optimises. `rankMovesGreedyV12` ranks by ΔE, which carries the whole λ block, so
   * these three bracket how much of the dial the tree is absorbing.
   */
  'v3.5-a00-eval': {
    ...V12_FAMILY['v3.1-lite'],
    id: 'v3.5-a00-eval',
    summary: 'Tuned evaluation with λ scaled to 0, for the eval-level arm of the aggression sweep.',
    bitboard: { ...V3_TUNED, aggressionScale: 0 },
  } as AlgoConfig,
  'v3.5-a25-eval': {
    ...V12_FAMILY['v3.1-lite'],
    id: 'v3.5-a25-eval',
    summary: 'Tuned evaluation with λ scaled to 2.5, for the eval-level arm of the aggression sweep.',
    bitboard: { ...V3_TUNED, aggressionScale: 2.5 },
  } as AlgoConfig,
};

/** `v3.1-pro-max` searching, with a committee arbitrating the root children it left tied. */
function v35committee(
  id: AlgoVersionId,
  summary: string,
  overrides: Partial<CommitteeParams>,
): AlgoConfig {
  const base = V31_TIERS['v3.1-pro-max'];
  return {
    ...base,
    id,
    summary,
    engine: 'committee',
    committee: { ...DEFAULT_COMMITTEE, primary: 'v3.1-pro-max', ...overrides },
  } as AlgoConfig;
}

/**
 * The arbiters, and why these three.
 *
 * `v2-pro` carries the only other *fitted* evaluation in the repo, and the evidence that it is worth
 * consulting is specific: `E_i` is the better global predictor of the final margin (Spearman 0.494
 * against 0.444) while v2's evaluation retains +0.065 incremental signal over it, concentrated in the
 * opening (+0.121) and endgame (+0.178). Complementary errors, neither dominant.
 *
 * `v3.1-lite` is the primary's own evaluation, included so the committee can be measured with and
 * without a *diverse* member — if it wins with only this one, the gain is the arbitration mechanism
 * rather than the second opinion, which is a different finding.
 *
 * `v4` is the learned network. It is a clean null as a root prior (−0.58 [−1.35, 0.23] over 400
 * games) and monotonically harmful as a leaf value, so it goes in at weight 0 by default: present so
 * the axis exists, off until something measures it on.
 */
const ARBITERS: CommitteeMember[] = [
  { version: 'v2-pro', weight: 1 },
  { version: 'v3.1-lite', weight: 1 },
  { version: 'v4', weight: 0 },
];

const V35_COMMITTEE: Record<AlgoVersionId, AlgoConfig> = {
  /**
   * The control, and the strongest test that the layer ships inert: `band: 0` forms no contested set,
   * calls no arbiter, and returns the primary's result untouched. Against `v3.1-pro-max` this must
   * print exactly 0.00 — a mirror-match signature, which here is the correct result rather than the
   * warning it usually is.
   */
  'v3.5-balanced': v35committee(
    'v3.5-balanced',
    'v3.1-pro-max with the committee layer present and inert (band 0). The identity control.',
    { arbiters: ARBITERS, band: 0 },
  ),

  // The band sweep. A band of b calls the arbiters whenever a child is within b of the leader's
  // share of root visits, capped at `maxArbitrated` children.
  'v3.5-arb02': v35committee('v3.5-arb02', 'Committee arbitration at a 2% visit-share band.', {
    arbiters: ARBITERS,
    band: 0.02,
  }),
  'v3.5-arb05': v35committee('v3.5-arb05', 'Committee arbitration at a 5% visit-share band.', {
    arbiters: ARBITERS,
    band: 0.05,
  }),
  'v3.5-arb10': v35committee('v3.5-arb10', 'Committee arbitration at a 10% visit-share band.', {
    arbiters: ARBITERS,
    band: 0.1,
  }),

  /**
   * Attribution probes for whichever band wins, so a gain can be told apart from its explanation.
   *
   * `-self` keeps only the primary's own evaluation as arbiter: if it scores the same as the full
   * committee, the second opinion is doing nothing and the effect is the arbitration rule.
   * `-geom` swaps Borda for the geometric-mean rule, which punishes a single last-place opinion far
   * harder — the literal "only play what they all agree on".
   */
  'v3.5-arb05-self': v35committee(
    'v3.5-arb05-self',
    'Committee at a 5% band with only the primary’s own evaluation arbitrating — the no-diversity null.',
    { arbiters: [{ version: 'v3.1-lite', weight: 1 }], band: 0.05 },
  ),
  'v3.5-arb05-geom': v35committee(
    'v3.5-arb05-geom',
    'Committee at a 5% band pooled by weighted geometric mean instead of Borda.',
    { arbiters: ARBITERS, band: 0.05, combine: 'geomMean' },
  ),

  /**
   * The eval-level arm. At `--policy greedy` the primary is itself a one-ply evaluator, so the whole
   * committee reduces to a weighted rank combination with no tree and no budget question — testable
   * at 400 seeds in minutes, before any search-level run is paid for.
   */
  'v3.5-arb-eval': {
    ...V12_FAMILY['v3.1-lite'],
    id: 'v3.5-arb-eval',
    summary: 'The committee at the one-ply policy: v3.1-lite ranked, then re-ranked by v2-pro and the primary’s own evaluation.',
    engine: 'committee',
    committee: {
      ...DEFAULT_COMMITTEE,
      primary: 'v3.1-lite',
      arbiters: ARBITERS,
      band: 0.05,
      maxArbitrated: 4,
    },
  } as AlgoConfig,
};

/**
 * v3.6 — where the iteration budget goes across a seat's 21 moves.
 *
 * `iterationScale` is a scalar, so every measurement in this repo was taken with an engine that
 * spends identical compute on own-move 1 and own-move 21. `timeManager.ts` has carried a
 * hand-authored curve for this since the report was implemented — plies 6–14 get the clock — but it
 * only reaches the wall-clock path and every tournament here passes `--iterations`, so the guess has
 * never affected a measured game.
 *
 * The allocation criterion is a slope, not a regret. If a seat's contribution is
 * `a_k + c_k*log(n_k)` with `sum(n_k)` fixed, the optimum is `n_k` proportional to `c_k` — the local
 * points per doubling. A move with high oracle regret but a flat compute ladder cannot repay
 * iterations, and if every `c_k` is equal then reallocation is worth exactly zero. That is what the
 * boost probes below are for; they are deliberately compute-*positive* so each one reads as one
 * extra doubling bought over a known slice of the game, and the fitted candidate that follows is
 * normalised back to budget-neutral.
 */
function v36shape(id: AlgoVersionId, summary: string, shape: number[], base = 'v3.2-pro'): AlgoConfig {
  const source = V31_TIERS[base];
  return {
    ...source,
    id,
    summary,
    bitboard: {
      ...(source.bitboard ?? {}),
      search: { ...((source.bitboard ?? {}).search ?? {}), iterationShape: shape },
    },
  } as AlgoConfig;
}

/** 2x over own moves `from`..`to` inclusive (1-based, as a player counts them), 1x elsewhere. */
function boostShape(from: number, to: number): number[] {
  return Array.from({ length: 21 }, (_, k) => (k + 1 >= from && k + 1 <= to ? 2 : 1));
}

const LEGACY_V36_SHAPE = [
  0.3307, 0.441, 0.588, 0.735, 0.8452, 1.6301, 1.7509, 1.8112, 1.8112, 1.7509, 1.6301, 1.5094,
  1.3886, 1.2679, 1.1471, 0.5355, 0.4725, 0.4095, 0.3465, 0.315, 0.2835,
];

const V36_SHAPES: Record<AlgoVersionId, AlgoConfig> = {
  /**
   * The identity gate. A flat shape must reproduce `v3.2-pro` exactly and print `0.00 [0.00, 0.00]`.
   * A non-zero interval here means the shape is reaching the budget when it should not; a
   * zero-*width* interval on a live arm is the opposite failure, and `v12-fracties` is the standing
   * reminder that a change which never reached the code path reads as an eleventh null.
   */
  'v3.6-flat': v36shape(
    'v3.6-flat',
    'v3.2-pro with an explicitly flat iteration shape. Must measure exactly 0.00.',
    Array.from({ length: 21 }, () => 1),
  ),

  /**
   * The four exchange-rate probes. Each buys one doubling over five or six own moves and nothing
   * else, so its advantage divided by the fraction of the game it boosted is the local points per
   * doubling. Run these at the pro tier: at 300 iterations the ladder is nearly flat (cutting the
   * budget 55% cost +5.00 -> +4.86), while pro -> pro-max is worth +1.02 [0.24, 1.84], so a probe
   * at the standard tier would measure the flat part of the curve and report a null about the wrong
   * thing.
   */
  'v3.6-boost-1-5': v36shape(
    'v3.6-boost-1-5',
    'v3.2-pro at double iterations over own moves 1-5 (the opening).',
    boostShape(1, 5),
  ),
  'v3.6-boost-6-10': v36shape(
    'v3.6-boost-6-10',
    'v3.2-pro at double iterations over own moves 6-10.',
    boostShape(6, 10),
  ),
  'v3.6-boost-11-15': v36shape(
    'v3.6-boost-11-15',
    'v3.2-pro at double iterations over own moves 11-15.',
    boostShape(11, 15),
  ),
  'v3.6-boost-16-21': v36shape(
    'v3.6-boost-16-21',
    'v3.2-pro at double iterations over own moves 16-21 (the endgame).',
    boostShape(16, 21),
  ),

  /**
   * The report's own hypothesis, made testable and made budget-neutral.
   *
   * This is `MOVE_SHAPE * PHASE_SHAPE` from `timeManager.ts` — "the opening is book-driven and
   * cheap; plies roughly 6 to 14 carry the largest branching factor and the largest score swings"
   * — rescaled to sum to 21 so it spends exactly `v3.2-pro`'s per-game budget. It is included
   * because it is a pre-registered guess that predates this work, not because the audit supports
   * it: E2 measured opening oracle-agreement at 8% against 67% midgame and 78% endgame, which
   * points the other way.
   */
  'v3.6-legacy-shape-pro': v36shape(
    'v3.6-legacy-shape-pro',
    "v3.2-pro spending the time manager's hand-authored move curve, normalised to a flat per-game budget.",
    LEGACY_V36_SHAPE,
  ),
  'v3.6-legacy-shape-pro-max': v36shape(
    'v3.6-legacy-shape-pro-max',
    "v3.2-pro-max spending the time manager's hand-authored move curve, normalised to a flat per-game budget.",
    LEGACY_V36_SHAPE,
    'v3.2-pro-max',
  ),
  'v3.5-lite': v36shape(
    'v3.5-lite',
    'v3.5 Lite candidate: v3.2-lite with the budget-neutral 21-own-move iteration curve.',
    LEGACY_V36_SHAPE,
    'v3.2-lite',
  ),
  'v3.5': v36shape(
    'v3.5',
    'v3.5 candidate: v3.2 with the budget-neutral 21-own-move iteration curve.',
    LEGACY_V36_SHAPE,
    'v3.2',
  ),
  'v3.5-pro': v36shape(
    'v3.5-pro',
    'Promoted v3.5 Pro: v3.2-pro with the budget-neutral 21-own-move iteration curve.',
    LEGACY_V36_SHAPE,
  ),
  'v3.5-pro-max': v36shape(
    'v3.5-pro-max',
    'v3.5 Pro Max: the curve at v3.2-pro-max\u2019s own budget. Not promoted \u2014 two disjoint 100-seed blocks pooled to +0.41 [-0.15, 0.98].',
    LEGACY_V36_SHAPE,
    'v3.2-pro-max',
  ),

  /**
   * PROMOTED 2026-08-24: **+0.84 [0.31, 1.37]** against `v3.2-pro-max`, 200 seeds / 800 games on a
   * single preregistered block (base 37800000, MDE 0.95).
   *
   * `MEASURED` Cost against `v3.2-pro-max` on identical seeds: **+9.5% executed iterations** but
   * **+13.9% wall clock** — the extra iterations run deeper in the tree, where nodes cost more.
   * Buying +0.84 on the compute ladder alone would cost about +57%, so this is roughly 4x cheaper
   * than iterations. Note that +13.9% is **outside** the 10% cap when the cap is read on the clock;
   * this tier is promoted on the efficiency ratio, not on fitting under a ceiling.
   *
   * `STRUCTURAL` **Why this tier needed a budget the others did not.** At `iterationScale` 8 the Pro
   * Max tier collected only +2.6% of the front-loading bonus the lower tiers take (+7.9% to +8.9%),
   * because a larger share of what the curve hands it is decision-locked — `decided()` stops a search
   * once the runner-up cannot catch up on visits, and Pro Max reaches that point sooner relative to
   * its allocation. Scale 8.33 restores compute the other tiers were already getting.
   *
   * **On the generation number.** This differs from `v3.5-pro-max` by one scalar —
   * `iterationScale` 8.0 -> 8.33 — and `config.test.ts` enforces that. By the convention stated
   * earlier in `docs/ALGORITHMS.md` ("Effort is a level, not a model") that is an effort level
   * rather than a design change, and a strict reading would call it a v3.5 tier. It takes a new
   * generation number instead for a concrete reason: the alternative was redefining `v3.5-pro-max`,
   * which would detach the two 100-seed blocks that measured the scale-8 config from the id that
   * produced them. A fresh id costs nothing and keeps every existing log valid. The number denotes
   * a new budget, not a new architecture.
   */
  'v3.6-pro-max': {
    ...v36shape(
      'v3.6-pro-max',
      'Promoted v3.6 Pro Max: the v3.5 iteration curve at iterationScale 8.33, spending to the 10% executed-compute cap.',
      LEGACY_V36_SHAPE,
      'v3.2-pro-max',
    ),
    bitboard: {
      ...v36shape('x', '', LEGACY_V36_SHAPE, 'v3.2-pro-max').bitboard!,
      search: {
        ...v36shape('x', '', LEGACY_V36_SHAPE, 'v3.2-pro-max').bitboard!.search,
        iterationScale: 8.33,
      },
    },
  } as AlgoConfig,
};

/**
 * v3.7 candidate — the pooled policy net as a *direct selector* on a seat's first three own moves.
 *
 * `netPrior: false` is load-bearing. This is deliberately not the prior channel E1 capped at 0.12
 * points; the net answers the move outright and no search runs. Everywhere past own move 3 the
 * engine is exactly the promoted v3.5/v3.6 config.
 *
 * `MEASURED` The asymmetry this exploits, on 416 oracle-labelled opening positions (majority of three
 * `v3.6-pro-max` searches at 9,600 iterations), top-1 agreement:
 *
 *   own moves 1-3   net 45.1%   search 10.5%   (+34.6 pp [+26.0, +43.3])
 *   own moves 4-5   net 30.7%   search 30.3%   (+0.4 pp [-6.6, +7.8])
 *
 * `ESTIMATE` Worth about +0.56 points, from a lower-bounded moves-1-3 ceiling of +1.45. Below a
 * 200-seed MDE of 0.95, so it needs a larger block — but it also *removes* compute, which makes it a
 * Pareto candidate rather than a strength-for-compute trade.
 */
function v37select(id: AlgoVersionId, summary: string, base: AlgoVersionId, maxOwnMove: number): AlgoConfig {
  const source = V36_SHAPES[base] ?? V31_TIERS[base];
  return {
    ...source,
    id,
    summary,
    bitboard: {
      ...(source.bitboard ?? {}),
      search: {
        ...((source.bitboard ?? {}).search ?? {}),
        pooledNetPath: 'ml/v45-pooled-ensemble.json',
        netPrior: false,
        openingSelectMaxOwnMove: maxOwnMove,
      },
    },
  } as AlgoConfig;
}

const V37_OPENING: Record<AlgoVersionId, AlgoConfig> = {
  /**
   * Diagnostics, not candidates: `v3.5-pro` forced to play its own SECOND-ranked move on the
   * earliest own moves. If the cost is near zero the opening is flat and the channel is closed.
   */
  'v3.7-diag-2nd3-pro': {
    ...V36_SHAPES['v3.5-pro'],
    id: 'v3.7-diag-2nd3-pro',
    summary: 'DIAGNOSTIC: v3.5-pro playing its second-choice move on own moves 1-3.',
    bitboard: {
      ...V36_SHAPES['v3.5-pro'].bitboard!,
      search: {
        ...V36_SHAPES['v3.5-pro'].bitboard!.search,
        openingRankOffset: 1,
        openingRankOffsetMaxOwnMove: 3,
      },
    },
  } as AlgoConfig,
  /**
   * v3.7 Pareto candidate — no tree on a seat's first three own moves.
   *
   * `MEASURED` Demoting the search's own top choice to second on own moves 1-3 measured
   * **+0.68 [−0.13, 1.53]**: its top two are interchangeable there, so the tree is not buying a
   * decision. The same demotion on own moves 4-5 measured **−0.58 [−1.25, 0.10]**, which is why the
   * window stops at three.
   *
   * The claim is Pareto, not strength: the same moves at roughly 16% less executed compute. It is
   * `netPrior: false` and uses no network — the policy-net version of this idea measured −0.76,
   * because the net's picks fall outside the search's interchangeable top two.
   */
  /**
   * PROMOTED 2026-08-25 — `v3.7-pro`.
   *
   * `MEASURED` **+0.45 [0.11, 0.78]** against `v3.5-pro` over 600 seeds / 2,400 games, at
   * **−8.2% executed iterations and −10.6% wall clock**. Stronger *and* cheaper: a Pareto
   * improvement rather than a compute trade. First place 30.9% against a 25% par.
   *
   * The mechanism is one line of policy: **do not run the tree on a seat's first three own moves.**
   * The tier-1 move ordering plays them. No network is involved.
   *
   * `MEASURED` Why that is not simply throwing away search. Forcing the engine to play its own
   * *second*-ranked move costs **−0.06 [−0.62, 0.56]** on own moves 1-3 (200 seeds, two pooled
   * disjoint blocks) but **−0.58 [−1.25, 0.10]** on own moves 4-5. On the first band the top two are
   * interchangeable, so the tree is not buying a decision; on the second it is. That is why the
   * window stops at three, and it was measured rather than tuned.
   *
   * `STRUCTURAL` **Read the provenance before quoting the interval.** The first 400 seeds were
   * collected by extending a sample that looked encouraging at 200 — optional stopping, which makes
   * the *pooled* interval optimistic as a decision rule. The clean evidence is the preregistered
   * 200-seed confirmation at **+0.27 [−0.30, 0.86]** and the fact that four of five disjoint blocks
   * are positive with the fifth at −0.01. See `selfplay-results/v37-noopening3-preregistered.md`.
   *
   * `v3.7-noopening3-pro` is retained as the id every block was measured under; `v3.7-pro` is the
   * same configuration under its shipping name.
   */
  'v3.7-pro': {
    ...V36_SHAPES['v3.5-pro'],
    id: 'v3.7-pro',
    summary: 'Promoted v3.7 Pro: v3.5-pro with no MCTS on own moves 1-3; the tier-1 ordering plays them.',
    bitboard: {
      ...V36_SHAPES['v3.5-pro'].bitboard!,
      search: {
        ...V36_SHAPES['v3.5-pro'].bitboard!.search,
        openingHeuristicMaxOwnMove: 3,
      },
    },
  } as AlgoConfig,
  /**
   * The same change at the two cheap tiers. `PROPOSED` until measured: the interchangeable top-two
   * finding was measured on the search rather than on a tier, so the mechanism should transfer, but
   * the tree on own moves 1-3 costs less in absolute terms down here and the saving is smaller.
   */
  'v3.7-lite': {
    ...V36_SHAPES['v3.5-lite'],
    id: 'v3.7-lite',
    summary: 'v3.5-lite with no MCTS on own moves 1-3; the tier-1 ordering plays them.',
    bitboard: {
      ...V36_SHAPES['v3.5-lite'].bitboard!,
      search: { ...V36_SHAPES['v3.5-lite'].bitboard!.search, openingHeuristicMaxOwnMove: 3 },
    },
  } as AlgoConfig,
  'v3.7': {
    ...V36_SHAPES['v3.5'],
    id: 'v3.7',
    summary: 'v3.5 with no MCTS on own moves 1-3; the tier-1 ordering plays them.',
    bitboard: {
      ...V36_SHAPES['v3.5'].bitboard!,
      search: { ...V36_SHAPES['v3.5'].bitboard!.search, openingHeuristicMaxOwnMove: 3 },
    },
  } as AlgoConfig,
  'v3.7-noopening3-pro': {
    ...V36_SHAPES['v3.5-pro'],
    id: 'v3.7-noopening3-pro',
    summary: 'v3.5-pro with no MCTS on own moves 1-3; the tier-1 ordering plays them.',
    bitboard: {
      ...V36_SHAPES['v3.5-pro'].bitboard!,
      search: {
        ...V36_SHAPES['v3.5-pro'].bitboard!.search,
        openingHeuristicMaxOwnMove: 3,
      },
    },
  } as AlgoConfig,
  /**
   * PROMOTED 2026-08-25 — `v3.7-pro-max`.
   *
   * `MEASURED` **+0.90 [0.47, 1.31]** against `v3.6-pro-max` over 400 seeds / 1,600 games, at
   * **−5.1% executed iterations and −11.5% wall clock**. First place 33.4% against a 25% par. Two
   * disjoint 200-seed blocks, **both individually significant** (+1.14 [0.56, 1.73] and
   * +0.65 [0.05, 1.21]), with the reproduction rule fixed before the second was read.
   *
   * `STRUCTURAL` The gain is **twice the Pro tier's** (+0.90 against +0.45), which the tier's own
   * measured pathology predicts: at Pro Max the v3.5 curve pours 1.8x into midgame moves the search
   * then decision-locks, and 17.0% of that allocation already provably cannot change the move. A tier
   * that wastes more of its tree gains more from not running one where the choice is interchangeable.
   *
   * `STRUCTURAL` The two compute currencies disagree by more than a factor of two here (−5.1% against
   * −11.5%). Skipped opening moves are the *cheapest* iterations at this tier, so removing them takes
   * out proportionally more clock than iteration count. Both are reported because assuming they track
   * is a mistake this line has already made once.
   */
  'v3.7-pro-max': {
    ...V36_SHAPES['v3.6-pro-max'],
    id: 'v3.7-pro-max',
    summary: 'Promoted v3.7 Pro Max: v3.6-pro-max with no MCTS on own moves 1-3; the tier-1 ordering plays them.',
    bitboard: {
      ...V36_SHAPES['v3.6-pro-max'].bitboard!,
      search: {
        ...V36_SHAPES['v3.6-pro-max'].bitboard!.search,
        openingHeuristicMaxOwnMove: 3,
      },
    },
  } as AlgoConfig,
  'v3.7-noopening3-pro-max': {
    ...V36_SHAPES['v3.6-pro-max'],
    id: 'v3.7-noopening3-pro-max',
    summary: 'v3.6-pro-max with no MCTS on own moves 1-3; the tier-1 ordering plays them.',
    bitboard: {
      ...V36_SHAPES['v3.6-pro-max'].bitboard!,
      search: {
        ...V36_SHAPES['v3.6-pro-max'].bitboard!.search,
        openingHeuristicMaxOwnMove: 3,
      },
    },
  } as AlgoConfig,
  'v3.7-diag-2nd45-pro': {
    ...V36_SHAPES['v3.5-pro'],
    id: 'v3.7-diag-2nd45-pro',
    summary: 'DIAGNOSTIC: v3.5-pro playing its second-choice move on own moves 4-5 only.',
    bitboard: {
      ...V36_SHAPES['v3.5-pro'].bitboard!,
      search: {
        ...V36_SHAPES['v3.5-pro'].bitboard!.search,
        openingRankOffset: 1,
        openingRankOffsetMinOwnMove: 3,
        openingRankOffsetMaxOwnMove: 5,
      },
    },
  } as AlgoConfig,
  'v3.7-diag-2nd5-pro': {
    ...V36_SHAPES['v3.5-pro'],
    id: 'v3.7-diag-2nd5-pro',
    summary: 'DIAGNOSTIC: v3.5-pro playing its second-choice move on own moves 1-5.',
    bitboard: {
      ...V36_SHAPES['v3.5-pro'].bitboard!,
      search: {
        ...V36_SHAPES['v3.5-pro'].bitboard!.search,
        openingRankOffset: 1,
        openingRankOffsetMaxOwnMove: 5,
      },
    },
  } as AlgoConfig,

  'v3.7-select3-pro': v37select(
    'v3.7-select3-pro',
    'v3.5-pro with the pooled policy net choosing directly on own moves 1-3; no search there.',
    'v3.5-pro',
    3,
  ),
  'v3.7-select2-pro': v37select(
    'v3.7-select2-pro',
    'v3.5-pro with the pooled policy net choosing directly on own moves 1-2.',
    'v3.5-pro',
    2,
  ),
  'v3.7-select3-pro-max': v37select(
    'v3.7-select3-pro-max',
    'v3.6-pro-max with the pooled policy net choosing directly on own moves 1-3.',
    'v3.6-pro-max',
    3,
  ),
};

const V36_BANKING: Record<AlgoVersionId, AlgoConfig> = {
  'v3.6-banking-pro': {
    ...V36_SHAPES['v3.5-pro'],
    id: 'v3.6-banking-pro',
    summary: 'v3.5-pro with fixed-pool dynamic iteration banking enabled.',
    bitboard: {
      ...V36_SHAPES['v3.5-pro'].bitboard!,
      search: {
        ...V36_SHAPES['v3.5-pro'].bitboard!.search,
        iterationBanking: true,
      },
    },
  } as AlgoConfig,
};

const V36_PHASE_EVAL: Record<AlgoVersionId, AlgoConfig> = {
  'v3.6-phase-v2-pro': {
    ...V36_SHAPES['v3.5-pro'],
    id: 'v3.6-phase-v2-pro',
    summary: 'v3.5-pro search with v2-pro selecting among its top four in opening and endgame.',
    engine: 'committee',
    committee: {
      ...DEFAULT_COMMITTEE,
      primary: 'v3.5-pro',
      arbiters: [{ version: 'v2-pro', weight: 1 }],
      primaryWeight: 0,
      band: 1,
      maxArbitrated: 4,
      ownMoveRanges: [[0, 4], [15, 20]],
    },
  } as AlgoConfig,
};

export const V3_VERSIONS = {
  ...V12_FAMILY,
  ...V31_TIERS,
  ...V32_CANDIDATES,
  ...V35_AGGRESSION,
  ...V35_COMMITTEE,
  ...V36_SHAPES,
  ...V37_OPENING,
  ...V36_BANKING,
  ...V36_PHASE_EVAL,
};
