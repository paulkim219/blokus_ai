import type { GameState, PlaceMove } from '../../engine/types';
import type { RankedMove } from '../searchTypes';
import {
  advanceOracleInteraction,
  createOracleInteractionState,
  oracleColor,
} from './interaction';
import { standardizeOracleFeatures } from './prototypeBayes';
import { extractOracleCandidateFeatures, extractOracleMoveFeatures } from './styleFeatures';
import type { OracleInteractionState, OracleMoveFeatures } from './types';

export const STRATEGIC_PERSONALITY_FAMILIES = [
  'expansion',
  'center',
  'edge',
  'blocker',
  'retaliator',
  'persistent',
  'next-hunter',
  'tempo',
] as const;

export type StrategicPersonalityFamily = (typeof STRATEGIC_PERSONALITY_FAMILIES)[number];
export type StrategicPersonalityVariant = 'a' | 'b' | 'c' | 'd' | 'e';
export type StrategicPersonalityId = `oracle-personality-${StrategicPersonalityFamily}-${StrategicPersonalityVariant}`;

export interface StrategicPersonality {
  id: StrategicPersonalityId;
  family: StrategicPersonalityFamily;
  variant: StrategicPersonalityVariant;
  /** Strength of the objective residual relative to the ordinary base ranking. */
  strength: number;
  baseWeight: number;
  secondaryWeight: number;
}

const VARIANT_STRENGTH: Record<StrategicPersonalityVariant, number> = {
  a: 0.9,
  b: 1.15,
  c: 1.4,
  d: 1.05,
  // Experiment L's sealed holdout: an in-envelope combination that is neither a development
  // amplitude clone nor variant d's exact base/secondary mixture.
  e: 1.25,
};

export const STRATEGIC_PERSONALITIES: readonly StrategicPersonality[] =
  STRATEGIC_PERSONALITY_FAMILIES.flatMap((family) =>
    (['a', 'b', 'c', 'd', 'e'] as const).map((variant) => ({
      id: `oracle-personality-${family}-${variant}` as StrategicPersonalityId,
      family,
      variant,
      strength: VARIANT_STRENGTH[variant],
      baseWeight: variant === 'd' ? 0.7 : variant === 'e' ? 0.62 : 0.55,
      secondaryWeight: variant === 'd' ? 0.15 : variant === 'e' ? 0.1 : 0,
    })),
  );

const PERSONALITY_BY_ID = new Map(
  STRATEGIC_PERSONALITIES.map((personality) => [personality.id, personality]),
);

export function strategicPersonality(id: StrategicPersonalityId): StrategicPersonality {
  const personality = PERSONALITY_BY_ID.get(id);
  if (!personality) throw new Error(`unknown strategic personality: ${id}`);
  return personality;
}

function scoreSecondaryObjective(
  features: OracleMoveFeatures,
  family: StrategicPersonalityFamily,
): number {
  switch (family) {
    case 'expansion':
      return features.centerAffinity;
    case 'center':
    case 'edge':
      return features.pieceSize;
    case 'blocker':
      return features.persistence;
    case 'retaliator':
      return features.totalContact;
    case 'persistent':
      return features.retaliation;
    case 'next-hunter':
      return features.totalContact;
    case 'tempo':
      return features.frontierGain;
  }
}

function targetPressure(features: OracleMoveFeatures, relativeTarget: number): number {
  return features.targetPressure[(features.source + relativeTarget) % 4];
}

/**
 * Objective-level preference, deliberately independent of the base engine's value scale.
 * The result is standardized across the legal set before it is mixed with the base ranking.
 */
export function scoreStrategicObjective(
  state: GameState,
  features: OracleMoveFeatures,
  family: StrategicPersonalityFamily,
): number {
  switch (family) {
    case 'expansion':
      return (
        1.35 * features.frontierGain +
        0.75 * features.outwardProgress +
        0.35 * features.pieceSize -
        0.2 * features.totalContact
      );
    case 'center':
      return (
        1.9 * features.centerAffinity +
        0.45 * features.frontierGain +
        0.2 * features.pieceSize
      );
    case 'edge':
      return (
        1.9 * features.edgeAffinity +
        0.55 * features.outwardProgress +
        0.25 * features.frontierGain
      );
    case 'blocker':
      return (
        1.45 * features.totalDenial +
        0.85 * features.totalContact +
        0.2 * features.persistence
      );
    case 'retaliator':
      return (
        1.8 * features.retaliation +
        0.5 * features.totalDenial +
        0.3 * features.totalContact
      );
    case 'persistent':
      return (
        1.8 * features.persistence +
        0.55 * features.totalDenial +
        0.25 * features.totalContact
      );
    case 'next-hunter':
      return 1.8 * targetPressure(features, 1) + 0.3 * features.totalDenial;
    case 'tempo': {
      // Because pieceSize is standardized within the exact legal set, this remains a preference
      // for unusually large available moves rather than a proxy for game phase.
      const remaining = state.remainingPieces[oracleColor(features.source)].length;
      const earlyWeight = remaining >= 12 ? 2.2 : remaining >= 6 ? 1.2 : 0.35;
      return earlyWeight * features.pieceSize - 0.2 * features.edgeAffinity;
    }
  }
}

function standardize(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const scale = Math.sqrt(variance);
  return values.map((value) => (scale > 1e-9 ? Math.max(-4, Math.min(4, (value - mean) / scale)) : 0));
}

/**
 * Reranks an already bounded base result. The base rank remains present, but the strategic
 * residual is intentionally large enough to generate identifiable behavior for the source audit.
 */
export function rerankStrategicMoves(
  state: GameState,
  rankedMoves: readonly RankedMove[],
  personalityId: StrategicPersonalityId,
  interaction: OracleInteractionState,
): RankedMove[] {
  if (rankedMoves.length <= 1) return [...rankedMoves];
  const personality = strategicPersonality(personalityId);
  const standardized = standardizeOracleFeatures(
    extractOracleCandidateFeatures(
      state,
      rankedMoves.map((entry) => entry.move),
      interaction,
    ),
  );
  const objectives = standardize(
    standardized.map(
      (features) =>
        scoreStrategicObjective(state, features, personality.family) +
        personality.secondaryWeight * scoreSecondaryObjective(features, personality.family),
    ),
  );
  const denominator = Math.max(1, rankedMoves.length - 1);
  return rankedMoves
    .map((entry, index) => {
      const baseRank = 1 - (2 * index) / denominator;
      return {
        ...entry,
        value: personality.baseWeight * baseRank + personality.strength * objectives[index],
        originalIndex: index,
      };
    })
    .sort((left, right) => right.value - left.value || left.originalIndex - right.originalIndex)
    .map(({ originalIndex: _originalIndex, ...entry }) => entry);
}

/**
 * A mid-game objective change for one seat. Experiment K measured switching by splicing two
 * players' prefixes from two different games, which is not a coherent trajectory. A schedule
 * produces the real thing: one continuous game in which a seat's objective changes at a known
 * point, so both training labels and change-point evaluation can be time-varying.
 */
export interface StrategicPersonalitySchedule {
  initial: StrategicPersonalityId;
  switchTo: StrategicPersonalityId;
  /** Count of the seat's own completed moves after which `switchTo` takes over. */
  afterOwnMoves: number;
}

/** The objective in force for a seat that has already made `ownMoves` moves this game. */
export function activeStrategicPersonality(
  schedule: StrategicPersonalitySchedule,
  ownMoves: number,
): StrategicPersonalityId {
  return ownMoves >= schedule.afterOwnMoves ? schedule.switchTo : schedule.initial;
}

export function createStrategicInteractionState(): OracleInteractionState {
  return createOracleInteractionState();
}

/** Advances only from the real move selected in the actual game. */
export function observeStrategicMove(
  state: GameState,
  move: PlaceMove | null,
  interaction: OracleInteractionState,
): OracleInteractionState {
  if (!move) return advanceOracleInteraction(interaction, null);
  return advanceOracleInteraction(interaction, extractOracleMoveFeatures(state, move, interaction));
}
