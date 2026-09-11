import type { PlayerColor } from '../../engine/types';

/** Metadata is evidence for a prior, never a hard-coded statement about how a seat will play. */
export type OraclePlayerKind = 'human' | 'cpu' | 'unknown';

export interface OracleSeatDescriptor {
  color: PlayerColor;
  kind: OraclePlayerKind;
  /** Optional display label for the current session. It is not a persistent identity. */
  name?: string | null;
  /** Known engine/config id for controlled experiments. Never supplied for ordinary humans. */
  engineId?: string | null;
}

export interface OracleInteractionState {
  ply: number;
  /** Decayed directed pressure: `pressure[source][target]`. */
  pressure: number[][];
  /** Most recent source to apply meaningful pressure to each target, or -1. */
  lastAggressor: number[];
  /** Most recent target pressured by each source, or -1. */
  lastVictim: number[];
}

export interface OracleMoveInteraction {
  source: number;
  /** Per-seat direct pressure created by the candidate move. */
  targetPressure: number[];
  deniedCorners: number[];
  edgeContacts: number[];
  diagonalContacts: number[];
  primaryTarget: number;
  retaliation: number;
  persistence: number;
}

export interface OracleMoveFeatures extends OracleMoveInteraction {
  pieceSize: number;
  centerAffinity: number;
  edgeAffinity: number;
  outwardProgress: number;
  frontierGain: number;
  totalDenial: number;
  totalContact: number;
}

/** Which learned identity is allowed to drive a response-aware search. */
export type OracleProfileMode = 'personalized' | 'fixed' | 'shuffled';

/**
 * Immutable, serializable view of the real-game observer at one search root. Search branches clone
 * `interaction`; they never mutate this object or update a posterior from an imagined action.
 */
export interface OracleSearchSnapshot {
  mode: OracleProfileMode;
  posteriors: number[][];
  observations: number[];
  interaction: OracleInteractionState;
}
