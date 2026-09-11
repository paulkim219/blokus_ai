import type { SyncStatusState } from '../sync/types';

interface SyncStatusProps {
  sync: SyncStatusState;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

const STATUS_LABEL: Record<SyncStatusState['status'], string> = {
  idle: 'Idle',
  connected: 'Connected',
  applied: 'Updated',
  synced: 'In sync',
  pass: 'Pass synced',
  mismatch: 'Mismatch',
  error: 'Error',
};

export function SyncStatus({ sync, enabled, onToggle }: SyncStatusProps) {
  return (
    <div className="sync-status">
      <label className="toggle">
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          aria-pressed={enabled}
          onClick={() => onToggle(!enabled)}
        />
        <span>Live sync {enabled ? 'on' : 'off'}</span>
      </label>
      {enabled ? (
        <div className={`sync-status-meta status-${sync.status}`}>
          <span className="sync-pill">{STATUS_LABEL[sync.status]}</span>
          <span className="sync-detail">{sync.detail || 'Waiting for Chrome extension…'}</span>
          {sync.lastSource ? <span className="sync-source">via {sync.lastSource}</span> : null}
        </div>
      ) : (
        <div className="sync-status-meta">
          <span className="sync-detail">
            Mirror Board Game Arena moves via the Blokee Chrome extension
          </span>
        </div>
      )}
    </div>
  );
}
