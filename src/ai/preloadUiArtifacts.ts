import raw from '../../ml/v41-rollout-policy.json' with { type: 'json' };
import {
  isRolloutPolicyRegistered,
  loadRolloutPolicy,
  registerRolloutPolicy,
  type RawRolloutPolicy,
} from './bitboard/rolloutPolicy';

/** Path the v4.1 configs name. Must match `playoutTablePath` on those configs. */
export const V41_ROLLOUT_POLICY_PATH = 'ml/v41-rollout-policy.json';

/**
 * Browser-safe load of the artifacts the live-game dropdown needs. Node entry points use
 * `scripts/lib/netPreload.ts` (filesystem). The engine never reads a file itself, so the worker
 * and the main-thread fallback both call this once at import.
 */
export function preloadUiArtifacts(): void {
  if (isRolloutPolicyRegistered(V41_ROLLOUT_POLICY_PATH)) {
    return;
  }
  registerRolloutPolicy(V41_ROLLOUT_POLICY_PATH, loadRolloutPolicy(raw as RawRolloutPolicy));
}
