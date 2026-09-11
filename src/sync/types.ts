import type { PlayerColor } from '../engine/types';
import { BOARD_SIZE } from '../engine/types';

export const SYNC_SOURCE = 'blokee-sync';
export const SYNC_VERSION = 1;

/** 20×20 occupancy grid; null = empty. */
export type ExternalBoard = Array<Array<PlayerColor | null>>;

export interface SyncBoardPayload {
  type: 'board';
  version: number;
  board: ExternalBoard;
  /** Active seat on the remote game, if known. */
  currentTurn?: PlayerColor;
  /** Seat whose tray currently shows a Pass button (outranks Meteor isActive). */
  passColor?: PlayerColor;
  /** Wall-clock from the extension. */
  ts: number;
  source?: string;
}

export interface SyncPingPayload {
  type: 'ping';
  version: number;
  ts: number;
  source?: string;
  detail?: string;
}

export interface SyncHelloPayload {
  type: 'hello';
  version: number;
  ts: number;
  source?: string;
}

export interface SyncRequestSnapshotPayload {
  type: 'request-snapshot';
  version: number;
  ts: number;
  source?: string;
}

export type SyncInboundPayload =
  | SyncBoardPayload
  | SyncPingPayload
  | SyncHelloPayload
  | SyncRequestSnapshotPayload;

export interface SyncEnvelope {
  source: typeof SYNC_SOURCE;
  payload: SyncInboundPayload;
}

export type SyncApplyStatus =
  | 'idle'
  | 'connected'
  | 'applied'
  | 'synced'
  | 'pass'
  | 'mismatch'
  | 'error';

export interface SyncStatusState {
  status: SyncApplyStatus;
  detail: string;
  lastTs: number | null;
  lastSource: string | null;
  appliedMoves: number;
}

export function emptyExternalBoard(): ExternalBoard {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null),
  );
}

export function isExternalBoard(value: unknown): value is ExternalBoard {
  if (!Array.isArray(value) || value.length !== BOARD_SIZE) {
    return false;
  }
  return value.every(
    (row) =>
      Array.isArray(row) &&
      row.length === BOARD_SIZE &&
      row.every(
        (cell) =>
          cell === null ||
          cell === 'blue' ||
          cell === 'yellow' ||
          cell === 'purple' ||
          cell === 'green',
      ),
  );
}
