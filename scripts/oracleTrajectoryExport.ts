import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALGO_VERSIONS, type AlgoConfig, type AlgoVersionId } from '../src/ai/algoVersions.ts';
import {
  ORACLE_CONTEXT_POLICY_FEATURE_NAMES,
  ORACLE_CONTEXT_STATE_FEATURE_NAMES,
  ORACLE_POLICY_FEATURE_NAMES,
} from '../src/ai/oracle/trajectory.ts';
import {
  STRATEGIC_PERSONALITIES,
  type StrategicPersonalityFamily,
  type StrategicPersonalityId,
  type StrategicPersonalityVariant,
} from '../src/ai/oracle/strategicPersonalities.ts';
import type { PolicyId } from '../src/ai/selfplay.ts';
import { TURN_ORDER } from '../src/engine/types.ts';
import type { PlayerColor } from '../src/engine/types.ts';
import { GamePool, defaultWorkerCount, type GameAssignment } from './lib/pool.ts';

type SplitName = 'train' | 'validation' | 'holdout';

interface Profile {
  id: string;
  version: AlgoVersionId;
  policy: PolicyId;
  personality?: StrategicPersonalityId;
  family?: StrategicPersonalityFamily;
  variant?: StrategicPersonalityVariant;
  /** Set only for switching profiles: the objective this seat adopts mid-game. */
  switchTo?: StrategicPersonalityId;
  switchToFamily?: StrategicPersonalityFamily;
}

const ORIGINAL_PROFILES: Record<SplitName, Profile[]> = {
  train: [
    { id: 'v1-greedy', version: 'v1', policy: 'greedy' },
    { id: 'v2pro-search', version: 'v2-pro', policy: 'mcts-bench' },
    { id: 'v32-greedy', version: 'v3.2', policy: 'greedy' },
    { id: 'v41-search', version: 'v4.1', policy: 'mcts-bench' },
  ],
  validation: [
    { id: 'v1-search', version: 'v1', policy: 'mcts-bench' },
    { id: 'v31-greedy', version: 'v3.1', policy: 'greedy' },
    { id: 'v37-search', version: 'v3.7', policy: 'mcts-bench' },
    { id: 'v41-greedy', version: 'v4.1', policy: 'greedy' },
  ],
  holdout: [
    { id: 'v2pro-greedy', version: 'v2-pro', policy: 'greedy' },
    { id: 'v31-search', version: 'v3.1', policy: 'mcts-bench' },
    { id: 'v32-search', version: 'v3.2', policy: 'mcts-bench' },
    { id: 'v37-greedy', version: 'v3.7', policy: 'greedy' },
  ],
};

/**
 * Broader behavioral league for the online-adapter cycle. The holdout deliberately contains
 * interpolated aggression/exploration settings plus v4.1, while training sees the endpoints.
 */
const EXPANDED_PROFILES: Record<SplitName, Profile[]> = {
  train: [
    { id: 'v1-greedy', version: 'v1', policy: 'greedy' },
    { id: 'v1-search', version: 'v1', policy: 'mcts-bench' },
    { id: 'v2lite-search', version: 'v2-lite', policy: 'mcts-bench' },
    { id: 'v2pro-search', version: 'v2-pro', policy: 'mcts-bench' },
    { id: 'v31lite-search', version: 'v3.1-lite', policy: 'mcts-bench' },
    { id: 'v31-search', version: 'v3.1', policy: 'mcts-bench' },
    { id: 'eps05', version: 'v3.2-eps05-pro', policy: 'mcts-bench' },
    { id: 'eps60', version: 'v3.2-eps60-pro', policy: 'mcts-bench' },
    { id: 'aggression00', version: 'v3.5-a00', policy: 'mcts-bench' },
    { id: 'aggression25', version: 'v3.5-a25', policy: 'mcts-bench' },
    { id: 'shape-flat', version: 'v3.6-flat', policy: 'mcts-bench' },
    { id: 'shape-opening', version: 'v3.6-boost-1-5', policy: 'mcts-bench' },
  ],
  validation: [
    { id: 'v31-mid', version: 'v3.1-pro-mid', policy: 'mcts-bench' },
    { id: 'history-off', version: 'v3.2-history0-pro', policy: 'mcts-bench' },
    { id: 'history-high', version: 'v3.2-history09-pro', policy: 'mcts-bench' },
    { id: 'aggression05', version: 'v3.5-a05', policy: 'mcts-bench' },
    { id: 'shape-mid', version: 'v3.6-boost-6-10', policy: 'mcts-bench' },
    { id: 'opening-off', version: 'v3.7-noopening3-pro', policy: 'mcts-bench' },
  ],
  holdout: [
    { id: 'v32-pro', version: 'v3.2-pro', policy: 'mcts-bench' },
    { id: 'eps30', version: 'v3.2-eps30-pro', policy: 'mcts-bench' },
    { id: 'aggression10', version: 'v3.5-a10', policy: 'mcts-bench' },
    { id: 'aggression16', version: 'v3.5-a16', policy: 'mcts-bench' },
    { id: 'shape-late', version: 'v3.6-boost-11-15', policy: 'mcts-bench' },
    { id: 'v41', version: 'v4.1', policy: 'mcts-bench' },
  ],
};

const CONTEXTUAL_PROFILES: Record<SplitName, Profile[]> = {
  train: [
    { id: 'depth', version: 'v3.1-depth-only', policy: 'mcts-bench' },
    { id: 'width', version: 'v3.1-wide-only', policy: 'mcts-bench' },
    { id: 'cpuct08', version: 'v3.2-cpuct08-pro', policy: 'mcts-bench' },
    { id: 'cpuct20', version: 'v3.2-cpuct20-pro', policy: 'mcts-bench' },
    { id: 'prior3', version: 'v3.2-prior3-pro', policy: 'mcts-bench' },
    { id: 'prior9', version: 'v3.2-prior9-pro', policy: 'mcts-bench' },
    { id: 'widen04', version: 'v3.2-widen04-pro', policy: 'mcts-bench' },
    { id: 'widen12', version: 'v3.2-widen12-pro', policy: 'mcts-bench' },
    { id: 'history03', version: 'v3.2-history03-pro', policy: 'mcts-bench' },
    { id: 'notrans', version: 'v3.2-notrans-pro', policy: 'mcts-bench' },
    { id: 'shape-end', version: 'v3.6-boost-16-21', policy: 'mcts-bench' },
    { id: 'select2', version: 'v3.7-select2-pro', policy: 'mcts-bench' },
  ],
  validation: [
    { id: 'cpuct12', version: 'v3.2-cpuct12-pro', policy: 'mcts-bench' },
    { id: 'implicit10', version: 'v3.2-implicit10-pro', policy: 'mcts-bench' },
    { id: 'policy25', version: 'v3.2-policy25-pro', policy: 'mcts-bench' },
    { id: 'eps15', version: 'v3.2-pro-eps15', policy: 'mcts-bench' },
    { id: 'mast05', version: 'v3.2-mast05-pro', policy: 'mcts-bench' },
    { id: 'select3', version: 'v3.7-select3-pro', policy: 'mcts-bench' },
  ],
  holdout: [
    { id: 'cpuct12-notrans', version: 'v3.2-cpuct12-notrans-pro', policy: 'mcts-bench' },
    { id: 'implicit20', version: 'v3.2-implicit20-pro', policy: 'mcts-bench' },
    { id: 'policy50', version: 'v3.2-policy50-pro', policy: 'mcts-bench' },
    { id: 'eps45', version: 'v3.2-eps45-pro', policy: 'mcts-bench' },
    { id: 'mast10', version: 'v3.2-mast10-pro', policy: 'mcts-bench' },
    { id: 'v41-lite', version: 'v4.1-lite', policy: 'mcts-bench' },
  ],
};

function personalityProfiles(variant: StrategicPersonalityVariant): Profile[] {
  return STRATEGIC_PERSONALITIES.filter((personality) => personality.variant === variant).map(
    (personality) => ({
      id: personality.id,
      version: personality.id,
      policy: 'greedy',
      personality: personality.id,
      family: personality.family,
      variant: personality.variant,
    }),
  );
}

const PERSONALITY_PROFILES: Record<SplitName, Profile[]> = {
  train: personalityProfiles('a'),
  validation: personalityProfiles('b'),
  holdout: personalityProfiles('c'),
};

const PERSONALITY_D_PROFILES: Record<SplitName, Profile[]> = {
  train: [],
  validation: [],
  holdout: personalityProfiles('d'),
};

/** Experiment L's stable once-read control. Defined now, but not exported before preregistration. */
const PERSONALITY_E_PROFILES: Record<SplitName, Profile[]> = {
  train: [],
  validation: [],
  holdout: personalityProfiles('e'),
};

/**
 * Switching profiles for change-point work. Experiment K could only simulate a switch by splicing
 * two players' prefixes from two different games; these are single continuous games in which one
 * seat's objective genuinely changes at a known point. Each family is paired with the family four
 * places away, so every pair crosses the spatial/interaction divide.
 */
/**
 * Deterministic per-seat draw. Experiment L's gate learned that every switch happened at own move
 * six, so it fired on the clock rather than on evidence — including on games where nothing
 * changed. The change point must therefore vary per seat, and some seats in the switching block
 * must never switch at all, so that turn index carries no information about whether a switch
 * occurred.
 */
function seatDraw(seedBase: number, gameIndex: number, seat: number, salt: number): number {
  let value = (seedBase % 2147483647) ^ ((gameIndex + 1) * 2654435761) ^ ((seat + 1) * 40503) ^ salt;
  value = Math.imul(value ^ (value >>> 15), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function switchingProfiles(variant: StrategicPersonalityVariant): Profile[] {
  const sources = STRATEGIC_PERSONALITIES.filter(
    (personality) => personality.variant === variant,
  );
  return sources.map((personality, index) => {
    const target = sources[(index + sources.length / 2) % sources.length];
    return {
      id: `${personality.family}->${target.family}-${variant}`,
      version: personality.id,
      policy: 'greedy' as PolicyId,
      personality: personality.id,
      family: personality.family,
      variant,
      switchTo: target.id,
      switchToFamily: target.family,
    };
  });
}

function personalityConfig(profile: Profile): AlgoConfig | null {
  if (!profile.personality) return null;
  const base = ALGO_VERSIONS['v4.1-lite'];
  return {
    ...structuredClone(base),
    id: profile.version,
    summary: `Synthetic Oracle ${profile.family} behavior source, variant ${profile.variant}.`,
  };
}

const SPLITS: SplitName[] = ['train', 'validation', 'holdout'];
const DECISION_FIELDS = [
  'game',
  'profile',
  'seat',
  'ply',
  'turnIndex',
  'candidateOffset',
  'candidateCount',
  'actualIndex',
  'split',
] as const;

function arg(name: string, fallback: string): string {
  // The last occurrence wins so callers can override defaults embedded in an npm script.
  const index = process.argv.lastIndexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name: string, fallback: number, minimum: number): number {
  const parsed = Number(arg(name, String(fallback)));
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be >= ${minimum}`);
  }
  return Math.floor(parsed);
}

interface SwitchPlan {
  minimum: number;
  maximum: number;
  fraction: number;
}

function assignments(
  profilesBySplit: Record<SplitName, Profile[]>,
  gamesPerSplit: number,
  iterations: number,
  seedBase: number,
  contextual: boolean,
  switchPlan: SwitchPlan,
  schedule: Array<{ id: string; seats: Array<{ seat: number; from?: string; to?: string; afterOwnMoves: number }> }>,
): GameAssignment[] {
  const result: GameAssignment[] = [];
  for (let splitIndex = 0; splitIndex < SPLITS.length; splitIndex += 1) {
    const split = SPLITS[splitIndex];
    const profiles = profilesBySplit[split];
    if (profiles.length === 0) continue;
    for (let game = 0; game < gamesPerSplit; game += 1) {
      const rotation = game % TURN_ORDER.length;
      const stride = Math.max(1, Math.floor(profiles.length / TURN_ORDER.length));
      // Four-profile original blocks retain their historical seat-rotation schedule exactly.
      const start = profiles.length === TURN_ORDER.length ? 0 : game % profiles.length;
      const seated = TURN_ORDER.map(
        (_, seat) => profiles[(start + (seat + rotation) * stride) % profiles.length],
      );
      const seatVersions = Object.fromEntries(
        TURN_ORDER.map((color, seat) => [color, seated[seat].version]),
      ) as Record<PlayerColor, AlgoVersionId>;
      const seatPolicies = Object.fromEntries(
        TURN_ORDER.map((color, seat) => [color, seated[seat].policy]),
      ) as Record<PlayerColor, PolicyId>;
      const seatPersonalities = Object.fromEntries(
        TURN_ORDER.flatMap((color, seat) =>
          seated[seat].personality ? [[color, seated[seat].personality]] : [],
        ),
      );
      const seatSwitches: Array<{ seat: number; from?: string; to?: string; afterOwnMoves: number }> = [];
      const seatPersonalitySchedules = Object.fromEntries(
        TURN_ORDER.flatMap((color, seat) => {
          const profile = seated[seat];
          if (!profile.personality || !profile.switchTo) return [];
          // A fraction of seats in the switching block keep one objective for the whole game.
          if (seatDraw(seedBase, game, seat, 0x9e37) >= switchPlan.fraction) return [];
          const span = switchPlan.maximum - switchPlan.minimum + 1;
          const afterOwnMoves =
            switchPlan.minimum + Math.floor(seatDraw(seedBase, game, seat, 0x85eb) * span);
          seatSwitches.push({
            seat,
            from: profile.family,
            to: profile.switchToFamily,
            afterOwnMoves,
          });
          return [
            [
              color,
              { initial: profile.personality, switchTo: profile.switchTo, afterOwnMoves },
            ],
          ];
        }),
      );
      const configs = seated
        .map(personalityConfig)
        .filter((config): config is AlgoConfig => config !== null);
      schedule.push({ id: `${split}:${game}`, seats: seatSwitches });
      result.push({
        id: `${split}:${game}`,
        seatVersions,
        seatPolicies,
        seatPersonalities,
        seatPersonalitySchedules,
        configs,
        seed: seedBase + splitIndex * 100_000 + game,
        iterationBudget: iterations,
        openingRandomPlies: 8,
        openingTopK: 3,
        oracleTrajectory: contextual ? 'contextual' : true,
      });
    }
  }
  return result;
}

async function main(): Promise<void> {
  const out = arg('out', 'ml/data/v5-oracle-policy');
  const league = arg('league', 'original');
  if (
    league !== 'original' &&
    league !== 'expanded' &&
    league !== 'contextual' &&
    league !== 'personality' &&
    league !== 'personality-d' &&
    league !== 'personality-e' &&
    league !== 'personality-switch' &&
    league !== 'personality-switch-e'
  ) {
    throw new Error(
      '--league must be original, expanded, contextual, personality, personality-d, personality-e, personality-switch, or personality-switch-e',
    );
  }
  // Randomized per seat, and only for a fraction of seats, so that turn index cannot stand in for
  // "a switch happened here" the way it could in Experiment L's corpus.
  const switchPlan = {
    minimum: numberArg('switch-after-min', 4, 1),
    maximum: numberArg('switch-after-max', 12, 1),
    fraction: Number(arg('switch-fraction', '0.75')),
  };
  if (switchPlan.maximum < switchPlan.minimum) {
    throw new Error('--switch-after-max must be >= --switch-after-min');
  }
  if (!(switchPlan.fraction > 0 && switchPlan.fraction <= 1)) {
    throw new Error('--switch-fraction must be in (0, 1]');
  }
  const SWITCH_PROFILES: Record<SplitName, Profile[]> = {
    train: switchingProfiles('a'),
    validation: switchingProfiles('b'),
    holdout: switchingProfiles('c'),
  };
  const SWITCH_E_PROFILES: Record<SplitName, Profile[]> = {
    train: [],
    validation: [],
    holdout: switchingProfiles('e'),
  };
  const profilesBySplit =
    league === 'personality-switch-e'
      ? SWITCH_E_PROFILES
      : league === 'personality-switch'
      ? SWITCH_PROFILES
      : league === 'personality-e'
      ? PERSONALITY_E_PROFILES
      : league === 'personality-d'
      ? PERSONALITY_D_PROFILES
      : league === 'personality'
      ? PERSONALITY_PROFILES
      : league === 'contextual'
      ? CONTEXTUAL_PROFILES
      : league === 'expanded'
        ? EXPANDED_PROFILES
        : ORIGINAL_PROFILES;
  let seedBase =
    league === 'personality-switch-e' || league === 'personality-e'
      ? 57_000_000
      : league === 'personality-switch'
      ? 56_000_000
      : league === 'personality-d'
      ? 55_000_000
      : league === 'personality'
      ? 54_000_000
      : league === 'contextual'
        ? 53_000_000
        : league === 'expanded'
          ? 52_600_000
          : 52_200_000;
  // A revised design needs a new seed block; the protocol forbids reusing a consumed one.
  const seedBaseOverride = numberArg('seed-base', 0, 0);
  if (seedBaseOverride) seedBase = seedBaseOverride;
  const contextual =
    league === 'contextual' ||
    league === 'personality' ||
    league === 'personality-d' ||
    league === 'personality-e' ||
    league === 'personality-switch' ||
    league === 'personality-switch-e';
  const featureCount = contextual
    ? ORACLE_CONTEXT_POLICY_FEATURE_NAMES.length
    : ORACLE_POLICY_FEATURE_NAMES.length;
  const gamesPerSplit = numberArg('games-per-split', 16, 4);
  const iterations = numberArg('iterations', 40, 1);
  const workers = numberArg('workers', defaultWorkerCount(), 1);
  const switchSchedule: Array<{
    id: string;
    seats: Array<{ seat: number; from?: string; to?: string; afterOwnMoves: number }>;
  }> = [];
  const work = assignments(
    profilesBySplit,
    gamesPerSplit,
    iterations,
    seedBase,
    contextual,
    switchPlan,
    switchSchedule,
  );
  const pool = new GamePool(workers);
  const started = Date.now();
  let outcomes;
  try {
    outcomes = await pool.run(work, (outcome, done, total) => {
      if (outcome.error) console.error(`${outcome.id}: ${outcome.error}`);
      if (done % 4 === 0 || done === total) {
        process.stdout.write(
          `\r${done}/${total} games ${((Date.now() - started) / 1000).toFixed(0)}s`,
        );
      }
    });
  } finally {
    pool.close();
  }
  process.stdout.write('\n');

  const ordered = outcomes.sort((a, b) => a.id.localeCompare(b.id));
  const profileKeys: string[] = [];
  for (const profile of Object.values(profilesBySplit).flat()) {
    for (const source of [profile.version as string, profile.switchTo]) {
      if (!source) continue;
      const key = `${source}|${profile.policy}`;
      if (!profileKeys.includes(key)) profileKeys.push(key);
    }
  }
  const profileIds = Object.fromEntries(
    profileKeys.map((key, index) => [key, index]),
  ) as Record<string, number>;
  // The decision `profile` column indexes this list, not `meta.profiles`. The two coincide for
  // every fixed-personality league, but a switching seat contributes two sources, so the mapping
  // has to be written down rather than inferred from the profile array's order.
  const personalityFamilies = new Map(
    STRATEGIC_PERSONALITIES.map((personality) => [personality.id as string, personality.family]),
  );
  const profileSources = profileKeys.map((key, index) => {
    const source = key.slice(0, key.lastIndexOf('|'));
    return { index, key, source, family: personalityFamilies.get(source) ?? null };
  });
  const candidateRows: number[] = [];
  const stateRows: number[] = [];
  const boardRows: number[] = [];
  const decisionRows: number[] = [];
  const games: Array<{ id: string; split: SplitName; finished: boolean; decisions: number }> = [];
  let missingPlayedActions = 0;

  for (let gameIndex = 0; gameIndex < ordered.length; gameIndex += 1) {
    const outcome = ordered[gameIndex];
    if (outcome.error || !outcome.oracleTrajectory) continue;
    const split = outcome.id.split(':')[0] as SplitName;
    const splitIndex = SPLITS.indexOf(split);
    const turns = [0, 0, 0, 0];
    for (const decision of outcome.oracleTrajectory.decisions) {
      const candidateOffset = candidateRows.length / featureCount;
      for (const candidate of decision.candidates) candidateRows.push(...candidate);
      if (contextual) {
        if (!decision.stateFeatures || !decision.board) {
          throw new Error(`contextual decision missing shared features in ${outcome.id}`);
        }
        stateRows.push(...decision.stateFeatures);
        boardRows.push(...decision.board);
      }
      decisionRows.push(
        gameIndex,
        profileIds[decision.label],
        decision.seat,
        decision.ply,
        turns[decision.seat]++,
        candidateOffset,
        decision.candidates.length,
        decision.actualIndex,
        splitIndex,
      );
    }
    missingPlayedActions += outcome.oracleTrajectory.missingPlayedActions;
    games.push({
      id: outcome.id,
      split,
      finished: outcome.finished,
      decisions: outcome.oracleTrajectory.decisions.length,
    });
  }

  const x = Float32Array.from(candidateRows);
  const d = Int32Array.from(decisionRows);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.candidates.f32`, Buffer.from(x.buffer));
  writeFileSync(`${out}.decisions.i32`, Buffer.from(d.buffer));
  if (contextual) {
    const states = Float32Array.from(stateRows);
    const boards = Uint8Array.from(boardRows);
    writeFileSync(`${out}.states.f32`, Buffer.from(states.buffer));
    writeFileSync(`${out}.boards.u8`, Buffer.from(boards.buffer));
  }
  const meta = {
    architecture:
      league === 'personality-switch' || league === 'personality-switch-e'
        ? 'v5-oracle-personality-switch-trajectories-v6'
        : league === 'personality-e'
        ? 'v5-oracle-player-residual-holdout-trajectories-v5'
        : league === 'personality-d'
        ? 'v5-oracle-player-residual-holdout-trajectories-v5'
        : league === 'personality'
        ? 'v5-oracle-strategic-personality-trajectories-v4'
        : league === 'contextual'
        ? 'v5-oracle-context-trajectories-v3'
        : league === 'expanded'
          ? 'v5-oracle-expanded-profile-trajectories-v2'
          : 'v5-oracle-legal-candidate-trajectories-v1',
    featureCount: contextual
      ? ORACLE_CONTEXT_POLICY_FEATURE_NAMES.length
      : ORACLE_POLICY_FEATURE_NAMES.length,
    featureNames: contextual
      ? ORACLE_CONTEXT_POLICY_FEATURE_NAMES
      : ORACLE_POLICY_FEATURE_NAMES,
    stateFeatureCount: contextual ? ORACLE_CONTEXT_STATE_FEATURE_NAMES.length : 0,
    stateFeatureNames: contextual ? ORACLE_CONTEXT_STATE_FEATURE_NAMES : [],
    boardShape: contextual ? [20, 20, 4] : [],
    decisionWidth: DECISION_FIELDS.length,
    decisionFields: DECISION_FIELDS,
    splitNames: SPLITS,
    splitContract:
      league === 'personality-switch-e'
        ? 'fresh variant-e switching holdout only; paired seed schedule with the stable variant-e holdout'
        : league === 'personality-e'
        ? 'fresh variant-e stable holdout only; paired seed schedule with the switching variant-e holdout'
        : league === 'personality-d'
        ? 'fresh variant-d holdout only; no profile or seed appears in development data'
        : league === 'personality'
        ? 'whole-game and whole-profile; objective families transfer across disjoint a/b/c variants'
        : 'whole-game and whole-profile; no game or profile appears in two splits',
    profiles:
      league === 'expanded' ||
      league === 'personality' ||
      league === 'personality-d' ||
      league === 'personality-e' ||
      league === 'personality-switch' ||
      league === 'personality-switch-e'
        ? Object.entries(profilesBySplit).flatMap(([split, profiles]) =>
            profiles.map((profile) => ({ ...profile, split })),
          )
        : Object.values(profilesBySplit).flat(),
    league,
    games,
    gamesPerSplit,
    iterations,
    openingRandomPlies: 8,
    openingTopK: 3,
    decisions: d.length / DECISION_FIELDS.length,
    candidates: x.length / featureCount,
    missingPlayedActions,
    finishedGames: games.filter((game) => game.finished).length,
    seedBase,
    profileSources,
    ...(league === 'personality-switch' || league === 'personality-switch-e'
      ? {
          switchPlan,
          switchSchedule,
          // The exported label already follows the active objective, so the change point is
          // recoverable from the decision rows alone; this is the intended schedule for checking.
          switchPairs: Object.values(profilesBySplit)
            .flat()
            .map((profile) => ({
              id: profile.id,
              from: profile.family,
              to: profile.switchToFamily,
            })),
        }
      : {}),
  };
  writeFileSync(`${out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify(meta, null, 2));
  console.log(
    `Wrote ${out}.{candidates.f32,decisions.i32${contextual ? ',states.f32,boards.u8' : ''},meta.json}`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
