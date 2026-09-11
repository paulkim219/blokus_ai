import { SYNC_SOURCE, isExternalBoard, type SyncEnvelope, type SyncInboundPayload } from './types';

export type SyncMessageHandler = (payload: SyncInboundPayload) => void;

function isSyncEnvelope(data: unknown): data is SyncEnvelope {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const envelope = data as SyncEnvelope;
  if (envelope.source !== SYNC_SOURCE || !envelope.payload || typeof envelope.payload !== 'object') {
    return false;
  }
  const { type } = envelope.payload;
  if (type === 'ping' || type === 'hello' || type === 'request-snapshot') {
    return typeof envelope.payload.ts === 'number';
  }
  if (type === 'board') {
    return isExternalBoard(envelope.payload.board) && typeof envelope.payload.ts === 'number';
  }
  return false;
}

export function requestSyncSnapshot(): void {
  window.postMessage(
    {
      source: SYNC_SOURCE,
      payload: {
        type: 'request-snapshot',
        version: 1,
        ts: Date.now(),
        source: 'blokee-app',
      },
    } satisfies SyncEnvelope,
    '*',
  );
}

/** Listen for Chrome-extension (or same-page) sync messages. */
export function subscribeSyncMessages(onMessage: SyncMessageHandler): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    if (!isSyncEnvelope(event.data)) {
      return;
    }
    // Ignore our own outbound snapshot requests.
    if (event.data.payload.type === 'request-snapshot') {
      return;
    }
    onMessage(event.data.payload);
  };

  window.addEventListener('message', handler);
  // Announce readiness so the extension content script can start pushing.
  window.postMessage(
    {
      source: SYNC_SOURCE,
      payload: { type: 'hello', version: 1, ts: Date.now(), source: 'blokee-app' },
    } satisfies SyncEnvelope,
    '*',
  );
  requestSyncSnapshot();

  return () => window.removeEventListener('message', handler);
}
