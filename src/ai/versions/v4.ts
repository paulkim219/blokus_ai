import type { AlgoConfig, AlgoVersionId } from '../algoVersions';
import type { BitboardParams, DeepPartial } from '../bitboard/config';
import { V3_TUNED, V3_VERSIONS } from './v3';
import { V4_WEIGHTS } from './v1';

/**
 * v4 — the learned evaluation.
 *
 * Everything before this generation tuned *weights* on a fixed set of hand-designed terms, and the
 * record on that is unambiguous: of a dozen hand-set changes to v3 only two ever helped, and both
 * changed what a term **computes** rather than what it is worth. v4 stops proposing terms. The
 * evaluation is a network (`ml/train_v4.py`) distilled from what v2-pro and v3.1 find when they
 * actually search, and it replaces the rollout rather than the truncated-leaf `E_i`.
 *
 * Two findings set that up:
 *
 *   - The rollout's value only becomes trustworthy when it is played to the end (+5.71 at 84 plies
 *     against baseline at 12), and playing it out is what makes v2-pro cost 732 ms/move. A network
 *     that estimates the same quantity directly gets the accuracy without the 2.7× cost.
 *   - v12's evaluation was the *better* global predictor of final margin (0.494 against v11's
 *     0.444) and still lost by 2.84. That is a sibling-ranking failure, so the network is trained
 *     with a listwise loss over one node's children, not a regression on the outcome.
 *
 * The parameters are v3.1's tuned values throughout, so a match against v3.1 isolates the
 * evaluation and nothing else. `netBlend: 0` in every other version keeps them byte-identical.
 */
function v4Variant(
  id: AlgoVersionId,
  summary: string,
  overrides: DeepPartial<BitboardParams>,
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

const NET = 'ml/v4-weights.json';

function withNet(
  base: DeepPartial<BitboardParams>,
  search: Record<string, unknown>,
): DeepPartial<BitboardParams> {
  return {
    ...base,
    search: { ...(base.search ?? {}), ...search },
  } as DeepPartial<BitboardParams>;
}

/**
 * v4.7 keeps the v3.7 tree and a real stochastic rollout prefix, then bootstraps only the tail.
 * The model's four means are already in backed-value space, so no second margin transform applies.
 */
function v47Tail(
  id: AlgoVersionId,
  base: AlgoVersionId,
  prefix: number,
  netPath: string,
  sampling: 'mean' | 'gaussian' | 'gaussianJoint' = 'mean',
): AlgoConfig {
  const source = V3_VERSIONS[base];
  if (!source) throw new Error(`v4.7 base ${base} is not registered`);
  return {
    ...source,
    id,
    summary:
      `${base} with ${prefix} real rollout plies followed by a learned four-seat continuation ` +
      'value; this is an experimental architecture candidate, not a promoted version.',
    bitboard: {
      ...(source.bitboard ?? {}),
      search: {
        ...((source.bitboard ?? {}).search ?? {}),
        netPath,
        netBlend: 1,
        netOutputKind: 'values',
        netValueSampling: sampling,
        netTailPrefix: prefix,
        netTailMaxStd: 0,
      },
    },
  } as AlgoConfig;
}

function v41RolloutCandidate(id: AlgoVersionId, base: AlgoVersionId): AlgoConfig {
  const source = V3_VERSIONS[base];
  if (!source) throw new Error(`v4.1 base ${base} is not registered`);
  return {
    ...source,
    id,
    summary:
      `${base} exact search with full terminal rollouts, the v3.7 opening shortcut, and the ` +
      'validation-selected 25% blend of the canonical counterfactual-return rollout-policy student.',
    bitboard: {
      ...(source.bitboard ?? {}),
      search: {
        ...((source.bitboard ?? {}).search ?? {}),
        openingHeuristicMaxOwnMove: 3,
        playoutPolicy: 'table',
        playoutTablePath: 'ml/v41-rollout-policy.json',
        playoutTableBlend: 0.25,
        playoutTemp: 0,
      },
    },
  } as AlgoConfig;
}

/** `v4.1-pro` at a different iteration scale and nothing else. */
function v41ComputeArm(id: AlgoVersionId, scale: number, note: string): AlgoConfig {
  const source = v41RolloutCandidate(id, 'v3.2-pro');
  return {
    ...source,
    summary: `v4.1-pro at iteration scale ${scale} — ${note}. Compute-ladder arm, not a release.`,
    bitboard: {
      ...(source.bitboard ?? {}),
      search: { ...((source.bitboard ?? {}).search ?? {}), iterationScale: scale },
    },
  } as AlgoConfig;
}

export const V4_VERSIONS: Record<AlgoVersionId, AlgoConfig> = {
  v4: v4Variant(
    'v4',
    'v3.1 with the hand-written leaf evaluation replaced by a network distilled from v2-pro and v3.1 search values, trained with a listwise loss over sibling moves. No rollout at all.',
    withNet(V3_TUNED, { netPath: NET, netBlend: 1, netScale: 12 }),
  ),

  /**
   * Corrects the value contract without changing the historical `v4` config. The exporter labels
   * every output as `score - mean(other three)`, so this candidate squashes those margins directly
   * instead of treating them as raw scores and subtracting an opponent reference a second time.
   */
  'v4-margin-corrected': v4Variant(
    'v4-margin-corrected',
    'v4 with its trained-output contract corrected: predicted mean-opponent margins are squashed directly rather than margin-transformed twice.',
    withNet(V3_TUNED, {
      netPath: NET,
      netBlend: 1,
      netScale: 12,
      netOutputKind: 'meanMargins',
    }),
  ),
  'v4-margin-corrected-hybrid25': v4Variant(
    'v4-margin-corrected-hybrid25',
    'v4-hybrid25 with the learned mean-margin output contract corrected.',
    withNet(V3_TUNED, {
      netPath: NET,
      netBlend: 0.25,
      netScale: 12,
      netOutputKind: 'meanMargins',
    }),
  ),

  // The network's output is already a margin in score units, so `netScale` sets how sharply the
  // sigmoid saturates — the one genuinely new free parameter this version introduces. Bracketing
  // it, rather than assuming 12 transfers from `sigmoidScale`, is the cheapest thing that could
  // explain a bad first result.
  'v4-scale6': v4Variant(
    'v4-scale6',
    'v4 with a sharper value sigmoid (netScale 6).',
    withNet(V3_TUNED, { netPath: NET, netBlend: 1, netScale: 6 }),
  ),
  'v4-scale24': v4Variant(
    'v4-scale24',
    'v4 with a flatter value sigmoid (netScale 24).',
    withNet(V3_TUNED, { netPath: NET, netBlend: 1, netScale: 24 }),
  ),
  /**
   * The network as a *prior* only: v3.1's rollout and evaluation are untouched, and the network
   * decides only how the root's PUCT prior is shaped. This is the one use that matches the training
   * objective exactly — a listwise loss over one node's children is a ranking loss, and ranking a
   * node's children is what a prior does. A flat prior costs v3 −1.41 [−2.42, −0.46], so the prior
   * is load-bearing and there is room for a better one to show up.
   */
  'v4-prior': v4Variant(
    'v4-prior',
    'v3.1 with the root PUCT prior taken from the learned ranker; leaf value and rollout unchanged.',
    withNet(V3_TUNED, { netPath: NET, netBlend: 0, netPrior: true, netPriorTemp: 4 }),
  ),
  'v4-prior-hybrid': v4Variant(
    'v4-prior-hybrid',
    'The learned ranker as the root prior *and* a quarter weight on the learned leaf value.',
    withNet(V3_TUNED, { netPath: NET, netBlend: 0.25, netScale: 12, netPrior: true, netPriorTemp: 4 }),
  ),

  /**
   * The network averaged with a full-length rollout rather than replacing it. The rollout is an
   * unbiased, high-variance sample of the final margin; the network is a biased, low-variance
   * estimate of the same quantity. Averaging two such estimators beats either when their errors are
   * not perfectly correlated, and here they cannot be — one is a simulation, the other a regression.
   */
  'v4-hybrid': v4Variant(
    'v4-hybrid',
    'v3.1 with the leaf value averaged half and half between its full-length rollout and the learned evaluation.',
    withNet(V3_TUNED, { netPath: NET, netBlend: 0.5, netScale: 12 }),
  ),
  'v4-hybrid25': v4Variant(
    'v4-hybrid25',
    'v3.1 with a quarter weight on the learned evaluation and three quarters on its rollout.',
    withNet(V3_TUNED, { netPath: NET, netBlend: 0.25, netScale: 12 }),
  ),

  /**
   * Rollouts kept, network used only as a *prior* on the value — the intermediate design, in case
   * replacing the rollout outright turns out to be the aggressive half of the change.
   */
  /**
   * The cheap hybrid: a *truncated* rollout averaged with the network. At blend 1 the rollout never
   * runs at all, so pairing blend 1 with a truncation setting would just be `v4` under another
   * name — the truncation only means something once both estimators are in play.
   */
  'v4-lite': v4Variant(
    'v4-lite',
    'Truncated 12-ply rollout averaged half and half with the learned evaluation — the cheap end of generation 4.',
    withNet(V3_TUNED, { netPath: NET, netBlend: 0.5, netScale: 12, playoutCutoff: 12 }),
  ),

  /**
   * The rank blend is fitted for the hand-written evaluation's spread; a network trained on margins
   * may not want it at all. `objectiveBlend` also ignores its own base when trailing (C1), so this
   * is the only way to actually switch rank off.
   */
  'v4-norank': v4Variant(
    'v4-norank',
    'v4 with the rank component of the backup switched off.',
    withNet(V3_TUNED, { netPath: NET, netBlend: 1, netScale: 12, rankBlend: 0, objectiveShift: false }),
  ),

  // v4.7 architecture search: each arm has a prefix-matched, game-disjoint continuation model.
  'v4.7-tail8': v47Tail('v4.7-tail8', 'v3.7', 8, 'ml/v47-tail8-values.json'),
  'v4.7-tail16': v47Tail('v4.7-tail16', 'v3.7', 16, 'ml/v47-tail16-values.json'),
  'v4.7-tail24': v47Tail('v4.7-tail24', 'v3.7', 24, 'ml/v47-tail24-values.json'),
  'v4.7-tail8-linear': v47Tail(
    'v4.7-tail8-linear',
    'v3.7',
    8,
    'ml/v47-tail8-linear.json',
  ),
  'v4.7-tail16-joint': v47Tail(
    'v4.7-tail16-joint',
    'v3.7',
    16,
    'ml/v47-tail16-joint.json',
    'gaussianJoint',
  ),
  'v4.7-tail24-joint': v47Tail(
    'v4.7-tail24-joint',
    'v3.7',
    24,
    'ml/v47-tail24-joint.json',
    'gaussianJoint',
  ),
  'v4.8-rollout-rl-base': {
    ...V3_VERSIONS['v3.7'],
    id: 'v4.8-rollout-rl-base',
    summary:
      'v3.7 expressed as the identity point of a trainable phase-conditioned rollout-policy family.',
    bitboard: {
      ...(V3_VERSIONS['v3.7'].bitboard ?? {}),
      search: {
        ...((V3_VERSIONS['v3.7'].bitboard ?? {}).search ?? {}),
        playoutPolicy: 'linear',
        playoutEpsByPhase: { opening: 0.6, midgame: 0.6, endgame: 0.6 },
        playoutCornerWeight: 0,
        playoutEdgeWeight: 0,
        playoutTemp: 0,
      },
    },
  } as AlgoConfig,
  'v4.8-rollout-rl': {
    ...V3_VERSIONS['v3.7'],
    id: 'v4.8-rollout-rl',
    summary:
      'First search-aware RL rollout-policy candidate: v3.7 tree search with a CEM-trained, ' +
      'phase-conditioned terminal simulation policy. Experimental and not promoted.',
    bitboard: {
      ...(V3_VERSIONS['v3.7'].bitboard ?? {}),
      search: {
        ...((V3_VERSIONS['v3.7'].bitboard ?? {}).search ?? {}),
        playoutPolicy: 'linear',
        playoutEpsByPhase: {
          opening: 0.6109215888838359,
          midgame: 0.45671839581521817,
          endgame: 0.7472508268047798,
        },
        playoutCornerWeight: 0.06241037462741441,
        playoutEdgeWeight: 0.06274933872677764,
        playoutTemp: 0,
      },
    },
  } as AlgoConfig,
  /**
   * Attribution ablation for the v4.1 release, not a release candidate.
   *
   * `v4.1-pro-candidate` differs from `v3.1-pro` in three ways at once: the promoted ε=0.60 rollout
   * mixture (v3.2), the inherited v3.7 own-moves-1–3 opening shortcut, and the learned rollout-policy
   * table. Gate 3's timing showed the whole wall-clock saving comes from the shortcut, which raises
   * the obvious question about the +1.13 strength result. This arm is v4.1-pro with the learned
   * table removed and everything else identical, so the difference between them is the student and
   * nothing else.
   */
  'v4.1-pro-noTable': {
    ...V3_VERSIONS['v3.2-pro'],
    id: 'v4.1-pro-noTable',
    summary:
      'v3.2-pro plus the v3.7 opening shortcut, without the learned rollout-policy table. ' +
      'Attribution ablation for v4.1; never promoted.',
    bitboard: {
      ...(V3_VERSIONS['v3.2-pro'].bitboard ?? {}),
      search: {
        ...((V3_VERSIONS['v3.2-pro'].bitboard ?? {}).search ?? {}),
        openingHeuristicMaxOwnMove: 3,
      },
    },
  } as AlgoConfig,
  /**
   * Promoted 2026-08-25 under the preregistered gates in
   * `research_paper/v41_foundation_experiment.md`. Pooled Pro result over two disjoint seed blocks
   * (140 seeds / 560 games): **+1.13 [0.51, 1.74]** against `v3.1-pro`, at 17.9% less wall time per
   * move.
   *
   * Read the attribution before attributing any of that to the learned policy. A head-to-head
   * ablation against the identical config with the table removed (`v4.1-pro-noTable`, 94 seeds)
   * measured **−0.06 [−0.72, 0.61]** — an interval that excludes the release's own +1.13. The
   * strength comes from v3.2's ε=0.60 rollout mixture and v3.7's own-moves-1–3 opening shortcut;
   * the student is strength-neutral and costs about 13% of midgame move time.
   *
   * This is therefore a *foundation* release exactly as its objective defined one: a safe, identity-
   * preserving, economically viable place to put a learned rollout policy. It is not evidence that
   * the learned rollout policy works.
   */
  /**
   * v4.2 compute ladder — reinvesting v4.1's efficiency surplus.
   *
   * Gate 3 measured `v4.1-pro` at 139.8 ms/move against `v3.1-pro`'s 170.2, a 17.9% saving that the
   * release banked and never spent. The saving is real but it was discarded, which is the same
   * mistake the selective-search experiment diagnosed in itself
   * (`v42_selective_search_experiment.md`, "Savings were discarded"): efficiency that is not
   * reinvested raises no ceiling.
   *
   * These arms spend it. 1.218x is the scale at which v4.1-pro costs what v3.1-pro already costs;
   * the larger arms deliberately overspend, so the strength-versus-wall-clock curve can be measured
   * rather than assumed. Nothing else about v4.1 changes.
   *
   * `E19` in `v4_learning_programme.md` proposed exactly this measurement and it has never been run.
   */
  /**
   * A genuine tier above `v4.1-pro-max`, which already occupies scale 8.
   *
   * The compute ladder's `s92` arm sits at scale 9.18 and was measured against `v4.1-pro` — a 2x
   * iteration step that returned +1.50. Against the tier that actually ships it is only +14.8%
   * compute, which the exchange rate prices at roughly +0.25. It is a near-duplicate of pro-max and
   * is not worth a name.
   *
   * `ultra` doubles pro-max instead, the same ratio pro-max has to the tier below it. Nothing about
   * the architecture changes; this is the compute ladder continued to a rung that is actually a rung.
   *
   * `MEASURED` +1.49 [0.69, 2.26] against `v4.1-pro-max` over 107 seeds / 428 games in three
   * disjoint blocks (+1.50, +1.37, +1.54), 33.9% first place. Costs 437.1 ms/move against
   * `v3.1-pro-max`'s 297.8, or +46.8%, measured on an idle machine.
   *
   * The gain matches the +1.27 the exchange rate predicts for a doubling, so this is a compute tier
   * and not an architectural advance. It buys strength at the ordinary price.
   */
  'v4.1-ultra': v41ComputeArm('v4.1-ultra', 16, 'doubles v4.1-pro-max'),
  /**
   * `v4.1-ultra` with the stale-settle descent fixed (`search.replaySettle`, see config.ts). An
   * experiment id, not a release: it changes what the tree simulates in 2–6% of descents and has to
   * be measured against `v4.1-ultra` before it means anything.
   */
  'v4.1-ultra-settlefix': (() => {
    const source = v41ComputeArm('v4.1-ultra-settlefix', 16, 'doubles v4.1-pro-max');
    return {
      ...source,
      summary: 'v4.1-ultra with search.replaySettle: revisited nodes re-apply their cached settle.',
      bitboard: {
        ...(source.bitboard ?? {}),
        search: { ...((source.bitboard ?? {}).search ?? {}), replaySettle: true },
      },
    } as AlgoConfig;
  })(),
  /**
   * RELEASE: `v4.1-ultra-settlefix` promoted under a release name. Identical config: v4.1-ultra
   * (scale 16) with `search.replaySettle`.
   *
   * `MEASURED` against `v4.1-ultra` on two disjoint 200-seed blocks (800 games each, native engine,
   * base 300): +0.29 [0.17, 0.43] (seeds 71,234,567–71,234,766) and +0.27 [0.14, 0.42]
   * (71,334,567–71,334,766). See `research_paper/v6_native_and_learning_results.md`.
   *
   * A bug fix, not a tuned parameter: same iteration budget, same per-iteration cost. The
   * experiment id stays registered because both measurements are logged under it.
   */
  'v4.2-ultra': (() => {
    const source = v41ComputeArm('v4.2-ultra', 16, 'doubles v4.1-pro-max');
    return {
      ...source,
      summary:
        'v4.1-ultra with the stale-settle descent fixed (search.replaySettle). +0.28 over v4.1-ultra across two 200-seed blocks.',
      bitboard: {
        ...(source.bitboard ?? {}),
        search: { ...((source.bitboard ?? {}).search ?? {}), replaySettle: true },
      },
    } as AlgoConfig;
  })(),

  'v4.2-pro-s56': v41ComputeArm('v4.2-pro-s56', 5.59, 'spends the surplus to v3.1-pro wall-clock parity'),
  'v4.2-pro-s69': v41ComputeArm('v4.2-pro-s69', 6.89, 'overspends to roughly 1.5x v4.1-pro'),
  'v4.2-pro-s92': v41ComputeArm('v4.2-pro-s92', 9.18, 'overspends to roughly 2x v4.1-pro'),

  'v4.1-lite': v41RolloutCandidate('v4.1-lite', 'v3.2-lite'),
  'v4.1': v41RolloutCandidate('v4.1', 'v3.2'),
  'v4.1-pro': v41RolloutCandidate('v4.1-pro', 'v3.2-pro'),
  'v4.1-pro-max': v41RolloutCandidate('v4.1-pro-max', 'v3.2-pro-max'),

  // Provenance: the ids every v4.1 gate match was logged under. Kept so those logs stay resolvable.
  'v4.1-lite-candidate': v41RolloutCandidate('v4.1-lite-candidate', 'v3.2-lite'),
  'v4.1-candidate': v41RolloutCandidate('v4.1-candidate', 'v3.2'),
  'v4.1-pro-candidate': v41RolloutCandidate('v4.1-pro-candidate', 'v3.2-pro'),
  'v4.1-pro-max-candidate': v41RolloutCandidate(
    'v4.1-pro-max-candidate',
    'v3.2-pro-max',
  ),

  /**
   * Exploratory v4.2 selective-action arm.
   *
   * A game-disjoint offline screen rejected the preregistered 20% coverage arm. The independently
   * listed 30% arm was directionally positive on all three safety quantities, so this id exists only
   * to run the mandatory fresh online falsification test. It is not a promotion candidate unless a
   * new preregistered confirmation is collected.
   */
  'v4.2-selective-probe-pro': {
    ...V3_VERSIONS['v3.7-pro'],
    id: 'v4.2-selective-probe-pro',
    summary:
      'EXPLORATORY: v3.7-pro with a cross-fitted ridge abstention head selecting pooled-policy ' +
      'moves on about 30% of own moves 4-5; exact v3.7 search is the fallback.',
    bitboard: {
      ...(V3_VERSIONS['v3.7-pro'].bitboard ?? {}),
      search: {
        ...((V3_VERSIONS['v3.7-pro'].bitboard ?? {}).search ?? {}),
        pooledNetPath: 'ml/v45-pooled-ensemble.json',
        netPrior: false,
        openingSelectMinOwnMove: 4,
        openingSelectMaxOwnMove: 5,
        openingSelectGate: {
          mean: [
            0.5354330708661418, 6.200184333801365, 0.20331274052859077,
            0.32420783491898797, 0.9733591598839777, 0.7598425196850387,
            0.4625536755675133, 0.16191119336444487, 0.14092404274439624,
            0.15748031496062992, 0.31576822128003257, 0.9984251968503938,
            0.22112204735203994,
          ],
          scale: [
            0.4997276031209089, 0.27311884911394213, 0.19189729856712387,
            0.2308366641137122, 0.02170182082582621, 0.2627124008885504,
            0.17188779210167027, 0.19128434110334686, 0.083415245285462,
            0.36497218152464306, 0.31073795495432166, 0.017712022082350728,
            0.09016876421494158,
          ],
          weights: [
            -0.13857921513085006, -0.04302142227922126, 0.2600773252258218,
            0.012522902534943614, 0.1723872667885721, -0.01806822285287254,
            0.0929074656596128, -0.03856366069037031, -0.08442884546466084,
            0.08740370620802318, -0.03488519433854845, 0.02988523833118445,
            0.13164881218197688,
          ],
          intercept: -0.12998810257066257,
          threshold: 0.026602643460797937,
        },
      },
    },
  } as AlgoConfig,
};
